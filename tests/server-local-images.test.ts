import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("local image previews serve image bytes and keep text and binary handling separate", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-local-images-"));
  const previous = { ...process.env };
  process.env.PI_WEB_STATE_FILE = join(directory, "state.json");
  process.env.PI_WEB_LEGACY_STATE_FILE = join(directory, "unused.json");
  await writeFile(process.env.PI_WEB_STATE_FILE, JSON.stringify({ version: 1, workspaces: [], sessions: [] }));
  const imagePath = join(directory, "主题 截图.png");
  const fakePath = join(directory, "not-an-image.png");
  const textPath = join(directory, "note.md");
  const largePath = join(directory, "large.png");
  await writeFile(imagePath, png);
  await writeFile(fakePath, "<html><script>alert(1)</script></html>");
  await writeFile(textPath, "# Local preview");
  await writeFile(largePath, Buffer.alloc(10 * 1024 * 1024 + 1));
  const { startWebServer, stopWebServer } = await import("../server.ts");
  try {
    const url = await startWebServer({ port: 0, open: false });
    const view = (path: string, format = "image") => fetch(`${url}/api/fs/view?${new URLSearchParams({ path, format })}`);
    const response = await view(imagePath);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    assert.equal((await view(imagePath, "json")).status, 415);
    assert.equal((await view(fakePath)).status, 415);
    assert.equal((await view(textPath)).status, 415);
    assert.equal((await view(largePath)).status, 413);
    assert.equal((await view(directory)).status, 400);
    assert.equal((await view(join(directory, "missing.png"))).status, 404);
    const text = await view(textPath, "json");
    assert.equal(text.status, 200);
    assert.equal((await text.json()).content, "# Local preview");
  } finally {
    await stopWebServer();
    for (const key of ["PI_WEB_STATE_FILE", "PI_WEB_LEGACY_STATE_FILE"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
