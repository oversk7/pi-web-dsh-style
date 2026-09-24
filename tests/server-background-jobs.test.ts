import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("session log endpoint reads growing logs without invoking tools and rejects other sessions' jobs", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-pwsh-notify-web-test-"));
  const logPath = join(directory, "bg-1.log");
  const previous = { ...process.env };
  process.env.PI_WEB_STATE_FILE = join(directory, "state.json");
  process.env.PI_WEB_LEGACY_STATE_FILE = join(directory, "unused.json");
  process.env.PI_WEB_RPC_ENTRY = join(directory, "rpc.mjs");
  const timestamp = new Date().toISOString();
  await writeFile(logPath, "first output\n");
  await writeFile(process.env.PI_WEB_STATE_FILE, JSON.stringify({
    version: 1,
    workspaces: [{ id: "ws", title: "Test", path: directory, sessionIds: ["one", "two"], createdAt: timestamp, updatedAt: timestamp }],
    sessions: ["one", "two"].map((id) => ({ id, workspaceId: "ws", title: id, createdAt: timestamp, updatedAt: timestamp })),
  }));
  await writeFile(process.env.PI_WEB_RPC_ENTRY, `
    import { createInterface } from "node:readline";
    const session = process.argv.includes("one") ? "one" : "two";
    const model = { id: "test", provider: "test", input: ["text"] };
    const entries = session === "one" ? [
      { type: "message", id: "a", parentId: null, message: { role: "assistant", content: [{ type: "toolCall", id: "call-one", name: "pwsh", arguments: { command: "npm test", run_in_background: true, name: "测试" } }] } },
      { type: "message", id: "b", parentId: "a", message: { role: "toolResult", toolCallId: "call-one", toolName: "pwsh", content: [{ type: "text", text: ${JSON.stringify(`Started background job bg-1 (测试), PID 123. You will be notified automatically when it finishes. Full log: ${logPath}`)} }] } }
    ] : [];
    createInterface({ input: process.stdin }).on("line", line => {
      const command = JSON.parse(line);
      if (["prompt", "bash"].includes(command.type)) process.exit(9);
      const data = command.type === "get_state" ? { model, isStreaming: false }
        : command.type === "get_available_models" ? { models: [model] }
        : command.type === "get_entries" ? { entries, leafId: session === "one" ? "b" : null }
        : command.type === "get_commands" ? { commands: [] } : {};
      process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data }) + "\\n");
    });
  `);
  const { startWebServer, stopWebServer } = await import("../server.ts");
  try {
    const url = await startWebServer({ port: 0, open: false });
    for (const id of ["one", "two"]) {
      const response = await fetch(`${url}/api/sessions/${id}/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(response.status, 200);
    }
    const get = (session: string, query = "") => fetch(`${url}/api/sessions/${session}/background-jobs${query}`);
    const first = await (await get("one")).json();
    assert.equal(first.jobs.length, 1);
    assert.equal(first.job.command, "npm test");
    assert.equal(first.job.logPath, undefined);
    assert.equal(first.output, "first output\n");
    assert.equal((await (await get("one")).json()).output, first.output);
    await writeFile(logPath, "first output\n中文新增输出\n");
    assert.match((await (await get("one", "?job=call-one")).json()).output, /中文新增输出/);
    assert.equal((await get("two", "?job=call-one")).status, 404);
    assert.equal((await get("one", "?job=..%2Fsecret")).status, 404);
    assert.deepEqual((await (await get("two")).json()).jobs, []);
    await rm(logPath);
    const missing = await (await get("one")).json();
    assert.equal(missing.jobs.length, 1);
    assert.match(missing.error, /已被清理/);
  } finally {
    await stopWebServer();
    for (const key of ["PI_WEB_STATE_FILE", "PI_WEB_LEGACY_STATE_FILE", "PI_WEB_RPC_ENTRY"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
