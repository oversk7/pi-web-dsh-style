import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applySessionPatches } from "../web/session-sync.js";

test("SSE connections receive only their subscribed session and small patches, then resume from current state", { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-session-sync-"));
  const previous = { ...process.env };
  process.env.PI_WEB_STATE_FILE = join(directory, "state.json");
  process.env.PI_WEB_LEGACY_STATE_FILE = join(directory, "unused.json");
  const timestamp = new Date().toISOString();
  const history = "existing history ".repeat(65_536);
  const stored = ["one", "two"].map((id) => ({ id, workspaceId: "ws", title: id, sessionFile: join(directory, `${id}.jsonl`), createdAt: timestamp, updatedAt: timestamp }));
  await writeFile(process.env.PI_WEB_STATE_FILE, JSON.stringify({
    version: 1,
    workspaces: [{ id: "ws", title: "Test", path: directory, sessionIds: ["one", "two"], createdAt: timestamp, updatedAt: timestamp }],
    sessions: stored,
  }));
  for (const session of stored) await writeFile(session.sessionFile, [
    { type: "session", version: 3, id: session.id, cwd: directory, timestamp },
    { type: "message", id: "u1", parentId: null, timestamp, message: { role: "user", content: session.id === "one" ? history : "second history", timestamp: 1 } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const { startWebServer, stopWebServer } = await import("../server.ts");
  const controllers: AbortController[] = [];
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    await stopWebServer();
    for (const key of ["PI_WEB_STATE_FILE", "PI_WEB_LEGACY_STATE_FILE"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(directory, { recursive: true, force: true });
  });
  const url = await startWebServer({ port: 0, open: false });
  const post = async (id: string, action: string, body = {}) => {
    const response = await fetch(`${url}/api/sessions/${id}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return response.json();
  };
  for (const session of stored) await post(session.id, "open");
  assert.equal((await fetch(`${url}/api/events?sessionId=missing`)).status, 404);

  async function subscribe(sessionId?: string) {
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${url}/api/events${sessionId ? `?sessionId=${sessionId}` : ""}`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const events: any[] = [];
    const waiting = new Set<() => void>();
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    const pump = (async () => {
      while (true) {
        const part = await reader.read();
        if (part.done) return;
        pending += decoder.decode(part.value, { stream: true });
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)));
          for (const notify of waiting) notify();
        }
      }
    })().catch((error) => { if (!controller.signal.aborted) throw error; });
    const waitFor = (predicate: (event: any) => boolean) => new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => { waiting.delete(check); reject(new Error("SSE event timeout")); }, 5000);
      const check = () => {
        const event = events.find(predicate);
        if (!event) return;
        clearTimeout(timeout);
        waiting.delete(check);
        resolve(event);
      };
      waiting.add(check);
      check();
    });
    return { events, waitFor, close: async () => { controller.abort(); await pump; } };
  }

  const one = await subscribe("one");
  const two = await subscribe("two");
  const passive = await subscribe();
  const initial = await one.waitFor((event) => event.type === "snapshot");
  assert.equal(initial.messages[0].text, history);
  assert.equal(initial.revision, 1);
  await two.waitFor((event) => event.type === "snapshot");
  await post("one", "set_name", { name: "renamed" });
  const patch = await one.waitFor((event) => event.type === "session_patch");
  assert.equal(patch.baseRevision, initial.revision);
  assert.equal(patch.revision, initial.revision + 1);
  assert.ok(Buffer.byteLength(JSON.stringify(patch)) < 2048, "renaming must not resend the megabyte history");
  const { revision: _revision, ...baseline } = initial;
  const updated = applySessionPatches(baseline, patch.patches) as any;
  assert.equal(updated.session.title, "renamed");
  assert.equal(updated.messages[0].text, history);
  const renamed = (event: any) => event.type === "workspaces" && event.workspaces[0].sessions[0].title === "renamed";
  await two.waitFor(renamed);
  await passive.waitFor(renamed);
  assert.equal(two.events.some((event) => event.sessionId === "one"), false);
  assert.equal(passive.events.some((event) => event.type === "snapshot" || event.type === "session_patch"), false);

  await one.close();
  await two.close();
  await passive.close();
  await post("one", "set_name", { name: "changed without viewers" });
  const resumed = await subscribe("one");
  const current = await resumed.waitFor((event) => event.type === "snapshot");
  assert.equal(current.revision, 1, "each new connection starts from an independent baseline");
  assert.equal(current.session.title, "changed without viewers");
  assert.equal(current.messages[0].text, history);
  await resumed.close();
});
