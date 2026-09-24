import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const renderSource = app.slice(app.indexOf("function renderConversation("), app.indexOf("function renderHeaderPlaceholder("));
const navigationSource = app.slice(app.indexOf("async function openHistoryView("), app.indexOf("async function navigateHistory("));
const clickSource = app.slice(app.indexOf("async function onClick("), app.indexOf("function moveWorkspace("));

function fixture() {
  const state = {
    currentSessionId: "session", conversationTab: "history", historyGeneration: 1,
    historyView: { sessionId: "session", loading: true, nodes: [] as unknown[] },
    snapshot: { session: { streaming: true }, messages: ["first chunk"] },
  };
  const nodes: Record<string, TestNode | null> = {};
  class TestNode {
    scrollTop = 120;
    readonly selector: string;
    readonly html: string;
    constructor(selector: string, html: string) { this.selector = selector; this.html = html; }
    isEqualNode(next: TestNode) { return this.html === next.html; }
    replaceWith(next: TestNode) { nodes[this.selector] = next; }
  }
  const headerHtml = () => `<header>${state.conversationTab}</header>`;
  const historyHtml = () => `<section>${JSON.stringify(state.historyView)}</section>`;
  const header = nodes[".wSkVaW_header"] = new TestNode(".wSkVaW_header", headerHtml());
  const history = nodes[".pi-historyView"] = new TestNode(".pi-historyView", historyHtml());
  nodes['.wSkVaW_root[data-phase="active"]'] = new TestNode("root", "");
  let mountedHtml = "";
  let mountWrites = 0;
  const mount = {
    set innerHTML(value: string) {
      mountedHtml = value;
      mountWrites += 1;
      nodes[".wSkVaW_header"] = new TestNode(".wSkVaW_header", headerHtml());
      nodes[".pi-historyView"] = state.conversationTab === "history" ? new TestNode(".pi-historyView", historyHtml()) : null;
    },
  };
  let resolveHistory!: (value: unknown) => void;
  const context = createContext({
    S: state, document: { activeElement: null },
    $: (selector: string) => selector === "#conversationMount" ? mount : nodes[selector] || null,
    el: (html: string) => new TestNode(html.startsWith("<header>") ? ".wSkVaW_header" : ".pi-historyView", html),
    renderHeader: headerHtml, renderHistoryView: historyHtml,
    renderActive: () => state.conversationTab === "history" ? historyHtml() : state.snapshot.messages.join(""),
    restoreDraft() {}, bindComposerInput() {}, bindConversationNavigator() {}, closePopovers() {},
    requestAnimationFrame() {},
    post: () => new Promise((resolve) => { resolveHistory = resolve; }),
  });
  runInContext(`${renderSource}\n${navigationSource}\n${clickSource}\nfunction queueRender() { renderConversation(); }`, context);
  return {
    state, nodes, header, history, context,
    render: () => runInContext("renderConversation()", context),
    html: () => mountedHtml, writes: () => mountWrites,
    resolveHistory: (value: unknown) => resolveHistory(value),
  };
}

test("streaming updates preserve history controls and the reader's scroll position", () => {
  const view = fixture();
  for (let i = 0; i < 5; i++) {
    view.state.snapshot.messages.push(`chunk ${i}`);
    view.render();
  }
  assert.equal(view.nodes[".wSkVaW_header"], view.header);
  assert.equal(view.nodes[".pi-historyView"], view.history);
  assert.equal(view.history.scrollTop, 120);
  assert.equal(view.writes(), 0);
});

test("history loading results update the content while preserving the conversation tab button", () => {
  const view = fixture();
  view.state.historyView.loading = false;
  view.state.historyView.nodes = [{ id: "prompt", text: "previous question" }];
  view.render();
  assert.equal(view.nodes[".wSkVaW_header"], view.header);
  assert.notEqual(view.nodes[".pi-historyView"], view.history);
  assert.match(view.nodes[".pi-historyView"]!.html, /previous question/);
  assert.equal(view.writes(), 0);
});

test("returning to conversation during generation shows the latest reply and survives a pending history response", async () => {
  const view = fixture();
  const pending = runInContext("openHistoryView()", view.context);
  const pressedHeader = view.nodes[".wSkVaW_header"];
  view.state.snapshot.messages.push(" latest chunk");
  view.render();
  assert.equal(view.nodes[".wSkVaW_header"], pressedHeader);
  const button = { dataset: { action: "conversation-tab" } };
  view.context.event = { target: { closest: (selector: string) => selector === "[data-action]" ? button : null } };
  await runInContext("onClick(event)", view.context);
  assert.equal(view.state.conversationTab, "conversation");
  assert.match(view.html(), /first chunk latest chunk/);
  assert.equal(view.state.snapshot.session.streaming, true);
  view.resolveHistory({ nodes: [{ id: "prompt" }] });
  await pending;
  assert.equal(view.state.conversationTab, "conversation");
  assert.equal(view.nodes[".pi-historyView"], null);
  assert.match(view.html(), /latest chunk/);
});
