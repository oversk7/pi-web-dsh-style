import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir, type NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isLocalRequest, lanAddresses, phoneLanAddress, WebAccess } from "../network-access.ts";

function request(host: string, headers: Record<string, string | undefined> = {}, remoteAddress = "192.168.1.20"): IncomingMessage {
  return { headers: { host, ...headers }, socket: { remoteAddress, localPort: 18789 } } as IncomingMessage;
}

test("fixed passwords persist as hashes and signed logins survive restart but expire and revoke on password changes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-password-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "auth.json");
  const access = await WebAccess.load(true, path);
  const remote = request("localhost:18789");
  assert.equal(isLocalRequest(remote), false);
  assert.equal(access.authorized(remote), false);
  assert.equal(access.passwordConfigured, false);
  assert.equal(await access.acceptsPassword("test-password"), false);
  await assert.rejects(access.setPassword(" ", path));
  await access.setPassword("test-password", path);
  assert.equal(access.passwordConfigured, true);
  assert.equal(await access.acceptsPassword("test-password"), true);
  assert.equal(await access.acceptsPassword("wrong"), false);
  assert.equal(await access.acceptsPassword(undefined), false);
  assert.equal((await readFile(path, "utf8")).includes("test-password"), false);
  remote.headers.cookie = access.cookie(remote).split(";")[0];
  assert.equal(access.authorized(remote), true);
  assert.match(access.cookie(remote), /HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000/);
  assert.equal((await WebAccess.load(true, path)).authorized(remote), true);
  assert.equal(await (await WebAccess.load(true, path)).acceptsPassword("test-password"), true);
  assert.equal((await WebAccess.load(false, path)).authorized(remote), false);
  const originalCookie = remote.headers.cookie;
  remote.headers.cookie = originalCookie.replace(/=\d+\./, "=9999999999.");
  assert.equal(access.authorized(remote), false);
  remote.headers.cookie = originalCookie;
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(31 * 24 * 60 * 60 * 1000);
  assert.equal(access.authorized(remote), false);
  t.mock.timers.reset();
  await access.setPassword("new-password", path);
  assert.equal(access.authorized(remote), false);
  assert.equal(await access.acceptsPassword("test-password"), false);
  assert.equal(await access.acceptsPassword("new-password"), true);
});

test("public proxy logins work without LAN access and require secure cookies even over loopback", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-proxy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "auth.json");
  const proxy = { origin: "https://www.example.com", secret: "0123456789abcdef0123456789abcdef" };
  const access = await WebAccess.load(false, path, proxy);
  const headers = { origin: proxy.origin, "x-pi-web-proxy-secret": proxy.secret };
  const remote = request("www.example.com", headers, "127.0.0.1");

  assert.equal(access.lan, false);
  assert.equal(access.remoteEnabled, true);
  assert.deepEqual(access.urls(18789), ["https://www.example.com/"]);
  assert.deepEqual((await WebAccess.load(true, path, proxy)).urls(20000), ["https://www.example.com/"]);
  assert.equal(access.trusted(remote), true);
  assert.equal(isLocalRequest(remote), false);
  assert.equal(access.authorized(remote), false);
  await access.setPassword("proxy-password", path);
  assert.equal(await access.acceptsPassword("proxy-password"), true);
  assert.equal(await access.acceptsPassword("wrong-password"), false);
  assert.equal(access.authorized(remote), false);
  const cookie = access.cookie(remote);
  assert.match(cookie, /; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000; Secure$/);
  remote.headers.cookie = cookie.split(";")[0];
  assert.equal(access.authorized(remote), true);
  assert.equal((await WebAccess.load(false, path, proxy)).authorized(remote), true);

  for (const [label, host, overrides] of [
    ["forged host", "attacker.example", {}],
    ["host suffix", "www.example.com.attacker.example", {}],
    ["unexpected host port", "www.example.com:18789", {}],
    ["missing secret", "www.example.com", { "x-pi-web-proxy-secret": undefined }],
    ["wrong secret", "www.example.com", { "x-pi-web-proxy-secret": "fedcba9876543210fedcba9876543210" }],
    ["forged origin", "www.example.com", { origin: "https://attacker.example" }],
    ["HTTP origin", "www.example.com", { origin: "http://www.example.com" }],
  ] as const) {
    const forged = request(host, { ...headers, cookie: remote.headers.cookie, ...overrides }, "127.0.0.1");
    assert.equal(access.trusted(forged), false, label);
  }

  const disguised = request("localhost:18789", { ...headers, origin: "http://localhost:18789" }, "127.0.0.1");
  assert.equal(isLocalRequest(disguised), false);
  assert.equal(access.trusted(disguised), false);
  assert.equal(access.authorized(disguised), false);
});

test("phone links select one Wi-Fi address and omit virtual adapters", () => {
  const entry = (address: string): NetworkInterfaceInfo => ({ address, family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: `${address}/24` });
  const virtual = { "vEthernet (WSL (Hyper-V firewall))": [entry("172.23.48.1")] };
  assert.equal(phoneLanAddress({ ...virtual, Ethernet: [entry("192.168.1.10")], WLAN: [entry("172.16.113.160")] }), "172.16.113.160");
  assert.equal(phoneLanAddress({ ...virtual, Ethernet: [entry("192.168.1.10")] }), "192.168.1.10");
  assert.equal(phoneLanAddress(virtual), undefined);
});

test("local access and exact same-origin requests work; rebinding and cross-origin requests fail", () => {
  const access = new WebAccess(true);
  const local = request("127.0.0.1:18789", {}, "127.0.0.1");
  assert.equal(access.authorized(local), true);
  assert.equal(access.trusted(local), true);
  assert.equal(access.trusted(request("attacker.example:18789")), false);
  assert.equal(access.trusted(request("user@localhost:18789")), false);
  assert.equal(access.trusted(request("localhost:18789/path")), false);
  for (const headers of [
    { origin: "http://attacker.example" },
    { origin: "http://localhost:80" },
    { origin: "https://localhost:18789" },
    { origin: "null" },
    { "sec-fetch-site": "cross-site" },
  ]) assert.equal(access.trusted(request("localhost:18789", headers)), false);
  assert.equal(access.trusted(request("localhost:18789", { origin: "http://localhost:18789" })), true);
  for (const address of lanAddresses()) {
    const remote = request(`${address}:18789`, { origin: `http://${address}:18789` });
    assert.equal(access.trusted(remote), true);
    assert.equal(new WebAccess(false).trusted(remote), false);
    assert.equal(access.authorized(remote), false);
  }
  assert.deepEqual(access.urls(20000).map((url) => new URL(url).port), phoneLanAddress() ? ["20000"] : []);
  assert.ok(access.urls(20000).every((url) => !new URL(url).hash && !new URL(url).search));
  assert.deepEqual(new WebAccess(false).urls(20000), []);
});
