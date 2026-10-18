import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, sep } from "node:path";
import test from "node:test";

test("directory listings preserve real ancestor paths and breadcrumb names at every depth", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-directory-list-"));
  const target = join(directory, "OneDrive - qr.com.qa", "02 Areas", ".hidden", "Test", "Test 22");
  await mkdir(target, { recursive: true });
  const previous = {
    state: process.env.PI_WEB_STATE_FILE,
    legacy: process.env.PI_WEB_LEGACY_STATE_FILE,
  };
  process.env.PI_WEB_STATE_FILE = join(directory, "state.json");
  process.env.PI_WEB_LEGACY_STATE_FILE = join(directory, "unused.json");
  await writeFile(process.env.PI_WEB_STATE_FILE, JSON.stringify({ version: 1, workspaces: [], sessions: [] }));
  const { startWebServer, stopWebServer } = await import("../server.ts");
  try {
    const base = await startWebServer({ port: 0, open: false });
    const list = async (path: string) => {
      const response = await fetch(`${base}/api/fs/list?${new URLSearchParams({ path })}`);
      assert.equal(response.status, 200);
      const listing = await response.json();
      assert.equal(listing.error, undefined);
      return listing;
    };
    for (const input of [target, `${target}${sep}`, dirname(target), parse(target).root]) {
      const listing = await list(input);
      const ancestors: string[] = [];
      for (let path = listing.path; ; path = dirname(path)) {
        ancestors.unshift(path);
        if (dirname(path) === path) break;
      }
      assert.deepEqual(listing.crumbs, ancestors.map((path, index) => ({
        name: index === 0 ? path : basename(path),
        path,
        hidden: index !== 0 && basename(path).startsWith("."),
      })));
      assert.equal(listing.parent, dirname(listing.path) === listing.path ? null : dirname(listing.path));
      if (listing.parent) {
        const parent = await list(listing.crumbs.at(-2).path);
        assert.ok(parent.entries.some((entry: { path: string }) => entry.path === listing.path),
          "the parent breadcrumb must lead to the listing that contains the selected folder");
      }
    }
  } finally {
    await stopWebServer();
    if (previous.state === undefined) delete process.env.PI_WEB_STATE_FILE;
    else process.env.PI_WEB_STATE_FILE = previous.state;
    if (previous.legacy === undefined) delete process.env.PI_WEB_LEGACY_STATE_FILE;
    else process.env.PI_WEB_LEGACY_STATE_FILE = previous.legacy;
    await rm(directory, { recursive: true, force: true });
  }
});
