import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const source = app.slice(app.indexOf("const extensionSettingsState ="), app.indexOf("let settingsReturnFocus"));
const escapeSource = app.slice(app.indexOf("function esc("), app.indexOf("function el("));

test("extension UI escapes sources, submits exact scope, and exposes save failures", async () => {
  const mount = { innerHTML: "" };
  const refresh = { onclick: null };
  const button = { dataset: { extensionIndex: "0" }, onclick: null };
  const calls: unknown[] = [];
  let fail = false;
  const data = { cwd: "D:/project", packages: [{ source: "npm:<example>", scope: "project", enabled: true }] };
  const context = createContext({
    S: {},
    $: (selector: string) => selector === "#webExtensionsMount" ? mount : refresh,
    $$: () => [button],
    api: async () => data,
    post: async (path: string, change: unknown) => {
      calls.push({ path, change });
      if (fail) throw new Error("保存失败");
      return { ...data, packages: [{ ...data.packages[0], enabled: false }] };
    },
  });
  runInContext(`${escapeSource}\n${source}`, context);
  await runInContext("loadExtensionSettings()", context);
  assert.match(mount.innerHTML, /npm:&lt;example&gt;/);
  assert.match(mount.innerHTML, /停用/);
  await runInContext('loadExtensionSettings({ scope: "project", source: "npm:<example>", enabled: false })', context);
  assert.equal(JSON.stringify(calls[0]), JSON.stringify({ path: "/api/extensions", change: { scope: "project", source: "npm:<example>", enabled: false } }));
  assert.match(mount.innerHTML, /已保存/);
  assert.match(mount.innerHTML, /已停用/);
  fail = true;
  await runInContext('loadExtensionSettings({ scope: "project", source: "npm:<example>", enabled: true })', context);
  assert.match(mount.innerHTML, /保存失败/);
  assert.match(mount.innerHTML, /已停用/);
  assert.equal(runInContext("extensionSettingsState.busy", context), false);
});
