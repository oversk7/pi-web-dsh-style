import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const source = app.slice(app.indexOf("let browser = null;"), app.indexOf("async function refreshWorkspaces("));
const home = "C:\\Users\\test";
const target = "D:\\Projects";
const deepTarget = "C:\\Users\\adoss\\OneDrive - qr.com.qa\\02 Areas\\Test\\Test 22";

type Listing = ReturnType<typeof listing>;
function listing(path: string, children: string[] = []) {
  const crumbs: { name: string; path: string; hidden: boolean }[] = [];
  for (let current = path; ; current = win32.dirname(current)) {
    const root = win32.dirname(current) === current;
    crumbs.unshift({ name: root ? current : win32.basename(current), path: current, hidden: false });
    if (root) break;
  }
  return { path, home, crumbs, entries: children.map((name) => ({ name, path: win32.join(path, name), hidden: false })) };
}

function picker(options: { fail?: boolean; target?: string; list?: (path: string) => Promise<Listing> } = {}) {
  const selectedPath = options.target ?? target;
  const parentPath = win32.dirname(selectedPath);
  const workspace = { id: "workspace", path: selectedPath };
  const listeners: Record<string, (event?: unknown) => void> = {};
  const input = {
    value: home, selectionStart: 0, selectionEnd: 0,
    focus() {},
    setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; },
    addEventListener: (name: string, listener: (event?: unknown) => void) => { listeners[name] = listener; },
  };
  const mount = { innerHTML: "", removed: false, remove() { this.removed = true; } };
  const requests: string[] = [];
  const opened: string[] = [];
  let adopted: unknown;
  const context = createContext({
    initialBrowser: {
      parent: listing(home),
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
      if (options.fail) return { error: "directory missing" };
      if (options.list) return options.list(path);
      const normalized = win32.normalize(path).replace(/\\$/, "").toLowerCase();
      if (normalized === selectedPath.toLowerCase()) return listing(selectedPath, ["child-folder"]);
      assert.equal(normalized, parentPath.replace(/\\$/, "").toLowerCase());
      return listing(parentPath, [win32.basename(selectedPath), "unrelated-folder"]);
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
  const type = (path: string) => {
    input.value = path;
    input.selectionStart = input.selectionEnd = path.length;
    listeners.input();
  };
  const submit = () => listeners.keydown({ key: "Enter", preventDefault() {} });
  return {
    mount, requests, opened, input, type, submit,
    adopted: () => adopted,
    state: () => runInContext("browser", context),
    openButton: () => mount.innerHTML.match(/<button[^>]*data-action="db-open"[^>]*>/)?.[0] ?? "",
    newFolderButton: () => mount.innerHTML.match(/<button[^>]*data-action="db-new-folder"[^>]*>/)?.[0] ?? "",
    enter: async (path: string) => {
      type(path);
      submit();
      await setImmediate();
    },
    edit: () => runInContext("openPathEditor()", context),
    cancelEdit: () => runInContext("cancelPathEdit()", context),
    select: () => runInContext("selectEntry(browser.parent.entries[0])", context),
    open: () => runInContext("adoptWorkspace()", context),
  };
}

for (const path of [target, deepTarget, `${deepTarget}\\`]) {
  test(`entering ${path} exits editing and opens the selected workspace`, async () => {
    const view = picker({ target: path.replace(/\\$/, "") });
    assert.match(view.openButton(), /disabled/);
    await view.enter(path);
    assert.ok(view.requests.includes(path));
    assert.equal(view.state().selected.path, path.replace(/\\$/, ""));
    assert.doesNotMatch(view.mount.innerHTML, /id="dbPathInput"/);
    assert.doesNotMatch(view.openButton(), /disabled/);
    assert.doesNotMatch(view.newFolderButton(), /disabled/);
    assert.deepEqual(view.opened, []);
    await view.open();
    assert.deepEqual(view.opened, [path.replace(/\\$/, "")]);
    assert.deepEqual(view.adopted(), { id: "workspace", path: path.replace(/\\$/, "") });
    assert.equal(view.mount.removed, true);
  });
}

test("pasting a deep path loads its parent and narrows the list before Enter", async () => {
  const view = picker({ target: deepTarget });
  view.type(deepTarget);
  await setImmediate();
  assert.deepEqual(view.requests, [`${win32.dirname(deepTarget)}\\`]);
  assert.equal(view.state().parent.path, win32.dirname(deepTarget));
  assert.match(view.mount.innerHTML, /Test 22/);
  assert.doesNotMatch(view.mount.innerHTML, /unrelated-folder/);
  assert.match(view.mount.innerHTML, /id="dbPathInput"/);
  assert.equal(view.input.selectionStart, deepTarget.length);
  assert.match(view.openButton(), /disabled/);
  view.type(`${deepTarget.slice(0, -1)}`);
  await setImmediate();
  assert.equal(view.requests.length, 1, "editing the leaf filters the loaded parent without another request");
});

test("clicking the folder found by a pasted path finishes editing and allows opening it", async () => {
  const view = picker({ target: deepTarget });
  view.type(deepTarget);
  await setImmediate();
  await view.select();
  assert.equal(view.state().pathDraft, null);
  assert.equal(view.state().selected.path, deepTarget);
  assert.doesNotMatch(view.openButton(), /disabled/);
  await view.open();
  assert.deepEqual(view.opened, [deepTarget]);
});

test("a trailing separator previews the pasted directory's contents", async () => {
  const view = picker({ target: deepTarget });
  view.type(`${deepTarget}\\`);
  await setImmediate();
  assert.equal(view.state().parent.path, deepTarget);
  assert.match(view.mount.innerHTML, /child-folder/);
});

test("Windows case and forward slashes still narrow the loaded directory", async () => {
  const view = picker({ target: deepTarget });
  view.type(deepTarget.toLowerCase().replaceAll("\\", "/"));
  await setImmediate();
  assert.doesNotMatch(view.mount.innerHTML, /unrelated-folder/);
});

test("an invalid typed path stays editable and cannot open the previous directory", async () => {
  const view = picker({ fail: true });
  const missing = "D:\\Missing";
  await view.enter(missing);
  assert.ok(view.requests.includes(missing));
  assert.match(view.mount.innerHTML, /directory missing/);
  assert.match(view.mount.innerHTML, /id="dbPathInput"/);
  assert.ok(view.mount.innerHTML.includes(`value="${missing}"`));
  assert.match(view.openButton(), /disabled/);
  assert.match(view.newFolderButton(), /disabled/);
  await view.open();
  assert.deepEqual(view.opened, []);
  assert.equal(view.mount.removed, false);
});

test("preview errors stay visible while the pasted path remains editable", async () => {
  const view = picker({ fail: true });
  view.type(deepTarget);
  await setImmediate();
  assert.match(view.mount.innerHTML, /directory missing/);
  assert.equal(view.state().pathDraft, deepTarget);
  assert.equal(view.state().loading, false);
});

test("a late row listing cannot overwrite a newer pasted path", async () => {
  const pending: ((value: Listing) => void)[] = [];
  const view = picker({ list: () => new Promise((resolve) => pending.push(resolve)) });
  view.type(target);
  pending[0](listing("D:\\", ["Projects"]));
  await setImmediate();
  const selecting = view.select();
  view.edit();
  view.type(deepTarget);
  pending[2](listing(win32.dirname(deepTarget), ["Test 22"]));
  await setImmediate();
  pending[1](listing(target, ["old-child"]));
  await selecting;
  assert.equal(view.state().parent.path, win32.dirname(deepTarget));
  assert.equal(view.state().child, null);
  assert.equal(view.state().pathDraft, deepTarget);
  assert.doesNotMatch(view.mount.innerHTML, /old-child/);
});

test("cancelling after Enter invalidates the pending navigation", async () => {
  const pending: ((value: Listing) => void)[] = [];
  const view = picker({ list: () => new Promise((resolve) => pending.push(resolve)) });
  view.type(deepTarget);
  view.submit();
  view.cancelEdit();
  pending[0](listing(win32.dirname(deepTarget), ["Test 22"]));
  pending[1](listing(deepTarget));
  await setImmediate();
  assert.equal(pending.length, 2, "cancelled navigation must not request the target's parent");
  assert.equal(view.state().parent.path, home);
  assert.equal(view.state().pathDraft, null);
  assert.equal(view.state().loading, false);
});

test("late path previews cannot replace a newer path or resume cancelled editing", async () => {
  const pending: ((value: Listing) => void)[] = [];
  const view = picker({ list: () => new Promise((resolve) => pending.push(resolve)) });
  view.type(deepTarget);
  view.type(target);
  pending[1](listing("D:\\", ["Projects"]));
  await setImmediate();
  pending[0](listing(win32.dirname(deepTarget), ["Test 22"]));
  await setImmediate();
  assert.equal(view.state().parent.path, "D:\\");
  assert.equal(view.state().pathDraft, target);

  view.type(deepTarget);
  view.cancelEdit();
  pending[2](listing(win32.dirname(deepTarget), ["Test 22"]));
  await setImmediate();
  assert.equal(view.state().parent.path, "D:\\");
  assert.equal(view.state().pathDraft, null);
  assert.equal(view.state().loading, false);
});
