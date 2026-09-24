import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const renderSource = app.slice(app.indexOf("function isImageAttachment("), app.indexOf("function renderComposerBar("));
const uploadSource = app.slice(app.indexOf("function setClipboardBusy("), app.indexOf("function restoreMessagesToDraft("));
const sendSource = app.slice(app.indexOf("async function sendDraft("), app.indexOf("async function respondDialog("));
const clickSource = app.slice(app.indexOf("async function onClick("), app.indexOf("function moveWorkspace("));
const escapeSource = app.slice(app.indexOf("function esc("), app.indexOf("function el("));

function fixture() {
  const state = {
    draft: "保留输入的消息", draftAttachments: [] as any[], clipboardBusy: false, currentSessionId: "session",
    pendingSends: new Map(), failedDrafts: new Map(), failedAttachmentDrafts: new Map(),
  };
  const toasts: string[] = [];
  const requests: Array<{ path: string; body: any }> = [];
  const deleted: string[] = [];
  const context = createContext({
    S: state, ICONS: { close: "" }, fmtNum: String, queueRender() {}, closePopovers() {},
    modelSupportsImages: () => false, draftKey: () => state.currentSessionId,
    setDraftAttachments: (items: any[]) => { state.draftAttachments = items; },
    setDraftValue: (text: string) => { state.draft = text; },
    showToast: (text: string) => { toasts.push(text); },
    api: async (path: string) => { deleted.push(path); },
    post: async (path: string, body: any) => {
      requests.push({ path, body });
      return { attachment: { id: body.name, name: body.name, kind: "document", mimeType: "text/plain", textLength: 8 } };
    },
    currentSnapshot: () => ({ session: { streaming: false } }),
    clearComposerDraft: () => { state.draft = ""; state.draftAttachments = []; },
    executeLocalSlashCommand: async () => false,
    $: () => null,
  });
  runInContext(`${escapeSource}\n${renderSource}\n${uploadSource}\n${sendSource}\n${clickSource}\nreadFileData = async file => file.data;`, context);
  return { state, context, toasts, requests, deleted };
}

test("the plus opens a multiple file picker and preserves the draft", async () => {
  const view = fixture();
  let clicked = false;
  const picker = { type: "", multiple: false, accept: "", addEventListener() {}, click() { clicked = true; } };
  view.context.document = { createElement: () => picker };
  view.context.event = { target: { closest: (selector: string) => selector === "[data-action]" ? { dataset: { action: "upload-files" } } : null } };
  await runInContext("onClick(event)", view.context);
  assert.equal(clicked, true);
  assert.equal(picker.type, "file");
  assert.equal(picker.multiple, true);
  assert.equal(picker.accept, "");
  assert.equal(view.state.draft, "保留输入的消息");
  assert.match(app, /aria-label="上传文件"[^\n]+data-action="upload-files"/);
  assert.doesNotMatch(app, /data-action="commands"/);
});

test("text-only models upload documents and send their attachment IDs", async () => {
  const view = fixture();
  await runInContext('uploadFiles([{ name: "说明.md", size: 8, data: "encoded" }])', view.context);
  assert.equal(view.requests[0].body.name, "说明.md");
  assert.equal(view.state.draftAttachments[0].kind, "document");
  assert.equal(view.state.clipboardBusy, false);
  const tray = runInContext("renderDraftAttachments(null)", view.context);
  assert.match(tray, /说明.md/);
  assert.match(tray, /已解析/);
  assert.doesNotMatch(tray, /<img|不支持图片/);
  await runInContext("sendDraft()", view.context);
  assert.equal(view.requests[1].path, "/api/sessions/session/prompt");
  assert.deepEqual([...view.requests[1].body.attachmentIds], ["说明.md"]);
  assert.equal(view.requests[1].body.message, "保留输入的消息");
  assert.equal(view.state.draftAttachments.length, 0);
});

test("partial upload failures keep successful files and the original text", async () => {
  const view = fixture();
  view.context.post = async (_path: string, body: any) => {
    if (body.name === "bad.zip") throw new Error("不支持的文件格式");
    return { attachment: { id: body.name, name: body.name, kind: "document", mimeType: "text/plain" } };
  };
  await runInContext('uploadFiles([{ name: "first.txt" }, { name: "bad.zip" }, { name: "last.txt" }])', view.context);
  assert.deepEqual(Array.from(view.state.draftAttachments, (item) => item.name), ["first.txt", "last.txt"]);
  assert.match(view.toasts[0], /bad.zip.*不支持/);
  assert.equal(view.state.draft, "保留输入的消息");
});

test("switching sessions during upload discards the arriving attachment", async () => {
  const view = fixture();
  view.context.post = async () => {
    view.state.currentSessionId = "other";
    return { attachment: { id: "orphan", kind: "document" } };
  };
  await runInContext('uploadFiles([{ name: "file.txt" }])', view.context);
  assert.equal(view.state.draftAttachments.length, 0);
  assert.deepEqual(view.deleted, ["/api/attachments/orphan"]);
  assert.match(view.toasts[0], /会话已切换/);
});

test("uploading blocks sends and failed sends restore the attachments", async () => {
  const view = fixture();
  view.state.clipboardBusy = true;
  await runInContext("sendDraft()", view.context);
  assert.equal(view.requests.length, 0);
  assert.match(view.toasts[0], /正在上传并解析/);
  view.state.clipboardBusy = false;
  view.state.draftAttachments = [{ id: "doc", kind: "document", mimeType: "text/plain" }];
  view.context.post = async () => { throw new Error("RPC failed"); };
  await runInContext("sendDraft()", view.context);
  assert.equal(view.state.draft, "保留输入的消息");
  assert.equal(view.state.draftAttachments[0].id, "doc");
  assert.match(view.toasts.at(-1)!, /发送失败/);
});

test("mixed image and document trays escape filenames and only images require vision", async () => {
  const view = fixture();
  view.state.draftAttachments = [
    { id: "doc", kind: "document", mimeType: "image/svg+xml", name: '<svg onload="alert(1)">', textLength: 10 },
    { id: "image", kind: "image", mimeType: "image/png", name: "image.png", url: "/api/attachments/image" },
  ];
  const tray = runInContext("renderDraftAttachments(null)", view.context);
  assert.match(tray, /&lt;svg/);
  assert.doesNotMatch(tray, /<svg/);
  assert.equal((tray.match(/<img /g) || []).length, 1);
  assert.match(tray, /当前模型不支持图片输入/);
  await runInContext("sendDraft()", view.context);
  assert.equal(view.requests.length, 0);
  assert.equal(view.state.draftAttachments.length, 2);
});
