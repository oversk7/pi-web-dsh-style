import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FrpProcess, type FrpStatus } from "../frp-process.ts";

const fixture = fileURLToPath(new URL("./fixtures/frp-process.mjs", import.meta.url));
const cwd = fileURLToPath(new URL("..", import.meta.url));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail("Timed out waiting for process state");
}
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-frp-test-"));
  const statuses: FrpStatus[] = [];
  const frp = new FrpProcess((status) => statuses.push(status));
  t.after(async () => { await frp.stop(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const marker = join(dir, "pid.json");
  const control = join(dir, "control.txt");
  const options = { executable: process.execPath, args: [fixture, "tree", marker, control, 'spaces 中文 "quote" trailing\\'], cwd };
  async function pids(): Promise<{ pid: number; leaf: number; args: string[] }> {
    let result: { pid: number; leaf: number; args: string[] } | undefined;
    await eventually(async () => { try { result = JSON.parse(await readFile(marker, "utf8")); return true; } catch { return false; } });
    return result!;
  }
  return { dir, frp, statuses, options, marker, control, pids };
}

test("spawn returns before connection; fragmented stdout, reconnect, stderr errors stay sanitized", { timeout: 30_000 }, async (t) => {
  const { frp, options, pids, control, statuses } = await setup(t);
  assert.equal(frp.status.state, "stopped");
  await frp.start(options);
  assert.equal(frp.status.state, "connecting");
  const running = await pids();
  assert.equal(running.args[0], options.args.at(-1));
  for (const [text, state] of [
    ["split:[pi-web-retry] start proxy success token=secret", "connected"],
    ["stderr:login to server failed token=secret", "connecting"],
    ["start proxy success", "connected"],
    ["connection lost retry token=secret", "connecting"],
    ["stderr:[E] invalid configuration token=secret", "error"],
    ["split:start proxy success", "connected"],
  ] as const) {
    await writeFile(control, text);
    await eventually(() => frp.status.state === state);
  }
  assert.equal(JSON.stringify(statuses).includes("secret"), false);
  await Promise.all([frp.stop(), frp.stop()]);
  assert.equal(frp.status.state, "stopped");
  assert.equal(alive(running.pid), false);
  await eventually(() => !alive(running.leaf));
});

test("unexpected exit is error and is not restarted", { timeout: 30_000 }, async (t) => {
  const { frp, options, pids, control } = await setup(t);
  await frp.start(options);
  const running = await pids();
  await writeFile(control, "exit");
  await eventually(() => frp.status.state === "error");
  await eventually(() => !alive(running.pid) && !alive(running.leaf));
  await delay(150);
  assert.equal(frp.status.state, "error");
  assert.equal((await pids()).pid, running.pid);
  await frp.stop();
  assert.equal(frp.status.state, "stopped");
});

test("OS spawn failure rejects without disclosing paths; missing target becomes error", { timeout: 30_000 }, async (t) => {
  const { frp, options, dir, statuses } = await setup(t);
  await assert.rejects(frp.start({ ...options, cwd: join(dir, "secret-missing-directory") }), /^Error: 隧道进程启动失败$/);
  assert.equal(frp.status.state, "error");
  await frp.stop();
  const start = frp.start({ ...options, executable: join(dir, "secret-missing.exe") });
  if (process.platform === "win32") await start;
  else await assert.rejects(start, /隧道进程启动失败/);
  await eventually(() => frp.status.state === "error");
  assert.equal(JSON.stringify(statuses).includes("secret"), false);
});

test("concurrent stop/start keeps replacement state and kill stops its tree", { timeout: 30_000 }, async (t) => {
  const { frp, options, pids, marker, control } = await setup(t);
  await frp.start(options);
  const old = await pids();
  await rm(marker);
  await Promise.all([frp.stop(), frp.stop(), frp.start(options)]);
  const replacement = await pids();
  assert.notEqual(old.pid, replacement.pid);
  assert.equal(alive(old.pid), false);
  await writeFile(control, "start proxy success");
  await eventually(() => frp.status.state === "connected");
  frp.kill();
  frp.kill();
  await frp.stop();
  assert.equal(alive(replacement.pid), false);
  await eventually(() => !alive(replacement.leaf));
  assert.equal(frp.status.state, "stopped");
});

test("force-killing Windows owner clears frpc and its descendants", { skip: process.platform !== "win32", timeout: 30_000 }, async (t) => {
  const { marker, control, pids } = await setup(t);
  const owner = spawn(process.execPath, [fixture, "owner", marker, control], { cwd, stdio: "ignore", windowsHide: true });
  t.after(async () => { owner.kill(); });
  const running = await pids();
  const exited = once(owner, "exit");
  owner.kill("SIGKILL");
  await exited;
  await eventually(() => !alive(running.pid) && !alive(running.leaf));
});
