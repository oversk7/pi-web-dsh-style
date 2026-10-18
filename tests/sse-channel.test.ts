import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { closeSseClient, createSseClient, createSnapshotScheduler, sendSseEvent } from "../sse-channel.ts";
import { applySessionPatches, type JsonValue, type SessionPatch } from "../web/session-sync.js";

test("snapshot bursts coalesce per session and final state flushes immediately", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent: number[] = [];
  const scheduler = createSnapshotScheduler<number>((value) => sent.push(value));
  scheduler.schedule("a", 1);
  scheduler.schedule("a", 2);
  scheduler.schedule("a", 3);
  scheduler.schedule("b", 4);
  assert.deepEqual(sent, [1, 4]);
  t.mock.timers.tick(100);
  assert.deepEqual(sent, [1, 4, 3]);
  scheduler.schedule("a", 5);
  scheduler.schedule("a", 6);
  scheduler.schedule("a", 7, true);
  assert.deepEqual(sent, [1, 4, 3, 5, 7]);
  t.mock.timers.tick(100);
  assert.deepEqual(sent, [1, 4, 3, 5, 7]);
});

test("snapshot cancellation and shutdown discard delayed snapshots", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent: number[] = [];
  const scheduler = createSnapshotScheduler<number>((value) => sent.push(value));
  scheduler.schedule("a", 1);
  scheduler.schedule("a", 2);
  scheduler.cancel("a");
  scheduler.schedule("b", 3);
  scheduler.schedule("b", 4);
  scheduler.clear();
  t.mock.timers.tick(100);
  assert.deepEqual(sent, [1, 3]);
});

class FakeResponse extends EventEmitter {
  readonly writes: string[] = [];
  acceptWrites = true;

  write(payload: string): boolean {
    this.writes.push(payload);
    return this.acceptWrites;
  }
}

test("SSE backpressure coalesces repeated snapshots until drain", () => {
  const response = new FakeResponse();
  response.acceptWrites = false;
  const client = createSseClient(response, () => assert.fail("unexpected SSE error"));

  sendSseEvent(client, { type: "snapshot", sessionId: "one", value: 1 });
  sendSseEvent(client, { type: "snapshot", sessionId: "one", value: 2 });
  sendSseEvent(client, { type: "snapshot", sessionId: "one", value: 3 });

  assert.equal(response.writes.length, 1);
  assert.equal(client.pendingEvents.size, 1);

  response.acceptWrites = true;
  response.emit("drain");

  assert.equal(response.writes.length, 2);
  assert.match(response.writes[1], /"type":"session_patch"/);
  assert.match(response.writes[1], /"baseRevision":1,"revision":2/);
  assert.match(response.writes[1], /"value":3/);
  assert.equal(client.pendingEvents.size, 0);
});

test("SSE backpressure retains the latest event of each kind", () => {
  const response = new FakeResponse();
  response.acceptWrites = false;
  const client = createSseClient(response, () => assert.fail("unexpected SSE error"));

  sendSseEvent(client, { type: "heartbeat", at: 1 });
  sendSseEvent(client, { type: "snapshot", sessionId: "one", value: 1 });
  sendSseEvent(client, { type: "workspaces", revision: 2 });
  sendSseEvent(client, { type: "snapshot", sessionId: "one", value: 3 });

  assert.equal(client.pendingEvents.size, 2);
  response.acceptWrites = true;
  response.emit("drain");

  assert.equal(response.writes.length, 3);
  assert.match(response.writes[1], /"type":"snapshot"/);
  assert.match(response.writes[1], /"revision":1/);
  assert.match(response.writes[1], /"value":3/);
  assert.match(response.writes[2], /"revision":2/);
});

