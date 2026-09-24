import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { renderCompaction, stripAnsi, type RenderedMessage } from "../transcript.ts";

const server = await readFile(new URL("../server.ts", import.meta.url), "utf8");
const snapshotSource = server.slice(server.indexOf("function snapshotMessages("), server.indexOf("function pendingQueueSnapshot("));
const eventsSource = server.slice(server.indexOf("function bindSessionEvents("), server.indexOf("function evictIdleProcesses("));

function fixture() {
  const record: { messages: RenderedMessage[]; compactionNotice?: RenderedMessage; compactionNoticeIndex?: number; state: object } = {
    messages: [{ kind: "user", text: "first" }], state: {},
  };
  let receive: (event: object) => void;
  const context = createContext({
    record, renderCompaction, stripAnsi,
    proc: { onEvent: (callback: (event: object) => void) => { receive = callback; } },
    broadcastSessionSnapshot() {},
    refreshMessages: async () => {}, refreshStats: async () => {},
  });
  runInContext(stripTypeScriptTypes(`${snapshotSource}\n${eventsSource}\nbindSessionEvents(record, proc)`), context);
  return {
    record,
    event: (event: object) => receive(event),
    snapshot: (): RenderedMessage[] => runInContext("snapshotMessages(record)", context),
  };
}

for (const aborted of [false, true]) {
  test(`a ${aborted ? "cancelled" : "failed"} compaction stays before later messages across snapshots and refreshes`, () => {
    const view = fixture();
    view.event({ type: "compaction_start", reason: "manual" });
    assert.equal(view.snapshot()[1].status, "running");
    view.event({ type: "compaction_end", aborted, errorMessage: "failure" });
    const notice = view.record.compactionNotice;
    view.record.messages.push({ kind: "assistant", text: "continued response" });
    assert.equal(view.snapshot()[1], notice);
    assert.equal(view.snapshot()[2].text, "continued response");
    view.record.messages = view.record.messages.map(message => ({ ...message }));
    view.record.messages.push({ kind: "user", text: "next prompt" });
    for (let index = 0; index < 3; index += 1) {
      const snapshot = view.snapshot();
      assert.equal(snapshot[1], notice);
      assert.equal(snapshot.filter(message => message.kind === "compaction").length, 1);
      assert.equal(snapshot.at(-1)?.text, "next prompt");
    }
  });
}

test("successful compaction metadata merges with its saved transcript entry exactly once", () => {
  const view = fixture();
  view.event({ type: "compaction_start", reason: "threshold" });
  view.event({ type: "compaction_end", reason: "threshold", result: { summary: "summary", tokensBefore: 100 }, willRetry: true });
  view.record.messages.push(renderCompaction({ id: "saved", summary: "summary", tokensBefore: 100 }));
  view.record.messages.push({ kind: "assistant", text: "continued" });
  const snapshot = view.snapshot();
  assert.equal(snapshot.length, 3);
  assert.equal(snapshot[1].id, "saved");
  assert.equal(snapshot[1].reason, "threshold");
  assert.equal(snapshot[1].willRetry, true);
});
