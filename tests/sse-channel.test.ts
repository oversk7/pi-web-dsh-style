import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { closeSseClient, createSseClient, createSnapshotScheduler, sendSseEvent } from "../sse-channel.ts";

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

  sendSseEvent(client, { type: "snapshot", sessionId: "one", revision: 1 });
  sendSseEvent(client, { type: "snapshot", sessionId: "one", revision: 2 });
  sendSseEvent(client, { type: "snapshot", sessionId: "one", revision: 3 });

  assert.equal(response.writes.length, 1);
  assert.equal(client.pendingEvents.size, 1);

  response.acceptWrites = true;
  response.emit("drain");

  assert.equal(response.writes.length, 2);
  assert.match(response.writes[1], /"revision":3/);
  assert.equal(client.pendingEvents.size, 0);
});

test("SSE backpressure retains the latest event of each kind", () => {
  const response = new FakeResponse();
  response.acceptWrites = false;
  const client = createSseClient(response, () => assert.fail("unexpected SSE error"));

  sendSseEvent(client, { type: "heartbeat", at: 1 });
  sendSseEvent(client, { type: "snapshot", sessionId: "one", revision: 1 });
  sendSseEvent(client, { type: "workspaces", revision: 2 });
  sendSseEvent(client, { type: "snapshot", sessionId: "one", revision: 3 });

  assert.equal(client.pendingEvents.size, 2);
  response.acceptWrites = true;
  response.emit("drain");

  assert.equal(response.writes.length, 3);
  assert.match(response.writes[1], /"revision":3/);
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
});
