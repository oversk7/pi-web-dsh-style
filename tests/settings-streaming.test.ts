import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const queueSource = app.slice(app.indexOf("let renderFrame ="), app.indexOf("function updateSnapshotFromEvent("));
const connectSource = app.slice(app.indexOf("function disconnectEvents()"), app.indexOf("async function resyncAfterReconnect()"))
  + app.slice(app.indexOf("function connectEvents("), app.indexOf('window.addEventListener("resize"'));

function streamingSettings() {
  let stream: any;
  let frame: (() => void) | null = null;
  let conversationRenders = 0;
  let sidebarRenders = 0;
  let panel = { input: "", scrollTop: 0, tab: "appearance" };
  const state = {
    currentSessionId: "session" as string | null, settingsOpen: false, maintenanceGeneration: 0,
    openGeneration: 1, loadingSession: null,
    maintenanceBusy: null as string | null, maintenanceMessage: null as any,
    snapshots: new Map<string, any>(), workspaces: [{ sessions: [{ id: "session" }] }],
  };
  const context = createContext({
    S: state, Date, document: { hidden: false },
    EventSource: class { constructor() { stream = this; } close() {} },
    setInterval() { return 1; }, clearInterval() {},
    requestAnimationFrame(callback: () => void) { frame = callback; return 1; },
    cancelAnimationFrame() { frame = null; },
    snapshotFor: (id: string) => state.snapshots.get(id) || {},
    applySavedWorkspaceOrder: (value: unknown) => value, resetWorkspaceDrag() {},
    rememberCurrentDraft() {}, loadCurrentDraftValue() {},
    renderConversation() { conversationRenders++; },
    renderSidebar() { sidebarRenders++; },
    renderOverlay() { panel = { input: "", scrollTop: 0, tab: "appearance" }; },
    bindGlobalEvents() {}, showToast() {},
  });
  runInContext(`let eventSource, eventWatchdog, lastEventAt, loginPromise; ${queueSource}\n${connectSource}\nqueueRender(true); connectEvents();`, context);
  state.settingsOpen = true;
  runInContext("renderOverlay()", context);
  panel.input = "unsaved form input";
  panel.scrollTop = 240;
  panel.tab = "security";
  const originalPanel = panel;
  const emit = (event: unknown) => {
    stream.onmessage({ data: JSON.stringify(event) });
    const callback = frame;
    frame = null;
    callback?.();
  };
  return { state, originalPanel, emit, panel: () => panel, conversations: () => conversationRenders, sidebars: () => sidebarRenders };
}

test("streamed snapshots update conversation without replacing open settings controls or unsaved state", () => {
  const view = streamingSettings();
  const renders = view.conversations();
  for (let chunk = 0; chunk < 30; chunk++) {
    view.emit({ type: "snapshot", sessionId: "session", messages: [`chunk ${chunk}`], state: { isStreaming: chunk < 29 } });
    assert.equal(view.panel(), view.originalPanel, "controls must survive between pointerdown and click");
  }
  assert.equal(view.panel().input, "unsaved form input");
  assert.equal(view.panel().scrollTop, 240);
  assert.equal(view.panel().tab, "security");
  assert.equal(view.conversations(), renders + 30);
  assert.deepEqual(Array.from(view.state.snapshots.get("session").messages), ["chunk 29"]);

  view.emit({ type: "snapshot", sessionId: "background", messages: ["background chunk"] });
  assert.equal(view.conversations(), renders + 30);
  assert.equal(view.panel(), view.originalPanel);
});

test("workspace updates and current-session removal preserve settings while updating the conversation", () => {
  const view = streamingSettings();
  const renders = view.conversations();
  const sidebarRenders = view.sidebars();
  view.emit({ type: "workspaces", workspaces: [{ sessions: [{ id: "session", streaming: true }] }] });
  assert.equal(view.sidebars(), sidebarRenders + 1);
  assert.equal(view.panel(), view.originalPanel);
  // Removing the last session returns the conversation to its empty state.
  // This must not rebuild the unrelated settings panel.
  view.emit({ type: "workspaces", workspaces: [] });
  assert.equal(view.panel(), view.originalPanel);
  assert.equal(view.conversations(), renders + 1);
  assert.equal(view.state.currentSessionId, null);
});

test("settings-specific maintenance errors still refresh their status during generation", () => {
  const view = streamingSettings();
  view.state.maintenanceBusy = "reload";
  view.emit({ type: "maintenance_error", message: "reload failed" });
  assert.equal(view.state.maintenanceBusy, null);
  assert.equal(view.state.maintenanceMessage.text, "reload failed");
  assert.notEqual(view.panel(), view.originalPanel);
});
