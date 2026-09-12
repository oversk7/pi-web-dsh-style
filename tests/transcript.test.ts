import assert from "node:assert/strict";
import test from "node:test";
import { renderCompaction, renderSessionEntries } from "../transcript.ts";

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
