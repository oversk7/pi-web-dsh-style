import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const navigation = app.slice(app.indexOf("async function openSession("), app.indexOf("async function ensureWorkspaceThen("));
const drafts = app.slice(app.indexOf("function draftKey("), app.indexOf("function loadCurrentDraftValue("));

function harness(post: (path: string, body?: any) => Promise<any>) {
  const state = {
    currentSessionId: "previous" as string | null, currentWorkspaceId: "ws",
    newSessionPreferenceWorkspaceId: null as string | null,
    newSessionSnapshot: { state: { model: { provider: "test", id: "selected" }, thinkingLevel: "high" } },
    snapshots: new Map<string, any>(), draft: "old draft", draftAttachments: [{ id: "attachment" }],
    drafts: new Map<string, string>(), attachmentDrafts: new Map<string, any[]>(),
    failedDrafts: new Map(), failedAttachmentDrafts: new Map(),
    openGeneration: 0, historyGeneration: 0, pendingCreation: null as any,
    loadingSession: null as string | null, conversationTab: "history", historyView: { id: "history" },
  };
  const renders: any[] = [];
  const alerts: string[] = [];
  const storage = new Map<string, string>();
  const context = createContext({
    S: state, post,
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
