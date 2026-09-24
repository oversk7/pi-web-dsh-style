import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const source = app.slice(app.indexOf("const terminalProxySettings ="), app.indexOf("let settingsReturnFocus"));

function fixture() {
  const mode = { value: "inherit", disabled: false };
  const url = { value: "", disabled: false, required: false };
  const buttons = [7987, 10808].map((port) => ({ dataset: { proxyPort: String(port) }, disabled: false, onclick() {} }));
  const submit = { disabled: false, textContent: "" };
  const nodes = new Map<string, any>();
  const form: any = {
    elements: { namedItem: (name: string) => name === "mode" ? mode : url },
    querySelectorAll: (selector: string) => selector === "[data-proxy-port]" ? buttons : [mode, url, submit, ...buttons],
  };
  const posts: any[] = [];
  let failSave = false;
  let load: () => Promise<any> = async () => ({ settings: { mode: "inherit", url: "http://127.0.0.1:7987" } });
  const context = createContext({
    S: { localClient: true }, el: () => form,
    $: (selector: string) => {
      if (selector === 'button[type="submit"]') return submit;
      if (!nodes.has(selector)) nodes.set(selector, { hidden: false, textContent: "", classList: { toggle() {} } });
      return nodes.get(selector);
    },
    api: () => load(),
    post: async (path: string, body: any) => {
      posts.push({ path, body });
      if (failSave) throw new Error("保存不可用");
      return { settings: body };
    },
  });
  runInContext(source, context);
  return {
    mode, url, buttons, form, posts, nodes,
    load: () => runInContext("loadTerminalProxySettings()", context),
    save: () => form.onsubmit({ preventDefault() {}, currentTarget: form }),
    fail: () => { failSave = true; },
    setLoad: (fn: () => Promise<any>) => { load = fn; },
    dirty: () => runInContext("terminalProxySettings.dirty", context),
  };
}

test("proxy quick ports fill HTTP addresses and save the selected mode", async () => {
  const view = fixture();
  await view.load();
  assert.equal(view.url.disabled, true);
  view.mode.value = "manual";
  view.form.onchange();
  assert.equal(view.url.disabled, false);
  assert.equal(view.nodes.get(".pi-proxyFields").hidden, false);
  for (const button of view.buttons) {
    button.onclick();
    assert.equal(view.url.value, `http://127.0.0.1:${button.dataset.proxyPort}`);
  }
  await view.save();
  assert.equal(view.posts[0].path, "/api/terminal-proxy");
  assert.equal(view.posts[0].body.mode, "manual");
  assert.equal(view.posts[0].body.url, "http://127.0.0.1:10808");
  assert.equal(view.dirty(), false);
  assert.match(view.nodes.get(".pi-proxyStatus").textContent, /已保存/);
});

test("late proxy load preserves unsaved input and failed saves allow retry", async () => {
  const view = fixture();
  await view.load();
  let resolveLoad: (value: any) => void = () => {};
  view.setLoad(() => new Promise((resolve) => { resolveLoad = resolve; }));
  const loading = view.load();
  view.mode.value = "manual";
  view.url.value = "http://localhost:4321";
  view.form.oninput();
  resolveLoad({ settings: { mode: "inherit", url: "http://127.0.0.1:7987" } });
  await loading;
  assert.equal(view.url.value, "http://localhost:4321");
  view.fail();
  await view.save();
  assert.equal(view.dirty(), true);
  assert.equal(view.url.disabled, false);
  assert.match(view.nodes.get(".pi-proxyStatus").textContent, /保存失败/);
});
