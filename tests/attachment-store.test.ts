import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ImageAttachmentStore } from "../attachment-store.ts";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("ImageAttachmentStore sniffs images and builds RPC payloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-attachments-"));
  const store = new ImageAttachmentStore({ directory, maxPromptImages: 2 });
  try {
    const attachment = await store.create(ONE_PIXEL_PNG);
    assert.equal(attachment.mimeType, "image/png");
    assert.equal(attachment.size, ONE_PIXEL_PNG.byteLength);

    const images = await store.imagesForRpc([attachment.id]);
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

test("ImageAttachmentStore rejects unsupported and oversized files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-attachments-"));
  const store = new ImageAttachmentStore({ directory, maxBytes: 16 });
  try {
    await assert.rejects(() => store.create(Buffer.from("not an image")), /不支持的图片格式/);
    await assert.rejects(() => store.create(Buffer.alloc(17)), /图片不能超过/);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
