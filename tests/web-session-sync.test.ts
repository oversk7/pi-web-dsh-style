import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { applySessionPatches, diffSessionSnapshots } from "../web/session-sync.js";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const helpers = app.slice(app.indexOf("function disconnectEvents()"), app.indexOf("async function resyncAfterReconnect()"));
const connect = app.slice(app.indexOf("function connectEvents("), app.indexOf('window.addEventListener("resize"'));
const visibility = app.slice(app.indexOf('document.addEventListener("visibilitychange"'), app.indexOf("setLanguage(getLanguage());"));
const login = app.slice(app.indexOf("function requireLogin()"), app.indexOf("let eventSource;"));

function fixture() {
  const streams: any[] = [];
  const listeners: Record<string, () => void> = {};
  const state = { currentSessionId: "one" as string | null, loadingSession: null as string | null, snapshots: new Map<string, any>() };
  let resyncs = 0;
  let renders = 0;
  const document = { hidden: false, addEventListener: (type: string, listener: () => void) => { listeners[type] = listener; } };
  const context = createContext({
    S: state, document, Date, applySessionPatches,
    EventSource: class {
      closed = false;
      url: string;
      constructor(url: string) { this.url = url; streams.push(this); }
      close() { this.closed = true; }
    },
    setInterval() { return 1; }, clearInterval() {},
    snapshotFor: (id: string) => state.snapshots.get(id) || {},
    queueRender: () => { renders++; },
    resyncAfterReconnect: () => { resyncs++; },
  });
  runInContext(`let eventSource, eventWatchdog, lastEventAt, loginPromise; ${helpers}\n${connect}\n${visibility}\nconnectEvents();`, context);
  const emit = (stream: any, event: unknown) => stream.onmessage({ data: JSON.stringify(event) });
  return { state, document, streams, listeners, context, emit, resyncs: () => resyncs, renders: () => renders };
}

const snapshot = (sessionId = "one", text = "hello") => ({
  type: "snapshot", sessionId, messages: [{ kind: "assistant", blocks: [{ type: "text", text }] }], state: { isStreaming: true },
});

test("the browser reconstructs patches from its stream baseline even after an HTTP response updates the cache", () => {
  const view = fixture();
  const stream = view.streams[0];
  stream.onopen();
  const first = snapshot();
  view.emit(stream, { ...first, revision: 1 });
  view.state.snapshots.set("one", { messages: ["HTTP response"] });
  const next = snapshot("one", "hello world");
  view.emit(stream, { type: "session_patch", sessionId: "one", baseRevision: 1, revision: 2, patches: diffSessionSnapshots(first, next) });
  assert.deepEqual(JSON.parse(JSON.stringify(view.state.snapshots.get("one"))), next);
  assert.equal(view.streams.length, 1);
  assert.equal(view.resyncs(), 1);
});

test("a stream snapshot clears an earlier request error while preserving first-open loading", () => {
  const view = fixture();
  view.state.loadingSession = "one";
  view.state.snapshots.set("one", { error: "earlier failure" });
  view.emit(view.streams[0], { ...snapshot(), session: { id: "one" }, revision: 1 });
  assert.equal(view.state.loadingSession, "one");
  assert.equal(view.state.snapshots.get("one").error, undefined);
  assert.equal(view.renders(), 1);
});

test("a missing revision or invalid patch replaces the connection and requests a fresh stream snapshot", () => {
  const view = fixture();
  view.emit(view.streams[0], { ...snapshot(), revision: 1 });
  view.emit(view.streams[0], { type: "session_patch", sessionId: "one", baseRevision: 2, revision: 3, patches: [] });
  assert.equal(view.streams[0].closed, true);
  assert.equal(view.streams.length, 2);
  assert.equal(view.streams[1].url, "/api/events?sessionId=one");
  view.streams[1].onopen();
  assert.equal(view.resyncs(), 0, "repair uses the SSE snapshot without opening the session again");
  view.emit(view.streams[1], { ...snapshot(), revision: 1 });
  view.emit(view.streams[1], { type: "session_patch", sessionId: "one", baseRevision: 1, revision: 2, patches: [{ op: "invalid", path: [] }] });
  assert.equal(view.streams.length, 3);
});

