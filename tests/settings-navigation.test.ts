import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const settingsSource = app.slice(app.indexOf("const SETTINGS_TABS ="), app.indexOf("function renderOverlay("));
const keydownSource = app.slice(app.indexOf("function onGlobalKeydown("), app.indexOf("function onWarmHover("));
const escapeSource = app.slice(app.indexOf("function esc("), app.indexOf("function el("));

function navigation() {
  let focused = "";
  const ids = ["appearance", "network", "proxy", "security", "extensions", "maintenance"];
  const tabs = ids.map((id) => ({
    dataset: { settingsTab: id }, tabIndex: id === "appearance" ? 0 : -1,
    selected: String(id === "appearance"),
    setAttribute(name: string, value: string) { if (name === "aria-selected") this.selected = value; },
    focus() { focused = id; },
  }));
  const pages = ids.map((id) => ({ dataset: { settingsPage: id }, hidden: id !== "appearance" }));
  const content = { scrollTop: 100 };
  const overlay = { set innerHTML(_: string) { assert.fail("Switching categories must preserve the form DOM"); } };
  const state = { settingsOpen: true, settingsTab: "appearance" };
  const context = createContext({
    S: state, matchMedia: () => ({ matches: false }),
    $: (selector: string) => selector === "#overlayMount" ? overlay : selector === ".pi-settingsNav" ? { setAttribute() {} } : content,
    $$: (selector: string) => selector === "[data-settings-tab]" ? tabs : pages,
  });
  runInContext(`${settingsSource}\n${keydownSource}`, context);
  return { context, state, tabs, pages, content, focused: () => focused };
}

test("settings navigation selects one category without rebuilding forms", () => {
  const view = navigation();
  runInContext('selectSettingsTab("network", true)', view.context);
  assert.equal(view.state.settingsTab, "network");
  assert.deepEqual(view.pages.filter((page) => !page.hidden).map((page) => page.dataset.settingsPage), ["network"]);
  assert.deepEqual(view.tabs.filter((tab) => tab.tabIndex === 0).map((tab) => tab.dataset.settingsTab), ["network"]);
  assert.equal(view.tabs[1].selected, "true");
  assert.equal(view.content.scrollTop, 0);
  assert.equal(view.focused(), "network");
  runInContext('selectSettingsTab("proxy", true)', view.context);
  assert.equal(view.state.settingsTab, "proxy");
  assert.deepEqual(view.pages.filter((page) => !page.hidden).map((page) => page.dataset.settingsPage), ["proxy"]);
  runInContext('selectSettingsTab("unknown", true)', view.context);
  assert.equal(view.state.settingsTab, "proxy");
});

test("settings keyboard navigation wraps and supports Home and End", () => {
  const view = navigation();
  let prevented = 0;
  for (const [current, key, expected] of [["appearance", "ArrowLeft", "maintenance"], ["maintenance", "ArrowDown", "appearance"], ["network", "End", "maintenance"], ["security", "Home", "appearance"]]) {
    view.context.event = {
      key, preventDefault() { prevented += 1; },
      target: { closest: (selector: string) => selector === "[data-settings-tab]" ? { dataset: { settingsTab: current } } : null },
    };
    runInContext("onGlobalKeydown(event)", view.context);
    assert.equal(view.state.settingsTab, expected);
    assert.equal(view.focused(), expected);
  }
  assert.equal(prevented, 4);
});

test("remote settings keep appearance and maintenance available without local credential forms", () => {
  const html = runInContext(`${escapeSource}\n${settingsSource}\nrenderSettings()`, createContext({
    S: { localClient: false, settingsTab: "security", theme: "dark" },
    ICONS: {}, matchMedia: () => ({ matches: true }),
  }));
  assert.doesNotMatch(html, /id="webPasswordForm"|id="webNetworkMount"|id="webTerminalProxyMount"/);
  assert.match(html, /data-action="maintenance-reload"/);
  assert.match(html, /data-theme="dark" aria-pressed="true"/);
  assert.match(html, /id="pi-settings-tab-security"[^>]*aria-selected="true"/);
  assert.match(html, /aria-orientation="horizontal"/);
});
