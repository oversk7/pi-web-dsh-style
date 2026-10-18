import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("local image previews serve image bytes and keep text and binary handling separate", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-local-images-"));
  const previous = { ...process.env };
  const previousCwd = process.cwd();
  const launchDirectory = join(directory, ".pi");
  await mkdir(launchDirectory);
  await writeFile(join(launchDirectory, "note.md"), "# Launch directory");
  process.chdir(launchDirectory);
  process.env.PI_WEB_STATE_FILE = join(directory, "state.json");
  process.env.PI_WEB_LEGACY_STATE_FILE = join(directory, "unused.json");
  const timestamp = new Date().toISOString();
  await writeFile(process.env.PI_WEB_STATE_FILE, JSON.stringify({
    version: 1,
    currentWorkspaceId: "launch",
    workspaces: [
      { id: "launch", title: "Launch", path: launchDirectory, sessionIds: [], createdAt: timestamp, updatedAt: timestamp },
      { id: "docs", title: "Documents", path: directory, sessionIds: ["doc-session"], createdAt: timestamp, updatedAt: timestamp },
    ],
    sessions: [{ id: "doc-session", workspaceId: "docs", title: "Documents", sessionFile: join(directory, "missing-session.jsonl"), createdAt: timestamp, updatedAt: timestamp }],
  }));
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
    assert.equal((await (await view("note.md", "json")).json()).content, "# Launch directory");
    assert.equal((await fetch(`${url}/api/sessions/doc-session/open`, { method: "POST" })).status, 200);
    const selected = await view("note.md", "json");
    assert.equal(selected.status, 200);
    assert.equal((await selected.json()).path, textPath);
    assert.match(await (await view("note.md", "html")).text(), /Local preview/);
    const launch = await fetch(`${url}/api/fs/view?path=note.md&format=json&workspaceId=launch`);
    assert.equal((await launch.json()).content, "# Launch directory");
    for (const context of [{ sessionId: "doc-session" }, { workspaceId: "docs" }] as Record<string, string>[]) {
      const response = await fetch(`${url}/api/fs/view?${new URLSearchParams({ path: "note.md", format: "json", ...context })}`);
      assert.equal(response.status, 200);
      const preview = await response.json();
      assert.equal(preview.path, textPath);
      assert.equal(preview.content, "# Local preview");
    }
    assert.equal((await fetch(`${url}/api/fs/view?path=note.md&sessionId=missing`)).status, 404);
    assert.equal((await fetch(`${url}/api/fs/view?path=note.md&workspaceId=missing`)).status, 404);
  } finally {
    await stopWebServer();
    for (const key of ["PI_WEB_STATE_FILE", "PI_WEB_LEGACY_STATE_FILE"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    process.chdir(previousCwd);
    await rm(directory, { recursive: true, force: true });
  }
});
