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
    S: state, message, currentSnapshot: () => ({ messages: [message] }), markdown, t: (value: string) => value,
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

const agentReceipt = [
  "Agent started in background.",
  "Agent ID: 539bfb2e-4e57-40b",
  "Type: Worker",
  "Description: 完善 MySQL 测试入口",
  "Output file: C:\\Temp\\pi-subagents\\task.output",
  "",
  "You will be notified when this agent completes.",
  "Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.",
  "Do not duplicate this agent's work.",
].join("\n");

test("Agent card shows delegation and full prompt while hiding the background receipt", async () => {
  const message = { kind: "assistant", blocks: [{ type: "toolCall", id: "call", name: "Agent",
    argumentsText: "{truncated raw arguments}", subagent: { type: "Worker", task: "完善 MySQL 测试入口", prompt: largeText },
    result: { content: agentReceipt, isError: false } }] };
  const view = fixture(message, "toggle-tool", 0);
  const collapsed = view.render();
  assert.match(collapsed, /Agent · Worker/);
  assert.match(collapsed, /完善 MySQL 测试入口/);
  assert.doesNotMatch(collapsed, /行输出|truncated raw arguments|END_DETAIL/);
  await view.click();
  assert.match(view.detail.innerHTML, /类型.*Worker.*委派任务.*完善 MySQL 测试入口.*提示词/s);
  assert.match(view.detail.innerHTML, /BEGIN&lt;&amp;&gt;/);
  assert.match(view.detail.innerHTML, /END_DETAIL/);
  assert.doesNotMatch(view.render(), /Agent started|Agent ID|Output file|pi-subagents|get_subagent_result|steer_subagent|Do not duplicate|You will be notified/);
  await view.click();
  assert.equal(view.detail.innerHTML, "");
  assert.doesNotMatch(view.render(), /END_DETAIL/);
});

test("older runtime snapshots explain missing prompts instead of silently showing only receipt fields", async () => {
  const block = { type: "toolCall", id: "call", name: "Agent", argumentsText: '{"prompt":"truncated…',
    result: { content: agentReceipt, isError: false },
    subagent: undefined as { type: string; task: string; prompt: string } | undefined };
  const view = fixture({ kind: "assistant", blocks: [block] }, "toggle-tool", 0);
  await view.click();
  assert.match(view.detail.innerHTML, /提示词.*当前运行时未提供完整提示词.*重新加载运行时/s);
  assert.doesNotMatch(view.detail.innerHTML, /truncated|Agent ID|Output file/);
  block.subagent = { type: "Worker", task: "完善 MySQL 测试入口", prompt: "完整提示词恢复后显示" };
  assert.match(view.render(), /完整提示词恢复后显示/);
  assert.doesNotMatch(view.render(), /当前运行时未提供完整提示词/);
});

test("Agent prompt stays expanded through running updates and a background receipt", async () => {
  const block = { type: "toolCall", id: "call", name: "Agent", running: true,
    subagent: { type: "Explore", task: "查找测试入口", prompt: "检查 tests 目录" },
    result: undefined as { content: string; isError: boolean } | undefined };
  const view = fixture({ kind: "assistant", streaming: true, blocks: [block] }, "toggle-tool", 0);
  await view.click();
  assert.match(view.render(), /data-state="running"/);
  block.running = false;
  block.result = { content: agentReceipt, isError: false };
  assert.match(view.render(), /aria-expanded="true"/);
  assert.match(view.render(), /Agent · Explore/);
  assert.match(view.render(), /检查 tests 目录/);
  assert.doesNotMatch(view.render(), /Agent started|Agent ID|行输出/);
});

test("standalone Agent receipts show type and task without operational boilerplate", async () => {
  const view = fixture({ kind: "toolResult", toolCallId: "call", toolName: "Agent", text: agentReceipt.replaceAll("\n", "\r\n") }, "toggle-tool", undefined, "result:call");
  assert.match(view.render(), /Agent · Worker/);
  assert.match(view.render(), /完善 MySQL 测试入口/);
  await view.click();
  assert.match(view.detail.innerHTML, /委派任务/);
  assert.doesNotMatch(view.render(), /Agent started|Agent ID|Output file|行输出/);
});

