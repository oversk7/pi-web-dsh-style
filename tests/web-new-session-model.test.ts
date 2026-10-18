import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const navigation = app.slice(app.indexOf("async function openSession("), app.indexOf("async function ensureWorkspaceThen("));
const drafts = app.slice(app.indexOf("function draftKey("), app.indexOf("function loadCurrentDraftValue("));

function harness(post: (path: string, body?: any, options?: any) => Promise<any>) {
  const state = {
    currentSessionId: "previous" as string | null, currentWorkspaceId: "ws",
    newSessionPreferenceWorkspaceId: null as string | null,
    newSessionSnapshot: { state: { model: { provider: "test", id: "selected" }, thinkingLevel: "high" } },
    snapshots: new Map<string, any>(), loadedSessions: new Set<string>(), sessionOpens: new Map<string, any>(),
    draft: "old draft", draftAttachments: [{ id: "attachment" }],
    drafts: new Map<string, string>(), attachmentDrafts: new Map<string, any[]>(),
    failedDrafts: new Map(), failedAttachmentDrafts: new Map(),
    openGeneration: 0, historyGeneration: 0, pendingCreation: null as any,
    loadingSession: null as string | null, conversationTab: "history", historyView: { id: "history" },
  };
  const renders: any[] = [];
  const alerts: string[] = [];
  const storage = new Map<string, string>();
  const context = createContext({
    S: state, post, AbortSignal, t: (text: string) => text,
    $() { return null; },
    closeMobileSidebar() {}, closeCommandMenu() {}, renderSidebar() {}, queueRender() {},
    renderConversation() { renders.push({ id: state.currentSessionId, draft: state.draft, pending: !!state.pendingCreation, tab: state.conversationTab }); },
    sessionStorage: { setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    snapshotFor: (id: string) => state.snapshots.get(id) || {},
    alert: (message: string) => alerts.push(message),
  });
  runInContext(drafts + navigation, context);
  return { state, renders, alerts, storage, context,
    create: (workspace = "ws", keepDraft = false): Promise<any> => runInContext(`createAndOpenSession(${JSON.stringify(workspace)}, "", { keepDraft: ${keepDraft} })`, context),
    open: (id: string): Promise<any> => runInContext(`openSession(${JSON.stringify(id)})`, context),
  };
}
function deferred() {
  let resolve!: (value: any) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const snapshot = (id: string) => ({ session: { id, workspaceId: "ws" }, state: { model: { id: "actual" }, thinkingLevel: "off" } });

test("opening a session preserves a newer streamed snapshot while its HTTP request is pending", async () => {
  const pending = deferred();
  const h = harness(async () => pending.promise);
  const opening = h.open("selected");
  const newer = { ...snapshot("selected"), messages: ["new streamed reply"] };
  h.state.snapshots.set("selected", newer);
  pending.resolve({ ...snapshot("selected"), messages: ["older HTTP reply"] });
  await opening;
  assert.equal(h.state.snapshots.get("selected"), newer);
  assert.equal(h.state.loadingSession, null);
});

test("returning to a loaded session displays its cache and restores its workspace while refreshing", async () => {
  const pending = deferred();
  let calls = 0;
  const h = harness(async () => ++calls === 3 ? pending.promise : snapshot(calls === 1 ? "one" : "two"));
  await h.open("one");
  await h.open("two");
  h.state.currentWorkspaceId = "other";
  const returning = h.open("one");
  assert.equal(h.state.currentSessionId, "one");
  assert.equal(h.state.currentWorkspaceId, "ws");
  assert.equal(h.state.loadingSession, null);
  assert.equal(h.state.snapshots.get("one").session.id, "one");
  pending.resolve(snapshot("one"));
  await returning;
});

test("returning to a newly created session keeps its content available even if refresh fails", async () => {
  const pending = deferred();
  const h = harness(async (path) => path.endsWith("/sessions") ? snapshot("created") : path.includes("/other/") ? snapshot("other") : pending.promise);
  await h.create();
  const cached = h.state.snapshots.get("created");
  await h.open("other");
  const returning = h.open("created");
  assert.equal(h.state.loadingSession, null);
  pending.reject(new Error("refresh timeout"));
  await returning;
  assert.equal(h.state.snapshots.get("created"), cached);
  assert.equal(h.state.sessionOpens.size, 0);
});

test("rapid navigation shares the pending open request for each session", async () => {
  const pending = deferred();
  const paths: string[] = [];
  const h = harness(async (path) => {
    paths.push(path);
    return path.includes("/one/") ? pending.promise : snapshot("two");
  });
  const first = h.open("one");
  await h.open("two");
  const returning = h.open("one");
  assert.deepEqual(paths, ["/api/sessions/one/open", "/api/sessions/two/open"]);
  assert.equal(h.state.loadingSession, "one");
  pending.resolve(snapshot("one"));
  await Promise.all([first, returning]);
  assert.equal(h.state.currentSessionId, "one");
  assert.equal(h.state.snapshots.get("one").session.id, "one");
  assert.equal(h.state.loadingSession, null);
  assert.equal(h.state.sessionOpens.size, 0);
});

test("reusing an open request after navigating back preserves the original snapshot baseline", async () => {
  const pending = deferred();
  const h = harness(async (path) => path.includes("/one/") ? pending.promise : snapshot("two"));
  const first = h.open("one");
  const streamed = { ...snapshot("one"), messages: ["new streamed reply"] };
  h.state.snapshots.set("one", streamed);
  await h.open("two");
  const returning = h.open("one");
  pending.resolve({ ...snapshot("one"), messages: ["older HTTP reply"] });
  await Promise.all([first, returning]);
  assert.equal(h.state.snapshots.get("one"), streamed);
  assert.equal(h.state.loadingSession, null);
});

test("an initial empty stream snapshot does not count as a loaded session", async () => {
  const pending = deferred();
  const h = harness(async () => pending.promise);
  h.state.snapshots.set("one", { session: { id: "one", workspaceId: "ws" }, state: null, messages: [] });
  const opening = h.open("one");
  assert.equal(h.state.loadingSession, "one");
  assert.equal(h.state.loadedSessions.has("one"), false);
  pending.resolve(snapshot("one"));
  await opening;
  assert.equal(h.state.loadedSessions.has("one"), true);
  assert.equal(h.state.loadingSession, null);
});

test("a failed open cannot overwrite a newer streamed snapshot", async () => {
  const pending = deferred();
  const h = harness(async () => pending.promise);
  const opening = h.open("one");
  const streamed = snapshot("one");
  h.state.snapshots.set("one", streamed);
  pending.reject(new Error("late failure"));
  await opening;
  assert.equal(h.state.snapshots.get("one"), streamed);
  assert.equal(h.state.loadingSession, null);
});

test("opening requests have a deadline and a failed request can be retried", async () => {
  let attempts = 0;
  const h = harness(async (_path, _body, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    if (++attempts === 1) throw new Error("timeout");
    return snapshot("one");
  });
  const deadlines: number[] = [];
  h.context.AbortSignal = { timeout: (ms: number) => { deadlines.push(ms); return AbortSignal.timeout(ms); } };
  await h.open("one");
  assert.equal(h.state.loadingSession, null);
  assert.equal(h.state.sessionOpens.size, 0);
  await h.open("one");
  assert.equal(h.state.snapshots.get("one").error, undefined);
  assert.equal(attempts, 2);
  assert.deepEqual(deadlines, [15_000, 15_000]);
});

test("new session inherits only choices made in the empty composer for its workspace", async () => {
  const calls: any[] = [];
  const h = harness(async (_path, body) => { calls.push(body); return snapshot(`new-${calls.length}`); });
  await h.create();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), { title: "" });
  h.state.currentSessionId = null;
  h.state.newSessionPreferenceWorkspaceId = "ws";
  await h.create();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), {
    title: "", model: { provider: "test", modelId: "selected" }, thinkingLevel: "high",
  });
  assert.equal(h.state.newSessionPreferenceWorkspaceId, null);
  h.state.currentSessionId = null;
  h.state.newSessionPreferenceWorkspaceId = "other";
  await h.create();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[2])), { title: "" });
});

