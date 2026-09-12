import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { closeSseClient, createSseClient, sendSseEvent } from "../sse-channel.ts";

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
