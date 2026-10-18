import { canonicalizeJson, diffSessionSnapshots, type JsonValue } from "./web/session-sync.js";

export type SseEvent = Record<string, unknown>;

// Coalesce before serializing full histories, so a burst of tokens does not
// become a queue of obsolete snapshots on a slower relay connection.
export function createSnapshotScheduler<T>(emit: (value: T) => void, intervalMs = 100) {
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; latest?: T }>();
  function cancel(key: string): void {
    const entry = pending.get(key);
    if (entry) clearTimeout(entry.timer);
    pending.delete(key);
  }
  return {
    schedule(key: string, value: T, immediate = false): void {
      if (immediate) {
        cancel(key);
        emit(value);
        return;
      }
      const current = pending.get(key);
      if (current) {
        current.latest = value;
        return;
      }
      const entry: { timer: ReturnType<typeof setTimeout>; latest?: T } = {
        timer: setTimeout(() => {
          pending.delete(key);
          if (entry.latest !== undefined) emit(entry.latest);
        }, intervalMs),
      };
      pending.set(key, entry);
      emit(value);
    },
    cancel,
    clear(): void {
      for (const key of pending.keys()) cancel(key);
    },
  };
}

export interface SseWritable {
  write(payload: string): boolean;
  once(event: "drain", listener: () => void): unknown;
}

export interface SseClient {
  res: SseWritable;
  sessionId?: string;
  snapshotBaseline?: Record<string, JsonValue>;
  snapshotRevision: number;
  waitingForDrain: boolean;
  pendingEvents: Map<string, SseEvent>;
  closed: boolean;
  onError: () => void;
}

function eventKey(event: SseEvent): string {
  const type = typeof event.type === "string" ? event.type : "event";
  const sessionId = typeof event.sessionId === "string" ? event.sessionId : "";
  return sessionId ? `${type}:${sessionId}` : type;
}

export function createSseClient(res: SseWritable, onError: () => void): SseClient {
  return {
    res,
    snapshotRevision: 0,
    waitingForDrain: false,
    pendingEvents: new Map(),
    closed: false,
    onError,
  };
}

function writeEvent(client: SseClient, event: SseEvent): boolean {
  try {
    let outgoing = event;
    const snapshot = event.type === "snapshot" ? event as Record<string, JsonValue> : undefined;
    if (snapshot) {
      const revision = client.snapshotRevision + 1;
      if (client.snapshotBaseline && client.snapshotBaseline.sessionId === snapshot.sessionId) {
        const patches = diffSessionSnapshots(client.snapshotBaseline, snapshot);
        if (patches.length === 0) return true;
        outgoing = { type: "session_patch", sessionId: snapshot.sessionId, baseRevision: client.snapshotRevision, revision, patches };
      } else {
        outgoing = { ...snapshot, revision };
      }
    }
    const accepted = client.res.write(`data: ${JSON.stringify(outgoing)}\n\n`);
    // A false return still means Node accepted the bytes into its buffer.
    if (snapshot) {
      client.snapshotBaseline = snapshot;
      client.snapshotRevision++;
    }
    if (accepted) return true;
    client.waitingForDrain = true;
    client.res.once("drain", () => flushPendingEvents(client));
    return false;
  } catch {
    closeSseClient(client);
    client.onError();
    return false;
  }
}

function flushPendingEvents(client: SseClient): void {
  if (client.closed) return;
  client.waitingForDrain = false;
  while (!client.waitingForDrain && client.pendingEvents.size > 0) {
    const next = client.pendingEvents.entries().next().value as [string, SseEvent] | undefined;
    if (!next) return;
    client.pendingEvents.delete(next[0]);
    writeEvent(client, next[1]);
  }
}

export function sendSseEvent(client: SseClient, event: SseEvent): void {
  if (client.closed) return;
  if (event.type === "snapshot") {
    try {
      const { revision: _revision, ...body } = event;
      event = canonicalizeJson(body) as Record<string, JsonValue>;
    } catch {
      closeSseClient(client);
      client.onError();
      return;
    }
  }
  if (client.waitingForDrain) {
    // Snapshot entries are detached full targets, diffed only when written.
    // Keep only the newest event of each kind while the browser catches up.
    // This bounds memory even when snapshots contain a long conversation.
    client.pendingEvents.set(eventKey(event), event);
    return;
  }
  writeEvent(client, event);
}

export function closeSseClient(client: SseClient): void {
  client.closed = true;
  client.waitingForDrain = false;
  client.pendingEvents.clear();
  client.snapshotBaseline = undefined;
  client.snapshotRevision = 0;
}
