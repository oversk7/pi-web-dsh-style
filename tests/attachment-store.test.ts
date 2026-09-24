import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AttachmentStore } from "../attachment-store.ts";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("AttachmentStore sniffs images and builds RPC payloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-attachments-"));
  const store = new AttachmentStore({ directory, maxPromptImages: 2 });
  try {
    const attachment = await store.create(ONE_PIXEL_PNG);
    assert.equal(attachment.mimeType, "image/png");
    assert.equal(attachment.size, ONE_PIXEL_PNG.byteLength);

    assert.equal(attachment.kind, "image");
    const { images, message } = await store.promptForRpc([attachment.id], "看图");
    assert.equal(message, "看图");
    assert.deepEqual(images, [{
      type: "image",
      data: ONE_PIXEL_PNG.toString("base64"),
      mimeType: "image/png",
    }]);

    assert.equal(await store.remove(attachment.id), true);
    await assert.rejects(() => store.read(attachment.id), /不存在或已过期/);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("AttachmentStore combines document text and images without losing file boundaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-attachments-"));
  const store = new AttachmentStore({ directory });
  try {
    const text = "# 中文说明\n\n```ts\nconst answer = 42;\n```";
    const document = await store.create(Buffer.from(text), "C:\\fakepath\\说明.md");
    const image = await store.create(ONE_PIXEL_PNG, "截图.png");
    assert.equal(document.kind, "document");
    assert.equal(document.name, "说明.md");
    assert.equal(document.textLength, text.length);
    const prompt = await store.promptForRpc([document.id, image.id, document.id], "请比较");
    assert.equal(prompt.message, `请比较\n\n附件："说明.md"\n\`\`\`\`text\n${text}\n\`\`\`\``);
    assert.equal(prompt.images.length, 1);
    const documentOnly = await store.promptForRpc([document.id], "");
    assert.match(documentOnly.message, /^请分析附加文件。/);
    assert.deepEqual(documentOnly.images, []);
    assert.deepEqual((await store.read(document.id)).bytes, Buffer.from(text));
  } finally {
    await store.close();
    assert.deepEqual(await readdir(directory), []);
    await rm(directory, { recursive: true, force: true });
  }
});

test("AttachmentStore enforces attachment, image and combined text limits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-attachments-"));
  const store = new AttachmentStore({ directory, maxPromptImages: 1, maxPromptAttachments: 2 });
  try {
    const images = await Promise.all([store.create(ONE_PIXEL_PNG), store.create(ONE_PIXEL_PNG)]);
    await assert.rejects(() => store.promptForRpc(images.map((entry) => entry.id), ""), /最多附加 1 张图片/);
    const first = await store.create(Buffer.from("甲".repeat(110_000)), "first.txt");
    const second = await store.create(Buffer.from("乙".repeat(110_000)), "second.txt");
    await assert.rejects(() => store.promptForRpc([first.id, second.id], ""), /文本总量/);
    await assert.rejects(() => store.promptForRpc([first.id, second.id, images[0].id], ""), /最多附加 2 个文件/);
    await store.remove(first.id);
    await assert.rejects(() => store.promptForRpc([first.id], ""), /不存在或已过期/);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("AttachmentStore rejects unsupported and oversized files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-attachments-"));
  const store = new AttachmentStore({ directory, maxBytes: 16 });
  try {
    await assert.rejects(() => store.create(Buffer.from("not an image")), /不支持的图片格式/);
    await assert.rejects(() => store.create(Buffer.alloc(17)), /文件不能超过/);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
