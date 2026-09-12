import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { loadLocalSession } from "../local-session.ts";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const source = app.slice(app.indexOf("function renderStats("), app.indexOf("function fmtNum("));

test("composer stats start with context and omit message and tool counts", () => {
  const html = runInNewContext(`${source}\nrenderStats(snap)`, {
    snap: { stats: { totalMessages: 12, toolCalls: 5, contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 }, tokens: { input: 80, output: 20 }, cost: 0.000123 } },
    fmtNum: String,
    esc: String,
  });
  assert.match(html, /role="status"><span class="FJxK0a_context"/);
  assert.doesNotMatch(html, /消息|工具/);
  assert.match(html, /\$0\.000123/);
});

test("small positive costs never round to zero", () => {
  for (const [cost, expected] of [[0, "$0.000"], [0.12, "$0.120"], [0.000001, "$0.000001"], [0.0000001, "<$0.000001"]]) {
    assert.equal(runInNewContext(`${source}\nformatCost(cost)`, { cost }), expected);
  }
});

test("local cost includes nested usage from all branches, tools and summaries without double counting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-stats-"));
  const file = join(dir, "session.jsonl");
  const timestamp = "2026-08-01T00:00:00.000Z";
  const usage = (total: number) => ({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total } });
  const assistant = (total: number) => ({ role: "assistant", content: [], usage: usage(total), stopReason: "stop", timestamp: 1 });
  try {
    await writeFile(file, [
      { type: "session", version: 3, id: "stats-test", cwd: dir, timestamp },
      { type: "message", id: "a", parentId: null, timestamp, message: { ...assistant(0.1), cost: 99 } },
      { type: "message", id: "old", parentId: "a", timestamp, message: assistant(0.2) },
      { type: "message", id: "new", parentId: "a", timestamp, message: assistant(0.3) },
      { type: "message", id: "tool", parentId: "new", timestamp, message: { role: "toolResult", toolCallId: "call", toolName: "test", content: [], usage: usage(0.4), timestamp: 2 } },
      { type: "compaction", id: "compact", parentId: "tool", timestamp, summary: "summary", firstKeptEntryId: "new", tokensBefore: 100, usage: usage(0.5) },
      { type: "branch_summary", id: "summary", parentId: "compact", timestamp, summary: "branch", fromId: "old", usage: usage(0.6) },
    ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    assert.ok(Math.abs(Number(loadLocalSession(file, dir).stats?.cost) - 2.1) < 1e-12);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
