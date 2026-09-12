import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const source = app.slice(app.indexOf("let browser = null;"), app.indexOf("async function refreshWorkspaces("));
const home = "C:\\Users\\test";
const target = "D:\\Projects";
const root = { name: "D:\\", path: "D:\\", hidden: false };
const entry = { name: "Projects", path: target, hidden: false };
const workspace = { id: "workspace", path: target };

function picker(fail = false) {
  const listeners: Record<string, (event?: unknown) => void> = {};
  const input = {
    value: home, selectionStart: 0, selectionEnd: 0,
    focus() {}, setSelectionRange() {},
    addEventListener: (name: string, listener: (event?: unknown) => void) => { listeners[name] = listener; },
  };
  const mount = { innerHTML: "", removed: false, remove() { this.removed = true; } };
  const requests: string[] = [];
  const opened: string[] = [];
  let adopted: unknown;
  const context = createContext({
    initialBrowser: {
      parent: { path: home, home, crumbs: [{ name: home, path: home }], entries: [] },
      selected: null, child: null, home, loading: false, error: null,
      pathDraft: null, showHidden: false, folderDraft: null, creatingFolder: false,
      createError: null, busy: false,
    },
    S: { workspaces: [] },
    $: (selector: string) => selector === "#workspacePickerMount" ? mount
      : selector === "#dbPathInput" && mount.innerHTML.includes('id="dbPathInput"') ? input : null,
    esc: (value: unknown) => String(value ?? ""),
    ICONS: { folder: "", folderOpen: "", chevron: "", edit: "", plus: "", check: "" },
    api: async (url: string) => {
      const path = new URL(url, "http://localhost").searchParams.get("path");
      assert.ok(path);
      requests.push(path);
      if (fail) return { error: "directory missing" };
      if (path === target) return { path, home, crumbs: [root, entry], entries: [] };
      assert.equal(path, root.path);
      return { path, home, crumbs: [root], entries: [entry] };
    },
    post: async (url: string, body: { path: string }) => {
      assert.equal(url, "/api/workspaces");
      opened.push(body.path);
      return { workspace };
    },
    refreshWorkspaces: async () => [workspace],
    resolvePicker: (value: unknown) => { adopted = value; },
  });
  runInContext(`${source}\nbrowser = initialBrowser; pickerResolve = resolvePicker; openPathEditor();`, context);
  return {
    mount, requests, opened,
    adopted: () => adopted,
    openButton: () => mount.innerHTML.match(/<button[^>]*data-action="db-open"[^>]*>/)?.[0] ?? "",
    newFolderButton: () => mount.innerHTML.match(/<button[^>]*data-action="db-new-folder"[^>]*>/)?.[0] ?? "",
    enter: async (path: string) => {
      input.value = path;
      input.selectionStart = input.selectionEnd = path.length;
      listeners.input();
      listeners.keydown({ key: "Enter", preventDefault() {} });
      await setImmediate();
    },
    open: () => runInContext("adoptWorkspace()", context),
  };
}

test("entering a D drive path exits editing and opens the selected workspace", async () => {
  const view = picker();
  assert.match(view.openButton(), /disabled/);
  await view.enter(target);
  assert.deepEqual(view.requests, [target, root.path]);
  assert.doesNotMatch(view.mount.innerHTML, /id="dbPathInput"/);
  assert.match(view.openButton(), /data-action="db-open"/);
  assert.doesNotMatch(view.openButton(), /disabled/);
  assert.doesNotMatch(view.newFolderButton(), /disabled/);
  assert.deepEqual(view.opened, []);
  await view.open();
  assert.deepEqual(view.opened, [target]);
  assert.equal(view.adopted(), workspace);
  assert.equal(view.mount.removed, true);
});

test("an invalid typed path stays editable and cannot open the previous directory", async () => {
  const view = picker(true);
  const missing = "D:\\Missing";
  await view.enter(missing);
  assert.deepEqual(view.requests, [missing]);
  assert.match(view.mount.innerHTML, /directory missing/);
  assert.match(view.mount.innerHTML, /id="dbPathInput"/);
  assert.ok(view.mount.innerHTML.includes(`value="${missing}"`));
  assert.match(view.openButton(), /disabled/);
  assert.match(view.newFolderButton(), /disabled/);
  await view.open();
  assert.deepEqual(view.opened, []);
  assert.equal(view.mount.removed, false);
});
