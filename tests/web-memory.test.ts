import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { markdown } from "../web/markdown.ts";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const escapeSource = app.slice(app.indexOf("function esc("), app.indexOf("function el("));
const renderSource = app.slice(app.indexOf("function compactionReasonLabel("), app.indexOf("function renderWorkspaceMenu("));
const clickSource = app.slice(app.indexOf("async function onClick("), app.indexOf("function moveWorkspace("));

function fixture(message: object, action: string, blockIndex?: number, toolKey = "call:call") {
  const detail = {
    hidden: true, innerHTML: "", dataset: { blockIndex },
    replaceChildren() { this.innerHTML = ""; },
  };
  const attributes = new Map<string, string>();
  const row = {
    dataset: { toolKey, compactionKey: "compaction:compact", thinkingKey: "session:0:0" },
    querySelector: () => detail,
    setAttribute: (key: string, value: string) => attributes.set(key, value),
  };
  const target = {
    ...row, dataset: { action, ...row.dataset },
    closest: (selector: string): unknown => {
      if (selector === "[data-action]") return target;
      if (selector === ".pi-messageGroup") return { dataset: { messageIndex: "0" } };
      if ([".CY-8Ka_root", ".ztWv_q_callRow", ".QWLzlG_row", ".QWLzlG_root", ".pi-compactionCard"].includes(selector)) return row;
      return null;
    },
  };
  const state = { currentSessionId: "session", expandedTools: new Set(), expandedThinking: new Set(), expandedCompactions: new Set() };
  const context = createContext({
    S: state, message, currentSnapshot: () => ({ messages: [message] }), markdown,
    ICONS: new Proxy({}, { get: () => "" }), fmtNum: String, clockLabel: () => "", closePopovers() {},
    event: { target },
  });
  runInContext(`${escapeSource}\n${renderSource}\n${clickSource}`, context);
  return {
    detail, state, attributes,
    render: (): string => runInContext("renderMessage(message, 0)", context),
    click: () => runInContext("onClick(event)", context),
  };
}

const largeText = "BEGIN<&>" + "x".repeat(1024 * 1024) + "END_DETAIL";
const cases = [
  { name: "tool call", action: "toggle-tool", blockIndex: 0, message: { kind: "assistant", blocks: [{ type: "toolCall", id: "call", name: "read", argumentsText: "file.txt", result: { content: largeText, isError: true } }] } },
  { name: "standalone tool result", action: "toggle-tool", toolKey: "result:call", message: { kind: "toolResult", toolCallId: "call", toolName: "read", text: largeText, isError: true } },
  { name: "bash output", action: "toggle-tool", toolKey: "bash:echo", message: { kind: "bashExecution", command: "echo", output: largeText } },
  { name: "thinking", action: "toggle-thinking", blockIndex: 0, message: { kind: "assistant", blocks: [{ type: "thinking", thinking: largeText }] } },
  { name: "compaction summary", action: "toggle-compaction", message: { kind: "compaction", id: "compact", status: "complete", text: largeText, tokensBefore: 100, estimatedTokensAfter: 10, reason: "manual", usage: { totalTokens: 7 } } },
];

for (const item of cases) {
  test(`${item.name} creates complete escaped detail on click and releases it on collapse`, async () => {
    const view = fixture(item.message, item.action, item.blockIndex, item.toolKey);
    const collapsed = view.render();
    assert.ok(collapsed.length < 4000);
    assert.ok(!collapsed.includes("END_DETAIL"));
    assert.equal(view.detail.innerHTML, "");

    await view.click();
    assert.equal(view.detail.hidden, false);
    assert.equal(view.attributes.get("aria-expanded"), "true");
    assert.match(view.detail.innerHTML, /BEGIN&lt;&amp;&gt;/);
    assert.match(view.detail.innerHTML, /END_DETAIL/);
    assert.ok(view.detail.innerHTML.length > 1024 * 1024);
    if (item.name === "tool call" || item.name === "standalone tool result") assert.match(view.detail.innerHTML, /Y0dWHa_payloadError/);
    if (item.name === "compaction summary") assert.match(view.detail.innerHTML, /压缩前.*100.*压缩后约.*10.*摘要实际消耗.*7/s);
    assert.match(view.render(), /END_DETAIL/);

    await view.click();
    assert.equal(view.detail.hidden, true);
    assert.equal(view.attributes.get("aria-expanded"), "false");
    assert.equal(view.detail.innerHTML, "");
    assert.ok(!view.render().includes("END_DETAIL"));
    await view.click();
    assert.match(view.detail.innerHTML, /END_DETAIL/);
  });
}

test("expanded thinking detail retains its state when a streaming snapshot updates", async () => {
  const message = { kind: "assistant", streaming: true, blocks: [{ type: "thinking", thinking: "first" }] };
  const view = fixture(message, "toggle-thinking", 0);
  await view.click();
  message.blocks[0].thinking = "first and second";
  assert.match(view.render(), /aria-expanded="true"/);
  assert.match(view.render(), /<pre class="Y0dWHa_payload">first and second<\/pre>/);
});
