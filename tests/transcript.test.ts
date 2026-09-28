import assert from "node:assert/strict";
import test from "node:test";
import { applyAssistantDelta, applyToolExecution, browserMessages, renderCompaction, renderSessionEntries, renderTranscript, type RenderedMessage } from "../transcript.ts";

test("browser messages omit unused tool payloads without changing display data or the original transcript", () => {
  const messages: RenderedMessage[] = [
    { kind: "user", text: "hello" },
    { kind: "assistant", streaming: true, blocks: [
      { type: "thinking", thinking: "reasoning" },
      { type: "text", text: "answer" },
      { type: "toolCall", id: "call", name: "write", arguments: { path: "file.txt", content: "x".repeat(1024 * 1024) }, argumentsText: "file.txt", running: false,
        result: { content: "saved", isError: true, details: { data: "y".repeat(1024 * 1024) } } },
      { type: "toolCall", id: "pending", arguments: { path: "next.txt" }, argumentsText: "next.txt", running: true },
    ] },
    { kind: "compaction", text: "summary", usage: { totalTokens: 10 } },
  ];
  const output = browserMessages(messages);
  assert.deepEqual(output[1].blocks?.[2], {
    type: "toolCall", id: "call", name: "write", argumentsText: "file.txt", running: false,
    result: { content: "saved", isError: true },
  });
  assert.deepEqual(output[1].blocks?.[3], { type: "toolCall", id: "pending", argumentsText: "next.txt", running: true });
  assert.deepEqual(output[1].blocks?.slice(0, 2), messages[1].blocks?.slice(0, 2));
  assert.deepEqual(output[0], messages[0]);
  assert.deepEqual(output[2], messages[2]);
  assert.equal(output[1].streaming, true);
  assert.ok(messages[1].blocks?.[2].arguments);
  assert.ok(messages[1].blocks?.[2].result?.details);
  assert.ok(JSON.stringify(output).length < 1024);
});

test("Agent cards retain full delegation fields in history and live browser snapshots", () => {
  const prompt = "Inspect <code>\n" + "完整提示词".repeat(200) + "\nEND_PROMPT";
  const args = { subagent_type: "Worker", description: "完善 MySQL 测试入口", prompt, run_in_background: true, model: "internal-model" };
  const call = { type: "toolCall", id: "agent-call", name: "Agent", arguments: args };
  const history = renderTranscript([{ role: "assistant", content: [call] }]);
  const live: RenderedMessage[] = [];
  applyAssistantDelta(live, { assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: call } });
  const execution: RenderedMessage[] = [];
  applyToolExecution(execution, { type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args });
  for (const messages of [history, live, execution]) {
    const block = browserMessages(messages)[0].blocks?.[0];
    assert.deepEqual(block?.subagent, { type: args.subagent_type, task: args.description, prompt });
    assert.equal(block?.argumentsText, args.description);
    assert.equal(block?.arguments, undefined);
    assert.ok(!JSON.stringify(block).includes("internal-model"));
    assert.deepEqual(messages[0].blocks?.[0].arguments, args);
  }
});

test("Agent projection tolerates incomplete arguments", () => {
  const output = browserMessages([{ kind: "assistant", blocks: [
    { type: "toolCall", name: "Agent", arguments: { description: "正在委派" } },
    { type: "toolCall", name: "Agent", arguments: { subagent_type: 42, prompt: null } },
  ] }]);
  assert.deepEqual(output[0].blocks?.[0].subagent, { type: "", task: "正在委派", prompt: "" });
  assert.deepEqual(output[0].blocks?.[1].subagent, { type: "", task: "", prompt: "" });
});

