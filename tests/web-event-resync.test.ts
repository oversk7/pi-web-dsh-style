import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const resync = app.slice(app.indexOf("async function resyncAfterReconnect()"), app.indexOf("function connectEvents()"));

test("reconnect requests have timeouts and preserve a newer streamed snapshot", async () => {
  const original = { messages: ["old"] };
  const streamed = { messages: ["latest"] };
  const S = { currentSessionId: "one", openGeneration: 1, snapshots: new Map([["one", original]]) };
  const calls: string[] = [];
  const deadlines: number[] = [];
  const context = createContext({
    S, networkSettings: {}, terminalProxySettings: {},
    AbortSignal: { timeout: (ms: number) => { deadlines.push(ms); return "signal"; } },
    applySavedWorkspaceOrder: (workspaces: unknown) => workspaces,
    queueRender() {}, showToast() {},
    api: async (path: string, options: any) => {
      calls.push(path);
      assert.equal(options.signal, "signal");
      if (path === "/api/bootstrap") return { workspaces: [{ sessions: [{ id: "one" }] }] };
      assert.equal(options.method, "POST");
      S.snapshots.set("one", streamed);
      return original;
    },
  });
  runInContext(`let resyncPending; ${resync}`, context);
  await runInContext("resyncAfterReconnect()", context);
  assert.deepEqual(calls, ["/api/bootstrap", "/api/sessions/one/open"]);
  assert.deepEqual(deadlines, [15_000, 15_000]);
  assert.equal(S.snapshots.get("one"), streamed);
});

test("a failed reconnect request releases the pending resync for retry", async () => {
  let attempts = 0;
  const context = createContext({
    AbortSignal, api: async () => { attempts++; throw new Error("timeout"); },
  });
  runInContext(`let resyncPending; ${resync}`, context);
  await runInContext("resyncAfterReconnect()", context);
  await runInContext("resyncAfterReconnect()", context);
  assert.equal(attempts, 2);
});
