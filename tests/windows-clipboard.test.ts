import assert from "node:assert/strict";
import test from "node:test";
import { extensionForImageMimeType } from "../windows-clipboard.ts";

test("maps supported image MIME types to safe extensions", () => {
  assert.equal(extensionForImageMimeType("image/png"), "png");
  assert.equal(extensionForImageMimeType("image/jpeg; charset=binary"), "jpg");
  assert.equal(extensionForImageMimeType("IMAGE/WEBP"), "webp");
  assert.equal(extensionForImageMimeType("image/gif"), "gif");
  assert.equal(extensionForImageMimeType("image/bmp"), null);
});
