import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const layoutSource = app.slice(app.indexOf("function clampPanelWidth("), app.indexOf("function fileNameFromPath("));
const previewSource = app.slice(app.indexOf("let filePreviewReturnFocus"), app.indexOf("function renderApp("));
const clickSource = app.slice(app.indexOf("async function onClick("), app.indexOf("function moveWorkspace("));
const keySource = app.slice(app.indexOf("function onGlobalKeydown("), app.indexOf("function onWarmHover("));

for (const [width, touch, fullscreen] of [[390, true, true], [844, true, true], [800, false, false], [1280, false, false]] as const) {
  test(`file preview at ${width}px with touch=${touch} isolates the conversation only when fullscreen`, () => {
    const attributes = new Map<string, string>();
    const sidebar = { inert: false };
    const conversation = { inert: false };
    const preview = {
      inert: false,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
    };
    const frame = { clientWidth: width, dataset: {}, style: { setProperty() {} }, toggleAttribute() {} };
    const nodes: Record<string, unknown> = { ".pI_x6G_frame": frame, ".pI_x6G_sidebarCol": sidebar, ".pI_x6G_centerCol": conversation, ".pI_x6G_detailsCol": preview };
    const state = { filePreview: {} as object | null, mobileSidebarOpen: false, sidebarWidth: 280, filePreviewWidth: 520 };
    const context = createContext({
      S: state, $: (selector: string) => nodes[selector],
      matchMedia: (query: string) => ({ matches: query.includes("pointer") ? width <= 640 || (touch && width <= 900) : width <= 640 }),
    });
    runInContext(`${layoutSource}\napplyFrameLayout()`, context);
    assert.equal(conversation.inert, fullscreen);
    assert.equal(preview.inert, false);
    assert.equal(attributes.get("aria-modal"), fullscreen ? "true" : undefined);
    assert.equal(attributes.get("role"), fullscreen ? "dialog" : undefined);
    state.filePreview = null;
    runInContext("applyFrameLayout()", context);
    assert.equal(conversation.inert, false);
    assert.equal(preview.inert, true);
    assert.equal(sidebar.inert, width <= 640);
    assert.equal(attributes.has("aria-modal"), false);
  });
}

function previewFixture() {
  let requests = 0;
  let previewFocused = 0;
  let linkFocused = 0;
  let resolveRequest: (value: unknown) => void = () => {};
  const state = { filePreview: null as null | { path: string; line?: number; loading?: boolean }, filePreviewGeneration: 0, mobileSidebarOpen: true, draft: "unsent draft" };
  const link = { isConnected: true, focus: (options: object) => { assert.equal((options as { preventScroll: boolean }).preventScroll, true); linkFocused += 1; } };
  const context = createContext({
    S: state, document: { activeElement: link }, link, usesMobileFilePreview: () => true,
    $: () => ({ focus: () => { previewFocused += 1; } }),
    fileNameFromPath: (path: string) => path.split("/").at(-1),
    renderFilePreview() {}, applyFrameLayout() {}, requestAnimationFrame() {}, scrollFilePreviewToLine() {},
    api: () => { requests += 1; return new Promise(resolve => { resolveRequest = resolve; }); },
  });
  runInContext(previewSource, context);
  return {
    state, context,
    open: (): Promise<void> => runInContext('openFilePreview("D:/project/file.ts", 30, "/api/fs/view", link)', context),
    close: () => runInContext("closeFilePreview()", context),
    resolve: () => resolveRequest({ path: "D:/project/file.ts", highlightedHtml: "source" }),
    counts: () => ({ requests, previewFocused, linkFocused }),
  };
}

test("mobile preview focuses the panel, reuses the same file, and returns to the link without changing the draft", async () => {
  const view = previewFixture();
  const opening = view.open();
  assert.equal(view.state.mobileSidebarOpen, false);
  assert.equal(view.state.filePreview?.loading, true);
  view.resolve();
  await opening;
  assert.equal(view.state.filePreview?.line, 30);
  await view.open();
  assert.equal(view.counts().requests, 1);
  view.close();
  assert.equal(view.state.filePreview, null);
  assert.equal(view.state.draft, "unsent draft");
  assert.deepEqual(view.counts(), { requests: 1, previewFocused: 2, linkFocused: 1 });
});

test("closing a mobile preview while loading prevents its late response from reopening it", async () => {
  const view = previewFixture();
  const opening = view.open();
  view.close();
  view.resolve();
  await opening;
  assert.equal(view.state.filePreview, null);
  assert.equal(view.counts().linkFocused, 1);
});

test("a local file link opens in the preview and supplies the link for focus restoration", async () => {
  const link = { dataset: { filePath: "D:/project/file.ts", fileLine: "30" }, href: "/api/fs/view?path=file" };
  let prevented = false;
  let args: unknown[] = [];
  await runInContext(`${clickSource}\nonClick(event)`, createContext({
    S: {}, closePopovers() {}, openFilePreview: async (...values: unknown[]) => { args = values; },
    event: { target: { closest: (selector: string) => selector === "a.md-local-file" ? link : null }, preventDefault: () => { prevented = true; } },
  }));
  assert.equal(prevented, true);
  assert.deepEqual(args, ["D:/project/file.ts", 30, link.href, link]);
});

test("Escape closes the fullscreen preview before handling the underlying conversation", () => {
  let closed = false;
  let prevented = false;
  runInContext(`${keySource}\nonGlobalKeydown(event)`, createContext({
    S: { filePreview: {} }, usesMobileFilePreview: () => true, closeFilePreview: () => { closed = true; },
    event: { key: "Escape", target: { closest: () => null }, preventDefault: () => { prevented = true; } },
  }));
  assert.equal(closed, true);
  assert.equal(prevented, true);
});
