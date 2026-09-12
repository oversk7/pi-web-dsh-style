import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { closeAllPiRpcs, spawnPiRpc, type PiRpc } from "../pi-rpc.ts";

const fixture = fileURLToPath(new URL("./fixtures/rpc-process-tree.mjs", import.meta.url));
const windowsOnly = { skip: process.platform !== "win32", timeout: 40_000 };
interface Service { pid: number; rootPid: number; intermediatePid: number; port: number; args: string[] }

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function eventually(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail(message);
}
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (result: boolean) => { socket.destroy(); resolve(result); };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}
async function withFixture(run: (dir: string, start: (name?: string) => Promise<{ rpc: PiRpc; service: Service }>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-process-test-"));
  const previous = process.env.PI_WEB_RPC_ENTRY;
  process.env.PI_WEB_RPC_ENTRY = fixture;
  const resources: Array<{ rpc: PiRpc; service?: Service }> = [];
  try {
    await run(dir, async (name) => {
      const rpc = spawnPiRpc({ cwd: dir, noSession: true, name });
      const resource: { rpc: PiRpc; service?: Service } = { rpc };
      resources.push(resource);
      const response = await rpc.send<{ data: Service }>({ type: "start_service", marker: join(dir, `service-${resources.length}.json`) }, 15_000);
      resource.service = response.data;
      await eventually(() => !alive(response.data.intermediatePid), "Intermediate process should exit before cleanup");
      assert.equal(await listening(response.data.port), true);
      return { rpc, service: response.data };
    });
  } finally {
    await Promise.all(resources.map(({ rpc }) => rpc.close(50)));
    for (const { service } of resources) {
      if (service && alive(service.pid)) process.kill(service.pid);
    }
    if (previous === undefined) delete process.env.PI_WEB_RPC_ENTRY;
    else process.env.PI_WEB_RPC_ENTRY = previous;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
async function assertStopped(service: Service): Promise<void> {
  await eventually(() => !alive(service.pid) && !alive(service.rootPid), "RPC and orphaned detached service must stop");
  assert.equal(await listening(service.port), false, "Service port must be released");
}

test("graceful RPC close kills orphaned detached descendants and preserves argument quoting", windowsOnly, async () => {
  await withFixture(async (_dir, start) => {
    const name = 'spaces 中文 "quote" trailing\\';
    const { rpc, service } = await start(name);
    assert.equal(service.args.at(-1), name);
    await rpc.close();
    await assertStopped(service);
  });
});

test("forced close kills the complete job, rejects pending requests, and is idempotent", windowsOnly, async () => {
  await withFixture(async (_dir, start) => {
    const { rpc, service } = await start("stubborn");
    const rejected = assert.rejects(rpc.send({ type: "hang" }), /close timed out|exited/);
    const first = rpc.close(50);
    assert.equal(rpc.close(50), first);
    await assert.rejects(rpc.send({ type: "get_state" }), /not running/);
    await first;
    await rejected;
    await assertStopped(service);
  });
});

test("unexpected RPC exit also tears down detached descendants", windowsOnly, async () => {
  await withFixture(async (_dir, start) => {
    const { rpc, service } = await start();
    await assert.rejects(rpc.send({ type: "crash" }), /exited/);
    await rpc.close();
    await assertStopped(service);
  });
});

test("global shutdown awaits all RPC jobs including ones already closing", windowsOnly, async () => {
  await withFixture(async (_dir, start) => {
    const first = await start("stubborn");
    const second = await start();
    const closing = first.rpc.close(50);
    await closeAllPiRpcs();
    await closing;
    await Promise.all([assertStopped(first.service), assertStopped(second.service)]);
  });
});

test("stopping the web server waits for every session tree and concurrent stop callers", windowsOnly, async () => {
  await withFixture(async (dir, start) => {
    const oldState = process.env.PI_WEB_STATE_FILE;
    const oldLegacy = process.env.PI_WEB_LEGACY_STATE_FILE;
    process.env.PI_WEB_STATE_FILE = join(dir, "web-state.json");
    process.env.PI_WEB_LEGACY_STATE_FILE = join(dir, "no-legacy.json");
    const { startWebServer, stopWebServer } = await import("../server.ts");
    try {
      const url = await startWebServer({ open: false, port: 0 });
      const first = await start("stubborn");
      const second = await start("stubborn");
      const stopping = stopWebServer();
      await stopWebServer();
      assert.equal(await listening(first.service.port), false);
      assert.equal(await listening(second.service.port), false);
      await stopping;
      await Promise.all([assertStopped(first.service), assertStopped(second.service)]);
      assert.equal(await listening(Number(new URL(url).port)), false);
    } finally {
      await stopWebServer();
      if (oldState === undefined) delete process.env.PI_WEB_STATE_FILE;
      else process.env.PI_WEB_STATE_FILE = oldState;
      if (oldLegacy === undefined) delete process.env.PI_WEB_LEGACY_STATE_FILE;
      else process.env.PI_WEB_LEGACY_STATE_FILE = oldLegacy;
    }
  });
});

test("force-killing the owner cleans its RPC jobs without killing unrelated processes", windowsOnly, async () => {
  await withFixture(async (dir, start) => {
    const unrelated = await start();
    const ownerPath = join(dir, "owner.mjs");
    await writeFile(ownerPath, `
      import { spawnPiRpc } from ${JSON.stringify(new URL("../pi-rpc.ts", import.meta.url).href)};
      const rpc = spawnPiRpc({ cwd: ${JSON.stringify(dir)}, noSession: true, name: "stubborn" });
      const result = await rpc.send({ type: "start_service", marker: ${JSON.stringify(join(dir, "owned.json"))} });
      console.log(JSON.stringify(result.data));
      setInterval(() => {}, 1000);
    `);
    const owner = spawn(process.execPath, [ownerPath], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let service: Service | undefined;
    try {
      let output = "";
      owner.stdout.on("data", (chunk) => { output += chunk.toString(); });
      let stderr = "";
      owner.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      await eventually(() => output.includes("\n"), `Owner did not start: ${stderr}`);
      service = JSON.parse(output.trim()) as Service;
      assert.equal(await listening(service.port), true);
      const exited = once(owner, "exit");
      owner.kill();
      await exited;
      await assertStopped(service);
      assert.equal(alive(unrelated.service.rootPid), true);
      assert.equal(await listening(unrelated.service.port), true);
    } finally {
      owner.kill();
      if (service && alive(service.pid)) process.kill(service.pid);
    }
  });
});
