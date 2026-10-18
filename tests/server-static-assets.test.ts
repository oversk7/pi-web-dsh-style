import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import test from "node:test";

function get(url: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = request(url, { headers, method }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

test("static assets negotiate compression, revalidate content, and support HEAD", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-static-state-"));
  const web = fileURLToPath(new URL("../web/", import.meta.url));
  // Unique on-disk fixtures exercise the production static route without changing shipped assets.
  const fixtures = await mkdtemp(join(web, "static-test-"));
  const asset = join(fixtures, "fixture.js");
  const text = Buffer.from("export const message = 'static asset';\n".repeat(100));
  await writeFile(asset, text);
  await writeFile(join(fixtures, "fixture.png"), Buffer.from([1, 2, 3]));
  await writeFile(join(fixtures, "fixture-A1B2C3D4.js"), text);
  const chunkName = `static-test-${Date.now()}-A1B2C3D4.js`;
  const chunks = join(web, "assets", "mermaid", "chunks");
  const chunk = join(chunks, chunkName);
  await mkdir(chunks, { recursive: true });
  await writeFile(chunk, text);
  const unhashedChunk = join(chunks, chunkName.replace("A1B2C3D4", "A1B2C3D"));
  await writeFile(unhashedChunk, text);
  const previous = { ...process.env };
  process.env.PI_WEB_STATE_FILE = join(directory, "state.json");
  process.env.PI_WEB_LEGACY_STATE_FILE = join(directory, "unused.json");
  await writeFile(process.env.PI_WEB_STATE_FILE, JSON.stringify({ version: 1, workspaces: [], sessions: [] }));
  const { startWebServer, stopWebServer } = await import("../server.ts");
  try {
    const base = await startWebServer({ port: 0, open: false });
    const fixtureUrl = `${base}/${basename(fixtures)}`;
    const url = `${fixtureUrl}/fixture.js`;
    const identity = await get(url);
    assert.equal(identity.status, 200);
    assert.deepEqual(identity.body, text);
    assert.equal(identity.headers["content-encoding"], undefined);
    assert.equal(identity.headers["cache-control"], "no-cache");
    assert.equal(identity.headers.vary, "Accept-Encoding");
    assert.equal(Number(identity.headers["content-length"]), text.length);
    const etag = identity.headers.etag!;
    assert.match(etag, /^W\/"[a-f0-9]+"$/);

    for (const encoding of ["gzip", "br"] as const) {
      const response = await get(url, { "accept-encoding": encoding });
      assert.equal(response.status, 200);
      assert.equal(response.headers["content-encoding"], encoding);
      assert.equal(response.headers.etag, etag);
      assert.equal(Number(response.headers["content-length"]), response.body.length);
      assert.deepEqual(encoding === "gzip" ? gunzipSync(response.body) : brotliDecompressSync(response.body), text);
      const head = await get(url, { "accept-encoding": encoding }, "HEAD");
      assert.equal(head.status, 200);
      assert.equal(head.headers["content-encoding"], encoding);
      assert.equal(head.headers["content-length"], response.headers["content-length"]);
      assert.equal(head.body.length, 0);
    }

    const cases: [string, string | undefined, number][] = [
      ["br;q=0, gzip", "gzip", 200],
      ["gzip;q=0, br", "br", 200],
      ["br;q=0.8, gzip;q=0.9, identity;q=0.1", "gzip", 200],
      ["br;q=0.8, gzip;q=0.9", undefined, 200],
      ["br;q=0, gzip;q=0", undefined, 200],
      ["*;q=1, br;q=0", "gzip", 200],
      ["*;q=0, gzip;q=1", "gzip", 200],
      ["*;q=0, identity;q=1", undefined, 200],
      ["*;q=0", undefined, 406],
      ["br;q=0, gzip;q=0, identity;q=0", undefined, 406],
      ["unknown", undefined, 200],
      ["gzip;q=0.5, identity;q=0", "gzip", 200],
      ["gzip;q=2", undefined, 200],
    ];
    for (const [accept, encoding, status] of cases) {
      const response = await get(url, { "accept-encoding": accept });
      assert.equal(response.status, status, accept);
      assert.equal(response.headers["content-encoding"], encoding, accept);
      if (status === 200 && !encoding) assert.deepEqual(response.body, text);
      if (status === 406) assert.equal(response.body.length, 0);
    }

    for (const match of [etag, `"other", ${etag}`, etag.replace(/^W\//, ""), "*"]) {
      const response = await get(url, { "accept-encoding": "gzip", "if-none-match": match });
      assert.equal(response.status, 304, match);
      assert.equal(response.body.length, 0);
      assert.equal(response.headers.etag, etag);
      assert.equal(response.headers.vary, "Accept-Encoding");
      assert.equal(response.headers["cache-control"], "no-cache");
      assert.equal(response.headers["content-length"], undefined);
    }
    const head304 = await get(url, { "if-none-match": etag }, "HEAD");
    assert.equal(head304.status, 304);
    assert.equal(head304.body.length, 0);
    assert.equal((await get(url, { "if-none-match": '"other"' })).status, 200);

    const changed = Buffer.from(text.toString().replaceAll("message", "updated"));
    await writeFile(asset, changed);
    const updated = await get(url, { "accept-encoding": "br", "if-none-match": etag });
    assert.equal(updated.status, 200);
    assert.notEqual(updated.headers.etag, etag);
    assert.deepEqual(brotliDecompressSync(updated.body), changed);
    assert.deepEqual((await get(url)).body, changed);
    const concurrent = await Promise.all(Array.from({ length: 12 }, () => get(url, { "accept-encoding": "gzip" })));
    for (const response of concurrent) assert.deepEqual(gunzipSync(response.body), changed);

    const immutable = await get(`${base}/assets/mermaid/chunks/${chunkName}`);
    assert.equal(immutable.status, 200);
    assert.equal(immutable.headers["cache-control"], "public, max-age=31536000, immutable");
    for (const path of [`${fixtureUrl}/fixture-A1B2C3D4.js`, `${base}/assets/mermaid/chunks/${basename(unhashedChunk)}`]) {
      assert.equal((await get(path)).headers["cache-control"], "no-cache");
    }
    const ordinaryChunk = await get(`${fixtureUrl}/fixture.png`, { "accept-encoding": "br" });
    assert.equal(ordinaryChunk.headers["content-encoding"], undefined);
    assert.equal(ordinaryChunk.headers["cache-control"], "no-cache");
    await rm(asset);
    assert.equal((await get(url, { "if-none-match": updated.headers.etag! })).status, 404);
    const missingHead = await get(url, {}, "HEAD");
    assert.equal(missingHead.status, 404);
    assert.equal(missingHead.body.length, 0);
  } finally {
    await stopWebServer();
    for (const key of ["PI_WEB_STATE_FILE", "PI_WEB_LEGACY_STATE_FILE"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(fixtures, { recursive: true, force: true });
    await rm(chunk, { force: true });
    await rm(unhashedChunk, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
