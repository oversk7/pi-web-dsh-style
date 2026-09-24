import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const connect = app.slice(app.indexOf("function connectEvents()"), app.indexOf('window.addEventListener("resize"'));

test("silent event streams reconnect, while heartbeats and hidden pages prevent unnecessary reconnects", () => {
  let now = 0;
  let tick: () => void = () => {};
  let syncs = 0;
  const streams: any[] = [];
  const document = { hidden: false };
  class EventSource {
    closed = false;
    constructor() { streams.push(this); }
    close() { this.closed = true; }
  }
  const context = createContext({
    EventSource, document, Date: { now: () => now },
    setInterval: (callback: () => void) => { tick = callback; return 1; },
    clearInterval() {}, resyncAfterReconnect: () => { syncs++; },
  });
  runInContext(`let eventSource, eventWatchdog, lastEventAt, loginPromise; ${connect}; connectEvents();`, context);
  streams[0].onopen();
  now = 50_000;
  streams[0].onmessage({ data: '{"type":"heartbeat"}' });
  now = 100_000;
  tick();
  assert.equal(streams.length, 1);
  now = 111_000;
  document.hidden = true;
  tick();
  assert.equal(streams.length, 1);
  document.hidden = false;
  tick();
  assert.equal(streams.length, 2);
  assert.equal(streams[0].closed, true);
  streams[1].onopen();
  assert.equal(syncs, 2);
  now = 170_000;
  streams[0].onmessage({ data: '{"type":"heartbeat"}' });
  now = 172_000;
  tick();
  assert.equal(streams.length, 3, "stale callbacks cannot keep the replacement connection alive");
});