test("creation renders an empty pending view before POST settles, blocks duplicates, and reuses its response", async () => {
  const pending = deferred();
  const paths: string[] = [];
  const h = harness(async (path) => {
    assert.equal(h.renders[0]?.id, null, "render precedes even issuing POST");
    paths.push(path); return pending.promise;
  });
  h.state.drafts.set("new:ws", "saved empty-composer draft");
  const creation = h.create();
  assert.deepEqual(h.renders[0], { id: null, draft: "", pending: true, tab: "conversation" });
  assert.equal(h.state.drafts.get("session:previous"), "old draft");
  assert.equal(h.state.attachmentDrafts.get("session:previous")?.[0].id, "attachment");
  assert.equal(await h.create(), null);
  // The real send entry point must also return before invoking other dependencies.
  runInContext(app.slice(app.indexOf("async function sendDraft("), app.indexOf("async function sendDraft(") + app.slice(app.indexOf("async function sendDraft(")).indexOf("\nasync function ", 1)), h.context);
  await runInContext("sendDraft()", h.context);
  assert.equal(paths.length, 1);
  const data = snapshot("created");
  pending.resolve(data);
  assert.equal(await creation, "created");
  assert.equal(h.state.snapshots.get("created"), data);
  assert.deepEqual(paths, ["/api/workspaces/ws/sessions"]);
  assert.equal(h.state.currentSessionId, "created");
  assert.equal(h.state.drafts.get("new:ws"), "saved empty-composer draft");
  assert.equal(h.state.pendingCreation, null);
});

test("typing during creation is retained when the session becomes ready", async () => {
  const pending = deferred();
  const h = harness(async () => pending.promise);
  const creation = h.create();
  runInContext('setDraftValue("提前输入的内容")', h.context);
  pending.resolve(snapshot("created"));
  await creation;
  assert.equal(h.state.draft, "提前输入的内容");
  assert.equal(h.state.drafts.get("session:created"), "提前输入的内容");
  assert.equal(h.state.loadingSession, null);
});