test("Agent results and failures remain visible, even if an error resembles a receipt", async () => {
  for (const [content, isError] of [["完成检查 <result>", false], ["启动失败 <error>", true], [agentReceipt, true]] as const) {
    const view = fixture({ kind: "assistant", blocks: [{ type: "toolCall", id: "call", name: "Agent",
      subagent: { type: "Worker", task: "检查入口", prompt: "检查代码" }, result: { content, isError } }] }, "toggle-tool", 0);
    await view.click();
    assert.ok(view.detail.innerHTML.includes(content.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("'", "&#39;")));
    if (isError) {
      assert.match(view.render(), /data-state="error"/);
      assert.match(view.detail.innerHTML, /Y0dWHa_payloadError/);
    }
  }
});

test("steering cards identify the target and show full escaped instructions instead of delivery boilerplate", async () => {
  const block = { type: "toolCall", id: "call", name: "steer_subagent", argumentsText: "raw arguments",
    subagentFeedback: { target: "agent-uuid", type: "Worker", task: "完善 MySQL 测试入口", message: largeText },
    result: { content: "Steering message sent to agent agent-uuid. The agent will process it after its current tool execution.\nCurrent state: 27.7k token · 18 tool uses · context 5% full", isError: false } };
  const view = fixture({ kind: "assistant", blocks: [block] }, "toggle-tool", 0);
  const collapsed = view.render();
  assert.match(collapsed, /补充指令 → Worker/);
  assert.match(collapsed, /完善 MySQL 测试入口/);
  assert.doesNotMatch(collapsed, /END_DETAIL|raw arguments|行输出/);
  await view.click();
  assert.match(view.detail.innerHTML, /目标 agent.*Worker · 完善 MySQL 测试入口.*指令内容/s);
  assert.match(view.detail.innerHTML, /BEGIN&lt;&amp;&gt;/);
  assert.match(view.detail.innerHTML, /END_DETAIL/);
  assert.doesNotMatch(view.render(), /Steering message sent|Current state|tool execution|agent-uuid/);
  await view.click();
  assert.equal(view.detail.innerHTML, "");
  assert.doesNotMatch(view.render(), /END_DETAIL/);
});

test("steering failures and unresolved target handles remain visible", async () => {
  const view = fixture({ kind: "assistant", blocks: [{ type: "toolCall", id: "call", name: "steer_subagent",
    subagentFeedback: { target: "worker-2", type: "", task: "", message: "补充检查 <tests>" },
    result: { content: 'Agent "worker-2" is not running (status: completed). Cannot steer a non-running agent.', isError: true } }] }, "toggle-tool", 0);
  assert.match(view.render(), /补充指令 → worker-2/);
  assert.match(view.render(), /data-state="error"/);
  await view.click();
  assert.match(view.detail.innerHTML, /目标 agent.*worker-2.*指令内容.*补充检查 &lt;tests&gt;/s);
  assert.match(view.detail.innerHTML, /Y0dWHa_payloadError/);
  assert.match(view.detail.innerHTML, /Cannot steer a non-running agent/);
});

test("older runtimes explicitly report missing steering content", async () => {
  const view = fixture({ kind: "assistant", blocks: [{ type: "toolCall", id: "call", name: "steer_subagent", argumentsText: '{"message":"truncated…' }] }, "toggle-tool", 0);
  await view.click();
  assert.match(view.detail.innerHTML, /指令内容.*当前运行时未提供完整指令内容/s);
  assert.doesNotMatch(view.detail.innerHTML, /truncated/);
});

const resultHeader = (status: string) => `Agent: result-agent\nType: Worker | Status: ${status} | Tool uses: 32 | 72.1k token | Context: 4% | Duration: 231.7s\nDescription: 完善 MySQL 测试入口\n\n`;

