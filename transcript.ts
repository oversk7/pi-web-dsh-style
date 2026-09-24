export type Json = Record<string, unknown>;

export interface RenderedBlock {
  type: "text" | "thinking" | "toolCall";
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  argumentsText?: string;
  result?: { content: string; isError: boolean; details?: unknown };
  running?: boolean;
}

export interface RenderedMessage {
  kind: "user" | "assistant" | "toolResult" | "bashExecution" | "compaction" | "notice";
  id?: string;
  text?: string;
  blocks?: RenderedBlock[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: string | number;
  usage?: unknown;
  model?: string;
  provider?: string;
  stopReason?: string;
  command?: string;
  output?: string;
  streaming?: boolean;
  status?: "running" | "complete" | "error" | "aborted";
  reason?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  errorMessage?: string;
  willRetry?: boolean;
}

export function browserMessages(messages: RenderedMessage[]): RenderedMessage[] {
  return messages.map((message) => !message.blocks ? message : {
    ...message,
    blocks: message.blocks.map((block) => {
      if (block.type !== "toolCall") return block;
      const { arguments: _arguments, result, ...visible } = block;
      return result
        ? { ...visible, result: { content: result.content, isError: result.isError } }
        : visible;
    }),
  });
}

function timestampValue(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return stripAnsi(content);
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== "object") return "";
      const p = part as Json;
      if (p.type === "text" && typeof p.text === "string") return stripAnsi(p.text);
      if (p.type === "thinking" && typeof p.thinking === "string") return stripAnsi(p.thinking);
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

/** Strip ANSI SGR/escape sequences (pi appends colored turn summaries to text). */
export function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;:<>?]*[ -/]*[@-~]/g, "");
}

export function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return String(args ?? "");
  const record = args as Json;
  if (typeof record.command === "string") return record.command;
  if (typeof record.pattern === "string") return record.pattern;
  if (typeof record.path === "string") return record.path;
  try {
    const text = JSON.stringify(args);
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return "";
  }
}

export function renderAssistantMessage(message: Json): RenderedMessage {
  const blocks: RenderedBlock[] = [];
  if (Array.isArray(message.content)) {
    for (const part of message.content as Json[]) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && typeof part.text === "string") {
        blocks.push({ type: "text", text: stripAnsi(part.text) });
      } else if (part.type === "thinking" && typeof part.thinking === "string") {
        blocks.push({ type: "thinking", thinking: stripAnsi(part.thinking) });
      } else if (part.type === "toolCall") {
        const args = part.arguments;
        blocks.push({
          type: "toolCall",
          id: typeof part.id === "string" ? part.id : undefined,
          name: typeof part.name === "string" ? part.name : "tool",
          arguments: args,
          argumentsText: summarizeArgs(args),
        });
      }
    }
  }
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
  const errorMessage = typeof message.errorMessage === "string" ? stripAnsi(message.errorMessage) : undefined;
  return {
    kind: "assistant",
    blocks,
    timestamp: timestampValue(message.timestamp),
    usage: message.usage ?? undefined,
    model: typeof message.model === "string" ? message.model : undefined,
    provider: typeof message.provider === "string" ? message.provider : undefined,
    stopReason,
    errorMessage,
    isError: stopReason === "error" || Boolean(errorMessage),
  };
}

export function renderMessage(message: Json): RenderedMessage | undefined {
  if (!message || typeof message !== "object") return undefined;
  const role = message.role;
  if (role === "user") {
    return { kind: "user", text: contentText(message.content), timestamp: timestampValue(message.timestamp) };
  }
  if (role === "assistant") return renderAssistantMessage(message);
  if (role === "toolResult") {
    return {
      kind: "toolResult",
      toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
      toolName: typeof message.toolName === "string" ? message.toolName : undefined,
      text: contentText(message.content),
      isError: Boolean(message.isError),
      timestamp: timestampValue(message.timestamp),
    };
  }
  if (role === "bashExecution") {
    return {
      kind: "bashExecution",
      command: typeof message.command === "string" ? stripAnsi(message.command) : undefined,
      output: typeof message.output === "string" ? stripAnsi(message.output) : undefined,
      timestamp: timestampValue(message.timestamp),
    };
  }
  return undefined;
}

