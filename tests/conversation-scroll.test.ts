import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const intentSource = app.slice(app.indexOf("function onConversationScroll("), app.indexOf("function conversationTargetTop("));
const renderSource = app.slice(app.indexOf("function renderConversation("), app.indexOf("function renderHeaderPlaceholder("));

function fixture(top = 1500) {
  const scroll = { scrollTop: top, scrollHeight: 2000, clientHeight: 500 };
  const input = { dataset: { sessionId: "session" } };
  const frames: (() => void)[] = [];
  const nodes: Record<string, unknown> = {
    "#conversationMount": {}, "#composerInput": input, "[data-conversation-scroll]": scroll,
    '.wSkVaW_root[data-phase="active"]': {}, ".wSkVaW_header": { isEqualNode: () => true },
    ".pi-conversationStage": {}, ".wSkVaW_viewArea": {}, "[data-composer-seat]": {},
  };
  const context = createContext({
    S: { currentSessionId: "session", conversationTab: "conversation" },
    document: { activeElement: null }, $: (selector: string) => nodes[selector],
    conversationNavScroll: scroll, conversationLastScrollTop: top, conversationFollowingBottom: top === 1500, conversationTouchY: null,
    el() {}, renderHeader() {}, reconcileConversationNavigator() {}, patchComposerState() {}, bindConversationNavigator() {},
    scheduleConversationNavigatorLayout() {},
    reconcileMessageFlow: () => { scroll.scrollHeight += 100; },
    requestAnimationFrame: (fn: () => void) => { frames.push(fn); },
  });
  runInContext(`${intentSource}\n${renderSource}`, context);
  return { scroll, context, frames, render: () => runInContext("renderConversation()", context) };
}

test("streaming follows the bottom until an upward wheel gesture, even within the old 96px threshold", () => {
  const view = fixture();
  view.render();
  assert.equal(view.scroll.scrollTop, 1600);
  runInContext("onConversationWheel({ deltaY: -20 })", view.context);
  view.scroll.scrollTop = 1580;
  runInContext("onConversationScroll()", view.context);
  view.render();
  assert.equal(view.scroll.scrollTop, 1580);
  view.scroll.scrollTop = 1500;
  for (const frame of view.frames) frame();
  assert.equal(view.scroll.scrollTop, 1500);
});

test("streaming leaves a reader's position alone and resumes following on return to the bottom", () => {
  const view = fixture(500);
  view.render();
  view.render();
  assert.equal(view.scroll.scrollTop, 500);
  view.scroll.scrollTop = view.scroll.scrollHeight - view.scroll.clientHeight;
  runInContext("onConversationScroll()", view.context);
  view.render();
  assert.equal(view.scroll.scrollTop, view.scroll.scrollHeight - view.scroll.clientHeight);
});

test("a touch scrolling gesture suspends following before the browser starts scrolling", () => {
  const view = fixture();
  runInContext("onConversationTouchStart({ touches: [{ clientY: 200 }] }); onConversationTouchMove({ touches: [{ clientY: 220 }] })", view.context);
  view.render();
  assert.equal(view.scroll.scrollTop, 1500);
});

test("a tap without scrolling keeps following the streaming response", () => {
  const view = fixture();
  runInContext("onConversationTouchStart({ touches: [{ clientY: 200 }] })", view.context);
  view.render();
  assert.equal(view.scroll.scrollTop, 1600);
});
