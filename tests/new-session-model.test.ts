import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("new sessions show and start with the current Pi defaults or explicit choices", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-new-model-"));
  const previous = { ...process.env };
  process.env.PI_WEB_STATE_FILE = join(directory, "state.json");
  process.env.PI_WEB_LEGACY_STATE_FILE = join(directory, "unused.json");
  process.env.PI_WEB_RPC_ENTRY = join(directory, "rpc.mjs");
  const log = join(directory, "rpc-log.jsonl");
  const oldModel = { provider: "test", id: "old", name: "Old", reasoning: false, input: ["text"] };
  const newModel = { provider: "test", id: "new", name: "New", reasoning: true, input: ["text"] };
  const probeOnly = { provider: "test", id: "probe-only", name: "Probe only", reasoning: true, input: ["text"] };
  const timestamp = new Date().toISOString();
  await writeFile(process.env.PI_WEB_STATE_FILE, JSON.stringify({
    version: 1,
    workspaces: [{ id: "ws", title: "Test", path: directory, sessionIds: [], createdAt: timestamp, updatedAt: timestamp }],
    sessions: [],
    modelCache: { [directory]: { models: [oldModel], defaultModel: oldModel, thinkingLevel: "off", thinkingLevels: ["off"] } },
  }));
  await writeFile(process.env.PI_WEB_RPC_ENTRY, `
    import { createInterface } from "node:readline";
    import { appendFileSync } from "node:fs";
    const models = ${JSON.stringify([oldModel, newModel, probeOnly])};
    let model = models[1];
    let thinkingLevel = "high";
    const session = process.argv.includes("--no-session") ? "probe" : "session";
    createInterface({ input: process.stdin }).on("line", line => {
      const command = JSON.parse(line);
      appendFileSync(${JSON.stringify(log)}, JSON.stringify({ session, type: command.type, modelId: command.modelId, level: command.level }) + "\\n");
      const missing = session === "session" && command.type === "set_model" && command.modelId === "probe-only";
      if (command.type === "set_model" && !missing) model = models.find(candidate => candidate.id === command.modelId) || model;
      if (command.type === "set_thinking_level") thinkingLevel = command.level;
      const data = command.type === "get_state" ? { model, thinkingLevel, isStreaming: false }
        : command.type === "get_available_models" ? { models }
        : command.type === "get_available_thinking_levels" ? { levels: model.reasoning ? ["off", "high"] : ["off"] }
        : command.type === "get_entries" ? { entries: [], leafId: null }
        : command.type === "get_commands" ? { commands: [] } : {};
      process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: !missing, ...(missing ? { error: "Model not found: test/probe-only" } : { data }) }) + "\\n");
    });
  `);
  const { startWebServer, stopWebServer } = await import("../server.ts");
  try {
    const url = await startWebServer({ port: 0, open: false });
    const post = async (path: string, body = {}) => {
      const response = await fetch(`${url}${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
      return response.json();
    };
    const boot = await (await fetch(`${url}/api/bootstrap`)).json();
    assert.equal(boot.modelInfo.state.model.id, "old", "fixture starts with stale cached model");

    const created = await post("/api/workspaces/ws/sessions");
    assert.equal(created.state.model.id, "new");
    assert.equal(created.state.thinkingLevel, "high");
    assert.ok(created.thinkingLevels.includes("high"));
    const opened = await post(`/api/sessions/${created.session.id}/open`);
    assert.equal(opened.state.model.id, "new");
    assert.equal(opened.state.thinkingLevel, "high");
    const prompted = await post(`/api/sessions/${created.session.id}/prompt`, { message: "hello" });
    assert.equal(prompted.queued, false);
    const running = await post(`/api/sessions/${created.session.id}/open`);
    assert.equal(running.state.model.id, "new");
    assert.equal(running.state.thinkingLevel, "high");

    const explicit = await post("/api/workspaces/ws/sessions", { model: { provider: "test", modelId: "old" }, thinkingLevel: "high" });
    assert.equal(explicit.state.model.id, "old");
    assert.equal(explicit.state.thinkingLevel, "off");
    await post(`/api/sessions/${explicit.session.id}/prompt`, { message: "hello" });
    const explicitRunning = await post(`/api/sessions/${explicit.session.id}/open`);
    assert.equal(explicitRunning.state.model.id, "old");
    assert.equal(explicitRunning.state.thinkingLevel, "off");

    const unavailable = await post("/api/workspaces/ws/sessions", { model: { provider: "test", modelId: "probe-only" } });
    assert.equal(unavailable.state.model.id, "probe-only");
    const rejected = await fetch(`${url}/api/sessions/${unavailable.session.id}/prompt`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "must not send" }),
    });
    assert.equal(rejected.status, 500);
    assert.match((await rejected.json()).error, /请在模型菜单中选择当前可用的模型/);
    const failedState = await post(`/api/sessions/${unavailable.session.id}/open`);
    assert.equal(failedState.session.status, "stopped");
    assert.equal(failedState.messages.length, 0);
    await post(`/api/sessions/${unavailable.session.id}/set_model`, { provider: "test", modelId: "new" });
    await post(`/api/sessions/${unavailable.session.id}/prompt`, { message: "retry" });
    const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls.filter((call) => call.type === "prompt").length, 3);
    assert.ok(!calls.some((call) => call.type === "prompt" && call.message === "must not send"));
    assert.ok(calls.some((call) => call.session === "probe" && call.type === "get_state"));
    assert.ok(calls.some((call) => call.session === "session" && call.type === "set_model" && call.modelId === "new"));
    assert.ok(calls.some((call) => call.session === "session" && call.type === "set_thinking_level" && call.level === "high"));
  } finally {
    await stopWebServer();
    for (const key of ["PI_WEB_STATE_FILE", "PI_WEB_LEGACY_STATE_FILE", "PI_WEB_RPC_ENTRY"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
