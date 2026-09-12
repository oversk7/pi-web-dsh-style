import { existsSync, statSync } from "node:fs";
import { calculateContextTokens, estimateTokens, SessionManager } from "@earendil-works/pi-coding-agent";
import { renderSessionEntries, type RenderedMessage } from "./transcript.ts";

export type Json = Record<string, unknown>;

export interface LocalSessionSnapshot {
  messages: RenderedMessage[];
  state: Json;
  stats: Json | null;
  title?: string;
  sessionFile?: string;
}

interface SessionEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: Json;
  usage?: Json;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  name?: string;
}

function localContextTokens(manager: SessionManager): number | null {
  const branch = manager.getBranch();
  let latestCompactionIndex = -1;
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    if (branch[i]?.type === "compaction") {
      latestCompactionIndex = i;
      break;
    }
  }
  if (latestCompactionIndex >= 0) {
    let hasPostCompactionUsage = false;
    for (let i = branch.length - 1; i > latestCompactionIndex; i -= 1) {
      const entry = branch[i];
      if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
      if (entry.message.stopReason === "aborted" || entry.message.stopReason === "error" || !entry.message.usage) continue;
      if (calculateContextTokens(entry.message.usage) > 0) {
        hasPostCompactionUsage = true;
        break;
      }
    }
    if (!hasPostCompactionUsage) return null;
  }

  const messages = manager.buildSessionContext().messages;
  let lastUsageIndex = -1;
  let contextTokens = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    if (message.stopReason === "aborted" || message.stopReason === "error" || !message.usage) continue;
    const tokens = calculateContextTokens(message.usage);
    if (tokens <= 0) continue;
    lastUsageIndex = i;
    contextTokens = tokens;
    break;
  }
  const trailingStart = lastUsageIndex >= 0 ? lastUsageIndex + 1 : 0;
  for (let i = trailingStart; i < messages.length; i += 1) {
    contextTokens += estimateTokens(messages[i]);
  }
  return contextTokens;
}

/**
 * Read a Pi session JSONL file directly (no pi process) and produce the same
 * shape the web UI uses for switching/display. This makes switching to a
 * not-yet-opened session instant, like DSH's in-memory harness sessions.
 */
export function loadLocalSession(sessionFile: string, fallbackCwd?: string): LocalSessionSnapshot {
  if (!existsSync(sessionFile) || statSync(sessionFile).size === 0) {
    return {
      messages: [],
      state: { sessionFile, isStreaming: false },
      stats: null,
      sessionFile,
    };
  }

  const manager = SessionManager.open(sessionFile, undefined, fallbackCwd);
  const entries = manager.getEntries() as SessionEntry[];
  const leafId = manager.getLeafId();

  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) {
    if (entry.id) byId.set(entry.id, entry);
  }

  // Walk from the current leaf to the root so forked branches only show the
  // active path, mirroring what the pi session exposes to the UI.
  let leaf = leafId ? byId.get(leafId) : undefined;
  if (!leaf) leaf = entries[entries.length - 1];
  const path: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  const seen = new Set<string>();
  while (current) {
    if (current.id && seen.has(current.id)) break;
    if (current.id) seen.add(current.id);
    path.push(current);
    current = current.parentId && current.id !== current.parentId ? byId.get(current.parentId) : undefined;
  }
  path.reverse();

  const rawMessages: Json[] = [];
  let model: Json | null = null;
  let thinkingLevel = "off";
  let sessionName = "";
  for (const entry of path) {
    if (entry.type === "message" && entry.message && typeof entry.message === "object") {
      rawMessages.push(entry.message);
      if (entry.message.role === "assistant") {
        if (typeof entry.message.provider === "string" && typeof entry.message.model === "string") {
          model = {
            provider: entry.message.provider,
            id: entry.message.model,
            name: entry.message.model,
          };
        }
      }
    } else if (entry.type === "model_change") {
      if (typeof entry.provider === "string" && typeof entry.modelId === "string") {
        model = { provider: entry.provider, id: entry.modelId, name: entry.modelId };
      }
    } else if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
      thinkingLevel = entry.thinkingLevel;
    } else if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
      sessionName = entry.name.trim();
    }
  }

  const messages = renderSessionEntries(entries, leafId);
  const contextTokens = localContextTokens(manager);

  // Cheap local stats until a warm process can provide the authoritative ones.
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let input = 0;
  let output = 0;
  let cost = 0;
  for (const entry of entries) {
    const message = entry.type === "message" ? entry.message : undefined;
    const usage = message?.usage ?? ((entry.type === "compaction" || entry.type === "branch_summary") ? entry.usage : undefined);
    const usageCost = usage && typeof usage === "object" ? (usage as Json).cost : undefined;
    const total = usageCost && typeof usageCost === "object" ? (usageCost as Json).total : usageCost;
    if (typeof total === "number" && Number.isFinite(total)) cost += total;
    else if (typeof message?.cost === "number" && Number.isFinite(message.cost)) cost += message.cost;
  }
  for (const raw of rawMessages) {
    const message = raw as Json;
    const role = message.role;
    if (role === "user") userMessages += 1;
    else if (role === "assistant") assistantMessages += 1;
    if (role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content as Json[]) {
        if (part && part.type === "toolCall") toolCalls += 1;
      }
    }
    if (message.usage && typeof message.usage === "object") {
      const usage = message.usage as Json;
      input += Number(usage.input ?? 0);
      output += Number(usage.output ?? 0);
    }
  }

  const state: Json = {
    model,
    thinkingLevel,
    isStreaming: false,
    isCompacting: false,
    sessionFile: manager.getSessionFile(),
    sessionId: manager.getSessionId(),
    sessionName,
    messageCount: rawMessages.length,
    pendingMessageCount: 0,
  };

  return {
    messages,
    state,
    stats: {
      userMessages,
      assistantMessages,
      toolCalls,
      tokens: { input, output },
      contextUsage: { tokens: contextTokens },
      cost,
    },
    title: sessionName || undefined,
    sessionFile: manager.getSessionFile(),
  };
}
