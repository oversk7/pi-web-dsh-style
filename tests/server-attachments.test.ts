import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("uploaded files reach RPC context, obey model capabilities and survive rejected prompts", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-file-context-"));
  const previous = { ...process.env };
  process.env.PI_WEB_STATE_FILE = join(directory, "state.json");
  process.env.PI_WEB_LEGACY_STATE_FILE = join(directory, "unused.json");
  process.env.PI_WEB_RPC_ENTRY = join(directory, "rpc.mjs");
  const timestamp = new Date().toISOString();
  await writeFile(process.env.PI_WEB_STATE_FILE, JSON.stringify({
    version: 1,
    workspaces: [{ id: "ws", title: "Test", path: directory, sessionIds: ["text", "vision", "failure"], createdAt: timestamp, updatedAt: timestamp }],
    sessions: ["text", "vision", "failure"].map((id) => ({ id, workspaceId: "ws", title: id, createdAt: timestamp, updatedAt: timestamp })),
  }));
  await writeFile(process.env.PI_WEB_RPC_ENTRY, `
    import { createInterface } from "node:readline";
    const model = { id: "test", provider: "test", input: process.argv.includes("vision") ? ["text", "image"] : ["text"] };
    createInterface({ input: process.stdin }).on("line", line => {
      const command = JSON.parse(line);
      const failed = command.type === "prompt" && command.message.includes("REJECT_PROMPT");
      const data = command.type === "get_state" ? { model, isStreaming: false }
        : command.type === "get_available_models" ? { models: [model] }
        : command.type === "get_entries" ? { entries: [], leafId: null }
        : command.type === "get_commands" ? { commands: [] }
        : command.type === "prompt" ? command : {};
      process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: !failed, data, ...(failed ? { error: "fixture rejection" } : {}) }) + "\\n");
      if (command.type === "prompt" && !failed) process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
    });
  `);
  const { startWebServer, stopWebServer } = await import("../server.ts");
  try {
    const url = await startWebServer({ port: 0, open: false });
    const post = (path: string, body: unknown) => fetch(`${url}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const upload = async (name: string, data: string) => {
      const response = await post("/api/attachments", { name, data });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result.attachment;
    };
    const document = await upload("说明.md", Buffer.from("# 测试内容\n答案是 42").toString("base64"));
    assert.equal(document.kind, "document");
    const download = await fetch(`${url}${document.url}`);
    assert.match(download.headers.get("content-disposition")!, /^attachment;/);
    assert.match(await download.text(), /答案是 42/);
    const image = await upload("test.png", png);
    const rejected = await post("/api/sessions/text/prompt", { message: "比较", attachmentIds: [document.id, image.id] });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /不支持图片/);
    assert.equal((await fetch(`${url}${document.url}`)).status, 200);
    const textPrompt = await post("/api/sessions/text/prompt", { message: "总结", attachmentIds: [document.id] });
    assert.equal(textPrompt.status, 200);
    const textCommand = (await textPrompt.json()).response.data;
    assert.match(textCommand.message, /^总结/);
    assert.match(textCommand.message, /说明.md/);
    assert.match(textCommand.message, /答案是 42/);
    assert.equal(textCommand.images, undefined);
    assert.equal((await fetch(`${url}${document.url}`)).status, 404);

    const code = await upload("example.ts", Buffer.from("export const value = 7;").toString("base64"));
    const mixedPrompt = await post("/api/sessions/vision/prompt", { message: "比较代码和图片", attachmentIds: [code.id, image.id] });
    assert.equal(mixedPrompt.status, 200);
    const mixedCommand = (await mixedPrompt.json()).response.data;
    assert.match(mixedCommand.message, /export const value = 7/);
    assert.equal(mixedCommand.images[0].data, png);
    assert.equal(mixedCommand.images[0].mimeType, "image/png");
    assert.equal((await fetch(`${url}${image.url}`)).status, 404);

    const retry = await upload("retry.txt", Buffer.from("keep this content").toString("base64"));
    assert.equal((await post("/api/sessions/failure/prompt", { message: "REJECT_PROMPT", attachmentIds: [retry.id] })).status, 500);
    assert.equal((await fetch(`${url}${retry.url}`)).status, 200);
    const retried = await post("/api/sessions/failure/prompt", { message: "", attachmentIds: [retry.id] });
    assert.equal(retried.status, 200);
    assert.match((await retried.json()).response.data.message, /请分析附加文件。.*keep this content/s);

    const remove = await upload("remove.txt", Buffer.from("unused").toString("base64"));
    assert.equal((await fetch(`${url}${remove.url}`, { method: "DELETE" })).status, 200);
    assert.equal((await fetch(`${url}${remove.url}`)).status, 404);
    assert.equal((await post("/api/attachments", { name: "binary.bin", data: Buffer.from([0, 1, 2, 255]).toString("base64") })).status, 400);
  } finally {
    await stopWebServer();
    for (const key of ["PI_WEB_STATE_FILE", "PI_WEB_LEGACY_STATE_FILE", "PI_WEB_RPC_ENTRY"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
