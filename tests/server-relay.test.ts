import assert from "node:assert/strict";
import { request } from "node:http";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveNetworkSettings, updateNetworkSettings } from "../network-settings.ts";

function fetch(url: string, options: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: options.method, headers: { ...Object.fromEntries(new Headers(options.headers)), connection: "close" }, signal: options.signal ?? undefined }, (res) => {
      const headers = new Headers();
      for (const [key, values] of Object.entries(res.headers)) {
        for (const value of Array.isArray(values) ? values : values ? [values] : []) headers.append(key, value);
      }
      resolve(new Response(Readable.toWeb(res) as ReadableStream, { status: res.statusCode, headers }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

test("the extension directly authenticates relayed requests and keeps network configuration local", { timeout: 20_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-direct-relay-"));
  process.env.PI_WEB_STATE_FILE = join(dir, "state.json");
  process.env.PI_WEB_LEGACY_STATE_FILE = join(dir, "unused.json");
  const settings = updateNetworkSettings({ mode: "relay", relay: {
    serverAddr: "relay.example.com", serverPort: 7000, token: "test-frps-token",
    origin: "https://web.example.com", frpcPath: "./uninstalled-frpc.exe",
  } });
  await saveNetworkSettings(join(dir, "network.json"), settings);
  const timestamp = "2026-08-01T00:00:00.000Z";
  const sessions = ["first", "second"].map((id) => ({ id, workspaceId: "ws", title: id, sessionFile: join(dir, `${id}.jsonl`), createdAt: timestamp, updatedAt: timestamp }));
  for (const session of sessions) await writeFile(session.sessionFile, [
    { type: "session", version: 3, id: session.id, cwd: dir, timestamp },
    { type: "message", id: "u1", parentId: null, timestamp, message: { role: "user", content: `${session.id} prompt`, timestamp: 1 } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await writeFile(process.env.PI_WEB_STATE_FILE, JSON.stringify({ version: 1, workspaces: [{ id: "ws", title: "Test", path: dir, sessionIds: sessions.map((s) => s.id), createdAt: timestamp, updatedAt: timestamp }], sessions }));
  const { startWebServer, stopWebServer, getWebConnectionOptions } = await import("../server.ts");
  t.after(async () => { await stopWebServer(); await rm(dir, { recursive: true, force: true }); });
  const url = await startWebServer({ port: 0, open: false });
  const localPost = (path: string, body: unknown) => fetch(`${url}${path}`, { method: "POST", body: JSON.stringify(body) });
  const view = await (await fetch(`${url}/api/network`)).json();
  assert.equal(view.settings.mode, "relay");
  assert.equal(view.status.state, "error");
  assert.match(view.status.message, /未找到 frpc/);
  assert.deepEqual(view.urls, ["https://web.example.com/"]);
  for (const key of [settings.relay!.token, settings.relay!.secretKey, settings.relay!.proxySecret]) assert.equal(JSON.stringify(view).includes(key), false);
  assert.equal((await localPost("/api/auth/password", { password: "phone-password" })).status, 200);
  const headers = { host: "web.example.com", origin: settings.relay!.origin, "x-pi-web-proxy-secret": settings.relay!.proxySecret };
  const get = (path: string, extra = {}) => fetch(`${url}${path}`, { headers: { ...headers, ...extra } });
  const post = (path: string, body: unknown, cookie = "") => fetch(`${url}${path}`, { method: "POST", headers: { ...headers, cookie }, body: JSON.stringify(body) });
  assert.equal((await get("/api/bootstrap")).status, 401);
  assert.equal((await get("/api/events")).status, 401);
  assert.equal((await get("/api/bootstrap", { "x-pi-web-proxy-secret": "wrong" })).status, 403);
  assert.equal((await get("/api/bootstrap", { host: "localhost" })).status, 403);
  assert.equal((await post("/api/auth", { password: "wrong" })).status, 401);
  const auth = await post("/api/auth", { password: "phone-password" });
  assert.equal(auth.status, 200);
  assert.match(auth.headers.get("set-cookie")!, /; Secure/);
  const cookie = auth.headers.get("set-cookie")!.split(";")[0];
  const boot = await (await get("/api/bootstrap", { cookie })).json();
  assert.equal(boot.localClient, false);
  assert.deepEqual(boot.lanUrls, []);
  assert.equal(boot.workspaces[0].sessions.length, 2);
  for (const path of ["/api/network", "/api/network/server-files"]) assert.equal((await get(path, { cookie })).status, 403);
  assert.equal((await post("/api/network", { mode: "lan" }, cookie)).status, 403);
  assert.equal((await post("/api/auth/password", { password: "changed" }, cookie)).status, 403);
  assert.equal((await get("/api/bootstrap", { cookie, origin: "https://attacker.example" })).status, 403);
  const abort = new AbortController();
  const events = await fetch(`${url}/api/events`, { headers: { ...headers, cookie }, signal: abort.signal });
  const reader = events.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /connected/);
  assert.equal((await (await post("/api/sessions/first/open", {}, cookie)).json()).session.id, "first");
  assert.equal((await (await localPost("/api/sessions/second/open", {})).json()).session.id, "second");
  assert.match(new TextDecoder().decode((await reader.read()).value), /workspaces|snapshot/);
  abort.abort();
  const files = await (await fetch(`${url}/api/network/server-files`)).json();
  assert.ok(files.files["visitor.toml"].includes(settings.relay!.secretKey));
  assert.equal((await localPost("/api/network", { mode: "relay", relay: { ...settings.relay, frpcPath: "./also-missing.exe" } })).status, 400);
  assert.equal(JSON.parse(await readFile(join(dir, "network.json"), "utf8")).relay.frpcPath, "./uninstalled-frpc.exe");
  const connection = getWebConnectionOptions()!;
  await stopWebServer();
  await startWebServer({ ...connection, open: false });
  assert.equal((await get("/api/bootstrap", { cookie })).status, 200);
  assert.equal((await localPost("/api/auth/password", { password: "new-password" })).status, 200);
  assert.equal((await get("/api/bootstrap", { cookie })).status, 401);
  assert.equal((await post("/api/auth", { password: "new-password" })).status, 200);
  const saved = await localPost("/api/network", { mode: "local" });
  assert.equal(saved.status, 200);
  await saved.json();
  await stopWebServer();
  await startWebServer({ port: connection.port, open: false });
  assert.equal((await (await fetch(`${url}/api/network`)).json()).settings.mode, "local");
  assert.equal((await get("/api/bootstrap", { cookie })).status, 403);
  assert.equal((await (await fetch(`${url}/api/bootstrap`)).json()).workspaces[0].sessions.length, 2);
});
