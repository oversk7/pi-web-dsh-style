import type { Json } from "./pi-rpc.ts";

export interface AbortRequestResult {
  acknowledged: boolean;
  response?: Json;
  errorMessage?: string;
}

export interface ClearedRpcQueue {
  supported: boolean;
  steering: string[];
  followUp: string[];
  response?: Json;
  errorMessage?: string;
}

export type RpcQueueKind = "steering" | "followUp";

export interface RpcQueueSnapshot {
  steering: string[];
  followUp: string[];
}

export interface RpcQueueItemTarget {
  kind: RpcQueueKind;
  index: number;
  message: string;
}

export interface WithdrawRpcQueueResult {
  supported: boolean;
  withdrawn: boolean;
  queue: RpcQueueSnapshot;
  unrestored: RpcQueueSnapshot;
  errorMessage?: string;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function emptyQueue(): RpcQueueSnapshot {
  return { steering: [], followUp: [] };
}

function queueFromEntries(entries: Array<{ kind: RpcQueueKind; message: string }>): RpcQueueSnapshot {
  const queue = emptyQueue();
  for (const entry of entries) queue[entry.kind].push(entry.message);
  return queue;
}

async function restoreRpcQueue(
  proc: { send(command: Json, timeoutMs?: number): Promise<Json> },
  queue: RpcQueueSnapshot,
  timeoutMs: number,
): Promise<{ queue: RpcQueueSnapshot; unrestored: RpcQueueSnapshot; errorMessage?: string }> {
  const entries: Array<{ kind: RpcQueueKind; message: string }> = [
    ...queue.steering.map((message) => ({ kind: "steering" as const, message })),
    ...queue.followUp.map((message) => ({ kind: "followUp" as const, message })),
  ];
  const restored: Array<{ kind: RpcQueueKind; message: string }> = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    try {
      await proc.send({ type: entry.kind === "steering" ? "steer" : "follow_up", message: entry.message }, timeoutMs);
      restored.push(entry);
    } catch (error) {
      return {
        queue: queueFromEntries(restored),
        unrestored: queueFromEntries(entries.slice(index)),
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { queue: queueFromEntries(restored), unrestored: emptyQueue() };
}

export async function requestRpcClearQueue(
  proc: { send(command: Json, timeoutMs?: number): Promise<Json> },
  timeoutMs: number,
): Promise<ClearedRpcQueue> {
  try {
    const response = await proc.send({ type: "clear_queue" }, timeoutMs);
    const data = response.data && typeof response.data === "object" ? response.data as Json : {};
    return {
      supported: true,
      steering: stringArray(data.steering),
      followUp: stringArray(data.followUp),
      response,
    };
  } catch (error) {
    return {
      supported: false,
      steering: [],
      followUp: [],
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function requestRpcWithdrawQueueItem(
  proc: { send(command: Json, timeoutMs?: number): Promise<Json> },
  target: RpcQueueItemTarget,
  timeoutMs: number,
): Promise<WithdrawRpcQueueResult> {
  const cleared = await requestRpcClearQueue(proc, timeoutMs);
  if (!cleared.supported) {
    return {
      supported: false,
      withdrawn: false,
      queue: emptyQueue(),
      unrestored: emptyQueue(),
      errorMessage: cleared.errorMessage,
    };
  }

  const remaining: RpcQueueSnapshot = {
    steering: [...cleared.steering],
    followUp: [...cleared.followUp],
  };
  const targetQueue = remaining[target.kind];
  const withdrawn = Number.isInteger(target.index)
    && target.index >= 0
    && targetQueue[target.index] === target.message;
  if (withdrawn) targetQueue.splice(target.index, 1);

  const restored = await restoreRpcQueue(proc, remaining, timeoutMs);
  return {
    supported: true,
    withdrawn,
    queue: restored.queue,
    unrestored: restored.unrestored,
    errorMessage: restored.errorMessage,
  };
}

export async function requestRpcAbort(
  proc: { send(command: Json, timeoutMs?: number): Promise<Json> },
  timeoutMs: number,
): Promise<AbortRequestResult> {
  try {
    const response = await proc.send({ type: "abort" }, timeoutMs);
    return { acknowledged: true, response };
  } catch (error) {
    return {
      acknowledged: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}
