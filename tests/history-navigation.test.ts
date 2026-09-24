import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const source = app.slice(app.indexOf("async function navigateHistory("), app.indexOf("function renderSettings("));

for (const confirmed of [false, true]) {
  test(`returning to an answer protects the draft and respects confirmation=${confirmed}`, async () => {
    const state = {
      historyView: { sessionId: "session" }, currentSessionId: "session", draft: "Rewound prompt",
      historyGeneration: 1, conversationTab: "history", snapshots: new Map(),
    };
    let requests = 0;
    await runInNewContext(`${source}\nnavigateHistory("answer", "assistant", "conversation")`, {
      S: state, t: (text: string) => text,
      confirm: (message: string) => {
        assert.match(message, /清空当前输入框草稿/);
        return confirmed;
      },
      renderConversation() {},
      post: async (_url: string, body: { entryId: string; restoreMode: string }) => {
        requests += 1;
        assert.equal(body.entryId, "answer");
        assert.equal(body.restoreMode, "conversation");
        return { editorText: "", messages: [], session: { id: "session" } };
      },
      snapshotFor: () => ({}),
      setDraftValue: (text: string) => { state.draft = text; },
      queueRender() {}, requestAnimationFrame() {}, showToast() {},
    });
    assert.equal(requests, confirmed ? 1 : 0);
    assert.equal(state.draft, confirmed ? "" : "Rewound prompt");
    assert.equal(state.conversationTab, confirmed ? "conversation" : "history");
  });
}
