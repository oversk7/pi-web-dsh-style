import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { frpcConfig, loadNetworkSettings, proxyForNetwork, publicNetworkSettings, relayServerFiles, resolveFrpc, saveNetworkSettings, updateNetworkSettings } from "../network-settings.ts";

const input = { mode: "relay", relay: { serverAddr: "relay.example.com", serverPort: 7000, token: 'a-secret-with-"quotes"', origin: "https://web.example.com", frpcPath: "bin/frpc.exe" } };

test("network modes and relay credentials persist without exposing secrets in settings responses", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-network-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "network.json");
  assert.deepEqual(await loadNetworkSettings(path), { mode: "local" });
  const settings = updateNetworkSettings(input);
  const relay = settings.relay!;
  assert.match(relay.proxyName, /^pi-web-[a-f0-9]{8}$/);
  assert.equal(relay.secretKey.length, 64);
  assert.notEqual(relay.proxySecret, relay.secretKey);
  await saveNetworkSettings(path, settings);
  assert.deepEqual(await loadNetworkSettings(path), settings);
  const view = publicNetworkSettings(settings);
  assert.equal(view.relay!.tokenConfigured, true);
  for (const secret of [relay.token, relay.secretKey, relay.proxySecret]) assert.equal(JSON.stringify(view).includes(secret), false);
  const edited = updateNetworkSettings({ ...input, relay: { ...input.relay, token: "", origin: "https://phone.example.com" } }, settings);
  assert.equal(edited.relay!.token, relay.token);
  assert.equal(edited.relay!.secretKey, relay.secretKey);
  assert.equal(edited.relay!.proxyName, relay.proxyName);
  const local = updateNetworkSettings({ mode: "local" }, edited);
  assert.equal(proxyForNetwork(local), undefined);
  assert.deepEqual(local.relay, edited.relay);
  const resumed = updateNetworkSettings({ mode: "relay" }, local);
  assert.deepEqual(proxyForNetwork(resumed), { origin: "https://phone.example.com", secret: relay.proxySecret });
  await writeFile(path, '{"mode":"relay"}');
  await assert.rejects(loadNetworkSettings(path));
});

test("relay settings reject invalid ports and config injection, and generate private STCP endpoints", () => {
  assert.throws(() => updateNetworkSettings({ mode: "relay" }));
  assert.throws(() => updateNetworkSettings({ mode: "other" }));
  for (const patch of [
    { origin: "http://web.example.com" }, { origin: "https://web.example.com/path" },
    { origin: "https://web.example.com?x=1" }, { origin: "https://user:pass@web.example.com" },
    { serverAddr: "relay.example.com; injected" }, { serverPort: 0 }, { serverPort: "7000" },
    { visitorPort: 65536 }, { proxyName: "a\n[[proxies]]" }, { token: "secret\nextra=true" },
    { proxySecret: 'abc"; injected;' }, { secretKey: "short" }, { frpcPath: "frpc\u0000.exe" },
  ]) assert.throws(() => updateNetworkSettings({ ...input, relay: { ...input.relay, ...patch } }), JSON.stringify(patch));
  const relay = updateNetworkSettings(input).relay!;
  const config = frpcConfig(relay, 45678);
  assert.match(config, /localIP = "127\.0\.0\.1"\nlocalPort = 45678/);
  assert.match(config, /type = "stcp"/);
  assert.ok(config.includes(`auth.token = ${JSON.stringify(relay.token)}`));
  assert.equal(config.includes("remotePort"), false);
  const files = relayServerFiles(relay);
  assert.match(files["visitor.toml"], /bindAddr = "127\.0\.0\.1"\nbindPort = 13000/);
  assert.ok(files["visitor.toml"].includes(relay.secretKey));
  assert.match(files["nginx.conf"], /proxy_buffering off/);
  assert.match(files["nginx.conf"], /proxy_read_timeout 3600s/);
  assert.match(files["nginx.conf"], /proxy_set_header Host web\.example\.com/);
  assert.ok(files["nginx.conf"].includes(relay.proxySecret));
  assert.match(files["nginx.conf"], /limit_req_status 429/);
});

test("native frpc paths resolve without a shell and missing executables have an actionable error", async () => {
  assert.equal(await resolveFrpc(process.execPath, tmpdir()), process.execPath);
  await assert.rejects(resolveFrpc("./missing-frpc.exe", tmpdir()), /未找到 frpc/);
});
