import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("background experiments survive idle eviction and model refresh until all jobs finish", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-bg-lifecycle-"));
  const previous = { ...process.env };
  process.env.PI_WEB_STATE_FILE = join(directory, "state.json");
  process.env.PI_WEB_LEGACY_STATE_FILE = join(directory, "unused.json");
  process.env.PI_WEB_RPC_ENTRY = join(directory, "rpc.mjs");
  const timestamp = new Date().toISOString();
  const ids = ["experiment", "second-experiment", "idle-one", "idle-two", "idle-three", "viewer"];
  await writeFile(process.env.PI_WEB_STATE_FILE, JSON.stringify({
    version: 1,
    workspaces: [{ id: "ws", title: "Test", path: directory, sessionIds: ids, createdAt: timestamp, updatedAt: timestamp }],
    sessions: ids.map((id) => ({ id, workspaceId: "ws", title: id, createdAt: timestamp, updatedAt: timestamp })),
  }));
  await writeFile(process.env.PI_WEB_RPC_ENTRY, `
    import { spawn } from "node:child_process";
    import { createInterface } from "node:readline";
    const session = process.argv[process.argv.indexOf("--session-id") + 1];
    const experiment = session === "experiment" || session === "second-experiment";
    const child = experiment ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }) : undefined;
    const model = { id: process.argv.includes("--no-session") ? "changed" : "test", provider: "test", input: ["text"] };
    const emit = event => process.stdout.write(JSON.stringify(event) + "\\n");
    const status = text => emit({ type: "extension_ui_request", method: "setStatus", statusKey: "pwsh-bg", statusText: text });
    if (experiment) status("2 bg jobs running");
    createInterface({ input: process.stdin }).on("line", line => {
      const command = JSON.parse(line);
      if (command.type === "set_session_name" && command.name === "one-job-left") status("1 bg job running");
      if (command.type === "set_session_name" && command.name === "all-jobs-finished") {
        child.kill();
        status(undefined);
      }
      const data = command.type === "get_state" ? { model, isStreaming: false, experimentPid: child?.pid, rpcPid: process.pid }
        : command.type === "get_available_models" ? { models: [model] }
        : command.type === "get_entries" ? { entries: [], leafId: null }
        : command.type === "get_commands" ? { commands: [] } : {};
      emit({ type: "response", id: command.id, command: command.type, success: true, data });
    }).on("close", () => process.exit(0));
  `);
  const { startWebServer, stopWebServer } = await import("../server.ts");
  try {
    const url = await startWebServer({ port: 0, open: false });
    const post = async (id: string, action: string, body = {}) => {
      const response = await fetch(`${url}/api/sessions/${id}/${action}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, `${id}/${action}: ${await response.clone().text()}`);
      return response.json();
    };
    const statuses = async () => {
      const bootstrap = await (await fetch(`${url}/api/bootstrap`)).json();
      return Object.fromEntries(bootstrap.workspaces[0].sessions.map((session: { id: string; status: string }) => [session.id, session.status]));
    };
    await post("viewer", "open");
    const first = await post("experiment", "refresh");
    const second = await post("second-experiment", "refresh");
    await post("idle-one", "refresh");
    await post("idle-two", "refresh");
    let state = await statuses();
    assert.equal(state.experiment, "idle", "oldest experiment must remain alive after model settles");
    assert.equal(state["second-experiment"], "idle", "all active experiments are protected");
    assert.equal(state["idle-one"], "stopped", "ordinary idle processes still obey the cache limit");
    assert.equal(state["idle-two"], "idle");
    assert.equal(process.kill(first.state.experimentPid, 0), true);
    assert.equal(process.kill(second.state.experimentPid, 0), true);

    await post("experiment", "models");
    const afterModels = await post("experiment", "refresh");
    assert.equal(afterModels.state.rpcPid, first.state.rpcPid, "model refresh must not restart the experiment's owner");
    assert.equal(process.kill(first.state.experimentPid, 0), true);

    await post("experiment", "set_name", { name: "one-job-left" });
    const oneLeft = await post("experiment", "refresh");
    assert.equal(oneLeft.extensionStatuses["pwsh-bg"], "1 bg job running");
    await post("idle-three", "refresh");
    assert.equal((await statuses()).experiment, "idle", "remaining job keeps protection active");
    assert.equal(process.kill(first.state.experimentPid, 0), true);

    await post("experiment", "set_name", { name: "all-jobs-finished" });
    const finished = await post("experiment", "refresh");
    assert.equal(finished.extensionStatuses["pwsh-bg"], undefined);
    await post("viewer", "open");
    await post("idle-one", "refresh");
    state = await statuses();
    assert.equal(state.experiment, "stopped", "completed experiments become eligible for normal eviction");
    assert.equal(state["second-experiment"], "idle");
    assert.equal(process.kill(second.state.experimentPid, 0), true);
  } finally {
    await stopWebServer();
    for (const key of ["PI_WEB_STATE_FILE", "PI_WEB_LEGACY_STATE_FILE", "PI_WEB_RPC_ENTRY"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
