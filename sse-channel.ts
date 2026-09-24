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
    waitingForDrain: false,
    pendingEvents: new Map(),
    closed: false,
    onError,
  };
}

function writeEvent(client: SseClient, event: SseEvent): boolean {
  try {
    const accepted = client.res.write(`data: ${JSON.stringify(event)}\n\n`);
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
  if (client.waitingForDrain) {
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
}
