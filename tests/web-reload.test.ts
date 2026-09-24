import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { webSlashCommands, unsupportedSlashCommands, parseSlashCommand } from "../web/slash-commands.js";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const commands = app.slice(app.indexOf("const WEB_SLASH_COMMANDS ="), app.indexOf("function commandSourceLabel("));
const execute = app.slice(app.indexOf("async function executeLocalSlashCommand("), app.indexOf("async function sendDraft("));

test("reload is handled locally and preserves the draft when rejected", async () => {
  const state = { currentSessionId: "session", draft: "/reload" };
  const calls: string[] = [];
  let reject = false;
  const context = createContext({
    S: state, webSlashCommands, unsupportedSlashCommands, parseSlashCommand,
    clearComposerDraft: () => { state.draft = ""; },
    showToast: () => {},
    post: async (path: string) => {
      calls.push(path);
      if (reject) throw new Error("busy");
      return { ok: true, reloaded: true };
    },
  });
  runInContext(`${commands}\n${execute}`, context);
  assert.equal(await runInContext('executeLocalSlashCommand("/reload")', context), true);
  assert.equal(state.draft, "");
  assert.deepEqual(calls, ["/api/sessions/session/reload"]);
  reject = true;
  state.draft = "/reload";
  await assert.rejects(runInContext('executeLocalSlashCommand("/reload")', context), /busy/);
  assert.equal(state.draft, "/reload");
  await assert.rejects(runInContext('executeLocalSlashCommand("/reload extra")', context), /不接受参数/);
  state.currentSessionId = "";
  await assert.rejects(runInContext('executeLocalSlashCommand("/reload")', context), /请先打开会话/);
  assert.equal(calls.length, 2);
});

const bind = app.slice(app.indexOf("function bindComposerInput("), app.indexOf("function restoreDraft("));
const suggest = app.slice(app.indexOf("async function applyCommandSuggestion("), app.indexOf("function openModelPopover("));
const send = app.slice(app.indexOf("async function sendDraft("), app.indexOf("async function respondDialog("));

for (const menuOpen of [false, true]) {
  for (const outcome of ["success", "old-server", "unconfirmed"] as const) {
    test(`Enter reload with menu=${menuOpen}, backend=${outcome} never posts a chat message`, { timeout: 5_000 }, async () => {
      const state = { currentSessionId: "old-session", draft: "/reload", draftAttachments: [], commandMenuOpen: menuOpen, commandSelected: 0 };
      const calls: string[] = [];
      const handlers = new Map<string, (event: any) => void>();
      const input = {
        dataset: {}, value: "/reload", setSelectionRange() {},
        addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
      };
      let notified!: (value: { message: string; type: string }) => void;
      const notification = new Promise<{ message: string; type: string }>((resolve) => { notified = resolve; });
      const context = createContext({
        S: state, webSlashCommands, unsupportedSlashCommands, parseSlashCommand,
        $: () => input, usesTouchInput: () => false, syncComposerInput() {},
        setDraftValue: (value: string) => { state.draft = value; },
        closeCommandMenu: () => { state.commandMenuOpen = false; },
        commandSuggestions: () => webSlashCommands.filter((command) => command.name === "reload"),
        clearComposerDraft: () => { state.draft = ""; },
        showToast: (message: string, type = "info") => notified({ message, type }),
        post: async (path: string) => {
          calls.push(path);
          assert.equal(path, "/api/sessions/old-session/reload");
          if (outcome === "old-server") throw Object.assign(new Error("not found"), { status: 404 });
          return outcome === "success" ? { ok: true, reloaded: true } : { ok: true };
        },
      });
      runInContext(`${commands}\n${execute}\n${send}\n${suggest}\n${bind}\nbindComposerInput()`, context);
      let prevented = false;
      handlers.get("keydown")!({ key: "Enter", preventDefault() { prevented = true; } });
      const toast = await notification;
      // Let the send handler complete its draft cleanup.
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(prevented, true);
      assert.deepEqual(calls, ["/api/sessions/old-session/reload"]);
      assert.equal(toast.type, outcome === "success" ? "info" : "error");
      assert.equal(state.draft, outcome === "success" ? "" : "/reload");
      if (outcome === "old-server") assert.match(toast.message, /尚未加载重载接口/);
      if (outcome === "unconfirmed") assert.match(toast.message, /未确认重载完成/);
    });
  }
}
