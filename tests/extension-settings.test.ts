import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extensionSettings, togglePackage } from "../extension-settings.ts";

test("package toggles restore extension filters and retain other resources", () => {
  const original = { source: "npm:example", extensions: ["extensions/*.ts", "!extensions/legacy.ts"], skills: ["skills/a"], themes: [] };
  const disabled = togglePackage(original, false);
  assert.deepEqual(typeof disabled === "string" ? null : disabled.extensions, []);
  assert.deepEqual(togglePackage(disabled, true), original);
  assert.deepEqual(togglePackage(disabled, false), disabled);
  assert.deepEqual(original.extensions, ["extensions/*.ts", "!extensions/legacy.ts"]);
  assert.deepEqual(togglePackage({ source: "npm:example", extensions: [], skills: [] }, true), { source: "npm:example", skills: [] });
});

test("global and project package settings are isolated and preserve unrelated fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-extensions-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const globalFile = join(agentDir, "settings.json");
  const projectFile = join(cwd, ".pi", "settings.json");
  await writeFile(globalFile, JSON.stringify({ theme: "dark", packages: ["npm:example"] }));
  await writeFile(projectFile, JSON.stringify({ packages: [{ source: "npm:example", extensions: ["a.ts"], skills: [] }] }));
  try {
    const view = await extensionSettings(cwd, undefined, agentDir);
    assert.equal(view.packages.length, 2);
    await extensionSettings(cwd, { scope: "project", source: "npm:example", enabled: false }, agentDir);
    assert.deepEqual(JSON.parse(await readFile(globalFile, "utf8")), { theme: "dark", packages: ["npm:example"] });
    const disabled = await extensionSettings(cwd, undefined, agentDir);
    assert.equal(disabled.packages[1].enabled, false);
    await extensionSettings(cwd, { scope: "project", source: "npm:example", enabled: true }, agentDir);
    assert.deepEqual(JSON.parse(await readFile(projectFile, "utf8")).packages, [{ source: "npm:example", extensions: ["a.ts"], skills: [] }]);
    await assert.rejects(extensionSettings(cwd, { scope: "global", source: "npm:missing", enabled: false }, agentDir), /配置已变化/);
    await writeFile(globalFile, "broken json");
    await assert.rejects(extensionSettings(cwd, undefined, agentDir));
    assert.equal(await readFile(globalFile, "utf8"), "broken json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
