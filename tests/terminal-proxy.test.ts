import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTerminalProxy, saveTerminalProxy, terminalProxyEnv, validateTerminalProxy } from "../terminal-proxy.ts";
import { spawnPiRpc } from "../pi-rpc.ts";

const manual = { mode: "manual", url: "http://127.0.0.1:10808" } as const;

test("terminal proxy validates HTTP endpoints and rejects unsupported or malformed addresses", () => {
  for (const url of ["http://127.0.0.1:7987", "http://127.0.0.1:10808", "https://proxy.example:443", "http://[::1]:7987"]) {
    assert.equal(validateTerminalProxy({ mode: "manual", url }).url, url);
  }
  for (const url of ["", "127.0.0.1:7987", "socks5://127.0.0.1:10808", "http://user:password@localhost:7987", "http://localhost/path", "http://localhost:0", "http://localhost:65536", "http://localhost:7987\n"]) {
    assert.throws(() => validateTerminalProxy({ mode: "manual", url }));
  }
  assert.throws(() => validateTerminalProxy({ mode: "unknown", url: "" }));
  assert.deepEqual(validateTerminalProxy({ mode: "direct", url: "" }), { mode: "direct", url: "" });
});

test("proxy modes override both cases without changing the parent environment", () => {
  const source = { PATH: "test-path", HTTP_PROXY: "http://old:1234", https_proxy: "http://old:5678", All_Proxy: "socks5://old:1234", NO_PROXY: "*" };
  assert.deepEqual(terminalProxyEnv({ mode: "inherit", url: "" }, source), source);
  const env = terminalProxyEnv(manual, source);
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) assert.equal(env[key], manual.url);
  assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1");
  assert.equal(env.no_proxy, env.NO_PROXY);
  assert.equal(env.PATH, source.PATH);
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
  assert.equal(env.All_Proxy, undefined);
  const direct = terminalProxyEnv({ mode: "direct", url: "" }, env);
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) assert.equal(direct[key], undefined);
  assert.equal(direct.NO_PROXY, "*");
  assert.equal(direct.NODE_USE_ENV_PROXY, "0");
  assert.equal(source.HTTP_PROXY, "http://old:1234");
});

test("terminal proxy persists across loads and defaults to inherited environment", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-proxy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "terminal-proxy.json");
  assert.equal((await loadTerminalProxy(path)).mode, "inherit");
  await saveTerminalProxy(path, manual);
  assert.deepEqual(await loadTerminalProxy(path), manual);
});

test("RPC process and its terminal child receive saved proxy environment", { timeout: 20_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-proxy-rpc-"));
  const entry = join(dir, "rpc.mjs");
  await writeFile(entry, `
    import { createInterface } from 'node:readline';
    import { execFileSync } from 'node:child_process';
    createInterface({ input: process.stdin }).on('line', line => {
      const command = JSON.parse(line);
      const child = JSON.parse(execFileSync(process.execPath, ['-e', 'console.log(JSON.stringify({https:process.env.HTTPS_PROXY, noProxy:process.env.NO_PROXY}))'], {encoding:'utf8'}));
      console.log(JSON.stringify({type:'response',id:command.id,success:true,data:{https:process.env.HTTPS_PROXY,lower:process.env.https_proxy,child}}));
    });
  `);
  const previous = process.env.PI_WEB_RPC_ENTRY;
  process.env.PI_WEB_RPC_ENTRY = entry;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_WEB_RPC_ENTRY;
    else process.env.PI_WEB_RPC_ENTRY = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const rpc = spawnPiRpc({ cwd: dir, noSession: true, proxy: manual });
  try {
    const response = await rpc.send<{ data: { https: string; lower: string; child: { https: string; noProxy: string } } }>({ type: "environment" }, 15_000);
    assert.equal(response.data.https, manual.url);
    assert.equal(response.data.lower, manual.url);
    assert.equal(response.data.child.https, manual.url);
    assert.equal(response.data.child.noProxy, "localhost,127.0.0.1,::1");
  } finally {
    await rpc.close();
  }
});
