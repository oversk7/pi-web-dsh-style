import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { flattenHistoryTree } from "../server.ts";

const timestamp = "2026-08-01T00:00:00.000Z";
const entries = [
  { id: "user1", parentId: null, type: "message", timestamp, message: { role: "user", content: "First prompt", timestamp: 1 } },
  { id: "answer1", parentId: "user1", type: "message", timestamp, message: { role: "assistant", content: [{ type: "text", text: "First answer" }] } },
  { id: "user2", parentId: "answer1", type: "message", timestamp: "2026-08-02T00:00:00.000Z", message: { role: "user", content: "Old branch prompt", timestamp: 2 } },
  { id: "tool", parentId: "user2", type: "message", timestamp, message: { role: "toolResult", toolName: "edit", content: [] } },
  { id: "checkpoint", parentId: "tool", type: "custom", customType: "fixture-checkpoint", data: {}, timestamp },
  { id: "compact", parentId: "checkpoint", type: "compaction", summary: "Old compaction checkpoint", firstKeptEntryId: "user2", tokensBefore: 1000, timestamp },
  { id: "answer2", parentId: "compact", type: "message", timestamp, message: { role: "assistant", content: [{ type: "text", text: "Old branch answer" }] } },
];

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-history-"));
  const path = join(dir, "session.jsonl");
  await writeFile(path, [
    { type: "session", version: 3, id: "history-test", cwd: dir, timestamp },
    ...entries,
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return { dir, path, manager: SessionManager.open(path, dir, dir) };
}

function navigationHandler(manager: SessionManager, cancelled = false) {
  let handler: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"] | undefined;
  const api: Pick<ExtensionAPI, "registerCommand" | "registerFlag" | "on" | "appendEntry"> = {
    registerCommand(name, options) {
      if (name === "pi-web-navigate-tree") handler = options.handler;
    },
    registerFlag() {},
    on() {},
    appendEntry(type, data) { manager.appendCustomEntry(type, data); },
  };
  extension(api as ExtensionAPI);
  const ctx = {
    sessionManager: manager,
    waitForIdle: async () => {},
    navigateTree: async (targetId: string) => {
      if (cancelled) return { cancelled: true };
      const entry = manager.getEntry(targetId)!;
      const parent = entry.type === "message" && entry.message.role === "user" ? entry.parentId : targetId;
      if (parent) manager.branch(parent);
      else manager.resetLeaf();
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;
  return (targetId: string) => handler!(targetId, ctx);
}

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const historySource = app.slice(app.indexOf("function historyNodeLabel("), app.indexOf("async function openHistoryView("));
function render(nodes: unknown[], mode = "rewind", selectedEntryId?: string, busyEntryId?: string): string {
  return runInNewContext(`${historySource}\nrenderHistoryView(view)`, {
    view: { nodes, mode, selectedEntryId, busyEntryId },
    esc: (value: unknown) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
    clockLabel: (value: string) => value || "",
    ICONS: { history: "<svg></svg>" },
  });
}

test("rewind keeps old branches selectable and persists return positions across repeated navigation", async () => {
  const { dir, path, manager } = await fixture();
  try {
    const navigate = navigationHandler(manager);
    await navigate("user2");
    let history = flattenHistoryTree(manager.getTree(), manager.getLeafId());
    const marker = history.nodes.find((node) => node.current)!;
    assert.equal(marker.navigationFromId, "answer2");
    assert.equal(marker.navigationTargetId, "user2");
    const oldPrompt = history.nodes.find((node) => node.id === "user2")!;
    assert.equal(oldPrompt.active, false);
    assert.equal(oldPrompt.rewindable, true);
    assert.equal(oldPrompt.navigable, true);
    assert.ok(history.nodes.some((node) => node.id === "checkpoint" && !node.active));
    assert.ok(history.nodes.some((node) => node.id === "compact" && !node.active && node.navigable));
    let html = render(history.nodes);
    assert.match(html, /Old branch prompt/);
    assert.match(html, /历史分支/);
    assert.match(html, /返回切换前的位置/);
    assert.ok(html.indexOf("Old branch prompt") < html.indexOf("First prompt"));

    const reopened = SessionManager.open(path, dir, dir);
    assert.deepEqual(flattenHistoryTree(reopened.getTree(), reopened.getLeafId()), history);
    await navigationHandler(reopened)("answer2");
    history = flattenHistoryTree(reopened.getTree(), reopened.getLeafId());
    assert.equal(history.nodes.find((node) => node.id === "checkpoint")?.active, true);
    assert.equal(history.nodes.find((node) => node.id === "compact")?.active, true);
    assert.equal(history.nodes.find((node) => node.current)?.navigationFromId, marker.id);
    await navigationHandler(reopened)(marker.id);
    history = flattenHistoryTree(reopened.getTree(), reopened.getLeafId());
    assert.equal(history.nodes.find((node) => node.id === "answer2")?.active, false);
    html = render(history.nodes, "tree", "checkpoint");
    for (const entry of entries) assert.ok(html.includes(`data-entry="${entry.id}"`));
    assert.match(html, /data-restore-mode="conversation"/);
    assert.match(html, /data-restore-mode="all"/);
    assert.doesNotMatch(html, /undefined/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("root rewind and legacy navigation entries still expose abandoned history", async () => {
  const { dir, manager } = await fixture();
  try {
    await navigationHandler(manager)("user1");
    const history = flattenHistoryTree(manager.getTree(), manager.getLeafId());
    assert.equal(history.nodes.filter((node) => node.rewindable).length, 2);
    assert.ok(history.nodes.filter((node) => node.rewindable).every((node) => !node.active));
    manager.appendCustomEntry("pi-web-tree-navigation", { targetId: "user1" });
    const legacy = flattenHistoryTree(manager.getTree(), manager.getLeafId());
    assert.match(render(legacy.nodes), /Old branch prompt/);
    assert.doesNotMatch(render(legacy.nodes), /pi-historyReturn/);
    assert.match(render(legacy.nodes, "tree"), /data-entry="checkpoint"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancelled navigation does not create a return marker", async () => {
  const { dir, manager } = await fixture();
  try {
    const before = manager.getEntries().length;
    await assert.rejects(navigationHandler(manager, true)("user1"), /已取消/);
    assert.equal(manager.getLeafId(), "answer2");
    assert.equal(manager.getEntries().length, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("busy navigation disables return and restore controls", () => {
  const nodes = [
    { id: "old", text: "Old answer", navigable: true, role: "assistant" },
    { id: "now", text: "Current", current: true, navigationFromId: "old" },
  ];
  const html = render(nodes, "tree", "old", "old");
  const buttons = html.match(/<button[^>]*>/g) || [];
  const navigationButtons = buttons.filter((button) => /data-action="history-(choose-rewind|rewind-mode|rewind-cancel)"/.test(button));
  assert.equal(navigationButtons.length, 6);
  for (const button of navigationButtons) {
    assert.match(button, /disabled/);
  }
  assert.doesNotMatch(render(nodes, "tree", "now"), /data-restore-mode=/);
});
