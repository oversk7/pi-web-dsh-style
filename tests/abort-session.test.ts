import assert from "node:assert/strict";
import test from "node:test";
import { requestRpcAbort, requestRpcClearQueue, requestRpcWithdrawQueueItem } from "../abort-session.ts";

test("requestRpcAbort forwards the timeout and returns the acknowledgement", async () => {
  const calls: Array<{ command: unknown; timeoutMs?: number }> = [];
  const proc = {
    async send(command: unknown, timeoutMs?: number) {
      calls.push({ command, timeoutMs });
      return { type: "response", success: true };
    },
  };

  const result = await requestRpcAbort(proc, 3_000);

  assert.equal(result.acknowledged, true);
  assert.deepEqual(result.response, { type: "response", success: true });
  assert.deepEqual(calls, [{ command: { type: "abort" }, timeoutMs: 3_000 }]);
});

test("requestRpcClearQueue returns queued messages in RPC order", async () => {
  const calls: Array<{ command: unknown; timeoutMs?: number }> = [];
  const proc = {
    async send(command: unknown, timeoutMs?: number) {
      calls.push({ command, timeoutMs });
      return {
        type: "response",
        success: true,
        data: { steering: ["修正方向"], followUp: ["下一条", 42] },
      };
    },
  };

  const result = await requestRpcClearQueue(proc, 3_000);

  assert.equal(result.supported, true);
  assert.deepEqual(result.steering, ["修正方向"]);
  assert.deepEqual(result.followUp, ["下一条"]);
  assert.deepEqual(calls, [{ command: { type: "clear_queue" }, timeoutMs: 3_000 }]);
});

test("requestRpcClearQueue reports unsupported or failed RPC calls", async () => {
  const proc = {
    async send() {
      throw new Error("unknown command: clear_queue");
    },
  };

  const result = await requestRpcClearQueue(proc, 3_000);

  assert.deepEqual(result, {
    supported: false,
    steering: [],
    followUp: [],
    errorMessage: "unknown command: clear_queue",
  });
});

test("requestRpcWithdrawQueueItem removes one item and preserves queue kinds", async () => {
  const calls: Array<{ command: any; timeoutMs?: number }> = [];
  const proc = {
    async send(command: any, timeoutMs?: number) {
      calls.push({ command, timeoutMs });
      if (command.type === "clear_queue") {
        return {
          type: "response",
          success: true,
          data: { steering: ["保留方向", "撤回方向"], followUp: ["最后总结"] },
        };
      }
      return { type: "response", success: true };
    },
  };

  const result = await requestRpcWithdrawQueueItem(
    proc,
    { kind: "steering", index: 1, message: "撤回方向" },
    3_000,
  );

  assert.deepEqual(result, {
    supported: true,
    withdrawn: true,
    queue: { steering: ["保留方向"], followUp: ["最后总结"] },
    unrestored: { steering: [], followUp: [] },
    errorMessage: undefined,
  });
  assert.deepEqual(calls, [
    { command: { type: "clear_queue" }, timeoutMs: 3_000 },
    { command: { type: "steer", message: "保留方向" }, timeoutMs: 3_000 },
    { command: { type: "follow_up", message: "最后总结" }, timeoutMs: 3_000 },
  ]);
});

test("requestRpcWithdrawQueueItem restores the queue when the target is stale", async () => {
  const calls: any[] = [];
  const proc = {
    async send(command: any) {
      calls.push(command);
      if (command.type === "clear_queue") {
        return { type: "response", success: true, data: { steering: ["仍在队列"], followUp: [] } };
      }
      return { type: "response", success: true };
    },
  };

  const result = await requestRpcWithdrawQueueItem(
    proc,
    { kind: "steering", index: 1, message: "已经发出" },
    3_000,
  );

  assert.equal(result.withdrawn, false);
  assert.deepEqual(result.queue, { steering: ["仍在队列"], followUp: [] });
  assert.deepEqual(calls, [
    { type: "clear_queue" },
    { type: "steer", message: "仍在队列" },
  ]);
});

test("requestRpcWithdrawQueueItem reports messages that could not be restored", async () => {
  const proc = {
    async send(command: any) {
      if (command.type === "clear_queue") {
        return {
          type: "response",
          success: true,
          data: { steering: ["撤回", "保留"], followUp: ["稍后处理"] },
        };
      }
      if (command.type === "follow_up") throw new Error("queue closed");
      return { type: "response", success: true };
    },
  };

  const result = await requestRpcWithdrawQueueItem(
    proc,
    { kind: "steering", index: 0, message: "撤回" },
    3_000,
  );

  assert.deepEqual(result, {
    supported: true,
    withdrawn: true,
    queue: { steering: ["保留"], followUp: [] },
    unrestored: { steering: [], followUp: ["稍后处理"] },
    errorMessage: "queue closed",
  });
});

test("requestRpcAbort converts timeout failures into a fallback result", async () => {
  const proc = {
    async send() {
      throw new Error("pi rpc command timed out: abort");
    },
  };

  const result = await requestRpcAbort(proc, 3_000);

  assert.deepEqual(result, {
    acknowledged: false,
    errorMessage: "pi rpc command timed out: abort",
  });
});
