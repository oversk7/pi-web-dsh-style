import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { buildFilePreview } from "../file-preview.ts";
import { markdown } from "../web/markdown.ts";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const escapeSource = app.slice(app.indexOf("function esc("), app.indexOf("function el("));
const previewSource = app.slice(app.indexOf("function fileNameFromPath("), app.indexOf("async function openFilePreview("));
const clickSource = app.slice(app.indexOf("async function onClick("), app.indexOf("function moveWorkspace("));

function renderMarkdown(text: string): string {
  return markdown(text).replace(/>\n(?=<)/g, ">").trim();
}

test("ordered lists keep numbering across blank lines, paragraphs and nested lists", () => {
  const html = renderMarkdown("1. first\n\n   explanation\n\n   - nested\n   - second nested\n\n2. second\n\n3. third");
  assert.equal((html.match(/<ol>/g) || []).length, 1);
  assert.equal((html.match(/<li>/g) || []).length, 5);
  assert.match(html, /<li><p>first<\/p><p>explanation<\/p><ul>/);
  assert.match(html, /<\/ul><\/li><li><p>second/);
  assert.match(html, /third<\/p><\/li><\/ol>$/);
});

test("repeated 1 markers form one list and explicit starting numbers survive separate lists", () => {
  assert.equal((renderMarkdown("1. a\n\n1. b\n\n1. c").match(/<ol>/g) || []).length, 1);
  const html = renderMarkdown("2. second\n\nOutside paragraph\n\n3. third");
  assert.match(html, /^<ol start="2">/);
  assert.match(html, /<\/ol><p>Outside paragraph<\/p><ol start="3">/);
  assert.equal(renderMarkdown("+ a\n+ b").startsWith("<ul>"), true);
});

test("nested ordered lists and fenced code remain inside their parent item", () => {
  const html = renderMarkdown("1. parent\n   1. child\n   2. child\n\n   ```js\n   const x = '<tag>';\n   ```\n\n2. next");
  assert.equal((html.match(/<ol>/g) || []).length, 2);
  assert.match(html, /<div class="md-code-language">js<\/div>/);
  assert.match(html, /class="hljs-keyword">const<\/span>/);
  assert.match(html, /&lt;tag&gt;/);
  assert.match(html, /<\/pre><\/div><\/li><li>/);
});

test("assistant text blocks render bold list labels after streaming delimiters arrive", () => {
  const source = app.slice(app.indexOf("function renderBlock("), app.indexOf("function renderWorkspaceMenu("));
  const block = { type: "text", text: "- **重点：" };
  const context = createContext({ markdown, block });
  runInContext(source, context);
  assert.match(runInContext("renderBlock(block, {}, 0, 0)", context), /<li>\*\*重点：<\/li>/);
  block.text += "**English\n- **数量：**123";
  const html = runInContext("renderBlock(block, {}, 0, 0)", context);
  assert.match(html, /data-chat-flow-kind="assistant-text"/);
  assert.match(html, /<ul>\n<li><strong>重点：<\/strong>English<\/li>\n<li><strong>数量：<\/strong>123<\/li>\n<\/ul>/);
  assert.doesNotMatch(html, /\*\*/);
});

test("Markdown previews render by default and source mode retains line highlighting", () => {
  const preview = { ...buildFilePreview("D:\\project\\note.md", Buffer.from("# Title\n\n1. one\n\n2. two")), line: 3, mode: "rendered" };
  const mount = { innerHTML: "" };
  const context = createContext({ S: { filePreview: preview }, $: () => mount, ICONS: { folderOpen: "" }, markdown });
  runInContext(`${escapeSource}\n${previewSource}\nrenderFilePreview()`, context);
  assert.match(mount.innerHTML, /<h1>Title<\/h1>/);
  assert.match(mount.innerHTML, /pi-filePreviewMarkdown/);
  assert.doesNotMatch(mount.innerHTML, /pi-filePreviewSource/);
  preview.mode = "source";
  runInContext("renderFilePreview()", context);
  assert.match(mount.innerHTML, /data-active-line="3"/);
  assert.match(mount.innerHTML, /pi-filePreviewSource/);
});

test("HTML previews use an opaque sandbox and source content cannot escape the iframe attribute", () => {
  const content = '<h1>Page</h1><script>window.example = true</script><div title="quoted">';
  const preview = buildFilePreview("D:\\project\\page.html", Buffer.from(content));
  const mount = { innerHTML: "" };
  runInContext(`${escapeSource}\n${previewSource}\nrenderFilePreview()`, createContext({ S: { filePreview: preview }, $: () => mount, ICONS: { folderOpen: "" } }));
  assert.match(mount.innerHTML, /<iframe[^>]*sandbox="allow-scripts"/);
  assert.doesNotMatch(mount.innerHTML, /allow-same-origin|<script>/);
  assert.match(mount.innerHTML, /Content-Security-Policy/);
  assert.match(mount.innerHTML, /&lt;h1&gt;Page&lt;\/h1&gt;/);
  assert.match(mount.innerHTML, /&quot;quoted&quot;/);
});

test("outside clicks dismiss menus even when the clicked element has its own action", async () => {
  let closed = 0;
  let layout = 0;
  const target = { dataset: { action: "file-preview-close" } };
  const context = createContext({
    S: {}, closePopovers: () => { closed += 1; }, closeFilePreview: () => { layout += 1; },
    event: { target: { closest: (selector: string) => selector === "[data-action]" ? target : null } },
  });
  await runInContext(`${clickSource}\nonClick(event)`, context);
  assert.equal(closed, 1);
  assert.equal(layout, 1);
});

test("touch pointerdown outside menus dismisses them; touching an option preserves it for click", () => {
  const source = app.slice(app.indexOf("function onGlobalPointerDown("), app.indexOf("function persistPanelWidth("));
  let closed = 0;
  let resized = 0;
  const context = createContext({
    closePopovers: () => { closed += 1; }, onPanelResizeStart: () => { resized += 1; },
    outside: { target: { closest: () => null } }, inside: { target: { closest: () => ({}) } },
  });
  runInContext(`${source}\nonGlobalPointerDown(outside); onGlobalPointerDown(inside)`, context);
  assert.equal(closed, 1);
  assert.equal(resized, 2);
});

test("workspace reveal sends the selected workspace path to the file manager endpoint", async () => {
  const requests: unknown[] = [];
  const target = { dataset: { action: "reveal-workspace", workspace: "other" }, disabled: false };
  const context = createContext({
    S: { currentSessionId: "current", workspaces: [{ id: "other", path: "D:\\Other project" }] },
    closePopovers() {}, showToast() {},
    post: async (url: string, body: unknown) => { requests.push([url, { ...body as object }]); return { path: "D:\\Other project" }; },
    event: { target: { closest: (selector: string) => selector === "[data-action]" ? target : null } },
  });
  await runInContext(`${clickSource}\nonClick(event)`, context);
  assert.deepEqual(requests, [["/api/fs/reveal", { path: "D:\\Other project" }]]);
  assert.equal(target.disabled, false);
});
