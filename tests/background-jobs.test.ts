import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectBackgroundJobs, readBackgroundJobLog } from "../background-jobs.ts";
import type { RenderedMessage } from "../transcript.ts";

const startMessage = (callId: string, logPath: string): RenderedMessage => ({
  kind: "assistant", blocks: [{ type: "toolCall", name: "pwsh", id: callId,
    arguments: { run_in_background: true, name: "中文任务", command: "npm test" },
    result: { content: `Started background job bg-1 (中文任务), PID 123. You will be notified automatically when it finishes. Full log: ${logPath}`, isError: false },
  }],
});

test("jobs bind to their tool call and log path even when bg IDs repeat", () => {
  const first = join(tmpdir(), "pi-pwsh-notify-one", "bg-1.log");
  const second = join(tmpdir(), "pi-pwsh-notify-two", "bg-1.log");
  const messages = [startMessage("call1", first), startMessage("call2", second)];
  const jobs = collectBackgroundJobs(messages);
  assert.deepEqual(jobs.map((job) => [job.id, job.logPath]), [["call2", second], ["call1", first]]);
  assert.equal(jobs[0].name, "中文任务");
  assert.equal(jobs[0].command, "npm test");
  assert.deepEqual(collectBackgroundJobs([startMessage("bad", join(tmpdir(), "secret.txt"))]), []);
  const fake = startMessage("fake", first);
  fake.blocks![0].name = "read";
  assert.deepEqual(collectBackgroundJobs([fake]), []);
});

test("log reads are repeatable, bounded, UTF-8 safe and strip terminal colors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-pwsh-notify-test-"));
  const path = join(directory, "bg-1.log");
  try {
    const text = "中文内容".repeat(14000) + "\n\u001b[32m完成\u001b[0m";
    await writeFile(path, text);
    const tail = await readBackgroundJobLog(path);
    assert.equal(tail.truncated, true);
    assert.match(tail.output, /\n完成$/);
    assert.ok(!tail.output.includes("�"));
    assert.ok(Buffer.byteLength(tail.output) <= 128 * 1024);
    assert.deepEqual(await readBackgroundJobLog(path), tail);
    assert.equal(await readFile(path, "utf8"), text);
    await writeFile(path, Array.from({ length: 1100 }, (_, index) => String(index)).join("\n"));
    const lines = await readBackgroundJobLog(path);
    assert.equal(lines.output.split("\n").length, 1000);
    assert.match(lines.output, /^100\n/);
    assert.equal(lines.truncated, true);
    await writeFile(path, "");
    assert.deepEqual(await readBackgroundJobLog(path), { output: "", truncated: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
