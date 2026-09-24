import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { builtinCommandError, parseSlashCommand, unsupportedSlashCommands, webSlashCommands } from "../web/slash-commands.js";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const execute = app.slice(app.indexOf("async function selectModelFromCommand("), app.indexOf("async function sendDraft("));

test("every installed Pi built-in command has an explicit Web policy", async () => {
  const source = await readFile(new URL("./core/slash-commands.js", import.meta.resolve("@earendil-works/pi-coding-agent")), "utf8");
  const names = [...source.matchAll(/name: "([^"]+)"/g)].map((match) => match[1]);
  assert.ok(names.length >= 23);
  for (const name of [...names, "debug", "arminsayshi", "dementedelves"]) {
    assert.ok(builtinCommandError(name), `Missing command policy: /${name}`);
  }
  assert.equal(builtinCommandError("my-extension"), null);
  assert.equal(builtinCommandError("toString"), null);
  assert.deepEqual(parseSlashCommand("  /compact\n保留代码  "), { name: "compact", args: "保留代码" });
});

function harness(draft: string, pendingRequest?: Promise<unknown>) {
  const state = {
    currentSessionId: "session", currentWorkspaceId: "ws", draft,
    snapshots: new Map<string, any>(), newSessionSnapshot: null,
    drafts: new Map(), search: "", searchOpen: false, sidebarCollapsed: true, mobileSidebarOpen: false,
  };
  const snap = {
    models: [{ provider: "test", id: "model-a" }, { provider: "other", id: "model-a" }, { provider: "test", id: "model-b" }],
    state: { model: { provider: "test", id: "model-a" }, thinkingLevel: "off" },
    thinkingLevels: ["off", "high"],
    thinkingLevelsByModel: { "test/model-b": ["off", "high"] },
    session: { title: "original" }, messages: [],
  };
  state.snapshots.set("session", snap);
  const calls: { path: string; body: any }[] = [];
  const notices: string[] = [];
  const search = { value: "", focused: false, dispatchEvent() {}, focus() { this.focused = true; } };
  let failure = false;
  let modelSelector = 0;
  const context = createContext({
    S: state, WEB_SLASH_COMMANDS: webSlashCommands, unsupportedSlashCommands, parseSlashCommand,
    currentSnapshot: () => state.snapshots.get(state.currentSessionId),
    snapshotFor: (id: string) => state.snapshots.get(id),
    currentWorkspace: () => ({ id: "ws" }),
    draftKey: () => `session:${state.currentSessionId}`,
    setDraftValue: (value: string) => { state.draft = value; state.drafts.set(`session:${state.currentSessionId}`, value); },
    syncComposerInput() {},
    clearComposerDraft: () => { state.draft = ""; state.drafts.delete(`session:${state.currentSessionId}`); },
    post: async (path: string, body: any) => {
      calls.push({ path, body });
      if (failure) throw new Error("fixture failure");
      if (pendingRequest) await pendingRequest;
      if (path.endsWith("/refresh")) return state.snapshots.get("session");
      return { ok: true };
    },
    refreshModelCatalog: async () => {},
    openModelSelector: async () => { modelSelector++; },
    showToast: (value: string) => notices.push(value),
    queueRender() {}, renderApp() {},
    $: () => search, Event: class {},
  });
  runInContext(execute, context);
  return { state, calls, notices, search, modelSelector: () => modelSelector, fail: () => { failure = true; }, run: (text = draft) => runInContext(`executeLocalSlashCommand(${JSON.stringify(text)})`, context) };
}

test("unsupported commands and unexpected arguments preserve drafts without sending prompts", async () => {
  for (const name of Object.keys(unsupportedSlashCommands)) {
    const view = harness(`/${name}`);
    await assert.rejects(view.run());
    assert.equal(view.state.draft, `/${name}`);
    assert.deepEqual(view.calls, []);
  }
  for (const command of webSlashCommands.filter((command) => !command.acceptsArgs)) {
    const view = harness(`/${command.name} ignored`);
    await assert.rejects(view.run(), /不接受参数/);
    assert.equal(view.state.draft, `/${command.name} ignored`);
    assert.deepEqual(view.calls, []);
  }
});

test("compact forwards custom instructions and restores a failed draft", async () => {
  const view = harness("/compact 保留接口签名\n以及测试结果");
  assert.equal(await view.run(), true);
  assert.equal(view.calls[0].path, "/api/sessions/session/compact");
  assert.equal(view.calls[0].body.customInstructions, "保留接口签名\n以及测试结果");
  assert.equal(view.state.draft, "");
  const failed = harness("/compact keep tests");
  failed.fail();
  await assert.rejects(failed.run(), /fixture failure/);
  assert.equal(failed.state.draft, "/compact keep tests");
});

test("compact clears immediately and preserves text entered while the request is pending", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const view = harness("/compact keep tests", pending);
  const sending = view.run();
  assert.equal(view.calls.length, 1);
  assert.equal(view.state.draft, "");
  view.state.draft = "/compact keep tests";
  finish();
  assert.equal(await sending, true);
  assert.equal(view.state.draft, "/compact keep tests");
});

test("failed compaction preserves new input and restores the command to its original session", async () => {
  for (const switchSession of [false, true]) {
    let fail!: (error: Error) => void;
    const pending = new Promise<void>((_, reject) => { fail = reject; });
    const view = harness("/compact keep tests", pending);
    const sending = view.run();
    if (switchSession) view.state.currentSessionId = "other";
    view.state.draft = "new input";
    view.state.drafts.set(`session:${view.state.currentSessionId}`, "new input");
    fail(new Error("fixture failure"));
    await assert.rejects(sending, /fixture failure/);
    assert.equal(view.state.draft, "new input");
    assert.equal(view.state.drafts.get("session:session"), switchSession ? "/compact keep tests" : "new input");
  }
});

test("model selects an exact provider reference and opens search for ambiguous references", async () => {
  const view = harness("/model test/model-b");
  await view.run();
  assert.equal(view.calls[0].path, "/api/sessions/session/set_model");
  assert.equal(view.calls[0].body.modelId, "model-b");
  assert.equal(view.state.snapshots.get("session").state.model.id, "model-b");
  const ambiguous = harness("/model model-a");
  await ambiguous.run();
  assert.equal(ambiguous.modelSelector(), 1);
  assert.equal(ambiguous.search.value, "model-a");
  assert.deepEqual(ambiguous.calls, []);
});

test("thinking validates arguments before setting the level", async () => {
  const view = harness("/thinking HIGH");
  await view.run();
  assert.equal(view.calls[1].path, "/api/sessions/session/set_thinking_level");
  assert.equal(view.calls[1].body.level, "high");
  const invalid = harness("/thinking typo");
  await assert.rejects(invalid.run(), /不支持思考强度/);
  assert.equal(invalid.calls.length, 1);
  assert.equal(invalid.state.draft, "/thinking typo");
});

test("resume opens the session search and name without arguments displays the current name", async () => {
  const view = harness("/resume");
  await view.run();
  assert.equal(view.state.searchOpen, true);
  assert.equal(view.state.sidebarCollapsed, false);
  assert.equal(view.search.focused, true);
  const name = harness("/name");
  await name.run();
  assert.match(name.notices[0], /original/);
  assert.deepEqual(name.calls, []);
});

test("extension, prompt template and skill commands remain available to RPC", async () => {
  for (const command of ["/custom args", "/template args", "/skill:pdf args"]) {
    const view = harness(command);
    assert.equal(await view.run(), false);
    assert.equal(view.state.draft, command);
  }
});