test("sending the first message preserves edits made while startup is pending", async () => {
  const pending = deferred();
  const sent: any[] = [];
  const started = deferred();
  const h = harness(async (path, body) => {
    if (path.endsWith("/sessions")) {
      started.resolve(null);
      return pending.promise;
    }
    sent.push(body);
    return {};
  });
  h.state.currentSessionId = null;
  h.state.draftAttachments = [];
  Object.assign(h.state, { pendingSends: new Map() });
  Object.assign(h.context, {
    executeLocalSlashCommand: async () => false,
    currentWorkspace: () => ({ id: "ws" }),
    clearComposerDraft() { h.state.draft = ""; },
  });
  runInContext(app.slice(app.indexOf("async function sendDraft("), app.indexOf("async function sendDraft(") + app.slice(app.indexOf("async function sendDraft(")).indexOf("\nasync function ", 1)), h.context);
  const sending = runInContext("sendDraft()", h.context);
  await started.promise;
  assert.ok(h.state.pendingCreation);
  runInContext('setDraftValue("new edits during startup")', h.context);
  pending.resolve(snapshot("created"));
  await sending;
  assert.equal(sent[0].message, "old draft");
  assert.equal(h.state.draft, "new edits during startup");
  assert.equal(h.state.drafts.get("session:created"), "new edits during startup");
});

test("pending composer allows typing while sending stays disabled", () => {
  const h = harness(async () => snapshot("created"));
  h.state.currentSessionId = null;
  h.state.pendingCreation = { generation: 0 };
  Object.assign(h.context, {
    currentSnapshot: () => ({}), esc: (value: string) => value,
    renderCommandMenu: () => "", renderDraftAttachments: () => "",
    modelSupportsImages: () => false, thinkingLabel: () => "off", ICONS: {},
  });
  runInContext(app.slice(app.indexOf("function renderComposerBar("), app.indexOf("function renderComposer(")), h.context);
  const html = runInContext("renderComposerBar(true)", h.context);
  assert.doesNotMatch(html.match(/<textarea[^>]*>/)[0], /disabled/);
  assert.match(html.match(/<button[^>]*data-action="send"[^>]*>/)[0], /disabled/);
});

test("failed startup retains newly typed text in the new-session draft", async () => {
  const pending = deferred();
  const h = harness(async () => pending.promise);
  const creation = h.create();
  runInContext('setDraftValue("保留输入")', h.context);
  pending.reject(new Error("startup failed"));
  await creation;
  assert.equal(h.state.draft, "old draft");
  assert.equal(h.state.drafts.get("new:ws"), "保留输入");
});

test("keepDraft carries text and attachments into the created session", async () => {
  const pending = deferred();
  const h = harness(async () => pending.promise);
  h.state.currentSessionId = null;
  const creation = h.create("ws", true);
  assert.equal(h.state.draft, "old draft");
  assert.equal(h.state.draftAttachments[0].id, "attachment");
  pending.resolve(snapshot("created"));
  await creation;
  assert.equal(h.state.drafts.get("session:created"), "old draft");
  assert.equal(h.state.attachmentDrafts.get("session:created")?.[0].id, "attachment");
});

test("late creation cannot steal navigation or replace the newly selected draft", async () => {
  const pending = deferred();
  const h = harness(async (path) => path.endsWith("/sessions") ? pending.promise : snapshot("other"));
  const creation = h.create("ws", true);
  h.state.drafts.set("session:other", "other draft");
  await h.open("other");
  pending.resolve(snapshot("created"));
  assert.equal(await creation, null);
  assert.equal(h.state.currentSessionId, "other");
  assert.equal(h.state.draft, "other draft");
  assert.equal(h.storage.get("pi-web-current-session"), "other");
  assert.equal(h.state.drafts.get("session:created"), "old draft");
});

for (const navigate of [false, true]) {
  test(`creation failure ${navigate ? "preserves later navigation" : "restores the previous view and drafts"}`, async () => {
    const pending = deferred();
    const h = harness(async (path) => path.endsWith("/sessions") ? pending.promise : snapshot("other"));
    const creation = h.create();
    if (navigate) {
      h.state.drafts.set("session:other", "other draft");
      await h.open("other");
    }
    pending.reject(new Error("probe failed"));
    assert.equal(await creation, null);
    assert.equal(h.state.currentSessionId, navigate ? "other" : "previous");
    assert.equal(h.state.draft, navigate ? "other draft" : "old draft");
    assert.equal(h.state.pendingCreation, null);
    assert.equal(h.alerts.length, navigate ? 0 : 1);
    if (!navigate) {
      assert.equal(h.state.draftAttachments[0].id, "attachment");
      assert.equal(h.state.conversationTab, "history");
      assert.equal(h.storage.get("pi-web-current-session"), "previous");
    }
  });
}
