import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";

test("shutdown persists pending workspace changes and leaves no delayed state writes", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-shutdown-state-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const keys = ["PI_WEB_STATE_FILE", "PI_WEB_LEGACY_STATE_FILE"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const stateFile = join(directory, "state.json");
  process.env.PI_WEB_STATE_FILE = stateFile;
  process.env.PI_WEB_LEGACY_STATE_FILE = join(directory, "unused.json");
  await writeFile(stateFile, JSON.stringify({ version: 1, workspaces: [], sessions: [] }));
  const { startWebServer, stopWebServer } = await import("../server.ts");
  try {
    const base = await startWebServer({ port: 0, open: false, defaultCwd: directory });
    const response = await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", connection: "close" },
      body: JSON.stringify({ path: workspace }),
    });
    assert.equal(response.status, 200);
    const created = (await response.json()).workspace;
    await stopWebServer();
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    assert.ok(saved.workspaces.some((entry: { id: string }) => entry.id === created.id));
    await rm(directory, { recursive: true, force: true });
    await setTimeout(250);
    await assert.rejects(stat(directory), { code: "ENOENT" });
  } finally {
    await stopWebServer();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