test("switching sessions changes only this browser's subscription and rejects late events from its old stream", () => {
  const view = fixture();
  view.state.currentSessionId = "two / next";
  runInContext("syncEventSubscription()", view.context);
  assert.equal(view.streams[0].closed, true);
  assert.equal(view.streams[1].url, "/api/events?sessionId=two%20%2F%20next");
  view.streams[1].onopen();
  view.emit(view.streams[0], { ...snapshot(), revision: 1 });
  view.streams[0].onerror();
  assert.equal(view.state.snapshots.has("one"), false);
  assert.equal(view.resyncs(), 0);
  view.emit(view.streams[1], { ...snapshot("two / next"), revision: 1 });
  assert.equal(view.state.snapshots.has("two / next"), true);
  view.state.currentSessionId = null;
  runInContext("syncEventSubscription()", view.context);
  assert.equal(view.streams[2].url, "/api/events");
});

test("native reconnects refresh workspace metadata even when the first subscription skipped HTTP resync", () => {
  const view = fixture();
  view.state.currentSessionId = "two";
  runInContext("syncEventSubscription()", view.context);
  const stream = view.streams[1];
  stream.onopen();
  assert.equal(view.resyncs(), 0);
  view.emit(stream, { ...snapshot("two"), revision: 1 });
  stream.onopen();
  assert.equal(view.resyncs(), 1);
  view.emit(stream, { ...snapshot("two", "after reconnect"), revision: 1 });
  assert.equal(view.state.snapshots.get("two").messages[0].blocks[0].text, "after reconnect");
});

for (const hiddenAtLogin of [false, true]) test(`signing in resumes streaming after the login guard clears (hidden at login: ${hiddenAtLogin})`, async () => {
  const view = fixture();
  const form: any = {};
  const input = { value: "password", focus() {} };
  const button = { disabled: false };
  const root = { inert: false };
  let mounted!: () => void;
  const ready = new Promise<void>((resolve) => { mounted = resolve; });
  Object.assign(view.document, { body: { appendChild() { mounted(); } } });
  Object.assign(view.context, {
    api: async () => ({ passwordConfigured: true }), post: async () => ({}),
    el: () => ({ remove() {} }),
    $: (selector: string) => ({ "#root": root, form, input, button, ".pi-loginMessage": {} } as Record<string, unknown>)[selector],
  });
  runInContext(login, view.context);
  if (hiddenAtLogin) {
    view.document.hidden = true;
    view.listeners.visibilitychange();
  }
  const signedIn = runInContext("requireLogin()", view.context);
  await ready;
  if (hiddenAtLogin) {
    view.document.hidden = false;
    view.listeners.visibilitychange();
    assert.equal(view.streams.length, 1, "visibility must wait for successful authentication");
  }
  assert.equal(view.streams[0].closed, true);
  await form.onsubmit({ preventDefault() {} });
  await signedIn;
  assert.equal(view.streams.length, 2);
  assert.equal(root.inert, false);
  view.streams[1].onopen();
  assert.equal(view.resyncs(), 1);
});

test("hidden pages close their event stream and reopen with a fresh baseline when visible", () => {
  const view = fixture();
  view.document.hidden = true;
  view.listeners.visibilitychange();
  assert.equal(view.streams[0].closed, true);
  const renders = view.renders();
  view.emit(view.streams[0], { ...snapshot(), revision: 1 });
  assert.equal(view.renders(), renders);
  runInContext("connectEvents()", view.context);
  assert.equal(view.streams.length, 1);
  view.document.hidden = false;
  view.listeners.visibilitychange();
  assert.equal(view.streams.length, 2);
  view.streams[1].onopen();
  assert.equal(view.resyncs(), 1);
  view.emit(view.streams[1], { ...snapshot("one", "finished while hidden"), revision: 1 });
  assert.equal(view.state.snapshots.get("one").messages[0].blocks[0].text, "finished while hidden");
});