export function renderCompaction(entry: Json): RenderedMessage {
  const numberField = (key: string): number | undefined => {
    const value = entry[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
  return {
    kind: "compaction",
    id: typeof entry.id === "string" ? entry.id : undefined,
    text: typeof entry.summary === "string" ? stripAnsi(entry.summary) : "",
    timestamp: timestampValue(entry.timestamp),
    status: "complete",
    tokensBefore: numberField("tokensBefore"),
    estimatedTokensAfter: numberField("estimatedTokensAfter"),
    usage: entry.usage ?? undefined,
  };
}

export function renderTranscript(rawMessages: unknown): RenderedMessage[] {
  if (!Array.isArray(rawMessages)) return [];
  const out: RenderedMessage[] = [];
  for (const raw of rawMessages) {
    const rendered = renderMessage(raw as Json);
    if (rendered) out.push(rendered);
  }
  return attachToolResults(out);
}

export function renderSessionEntries(rawEntries: unknown, leafValue: unknown): RenderedMessage[] {
  if (!Array.isArray(rawEntries)) return [];
  const entries = rawEntries.filter((entry): entry is Json => Boolean(entry && typeof entry === "object"));
  const byId = new Map<string, Json>();
  for (const entry of entries) {
    if (typeof entry.id === "string") byId.set(entry.id, entry);
  }

  let current: Json | undefined = typeof leafValue === "string" ? byId.get(leafValue) : undefined;
  if (!current) current = entries[entries.length - 1];
  const path: Json[] = [];
  const seen = new Set<string>();
  while (current) {
    const id: string | undefined = typeof current.id === "string" ? current.id : undefined;
    if (id && seen.has(id)) break;
    if (id) seen.add(id);
    path.push(current);
    const parentId: string | undefined = typeof current.parentId === "string" ? current.parentId : undefined;
    current = parentId && parentId !== id ? byId.get(parentId) : undefined;
  }
  path.reverse();

  const rendered: RenderedMessage[] = [];
  for (const entry of path) {
    if (entry.type === "message" && entry.message && typeof entry.message === "object") {
      const message = renderMessage(entry.message as Json);
      if (message) rendered.push(message);
    } else if (entry.type === "compaction") {
      rendered.push(renderCompaction(entry));
    }
  }
  return attachToolResults(rendered);
}

export function attachToolResults(messages: RenderedMessage[]): RenderedMessage[] {
  const byCallId = new Map<string, RenderedBlock>();
  for (const message of messages) {
    if (message.kind !== "assistant" || !message.blocks) continue;
    for (const block of message.blocks) {
      if (block.type === "toolCall" && block.id) byCallId.set(block.id, block);
    }
  }

  const attached = new Set<RenderedMessage>();
  for (const message of messages) {
    if (message.kind !== "toolResult" || !message.toolCallId) continue;
    const block = byCallId.get(message.toolCallId);
    if (!block) continue;
    block.result = { content: message.text ?? "", isError: Boolean(message.isError) };
    block.running = false;
    attached.add(message);
  }

  return attached.size === 0 ? messages : messages.filter((message) => !attached.has(message));
}

export function applyAssistantDelta(messages: RenderedMessage[], event: Json): void {
  const delta = (event.assistantMessageEvent ?? {}) as Json;
  const message = (event.message ?? {}) as Json;
  let assistant = messages.find((m) => m.kind === "assistant" && m.streaming === true);
  if (!assistant) {
    const created: RenderedMessage = {
      kind: "assistant",
      blocks: [],
      streaming: true,
      timestamp: timestampValue(message.timestamp) ?? Date.now(),
    };
    messages.push(created);
    assistant = created;
  }
  const blocks = assistant.blocks ?? (assistant.blocks = []);
  const index = typeof delta.contentIndex === "number" ? delta.contentIndex : 0;
  const dType = delta.type;
  if (dType === "text_start") {
    blocks[index] = { type: "text", text: "" };
  } else if (dType === "text_delta" && typeof delta.delta === "string") {
    if (blocks[index]?.type !== "text") blocks[index] = { type: "text", text: "" };
    blocks[index].text = `${blocks[index].text ?? ""}${stripAnsi(delta.delta)}`;
  } else if (dType === "text_end" && typeof delta.content === "string") {
    if (blocks[index]?.type !== "text") blocks[index] = { type: "text", text: "" };
    blocks[index].text = stripAnsi(delta.content);
  } else if (dType === "thinking_start") {
    blocks[index] = { type: "thinking", thinking: "" };
  } else if (dType === "thinking_delta" && typeof delta.delta === "string") {
    if (blocks[index]?.type !== "thinking") blocks[index] = { type: "thinking", thinking: "" };
    blocks[index].thinking = `${blocks[index].thinking ?? ""}${stripAnsi(delta.delta)}`;
  } else if (dType === "thinking_end" && typeof delta.content === "string") {
    if (blocks[index]?.type !== "thinking") blocks[index] = { type: "thinking", thinking: "" };
    blocks[index].thinking = stripAnsi(delta.content);
  } else if (dType === "toolcall_start") {
    blocks[index] = { type: "toolCall", id: "", name: "", argumentsText: "", running: true };
  } else if (dType === "toolcall_delta") {
    if (blocks[index]?.type !== "toolCall") blocks[index] = { type: "toolCall", id: "", name: "", argumentsText: "", running: true };
    if (typeof delta.delta === "string") blocks[index].argumentsText = `${blocks[index].argumentsText ?? ""}${delta.delta}`;
  } else if (dType === "toolcall_end") {
    const call = (delta.toolCall ?? {}) as Json;
    const args = call.arguments;
    blocks[index] = {
      type: "toolCall",
      id: typeof call.id === "string" ? call.id : blocks[index]?.id,
      name: typeof call.name === "string" ? call.name : blocks[index]?.name ?? "tool",
      arguments: args,
      argumentsText: summarizeArgs(args),
      running: true,
    };
  }
}

export function applyToolExecution(messages: RenderedMessage[], event: Json): void {
  const callId = typeof event.toolCallId === "string" ? event.toolCallId : "";
  if (!callId) return;
  let block: RenderedBlock | undefined;
  let assistant: RenderedMessage | undefined;
  for (const m of messages) {
    if (m.kind === "assistant" && m.blocks) {
      const found = m.blocks.find((b) => b.type === "toolCall" && b.id === callId);
      if (found) {
        block = found;
        assistant = m;
        break;
      }
    }
  }
  if (!block) {
    assistant = { kind: "assistant", blocks: [], streaming: true, timestamp: Date.now() };
    messages.push(assistant);
    block = {
      type: "toolCall",
      id: callId,
      name: typeof event.toolName === "string" ? event.toolName : "tool",
      arguments: event.args ?? {},
      argumentsText: summarizeArgs(event.args),
      running: true,
    };
    assistant.blocks = [...(assistant.blocks ?? []), block];
  }
  if (event.type === "tool_execution_start") {
    block.name = typeof event.toolName === "string" ? event.toolName : block.name;
    block.arguments = event.args ?? block.arguments;
    block.argumentsText = summarizeArgs(event.args) || block.argumentsText;
    block.running = true;
  } else if (event.type === "tool_execution_update") {
    block.running = true;
    const partial = event.partialResult as Json | undefined;
    if (partial) block.result = { content: contentText(partial.content), isError: false, details: partial.details };
  } else if (event.type === "tool_execution_end") {
    block.running = false;
    const result = event.result as Json | undefined;
    block.result = {
      content: contentText(result?.content),
      isError: Boolean(event.isError),
      details: result?.details,
    };
  }
}

export function findLast<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i])) return i;
  }
  return -1;
}