test("result cards render complete Markdown results without metadata or raw query arguments", async () => {
  const view = fixture({ kind: "assistant", blocks: [{ type: "toolCall", id: "call", name: "get_subagent_result",
    argumentsText: '{"agent_id":"result-agent","verbose":true}',
    result: { content: resultHeader("completed") + "**验证通过**\n\n" + largeText, isError: false } }] }, "toggle-tool", 0);
  assert.match(view.render(), /查看结果 ← Worker/);
  assert.match(view.render(), /完善 MySQL 测试入口 · 已完成/);
  assert.doesNotMatch(view.render(), /END_DETAIL|result-agent|verbose|行输出/);
  await view.click();
  assert.match(view.detail.innerHTML, /结果来源.*Worker · 完善 MySQL 测试入口.*状态.*已完成.*执行结果/s);
  assert.match(view.detail.innerHTML, /<strong>验证通过<\/strong>/);
  assert.match(view.detail.innerHTML, /BEGIN&lt;&amp;&gt;/);
  assert.match(view.detail.innerHTML, /END_DETAIL/);
  assert.doesNotMatch(view.render(), /Tool uses|Context:|Duration:|72\.1k|Agent: result-agent/);
  await view.click();
  assert.equal(view.detail.innerHTML, "");
});

test("agent failure status overrides a successful result lookup and retains partial output and conversation", async () => {
  const content = (resultHeader("error") + 'Error: API 429\n\nPartial output before the failure:\n已完成一部分检查。\n\n--- Agent Conversation ---\n[User]: 检查 <code>\n[Assistant]: 执行记录末尾').replaceAll("\n", "\r\n");
  const view = fixture({ kind: "assistant", blocks: [{ type: "toolCall", id: "call", name: "get_subagent_result", result: { content, isError: false } }] }, "toggle-tool", 0);
  assert.match(view.render(), /data-state="error"/);
  assert.match(view.render(), /完善 MySQL 测试入口 · 失败/);
  await view.click();
  assert.match(view.detail.innerHTML, /失败原因.*API 429.*已完成一部分检查/s);
  assert.match(view.detail.innerHTML, /Y0dWHa_payloadError/);
  assert.match(view.detail.innerHTML, /<details class="pi-subagentConversation"><summary>执行记录<\/summary>/);
  assert.match(view.detail.innerHTML, /检查 &lt;code&gt;.*执行记录末尾/s);
  assert.doesNotMatch(view.detail.innerHTML, /<details[^>]* open|Tool uses:|Duration:/);
});

test("running agent results and pending lookups do not claim the agent has completed", async () => {
  for (const pending of [false, true]) {
    const block = { type: "toolCall", id: "call", name: "get_subagent_result", running: pending,
      subagentResult: { target: "result-agent", type: "Explore", task: "检查调用链" },
      result: pending ? undefined : { content: resultHeader("running"), isError: false } };
    const view = fixture({ kind: "assistant", blocks: [block] }, "toggle-tool", 0);
    assert.match(view.render(), /查看结果 ← Explore/);
    assert.match(view.render(), /data-state="running"/);
    await view.click();
    assert.match(view.detail.innerHTML, pending ? /正在获取结果/ : /子 agent 仍在运行，尚无结果/);
    assert.doesNotMatch(view.render(), /已完成|>完成</);
  }
});

test("standalone result messages recover source identity and unknown errors stay intact", async () => {
  const view = fixture({ kind: "toolResult", toolCallId: "call", toolName: "get_subagent_result", text: resultHeader("completed") + "最终结果" }, "toggle-tool", undefined, "result:call");
  assert.match(view.render(), /查看结果 ← Worker/);
  await view.click();
  assert.match(view.detail.innerHTML, /最终结果/);
  assert.doesNotMatch(view.detail.innerHTML, /Tool uses:|Duration:/);
  const failed = fixture({ kind: "assistant", blocks: [{ type: "toolCall", id: "call", name: "get_subagent_result",
    subagentResult: { target: "missing-agent", type: "", task: "" }, result: { content: "Agent not found: missing-agent <error>", isError: true } }] }, "toggle-tool", 0);
  await failed.click();
  assert.match(failed.render(), /查看结果 ← missing-agent/);
  assert.match(failed.detail.innerHTML, /Agent not found: missing-agent &lt;error&gt;/);
});

test("expanded thinking detail retains its state when a streaming snapshot updates", async () => {
  const message = { kind: "assistant", streaming: true, blocks: [{ type: "thinking", thinking: "first" }] };
  const view = fixture(message, "toggle-thinking", 0);
  await view.click();
  message.blocks[0].thinking = "first and second";
  assert.match(view.render(), /aria-expanded="true"/);
  assert.match(view.render(), /<pre class="Y0dWHa_payload">first and second<\/pre>/);
});
