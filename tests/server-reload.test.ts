import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { webSlashCommands, unsupportedSlashCommands } from "../web/slash-commands.js";

test("slash commands execute explicitly or are rejected before reaching the model", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-reload-"));
  const previous = { ...process.env };
  process.env.PI_WEB_STATE_FILE = join(directory, "state.json");
  process.env.PI_WEB_LEGACY_STATE_FILE = join(directory, "unused.json");
  process.env.PI_WEB_RPC_ENTRY = join(directory, "rpc.mjs");
  const timestamp = new Date().toISOString();
  const ids = ["ready", "busy", "missing", "failure", "normal", "extension", "template", "skill", "unavailable", "handler-error"];
  const log = join(directory, "commands.jsonl");
  await writeFile(log, "");
  await writeFile(process.env.PI_WEB_STATE_FILE, JSON.stringify({
    version: 1,
    workspaces: [{ id: "ws", title: "Test", path: directory, sessionIds: ids, createdAt: timestamp, updatedAt: timestamp }],
    sessions: ids.map((id) => ({ id, workspaceId: "ws", title: id, createdAt: timestamp, updatedAt: timestamp })),
  }));
  await writeFile(process.env.PI_WEB_RPC_ENTRY, `
    import { createInterface } from "node:readline";
    import { appendFileSync } from "node:fs";
    const model = { id: "test", provider: "test", input: ["text"] };
    createInterface({ input: process.stdin }).on("line", line => {
      const command = JSON.parse(line);
      appendFileSync(${JSON.stringify(log)}, JSON.stringify(command) + "\\n");
      const failed = (["prompt", "set_session_name"].includes(command.type) && process.argv.includes("failure"))
        || (command.type === "get_commands" && process.argv.includes("unavailable"));
      const data = command.type === "get_state" ? { model, isStreaming: process.argv.includes("busy") }
        : command.type === "get_available_models" ? { models: [model] }
        : command.type === "get_entries" ? { entries: [], leafId: null }
        : command.type === "get_commands" ? { commands: process.argv.includes("missing") ? [] : [
          { name: "pi-web-reload-runtime", source: "extension" },
          { name: "custom", source: "extension" },
          { name: "template", source: "prompt" },
          { name: "skill:test", source: "skill" },
        ] }
        : {};
      if (command.type === "prompt" && process.argv.includes("handler-error")) {
        process.stdout.write(JSON.stringify({ type: "extension_error", extensionPath: "command:pi-web-reload-runtime", event: "command", error: "reload handler failed" }) + "\\n");
      }
      process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: !failed, data, ...(failed ? { error: "reload failed" } : {}) }) + "\\n");
    });
  `);
  const { startWebServer, stopWebServer } = await import("../server.ts");
  try {
    const url = await startWebServer({ port: 0, open: false });
    const post = (id: string, message: string, attachmentIds: string[] = []) => fetch(`${url}/api/sessions/${id}/prompt`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, attachmentIds }),
    });
    for (const name of [...webSlashCommands.map((command) => command.name), ...Object.keys(unsupportedSlashCommands)]) {
      const rejected = await post("ready", `/${name}`);
      assert.equal(rejected.status, 400, name);
    }
    for (const text of ["/typo", "/", "/skill:missing", "/pi-web-reload-runtime", "/pi-web-navigate-tree node"]) {
      assert.equal((await post("ready", text)).status, 400, text);
    }
    assert.equal((await post("unavailable", "/custom")).status, 500);
    const reload = (id: string) => fetch(`${url}/api/sessions/${id}/reload`, { method: "POST" });
    const success = await reload("ready");
    assert.equal(success.status, 200);
    assert.equal((await success.json()).reloaded, true);
    assert.equal((await reload("busy")).status, 409);
    assert.equal((await reload("missing")).status, 409);
    assert.equal((await post("ready", "/reload extra")).status, 400);
    assert.equal((await post("ready", "/reload", ["attachment"])).status, 400);
    assert.equal((await reload("failure")).status, 500);
    const handlerError = await reload("handler-error");
    assert.equal(handlerError.status, 500);
    assert.match((await handlerError.json()).error, /reload handler failed/);
    for (const [id, message] of [["normal", "普通消息 /reload"], ["extension", "  /custom args  "], ["template", "/template args"], ["skill", "/skill:test args"]]) {
      assert.equal((await post(id, message)).status, 200);
    }
    const immediate = await post("busy", "/custom now");
    assert.equal(immediate.status, 200);
    assert.equal((await immediate.json()).queued, false);
    const compact = await fetch(`${url}/api/sessions/ready/compact`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ customInstructions: "保留测试" }),
    });
    assert.equal(compact.status, 200);
    assert.equal((await fetch(`${url}/api/sessions/busy/compact`, { method: "POST" })).status, 409);
    for (const [id, status] of [["ready", 200], ["failure", 500]] as const) {
      assert.equal((await fetch(`${url}/api/sessions/${id}/commands`, { method: "POST" })).status, 200);
      const renamed = await fetch(`${url}/api/sessions/${id}/set_name`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "renamed" }),
      });
      assert.equal(renamed.status, status);
    }
    const failedSession = await fetch(`${url}/api/sessions/failure/open`, { method: "POST" });
    assert.equal((await failedSession.json()).session.title, "failure");
    const commands = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(commands.find((command) => command.type === "compact").customInstructions, "保留测试");
    assert.deepEqual(commands.filter((command) => command.type === "prompt").map((command) => command.message), [
      "/pi-web-reload-runtime", "/pi-web-reload-runtime", "/pi-web-reload-runtime", "普通消息 /reload", "/custom args", "/template args", "/skill:test args", "/custom now",
    ]);
    assert.deepEqual(commands.filter((command) => command.type === "set_session_name").map((command) => command.name), ["renamed", "renamed"]);
  } finally {
    await stopWebServer();
    for (const key of ["PI_WEB_STATE_FILE", "PI_WEB_LEGACY_STATE_FILE", "PI_WEB_RPC_ENTRY"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
