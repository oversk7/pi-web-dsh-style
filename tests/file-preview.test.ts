import assert from "node:assert/strict";
import test from "node:test";
import { buildFilePreview } from "../file-preview.ts";

test("highlights known source files and escapes source markup", () => {
  const preview = buildFilePreview("C:\\project\\sample.ts", Buffer.from('const value: string = "<tag>";\r\n'));

  assert.equal(preview.name, "sample.ts");
  assert.equal(preview.language, "typescript");
  assert.equal(preview.highlighted, true);
  assert.equal(preview.lineCount, 2);
  assert.match(preview.highlightedHtml, /hljs-keyword/);
  assert.ok(!preview.highlightedHtml.includes("<tag>"));
  assert.match(preview.highlightedHtml, /&lt;tag&gt;/);
});

test("uses plain escaped text for files above the highlighting limit", () => {
  const source = `${"x".repeat(512 * 1024)}<unsafe>`;
  const preview = buildFilePreview("C:\\project\\large.ts", Buffer.from(source));

  assert.equal(preview.language, "typescript");
  assert.equal(preview.highlighted, false);
  assert.ok(!preview.highlightedHtml.includes("<unsafe>"));
  assert.match(preview.highlightedHtml, /&lt;unsafe&gt;/);
});

test("recognizes PowerShell files", () => {
  const preview = buildFilePreview("C:\\project\\script.ps1", Buffer.from("Get-ChildItem | Where-Object { $_.Name }"));

  assert.equal(preview.language, "powershell");
  assert.equal(preview.highlighted, true);
  assert.match(preview.highlightedHtml, /hljs-built_in|hljs-keyword|hljs-variable/);
});
