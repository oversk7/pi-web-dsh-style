import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { phoneLanAddress } from "../network-access.ts";

function fetch(input: Parameters<typeof globalThis.fetch>[0], options: Parameters<typeof globalThis.fetch>[1] = {}) {
  const headers = new Headers(options.headers);
  // Rebinding the listener closes pooled sockets between these requests.
  headers.set("connection", "close");
  return globalThis.fetch(input, { ...options, headers });
}

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

test("password login protects all APIs and shares sessions, attachments and events with localhost", { timeout: 30_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-lan-"));
  process.env.PI_WEB_STATE_FILE = join(dir, "state.json");
  process.env.PI_WEB_LEGACY_STATE_FILE = join(dir, "unused.json");
  const timestamp = "2026-08-01T00:00:00.000Z";
  const sessions = ["first", "second"].map((id) => ({ id, workspaceId: "ws", title: id, sessionFile: join(dir, `${id}.jsonl`), createdAt: timestamp, updatedAt: timestamp }));
  for (const session of sessions) {
    await writeFile(session.sessionFile, [
      { type: "session", version: 3, id: session.id, cwd: dir, timestamp },
      { type: "message", id: "u1", parentId: null, timestamp, message: { role: "user", content: `${session.id} prompt`, timestamp: 1 } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }
  await writeFile(process.env.PI_WEB_STATE_FILE, JSON.stringify({ version: 1, workspaces: [{ id: "ws", title: "Test", path: dir, sessionIds: sessions.map((session) => session.id), createdAt: timestamp, updatedAt: timestamp }], sessions }));
  const { startWebServer, stopWebServer, getWebLanUrls, getWebConnectionOptions } = await import("../server.ts");
  t.after(async () => { await stopWebServer(); await rm(dir, { recursive: true, force: true }); });
  const localUrl = await startWebServer({ port: 0, open: false });
  assert.deepEqual(getWebLanUrls(), []);
  assert.equal((await fetch(`${localUrl}/api/bootstrap`)).status, 200);
  const lanLocalUrl = await startWebServer({ lan: true, open: false });
  assert.equal(lanLocalUrl, localUrl);
  const boot = await (await fetch(`${localUrl}/api/bootstrap`)).json();
  assert.equal(boot.lanEnabled, true);
  assert.equal(boot.localClient, true);
  assert.equal(boot.workspaces[0].sessions.length, 2);
  const address = phoneLanAddress();
  if (!address) { t.skip("No LAN IPv4 interface available"); return; }
  const remoteUrl = new URL(getWebLanUrls()[0]);
  assert.equal(remoteUrl.hostname, address);
  assert.equal(remoteUrl.hash, "");
  assert.equal(remoteUrl.search, "");
  const remoteOrigin = remoteUrl.origin;
  for (const route of ["/api/bootstrap", "/api/events", "/api/fs/view?path=x", "/api/attachments/00000000", "/api/exports/00000000"]) {
    assert.equal((await fetch(`${remoteOrigin}${route}`)).status, 401, route);
  }
  const post = (path: string, body: unknown, cookie = "", origin = remoteOrigin) => fetch(`${remoteOrigin}${path}`, {
    method: "POST", headers: { "content-type": "application/json", origin, cookie }, body: JSON.stringify(body),
  });
  assert.deepEqual(await (await fetch(`${remoteOrigin}/api/auth`)).json(), { passwordConfigured: false });
  assert.equal((await post("/api/auth", { password: "test-password" })).status, 503);
  assert.equal((await fetch(`${localUrl}/api/auth/password`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test-password" }),
  })).status, 200);
  assert.equal((await post("/api/auth", { password: "wrong" })).status, 401);
  assert.equal((await post("/api/auth", { token: "old-link" })).status, 401);
  assert.equal((await post("/api/auth", { password: "test-password" }, "", "http://attacker.example")).status, 403);
  const auth = await post("/api/auth", { password: "test-password" });
  assert.equal(auth.status, 200);
  const cookie = auth.headers.get("set-cookie")!.split(";")[0];
  assert.match(auth.headers.get("set-cookie")!, /Max-Age=2592000/);
  assert.equal(cookie.includes("test-password"), false);
  assert.equal((await post("/api/auth/password", { password: "unauthorized-change" }, cookie)).status, 403);
  const remoteBoot = await (await fetch(`${remoteOrigin}/api/bootstrap`, { headers: { cookie } })).json();
  assert.equal(remoteBoot.localClient, false);
  assert.deepEqual(remoteBoot.lanUrls, []);
  assert.equal(remoteBoot.workspaces[0].sessions.length, 2);
  assert.equal((await post("/api/sessions/first/open", {}, cookie, "http://attacker.example")).status, 403);
  const abort = new AbortController();
  const events = await fetch(`${remoteOrigin}/api/events`, { headers: { cookie }, signal: abort.signal });
  assert.equal(events.status, 200);
  const reader = events.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /connected/);
  const mobileSession = await (await post("/api/sessions/first/open", {}, cookie)).json();
  const desktopSession = await (await fetch(`${localUrl}/api/sessions/second/open`, { method: "POST" })).json();
  assert.equal(mobileSession.session.id, "first");
  assert.equal(desktopSession.session.id, "second");
  assert.match(JSON.stringify(mobileSession.messages), /first prompt/);
  assert.match(JSON.stringify(desktopSession.messages), /second prompt/);
  assert.match(new TextDecoder().decode((await reader.read()).value), /workspaces|snapshot/);
  abort.abort();
  const uploaded = await post("/api/attachments", { data: png }, cookie);
  assert.equal(uploaded.status, 200);
  const attachment = (await uploaded.json()).attachment;
  assert.equal((await fetch(`${remoteOrigin}${attachment.url}`)).status, 401);
  const image = await fetch(`${remoteOrigin}${attachment.url}`, { headers: { cookie } });
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(png, "base64"));
  assert.equal((await post("/api/attachments", { data: Buffer.from("not an image").toString("base64") }, cookie)).status, 400);
  assert.equal(await new Promise<number>((resolve, reject) => {
    const req = request(`${localUrl}/api/bootstrap`, { headers: { host: "attacker.example" } }, (res) => { res.resume(); resolve(res.statusCode!); });
    req.on("error", reject); req.end();
  }), 403);
  const options = getWebConnectionOptions()!;
  await stopWebServer();
  await startWebServer({ ...options, open: false });
  assert.equal((await fetch(`${remoteOrigin}/api/bootstrap`, { headers: { cookie } })).status, 200);
  assert.equal((await post("/api/auth", { password: "test-password" })).status, 200);
  const live = new AbortController();
  const stream = await fetch(`${remoteOrigin}/api/events`, { headers: { cookie }, signal: live.signal });
  const liveReader = stream.body!.getReader();
  await liveReader.read();
  assert.equal((await fetch(`${localUrl}/api/auth/password`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "new-password" }),
  })).status, 200);
  assert.equal((await liveReader.read()).done, true);
  live.abort();
  assert.equal((await fetch(`${remoteOrigin}/api/bootstrap`, { headers: { cookie } })).status, 401);
  assert.equal((await post("/api/auth", { password: "test-password" })).status, 401);
  assert.equal((await post("/api/auth", { password: "new-password" })).status, 200);
  await startWebServer({ lan: false, open: false });
  assert.deepEqual(getWebLanUrls(), []);
  assert.equal((await (await fetch(`${localUrl}/api/bootstrap`)).json()).workspaces[0].sessions.length, 2);
});
