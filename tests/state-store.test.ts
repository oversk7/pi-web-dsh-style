import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnPiRpc } from "../pi-rpc.ts";
import { loadJsonWithLegacyMigration, writeJsonAtomically } from "../state-store.ts";

interface TestState {
  version: 1;
  workspaces: unknown[];
  sessions: unknown[];
  marker?: string;
}

function isTestState(value: unknown): value is TestState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<TestState>;
  return state.version === 1 && Array.isArray(state.workspaces) && Array.isArray(state.sessions);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-state-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("migrates legacy state without changing the source", async () => {
  await withTempDir(async (dir) => {
    const legacy = join(dir, "legacy", "state.json");
    const current = join(dir, "current", "state.json");
    const raw = `${JSON.stringify({ version: 1, workspaces: [], sessions: [], marker: "legacy" }, null, 2)}\n`;
    await writeJsonAtomically(legacy, JSON.parse(raw));
    const sourceBefore = await readFile(legacy, "utf8");

    const loaded = await loadJsonWithLegacyMigration({ stateFile: current, legacyStateFile: legacy, validate: isTestState });

    assert.equal(loaded?.marker, "legacy");
    assert.equal(await readFile(current, "utf8"), sourceBefore);
    assert.equal(hash(await readFile(legacy, "utf8")), hash(sourceBefore));
  });
});

test("prefers an existing current state over legacy state", async () => {
  await withTempDir(async (dir) => {
    const legacy = join(dir, "legacy.json");
    const current = join(dir, "current.json");
    await writeJsonAtomically(legacy, { version: 1, workspaces: [], sessions: [], marker: "legacy" });
    await writeJsonAtomically(current, { version: 1, workspaces: [], sessions: [], marker: "current" });

    const loaded = await loadJsonWithLegacyMigration({ stateFile: current, legacyStateFile: legacy, validate: isTestState });

    assert.equal(loaded?.marker, "current");
  });
});

test("rejects corrupt current state instead of restoring stale legacy data", async () => {
  await withTempDir(async (dir) => {
    const legacy = join(dir, "legacy.json");
    const current = join(dir, "current.json");
    await writeJsonAtomically(legacy, { version: 1, workspaces: [], sessions: [], marker: "legacy" });
    await writeFile(current, "{broken", "utf8");

    await assert.rejects(
      loadJsonWithLegacyMigration({ stateFile: current, legacyStateFile: legacy, validate: isTestState }),
      /Invalid JSON in pi-web state/,
    );
    assert.equal(await readFile(current, "utf8"), "{broken");
  });
});

test("closes a stalled rpc child instead of waiting forever", async () => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.json");
    const rpc = spawnPiRpc({ cwd: dir, sessionFile, name: "stall-test" });
    const closed = rpc.close(1);
    await assert.doesNotReject(closed);
  });
});
