import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter, once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { spawnPiRpc, type Json } from "../pi-rpc.ts";

function createRpc(t: TestContext) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill() {} });
  stdin.once("finish", () => {
    stdout.end();
    stderr.end();
    child.emit("exit", 0, null);
  });
  t.mock.method(childProcess, "spawn", () => child);
  syncBuiltinESMExports();
  const previousEntry = process.env.PI_WEB_RPC_ENTRY;
  process.env.PI_WEB_RPC_ENTRY = fileURLToPath(import.meta.url);
  const rpc = spawnPiRpc({ cwd: process.cwd(), noSession: true });
  t.after(async () => {
    try {
      await rpc.close();
    } finally {
      if (previousEntry === undefined) delete process.env.PI_WEB_RPC_ENTRY;
      else process.env.PI_WEB_RPC_ENTRY = previousEntry;
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
  return { rpc, stdin, stdout, stderr };
}

function writeSplitUtf8(stream: PassThrough, text: string) {
  const bytes = Buffer.from(text, "utf8");
  for (let index = 0; index < bytes.length; index += 1) {
    stream.write(bytes.subarray(index, index + 1));
  }
}

test("RPC assistant events preserve Chinese and emoji across byte boundaries", (t) => {
  const { rpc, stdout } = createRpc(t);
  const received: Json[] = [];
  rpc.onEvent((event) => received.push(event));
  const event = {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "中文回复 🌍，继续生成。" },
  };
  writeSplitUtf8(stdout, `${JSON.stringify(event)}\r\n`);
  assert.deepEqual(received, [event]);
  stdout.write(`${JSON.stringify(event)}\n${JSON.stringify(event)}\n`);
  assert.deepEqual(received, [event, event, event]);
});

test("RPC command responses preserve split UTF-8 content", async (t) => {
  const { rpc, stdin, stdout } = createRpc(t);
  stdin.once("data", (chunk: Buffer) => {
    const command = JSON.parse(chunk.toString("utf8"));
    writeSplitUtf8(stdout, `${JSON.stringify({ type: "response", id: command.id, success: true, data: { text: "完整回复 😀" } })}\n`);
  });
  const response = await rpc.send<{ data: { text: string } }>({ type: "get_state" });
  assert.equal(response.data.text, "完整回复 😀");
});

test("RPC stderr preserves split UTF-8 in lines and the final unterminated line", async (t) => {
  const { stderr } = createRpc(t);
  const logs: string[] = [];
  t.mock.method(console, "error", (message: string) => { logs.push(message); });
  writeSplitUtf8(stderr, "中文错误 ⚠️\r\n最后一行 😀");
  const ended = once(stderr, "end");
  stderr.end();
  await ended;
  assert.deepEqual(logs, ["[pi-web rpc stderr] 中文错误 ⚠️", "[pi-web rpc stderr] 最后一行 😀"]);
});