test("closing an SSE client releases pending events", () => {
  const response = new FakeResponse();
  response.acceptWrites = false;
  const client = createSseClient(response, () => assert.fail("unexpected SSE error"));

  sendSseEvent(client, { type: "heartbeat", at: 1 });
  sendSseEvent(client, { type: "snapshot", sessionId: "one" });
  closeSseClient(client);
  response.acceptWrites = true;
  response.emit("drain");

  assert.equal(response.writes.length, 1);
  assert.equal(client.pendingEvents.size, 0);
  assert.equal(client.snapshotBaseline, undefined);
  assert.equal(client.snapshotRevision, 0);
});

function decode(payload: string): Record<string, JsonValue> {
  return JSON.parse(payload.slice(6));
}

function body(event: Record<string, JsonValue>): Record<string, JsonValue> {
  const { revision: _revision, ...snapshot } = event;
  return snapshot;
}

function reconstruct(snapshot: Record<string, JsonValue>, payload: string): Record<string, JsonValue> {
  const event = decode(payload);
  return event.type === "snapshot" ? body(event) : applySessionPatches(snapshot, event.patches as unknown as SessionPatch[]);
}

test("one megabyte history sends tiny append patches and no-op snapshots send nothing", () => {
  const response = new FakeResponse();
  const client = createSseClient(response, () => assert.fail("unexpected SSE error"));
  const snapshot = { type: "snapshot", sessionId: "large", revision: 88, history: [{ text: "x".repeat(1024 * 1024) }] };
  sendSseEvent(client, snapshot);
  let reconstructed = body(decode(response.writes[0]));
  assert.equal(decode(response.writes[0]).revision, 1);
  assert.equal(client.snapshotBaseline?.revision, undefined);
  for (let i = 0; i < 5; i++) {
    snapshot.history[0].text += "token";
    sendSseEvent(client, snapshot);
    const payload = response.writes.at(-1)!;
    assert.ok(payload.length < 250, `Patch was ${payload.length} bytes`);
    assert.deepEqual(decode(payload).patches, [{ op: "append", path: ["history", 0, "text"], value: "token" }]);
    assert.equal(decode(payload).baseRevision, i + 1);
    reconstructed = reconstruct(reconstructed, payload);
    assert.deepEqual(reconstructed, body(snapshot));
  }
  sendSseEvent(client, { ...snapshot, revision: 99, omitted: undefined });
  assert.equal(response.writes.length, 6);
  assert.equal(client.snapshotRevision, 6);
});

test("backpressure diffs latest detached target against bytes actually written", () => {
  const response = new FakeResponse();
  response.acceptWrites = false;
  const client = createSseClient(response, () => assert.fail("unexpected SSE error"));
  const snapshot = { type: "snapshot", sessionId: "one", history: [{ text: "a", status: "running" }] };
  sendSseEvent(client, snapshot);
  snapshot.history[0].text = "ab";
  sendSseEvent(client, snapshot);
  snapshot.history[0].text = "abc";
  snapshot.history[0].status = "done";
  sendSseEvent(client, snapshot);
  snapshot.history[0].text = "mutated after enqueue";
  response.acceptWrites = true;
  response.emit("drain");
  assert.equal(response.writes.length, 2);
  assert.equal(decode(response.writes[1]).baseRevision, 1);
  assert.equal(decode(response.writes[1]).revision, 2);
  assert.deepEqual(reconstruct(body(decode(response.writes[0])), response.writes[1]), {
    type: "snapshot", sessionId: "one", history: [{ text: "abc", status: "done" }],
  });
  assert.equal((client.snapshotBaseline!.history as { text: string }[])[0].text, "abc");
  closeSseClient(client);
  assert.equal(client.snapshotBaseline, undefined);
});

test("write failures close and release snapshot references", () => {
  const response = new FakeResponse();
  let errors = 0;
  const client = createSseClient(response, () => errors++);
  sendSseEvent(client, { type: "snapshot", sessionId: "one", value: 1 });
  response.write = () => { throw new Error("closed socket"); };
  sendSseEvent(client, { type: "snapshot", sessionId: "one", value: 2 });
  assert.equal(errors, 1);
  assert.equal(client.closed, true);
  assert.equal(client.snapshotBaseline, undefined);
  assert.equal(client.pendingEvents.size, 0);
});
