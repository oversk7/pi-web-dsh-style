import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const composerSource = app.slice(app.indexOf("function syncComposerInput("), app.indexOf("function restoreDraft("));

for (const touch of [false, true]) {
  test(`Enter ${touch ? "inserts a newline on phones" : "sends on desktop"} and respects IME`, () => {
    const listeners: Record<string, (event: unknown) => void> = {};
    const input = { dataset: {}, value: "draft", closest: () => null, addEventListener: (name: string, listener: (event: unknown) => void) => { listeners[name] = listener; } };
    let sent = 0;
    let prevented = 0;
    runInNewContext(`${composerSource}\nbindComposerInput()`, {
      $: () => input, S: { draft: "draft", commandMenuOpen: false }, usesTouchInput: () => touch,
      sendDraft: () => { sent += 1; },
    });
    const enter = { key: "Enter", preventDefault: () => { prevented += 1; } };
    listeners.keydown({ ...enter, isComposing: true });
    listeners.keydown({ ...enter, keyCode: 229 });
    listeners.keydown({ ...enter, shiftKey: true });
    assert.equal(sent, 0);
    listeners.keydown(enter);
    assert.equal(sent, touch ? 0 : 1);
    assert.equal(prevented, touch ? 0 : 1);
    listeners.keydown({ ...enter, ctrlKey: true });
    assert.equal(sent, touch ? 1 : 2);
  });
}

const resyncSource = app.slice(app.indexOf("let eventSource;"), app.indexOf("function connectEvents("));
test("reconnection refreshes content without adopting another client's selection or replacing a newer SSE snapshot", async () => {
  const before = { messages: ["old"] };
  const newest = { messages: ["streaming update"] };
  const state = { snapshots: new Map([["phone", before]]), workspaces: [], currentSessionId: "phone", draft: "unsent phone draft", openGeneration: 1 };
  let opens = 0;
  let networkRefreshes = 0;
  await runInNewContext(`${resyncSource}\nresyncAfterReconnect()`, {
    S: state,
    AbortSignal,
    networkSettings: { data: {} },
    terminalProxySettings: { data: null },
    loadNetworkSettings: async () => { networkRefreshes += 1; },
    api: async (path: string, options: RequestInit) => {
      assert.ok(options.signal);
      if (path === "/api/bootstrap") return { currentSessionId: "desktop", workspaces: [{ id: "ws", sessions: [{ id: "phone" }, { id: "desktop" }] }] };
      assert.equal(path, "/api/sessions/phone/open");
      assert.equal(options.method, "POST");
      opens += 1;
      state.snapshots.set("phone", newest);
      return before;
    },
    applySavedWorkspaceOrder: (value: unknown) => value,
    queueRender() {},
  });
  assert.equal(opens, 1);
  assert.equal(networkRefreshes, 1);
  assert.equal(state.currentSessionId, "phone");
  assert.equal(state.draft, "unsent phone draft");
  assert.equal(state.snapshots.get("phone"), newest);
});
