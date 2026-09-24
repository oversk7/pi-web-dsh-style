import assert from "node:assert/strict";
import test from "node:test";
import { browserMessages, renderCompaction, renderSessionEntries, type RenderedMessage } from "../transcript.ts";

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
