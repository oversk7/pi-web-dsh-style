import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const source = await readFile(new URL("../server.ts", import.meta.url), "utf8");
const opening = stripTypeScriptTypes(source.slice(source.indexOf("function refreshOpenedSession("), source.indexOf("async function stopSessionProcess(")));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(overrides: Record<string, unknown> = {}) {
  const record: any = {
    id: "one", workspaceId: "ws", cwd: "workspace", sessionFile: "one.jsonl",
    proc: {}, status: "idle", state: { isStreaming: false }, messages: ["cached"],
    models: ["model"], streaming: false, needsAttention: true, lastUsed: 0,
    ...overrides,
  };
  const state: any = { workspaces: [{ id: "ws" }], sessions: [] };
  const blocked = deferred();
  const calls = { states: 0, messages: 0, stats: 0, snapshots: 0, workspaces: 0, saves: 0, disk: 0 };
  const errors: unknown[] = [];
  const context = createContext({
    state, Date, console: { error: (...args: unknown[]) => errors.push(args) },
    applyCachedCommands() {}, applyCachedModelInfo() {}, evictIdleProcesses() {},
    setSessionNeedsAttention: (session: any, attention: boolean) => { session.needsAttention = attention; },
    scheduleSave: () => { calls.saves++; },
    broadcastWorkspaces: () => { calls.workspaces++; },
    broadcastSessionSnapshot: () => { calls.snapshots++; },
    existsSync: () => true,
    loadLocalSession: () => { calls.disk++; return { messages: [`disk ${calls.disk}`], state: { isStreaming: false }, title: "Disk session" }; },
    refreshState: () => { calls.states++; return blocked.promise; },
    refreshMessages: () => { calls.messages++; return blocked.promise; },
    refreshModels: async () => {},
    refreshStats: async () => { calls.stats++; },
    ensureProcess: async () => { throw new Error("Unexpected process startup"); },
    record,
  });
  runInContext(opening, context);
  return { record, state, calls, blocked, context, errors, open: () => runInContext("openSessionRecord(record)", context) };
}

test("opening a live cached session returns immediately and coalesces blocked background RPC refreshes", { timeout: 1000 }, async () => {
  const h = fixture();
  await h.open();
  assert.equal(h.calls.states, 1);
  assert.equal(h.calls.messages, 1);
  assert.ok(h.record.openRefresh);
  const refresh = h.record.openRefresh;
  await h.open();
  await h.open();
  assert.equal(h.record.openRefresh, refresh);
  assert.equal(h.calls.states, 1);
  assert.equal(h.calls.messages, 1);
  assert.deepEqual(h.record.messages, ["cached"]);
  assert.equal(h.record.needsAttention, false);
  assert.equal(h.state.currentSessionId, "one");
  assert.equal(h.state.currentWorkspaceId, "ws");
  assert.ok(h.record.lastUsed > 0);
  assert.equal(h.calls.saves, 3);
  assert.equal(h.calls.workspaces, 3);
  assert.equal(h.calls.snapshots, 3);
  h.blocked.resolve();
  await refresh;
  assert.equal(h.calls.stats, 1);
  assert.equal(h.calls.snapshots, 4);
  assert.equal(h.record.openRefresh, undefined);
  await h.open();
  assert.equal(h.calls.states, 2, "a completed refresh allows future synchronization");
  await h.record.openRefresh;
});

for (const mode of ["streaming", "starting"]) test(`opening a ${mode} session uses live events without issuing more RPC reads`, async () => {
  const h = fixture(mode === "streaming" ? { streaming: true, status: "running" } : { starting: Promise.resolve(), status: "starting" });
  await h.open();
  assert.equal(h.calls.states, 0);
  assert.equal(h.calls.messages, 0);
  assert.equal(h.record.openRefresh, undefined);
  assert.equal(h.calls.snapshots, 1);
});

test("sessions without a live process still reload disk to discover external changes", async () => {
  const h = fixture({ proc: undefined, status: "stopped" });
  await h.open();
  assert.deepEqual(h.record.messages, ["disk 1"]);
  await h.open();
  assert.deepEqual(h.record.messages, ["disk 2"]);
  assert.equal(h.calls.disk, 2);
  assert.equal(h.calls.states, 0);
});

test("a failed background refresh releases its slot and preserves the cached conversation", async () => {
  const h = fixture();
  h.context.refreshStats = async () => { throw new Error("stats failed"); };
  await h.open();
  const refresh = h.record.openRefresh;
  h.blocked.resolve();
  await refresh;
  assert.equal(h.record.openRefresh, undefined);
  assert.deepEqual(h.record.messages, ["cached"]);
  assert.equal(h.errors.length, 1);
  await h.open();
  assert.equal(h.calls.states, 2);
  await h.record.openRefresh;
});
