import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
const themeSource = app.slice(app.indexOf("function applyTheme("), app.indexOf("const ICONS ="));
const listenerSource = app.slice(app.indexOf('matchMedia("(prefers-color-scheme: dark)").addEventListener'), app.indexOf("updateViewport();\nbindGlobalEvents();"));

function appearance(saved: Record<string, string> = {}, dark = false) {
  const storage = new Map(Object.entries(saved));
  const attributes = new Set<string>();
  const body = {
    dataset: {} as Record<string, string>,
    toggleAttribute(name: string, enabled: boolean) { enabled ? attributes.add(name) : attributes.delete(name); },
    hasAttribute(name: string) { return attributes.has(name); },
  };
  let listener = () => {};
  const media = { matches: dark, addEventListener(_: string, callback: () => void) { listener = callback; } };
  const document = { body, documentElement: { style: { colorScheme: "" } } };
  const state = { theme: saved["pi-web-theme"] || "system", themeStyle: saved["pi-web-theme-style"] || "classic" };
  const context = createContext({
    document, S: state, matchMedia: () => media,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
  });
  runInContext(`${themeSource}\n${listenerSource}`, context);
  return { context, storage, document, state, media, changeSystem(value: boolean) { media.matches = value; listener(); } };
}

test("style and brightness are independent, persist, and restore before app rendering", () => {
  const view = appearance({ "pi-web-theme": "dark" });
  runInContext('setThemeStyle("sakura")', view.context);
  assert.equal(view.document.body.dataset.themeStyle, "sakura");
  assert.equal(view.document.documentElement.style.colorScheme, "dark");
  runInContext('setTheme("light"); setThemeStyle("starlight")', view.context);
  assert.equal(view.state.theme, "light");
  assert.equal(view.storage.get("pi-web-theme-style"), "starlight");
  const restored = appearance(Object.fromEntries(view.storage));
  runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], restored.context);
  assert.equal(restored.document.body.dataset.themeStyle, "starlight");
  assert.equal(restored.document.documentElement.style.colorScheme, "light");
  runInContext('setThemeStyle("classic")', view.context);
  assert.equal(view.document.body.dataset.themeStyle, "classic");
});

test("system changes update brightness while preserving the selected style and explicit modes", () => {
  const view = appearance();
  runInContext('setThemeStyle("sakura"); setTheme("system")', view.context);
  view.changeSystem(true);
  assert.equal(view.document.body.hasAttribute("data-ds-dark-theme"), true);
  assert.equal(view.document.body.dataset.themeStyle, "sakura");
  view.changeSystem(false);
  assert.equal(view.document.body.hasAttribute("data-ds-dark-theme"), false);
  runInContext('setTheme("dark")', view.context);
  view.changeSystem(false);
  assert.equal(view.document.documentElement.style.colorScheme, "dark");
  runInContext("toggleTheme()", view.context);
  assert.equal(view.state.theme, "light");
  assert.equal(view.state.themeStyle, "sakura");
});

test("custom backgrounds reject unsupported files and images over 10 MB", async () => {
  const view = appearance();
  view.context.file = { type: "image/svg+xml", size: 100 };
  await assert.rejects(runInContext("prepareBackground(file)", view.context), /PNG、JPEG 或 WebP/);
  view.context.file = { type: "image/png", size: 10 * 1024 * 1024 + 1 };
  await assert.rejects(runInContext("prepareBackground(file)", view.context), /10 MB/);
});

test("custom background changes commit to storage before replacing the visible image", async () => {
  const source = app.slice(app.indexOf("async function changeCustomBackground("), app.indexOf("const ICONS ="));
  const events: string[] = [];
  const state = { backgroundBusy: false, backgroundError: "", backgroundUrl: "blob:previous" };
  const background = { blob: {}, name: "new.png" };
  const context = createContext({
    S: state, file: {}, renderOverlay() {}, prepareBackground: async () => background,
    backgroundStorage: async (_: string, value: unknown) => { assert.equal(value, background); events.push("saved"); },
    applyCustomBackground: () => { events.push("applied"); },
  });
  await runInContext(`${source}\nchangeCustomBackground(file)`, context);
  assert.deepEqual(events, ["saved", "applied"]);
  context.backgroundStorage = async () => { throw new Error("storage unavailable"); };
  events.length = 0;
  await runInContext("changeCustomBackground(file)", context);
  assert.deepEqual(events, []);
  assert.equal(state.backgroundUrl, "blob:previous");
  assert.equal(state.backgroundBusy, false);
  assert.match(state.backgroundError, /背景未更改/);
});

test("replacing and clearing custom backgrounds release old image URLs", () => {
  const view = appearance();
  const revoked: string[] = [];
  const properties = new Map<string, string>();
  view.context.document.body.style = {
    setProperty: (name: string, value: string) => properties.set(name, value),
    removeProperty: (name: string) => properties.delete(name),
  };
  view.context.URL = { createObjectURL: () => "blob:new", revokeObjectURL: (url: string) => revoked.push(url) };
  view.context.S.backgroundUrl = "blob:previous";
  runInContext('applyCustomBackground({blob: {}, name: "picture.png"})', view.context);
  assert.equal(view.document.body.hasAttribute("data-custom-background"), true);
  assert.equal(properties.get("--pi-background-image"), 'url("blob:new")');
  runInContext("applyCustomBackground(null)", view.context);
  assert.equal(view.document.body.hasAttribute("data-custom-background"), false);
  assert.equal(properties.has("--pi-background-image"), false);
  assert.deepEqual(revoked, ["blob:previous", "blob:new"]);
});

test("unknown saved preferences use the same defaults at boot and in settings", () => {
  const view = appearance({ "pi-web-theme": "unknown", "pi-web-theme-style": "retired" }, true);
  runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], view.context);
  assert.equal(view.document.documentElement.style.colorScheme, "dark");
  assert.equal(view.document.body.dataset.themeStyle, "classic");
  runInContext("setTheme(S.theme); setThemeStyle(S.themeStyle)", view.context);
  assert.equal(view.state.theme, "system");
  assert.equal(view.state.themeStyle, "classic");
  assert.equal(view.document.documentElement.style.colorScheme, "dark");
});