test("steering feedback resolves agent IDs and names to their tasks and preserves the full message", () => {
  const message = "请检查 <mysql>\n" + "完整反馈内容".repeat(100) + "\nEND_FEEDBACK";
  const launch = (id: string, type: string, task: string, name?: string) => [
    { role: "assistant", content: [{ type: "toolCall", id: `call-${id}`, name: "Agent", arguments: { subagent_type: type, description: task, prompt: "do work", name } }] },
    { role: "toolResult", toolCallId: `call-${id}`, toolName: "Agent", content: `Agent started in background.\nAgent ID: ${id}\nType: ${type}\nDescription: ${task}` },
  ];
  const steer = (target: string) => ({ role: "assistant", content: [{ type: "toolCall", name: "steer_subagent", arguments: { agent_id: target, message } }] });
  const input = renderTranscript([
    ...launch("worker-a", "Worker", "完善 MySQL 测试入口", "mysql-tests"),
    steer("worker-a"), steer("mysql-tests"), steer("worker"),
    ...launch("worker-b", "Worker", "完善 PostgreSQL 测试入口"),
    steer("worker-b"), steer("worker-a"), steer("worker"), steer("unknown-agent"),
  ]);
  const feedback = browserMessages(input).flatMap(msg => msg.blocks || []).filter(block => block.name === "steer_subagent");
  assert.equal(feedback.length, 7);
  for (const index of [0, 1, 2, 4]) {
    assert.equal(feedback[index].subagentFeedback?.type, "Worker");
    assert.equal(feedback[index].subagentFeedback?.task, "完善 MySQL 测试入口");
  }
  assert.equal(feedback[3].subagentFeedback?.task, "完善 PostgreSQL 测试入口");
  for (const index of [5, 6]) {
    assert.equal(feedback[index].subagentFeedback?.type, "");
    assert.equal(feedback[index].subagentFeedback?.task, "");
  }
  assert.equal(feedback[6].subagentFeedback?.target, "unknown-agent");
  for (const block of feedback) {
    assert.equal(block.subagentFeedback?.message, message);
    assert.equal(block.arguments, undefined);
    assert.ok(!block.argumentsText?.includes("END_FEEDBACK"));
  }
});

test("live steering resolves structured agent results before serializing away result details", () => {
  const messages: RenderedMessage[] = [];
  applyToolExecution(messages, { type: "tool_execution_start", toolCallId: "launch", toolName: "Agent", args: { subagent_type: "Explore", description: "查找入口", prompt: "查找代码" } });
  applyToolExecution(messages, { type: "tool_execution_end", toolCallId: "launch", result: { content: [], details: { agentId: "live-agent" } } });
  applyToolExecution(messages, { type: "tool_execution_start", toolCallId: "feedback", toolName: "steer_subagent", args: { agent_id: "live-agent", message: "也检查 tests\n完整反馈" } });
  const visible = browserMessages(messages).flatMap(msg => msg.blocks || []);
  assert.deepEqual(visible[1].subagentFeedback, { target: "live-agent", type: "Explore", task: "查找入口", message: "也检查 tests\n完整反馈" });
  assert.equal(visible[0].result?.details, undefined);
  assert.ok(messages[0].blocks?.[0].result?.details);
});

test("result requests resolve the source agent before a result arrives without exposing query options", () => {
  const messages: RenderedMessage[] = [{ kind: "assistant", blocks: [
    { type: "toolCall", name: "Agent", arguments: { subagent_type: "Worker", description: "检查测试入口", name: "test-worker" }, result: { content: "Agent started in background.\nAgent ID: result-worker\nType: Worker\nDescription: 检查测试入口", isError: false } },
    { type: "toolCall", name: "get_subagent_result", arguments: { agent_id: "result-worker", wait: true, verbose: true }, running: true },
    { type: "toolCall", name: "get_subagent_result", arguments: { agent_id: "test-worker" } },
    { type: "toolCall", name: "get_subagent_result", arguments: { agent_id: "unknown" } },
  ] }];
  const blocks = browserMessages(messages)[0].blocks!;
  assert.deepEqual(blocks[1].subagentResult, { target: "result-worker", type: "Worker", task: "检查测试入口" });
  assert.deepEqual(blocks[2].subagentResult, { target: "test-worker", type: "Worker", task: "检查测试入口" });
  assert.deepEqual(blocks[3].subagentResult, { target: "unknown", type: "", task: "" });
  assert.equal(blocks[1].arguments, undefined);
  assert.equal(blocks[1].argumentsText, "Worker · 检查测试入口");
  assert.equal(blocks[1].running, true);
});

test("renderCompaction preserves cache-miss usage", () => {
  const usage = {
    input: 1200,
    output: 300,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1500,
    cost: { total: 0.0042 },
  };

  const rendered = renderCompaction({
    id: "compact-1",
    summary: "summary",
    tokensBefore: 20_000,
    estimatedTokensAfter: 8_000,
    usage,
  });

  assert.deepEqual(rendered.usage, usage);
});

test("renderSessionEntries carries compaction usage through the active branch", () => {
  const usage = { totalTokens: 900 };
  const rendered = renderSessionEntries([
    { id: "user-1", parentId: null, type: "message", message: { role: "user", content: "hello" } },
    { id: "compact-1", parentId: "user-1", type: "compaction", summary: "summary", usage },
  ], "compact-1");

  assert.equal(rendered[1]?.kind, "compaction");
  assert.deepEqual(rendered[1]?.usage, usage);
});
