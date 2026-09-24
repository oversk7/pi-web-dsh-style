import type { ServerResponse } from "node:http";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import {
  requestRpcAbort,
  requestRpcClearQueue,
  requestRpcWithdrawQueueItem,
  type RpcQueueKind,
  type RpcQueueSnapshot,
} from "./abort-session.ts";
import { AttachmentStore, detectImageMimeType } from "./attachment-store.ts";
import { builtinCommandError, parseSlashCommand } from "./web/slash-commands.js";
import { extensionSettings } from "./extension-settings.ts";
import { isLocalRequest, WebAccess } from "./network-access.ts";
import { FrpProcess } from "./frp-process.ts";
import { loadTerminalProxy, saveTerminalProxy, validateTerminalProxy, type TerminalProxySettings } from "./terminal-proxy.ts";
import { frpcConfig, loadNetworkSettings, proxyForNetwork, publicNetworkSettings, relayServerFiles, resolveFrpc, saveNetworkSettings, updateNetworkSettings, type NetworkMode, type NetworkSettings } from "./network-settings.ts";
import { closeSseClient, createSseClient, createSnapshotScheduler, sendSseEvent, type SseClient } from "./sse-channel.ts";
import { closeAllPiRpcs, spawnPiRpc, type Json, type PiRpc } from "./pi-rpc.ts";
import { loadLocalSession } from "./local-session.ts";
import { loadJsonWithLegacyMigration, writeJsonAtomically, writeTextAtomically } from "./state-store.ts";
import { buildFilePreview } from "./file-preview.ts";
import { collectBackgroundJobs, readBackgroundJobLog } from "./background-jobs.ts";
import { readClipboardImage, readClipboardText } from "./windows-clipboard.ts";
import {
  applyAssistantDelta,
  applyToolExecution,
  attachToolResults,
  browserMessages,
  findLast,
  renderAssistantMessage,
  renderCompaction,
  renderMessage,
  renderSessionEntries,
  renderTranscript,
  stripAnsi,
  type RenderedMessage,
} from "./transcript.ts";

const here = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(here, "web");
const HOST = "127.0.0.1";
const DEFAULT_PORT = 18789;
const STATE_DIR = process.env.PI_WEB_STATE_DIR || join(getAgentDir(), "pi-web");
const STATE_FILE = resolve(process.env.PI_WEB_STATE_FILE || join(STATE_DIR, "state.json"));
const LEGACY_STATE_FILE = resolve(process.env.PI_WEB_LEGACY_STATE_FILE || join(here, "state.json"));
const AUTH_FILE = join(dirname(STATE_FILE), "auth.json");
const NETWORK_FILE = join(dirname(STATE_FILE), "network.json");
const TERMINAL_PROXY_FILE = join(dirname(STATE_FILE), "terminal-proxy.json");

interface Workspace {
  id: string;
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface ReorderWorkspaceInput {
  workspaceIds: string[];
}

interface StoredSession {
  id: string;
  workspaceId: string;
  title: string;
  sessionFile?: string;
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  needsAttention?: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ModelInfo {
  models: unknown[];
  thinkingLevels: string[];
  defaultModel?: unknown;
  thinkingLevel?: string;
}

interface ModelCatalog {
  models: unknown[];
  defaultModel?: unknown;
  thinkingLevel?: string;
}

interface SlashCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: Json;
}

interface StateFile {
  version: 1;
  currentWorkspaceId?: string;
  currentSessionId?: string;
  workspaces: Workspace[];
  sessions: StoredSession[];
  modelCache?: Record<string, ModelInfo>;
}

interface ExtensionDialog {
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title?: string;
  message?: string;
  placeholder?: string;
  options?: string[];
  prefill?: string;
  timeout?: number;
  createdAt: number;
  expiresAt?: number;
}

type TreeRestoreMode = "conversation" | "all";

interface PendingTreeNavigation {
  restoreMode: TreeRestoreMode;
  restoreDialogHandled: boolean;
  error?: string;
}

interface LiveUsageSnapshot {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

interface HistoryNode {
  id: string;
  parentId: string | null;
  type: string;
  role?: string;
  customType?: string;
  navigationTargetId?: string;
  navigationFromId?: string;
  text: string;
  timestamp?: string;
  label?: string;
  active: boolean;
  current: boolean;
  rewindable: boolean;
  navigable: boolean;
  branchDepth: number;
  branchStart: boolean;
  branchIndex: number;
  branchCount: number;
}

interface RuntimeSession {
  id: string;
  workspaceId: string;
  title: string;
  sessionFile?: string;
  cwd: string;
  status: "stopped" | "starting" | "running" | "idle" | "error";
  error?: string;
  proc?: PiRpc;
  messages: RenderedMessage[];
  state: Json | null;
  stats: Json | null;
  models: unknown[];
  thinkingLevels: string[];
  commands: SlashCommandInfo[];
  extensionStatuses: Record<string, string>;
  dialogs: ExtensionDialog[];
  streaming: boolean;
  needsAttention: boolean;
  starting?: Promise<void>;
  modelRefresh?: Promise<void>;
  commandRefresh?: Promise<void>;
  lastUsed: number;
  pendingModel?: { provider: string; modelId: string };
  pendingThinkingLevel?: string;
  pendingName?: string;
  liveUsage?: LiveUsageSnapshot;
  statsRevision?: number;
  operationChain?: Promise<void>;
  pendingTreeNavigation?: PendingTreeNavigation;
  compactionNotice?: RenderedMessage;
  compactionNoticeIndex?: number;
  pendingQueue?: RpcQueueSnapshot;
}

interface NewSessionPreferences {
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
}

interface ExportDownload {
  path: string;
  filename: string;
  expiresAt: number;
}

interface MaintenanceCommandResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

let server: ReturnType<typeof createServer> | undefined;
let serverUrl: string | undefined;
let serverInstanceId: string | undefined;
let webAccess = new WebAccess(false);
let networkSettings: NetworkSettings = { mode: "local" };
let terminalProxy: TerminalProxySettings = { mode: "inherit", url: "http://127.0.0.1:7987" };
let terminalProxySaving = false;
let networkApplying = false;
let networkChange: Promise<void> = Promise.resolve();
let networkError: string | undefined;
let frpRuntimeDir: string | undefined;
const frpProcess = new FrpProcess(() => broadcastEvent({ type: "network_changed" }));
let updateExtensions: (() => Promise<MaintenanceCommandResult>) | undefined;
let reloadRuntime: (() => Promise<void>) | undefined;
let extensionSettingsCwd = process.cwd();
let extensionSettingsSaving = false;
let maintenanceRunning = false;
let sessions = new Map<string, RuntimeSession>();
let sseClients = new Set<SseClient>();
let state: StateFile = { version: 1, workspaces: [], sessions: [] };
let stateSaveChain: Promise<void> = Promise.resolve();
let shuttingDown = false;
let shutdownPromise: Promise<void> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;

const MAX_IDLE_PROCESSES = 1;
const modelInfoCache = new Map<string, ModelInfo>();
const modelCatalogRefreshes = new Map<string, Promise<ModelCatalog>>();
const commandCache = new Map<string, SlashCommandInfo[]>();
const exportDownloads = new Map<string, ExportDownload>();
const attachments = new AttachmentStore();
const ABORT_RPC_TIMEOUT_MS = 3_000;
const INTERNAL_TREE_COMMAND = "pi-web-navigate-tree";
const INTERNAL_RELOAD_COMMAND = "pi-web-reload-runtime";
const PI_REWIND_KEEP_OPTIONS = ["Keep current files", "Conversation only (keep files)"];
const PI_REWIND_RESTORE_OPTIONS = ["Restore files to that point", "Restore all (files + conversation)"];
const PI_REWIND_CANCEL_OPTIONS = ["Cancel navigation", "Cancel"];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".webp": "image/webp",
};
const MAX_FILE_VIEW_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_VIEW_BYTES = 10 * 1024 * 1024;

function nowIso(): string {
  return new Date().toISOString();
}

function pathTitle(path: string): string {
  const trimmed = path.replace(/[\/]+$/, "");
  return basename(trimmed) || trimmed;
}

function normalizePath(path: string): string {
  return normalize(resolve(path));
}

function exportFilename(title: string): string {
  const safe = title.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/\s+/g, " ").slice(0, 80) || "pi-session";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${safe}-${timestamp}.html`;
}

function rawContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Json[]).map((part) => {
    if (!part || typeof part !== "object") return "";
    if (part.type === "text" && typeof part.text === "string") return part.text;
    if (part.type === "thinking" && typeof part.thinking === "string") return part.thinking;
    if (part.type === "image") return "[图片]";
    if (part.type === "toolCall") return `调用 ${String(part.name ?? "工具")}`;
    return "";
  }).filter(Boolean).join("\n");
}

function contentText(content: unknown, limit = Number.POSITIVE_INFINITY): string {
  const normalized = stripAnsi(rawContentText(content)).replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, Math.max(0, limit - 1))}…` : normalized;
}

function historyEntrySummary(entry: Json): { role?: string; customType?: string; text: string } {
  if (entry.type === "message" && entry.message && typeof entry.message === "object") {
    const message = entry.message as Json;
    const role = typeof message.role === "string" ? message.role : "message";
    let text = contentText(message.content, 280);
    if (!text && role === "toolResult") text = `${String(message.toolName ?? "工具")} 执行结果`;
    return { role, text: text || `${role} 消息` };
  }
  if (entry.type === "custom_message") {
    return { role: "custom", customType: String(entry.customType ?? "custom"), text: contentText(entry.content, 280) || "自定义消息" };
  }
  if (entry.type === "compaction") return { text: contentText(entry.summary, 280) || "上下文压缩" };
  if (entry.type === "branch_summary") return { text: contentText(entry.summary, 280) || "分支摘要" };
  if (entry.type === "model_change") return { text: `切换模型：${String(entry.provider ?? "")}/${String(entry.modelId ?? "")}` };
  if (entry.type === "thinking_level_change") return { text: `思考强度：${String(entry.thinkingLevel ?? "off")}` };
  if (entry.type === "session_info") return { text: `会话名称：${String(entry.name ?? "")}` };
  if (entry.type === "label") return { text: `标签：${String(entry.label ?? "已清除")}` };
  if (entry.type === "custom") {
    const customType = String(entry.customType ?? "custom");
    return { customType, text: customType === "pi-web-tree-navigation" ? "Web 回溯点" : `扩展状态：${customType}` };
  }
  return { text: String(entry.type ?? "会话节点") };
}

export function flattenHistoryTree(treeValue: unknown, leafValue: unknown): { nodes: HistoryNode[]; leafId: string | null } {
  const roots = Array.isArray(treeValue) ? treeValue as Json[] : [];
  const leafId = typeof leafValue === "string" ? leafValue : null;
  const entries = new Map<string, Json>();
  const indexStack = [...roots];
  while (indexStack.length > 0) {
    const node = indexStack.pop();
    if (!node || typeof node !== "object") continue;
    const entry = node.entry && typeof node.entry === "object" ? node.entry as Json : {};
    if (typeof entry.id === "string") entries.set(entry.id, entry);
    if (Array.isArray(node.children)) indexStack.push(...node.children as Json[]);
  }
  const activeIds = new Set<string>();
  let current = leafId ? entries.get(leafId) : undefined;
  while (current && typeof current.id === "string" && !activeIds.has(current.id)) {
    activeIds.add(current.id);
    current = typeof current.parentId === "string" ? entries.get(current.parentId) : undefined;
  }

  const nodes: HistoryNode[] = [];
  const stack = roots.slice().reverse().map((node) => ({ node, branchDepth: 0, branchStart: false, branchIndex: 0, branchCount: roots.length }));
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item?.node || typeof item.node !== "object") continue;
    const entry = item.node.entry && typeof item.node.entry === "object" ? item.node.entry as Json : {};
    if (typeof entry.id !== "string") continue;
    const children = Array.isArray(item.node.children) ? item.node.children as Json[] : [];
    const summary = historyEntrySummary(entry);
    const active = activeIds.has(entry.id);
    nodes.push({
      id: entry.id,
      parentId: typeof entry.parentId === "string" ? entry.parentId : null,
      type: typeof entry.type === "string" ? entry.type : "unknown",
      role: summary.role,
      customType: summary.customType,
      navigationTargetId: entry.type === "custom" && entry.data && typeof entry.data === "object" && typeof (entry.data as Json).targetId === "string"
        ? (entry.data as Json).targetId as string
        : undefined,
      navigationFromId: entry.type === "custom" && entry.customType === "pi-web-tree-navigation" && entry.data && typeof entry.data === "object" && typeof (entry.data as Json).fromId === "string"
        ? (entry.data as Json).fromId as string
        : undefined,
      text: summary.text,
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
      label: typeof item.node.label === "string" ? item.node.label : undefined,
      active,
      current: entry.id === leafId,
      rewindable: summary.role === "user",
      navigable: entry.id !== leafId,
      branchDepth: item.branchDepth,
      branchStart: item.branchStart,
      branchIndex: item.branchIndex,
      branchCount: children.length,
    });
    const nextDepth = item.branchDepth + (children.length > 1 ? 1 : 0);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({
        node: children[index],
        branchDepth: nextDepth,
        branchStart: children.length > 1,
        branchIndex: index,
        branchCount: children.length,
      });
    }
  }
  return { nodes, leafId };
}

async function sessionHistory(record: RuntimeSession): Promise<{ nodes: HistoryNode[]; leafId: string | null }> {
  if (record.proc) {
    const response = await record.proc.send<Json>({ type: "get_tree" });
    return flattenHistoryTree(response.data?.tree, response.data?.leafId);
  }
  if (!record.sessionFile || !existsSync(record.sessionFile)) return { nodes: [], leafId: null };
  const manager = SessionManager.open(record.sessionFile, undefined, record.cwd);
  return flattenHistoryTree(manager.getTree(), manager.getLeafId());
}

function historyEditorText(record: RuntimeSession, entryId: string): string | undefined {
  if (!record.sessionFile || !existsSync(record.sessionFile)) return undefined;
  const manager = SessionManager.open(record.sessionFile, undefined, record.cwd);
  const entry = manager.getEntry(entryId) as Json | undefined;
  if (!entry) return undefined;
  if (entry.type === "message" && entry.message && typeof entry.message === "object") {
    const message = entry.message as Json;
    if (message.role === "user") return rawContentText(message.content);
  }
  if (entry.type === "custom_message") return rawContentText(entry.content);
  return "";
}

async function pasteSystemClipboard(): Promise<Json> {
  const image = await readClipboardImage();
  if (image) {
    const attachment = await attachments.create(image.bytes);
    return {
      kind: "image",
      attachment: { ...attachment, url: `/api/attachments/${attachment.id}` },
    };
  }
  const text = await readClipboardText();
  if (text) return { kind: "text", text };
  throw new Error("剪贴板中没有可粘贴的图片或文本");
}

async function withSessionOperation<T>(record: RuntimeSession, operation: () => Promise<T>): Promise<T> {
  const previous = record.operationChain ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const chain = previous.catch(() => {}).then(() => gate);
  record.operationChain = chain;
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (record.operationChain === chain) record.operationChain = undefined;
  }
}

function isGitWorkingTree(cwd: string): Promise<boolean> {
  return new Promise((resolveResult) => {
    const child = spawn("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, 5000);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0 && stdout.trim() === "true"));
  });
}

function hasPiRewindCommand(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return (value as Json[]).some((command) => {
    if (!command || command.source !== "extension" || typeof command.name !== "string") return false;
    if (!/^rewind(?::\d+)?$/.test(command.name.trim().replace(/^\/+/, ""))) return false;
    const sourceInfo = command.sourceInfo && typeof command.sourceInfo === "object" ? command.sourceInfo as Json : {};
    const provenance = `${String(sourceInfo.path ?? "")} ${String(sourceInfo.source ?? "")}`;
    const description = typeof command.description === "string" ? command.description : "";
    return /(^|[\\/])pi-rewind([\\/]|$)/i.test(provenance)
      || (/file/i.test(description) && /conversation/i.test(description) && /checkpoint/i.test(description));
  });
}

function handlePendingTreeRestoreDialog(record: RuntimeSession, proc: PiRpc, event: Json): boolean {
  const pending = record.pendingTreeNavigation;
  if (!pending || event.method !== "select" || typeof event.id !== "string" || !Array.isArray(event.options)) return false;
  const options = (event.options as unknown[]).filter((option): option is string => typeof option === "string");
  const keepOption = PI_REWIND_KEEP_OPTIONS.find((option) => options.includes(option));
  const cancelOption = PI_REWIND_CANCEL_OPTIONS.find((option) => options.includes(option));
  if (!keepOption || !cancelOption) return false;

  let value = keepOption;
  if (pending.restoreMode === "all") {
    const restoreOption = PI_REWIND_RESTORE_OPTIONS.find((option) => options.includes(option));
    if (restoreOption) value = restoreOption;
    else {
      value = cancelOption;
      pending.error = "所选位置没有可用的文件检查点，未执行回溯";
    }
  }
  pending.restoreDialogHandled = true;
  proc.write({ type: "extension_ui_response", id: event.id, value });
  return true;
}

function isImmediateExtensionCommand(record: RuntimeSession, message: string): boolean {
  const match = /^\/([^\s]+)/.exec(message.trim());
  if (!match) return false;
  return record.commands.some((command) => command.source === "extension" && command.name === match[1]);
}

function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const scheduleSave = debounce(() => {
  stateSaveChain = stateSaveChain.then(saveStateNow).catch(() => {});
}, 120);

function isStateFile(value: unknown): value is StateFile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StateFile>;
  return candidate.version === 1 && Array.isArray(candidate.workspaces) && Array.isArray(candidate.sessions);
}

async function saveStateNow(): Promise<void> {
  await writeJsonAtomically(STATE_FILE, state);
}

async function loadState(): Promise<void> {
  state = await loadJsonWithLegacyMigration({
    stateFile: STATE_FILE,
    legacyStateFile: LEGACY_STATE_FILE,
    validate: isStateFile,
  }) ?? { version: 1, workspaces: [], sessions: [] };
  sessions = new Map();
  modelInfoCache.clear();
  commandCache.clear();
  if (state.modelCache) {
    for (const [cwd, cached] of Object.entries(state.modelCache)) {
      if (cwd && cached && Array.isArray(cached.models)) {
        modelInfoCache.set(cwd, {
          models: cached.models,
          thinkingLevels: Array.isArray(cached.thinkingLevels) ? cached.thinkingLevels : [],
          defaultModel: cached.defaultModel,
          thinkingLevel: typeof cached.thinkingLevel === "string" ? cached.thinkingLevel : undefined,
        });
      }
    }
  }
  for (const stored of state.sessions) {
    const ws = state.workspaces.find((w) => w.id === stored.workspaceId);
    sessions.set(stored.id, {
      id: stored.id,
      workspaceId: stored.workspaceId,
      title: stored.title,
      sessionFile: stored.sessionFile,
      cwd: ws?.path ?? process.cwd(),
      status: "stopped",
      messages: [],
      state: null,
      stats: null,
      models: [],
      thinkingLevels: [],
      commands: [],
      extensionStatuses: {},
      dialogs: [],
      streaming: false,
      needsAttention: stored.needsAttention === true,
      lastUsed: 0,
      pendingModel: stored.model,
      pendingThinkingLevel: stored.thinkingLevel,
    });
  }
}

async function scanPiSessions(cwd: string): Promise<SessionInfo[]> {
  try {
    return await SessionManager.list(cwd);
  } catch (error) {
    console.error("[pi-web] SessionManager.list failed:", error);
    return [];
  }
}

function firstMessageTitle(session: SessionInfo): string {
  const first = (session.firstMessage ?? "").trim().replace(/\s+/g, " ");
  if (!first) return session.name?.trim() || "新会话";
  const codeStripped = first.replace(/^```[\s\S]*?```/, "").trim();
  return (session.name?.trim() || codeStripped || first).slice(0, 60);
}

// ---------------------------------------------------------------------------
// broadcasting / serialization
// ---------------------------------------------------------------------------

function broadcastEvent(event: Json): void {
  for (const client of [...sseClients]) sendSseEvent(client, event);
}

function sessionSummary(record: RuntimeSession): Json {
  const stored = state.sessions.find((s) => s.id === record.id);
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    title: record.title,
    sessionFile: record.sessionFile ?? null,
    cwd: record.cwd,
    status: record.status,
    streaming: record.streaming,
    waitingForUser: record.dialogs.length > 0,
    needsAttention: record.needsAttention,
    error: record.error ?? null,
    updatedAt: stored?.updatedAt ?? nowIso(),
  };
}

function snapshotMessages(record: RuntimeSession): RenderedMessage[] {
  const notice = record.compactionNotice;
  if (!notice) return record.messages;
  if (notice.status === "complete") {
    for (let index = record.messages.length - 1; index >= 0; index -= 1) {
      const message = record.messages[index];
      if (message.kind !== "compaction" || message.text !== notice.text || message.tokensBefore !== notice.tokensBefore) continue;
      const merged = [...record.messages];
      merged[index] = {
        ...message,
        reason: notice.reason,
        estimatedTokensAfter: notice.estimatedTokensAfter,
        usage: notice.usage ?? message.usage,
        willRetry: notice.willRetry,
      };
      return merged;
    }
  }
  const messages = [...record.messages];
  messages.splice(Math.min(record.compactionNoticeIndex ?? messages.length, messages.length), 0, notice);
  return messages;
}

function pendingQueueSnapshot(record: RuntimeSession): RpcQueueSnapshot {
  return {
    steering: [...(record.pendingQueue?.steering ?? [])],
    followUp: [...(record.pendingQueue?.followUp ?? [])],
  };
}

function setPendingQueue(record: RuntimeSession, queue: RpcQueueSnapshot): void {
  record.pendingQueue = {
    steering: [...queue.steering],
    followUp: [...queue.followUp],
  };
  record.state = {
    ...(record.state ?? {}),
    pendingMessageCount: queue.steering.length + queue.followUp.length,
  };
}

const snapshotScheduler = createSnapshotScheduler<RuntimeSession>(emitSessionSnapshot);

function broadcastSessionSnapshot(record: RuntimeSession): void {
  if (shuttingDown) return;
  snapshotScheduler.schedule(record.id, record, !record.streaming || record.dialogs.length > 0);
}

function emitSessionSnapshot(record: RuntimeSession): void {
  broadcastEvent({
    type: "snapshot",
    sessionId: record.id,
    session: sessionSummary(record),
    state: record.state,
    stats: record.stats,
    models: record.models,
    thinkingLevels: record.thinkingLevels,
    thinkingLevelsByModel: thinkingLevelsByModel(record.models),
    commands: record.commands,
    extensionStatuses: record.extensionStatuses,
    messages: browserMessages(snapshotMessages(record)),
    pendingQueue: pendingQueueSnapshot(record),
    dialogs: record.dialogs,
  });
}

function serializeWorkspaces(): Json[] {
  return state.workspaces.map((ws) => {
    const rows = ws.sessionIds.map((id) => {
      const stored = state.sessions.find((s) => s.id === id);
      const rec = sessions.get(id);
      return {
        id,
        title: rec?.title ?? stored?.title ?? "新会话",
        sessionFile: rec?.sessionFile ?? stored?.sessionFile ?? null,
        status: rec?.status ?? "stopped",
        streaming: rec?.streaming ?? false,
        waitingForUser: (rec?.dialogs?.length ?? 0) > 0,
        needsAttention: rec?.needsAttention ?? stored?.needsAttention ?? false,
        dialogCount: rec?.dialogs?.length ?? 0,
        updatedAt: stored?.updatedAt ?? nowIso(),
      };
    });
    return { ...ws, sessions: rows };
  });
}

function broadcastWorkspaces(): void {
  broadcastEvent({ type: "workspaces", workspaces: serializeWorkspaces() });
}

function supportedThinkingLevels(model: unknown): string[] {
  if (!model || typeof model !== "object") return ["off"];
  try {
    return getSupportedThinkingLevels(model as Parameters<typeof getSupportedThinkingLevels>[0]) as string[];
  } catch {
    return ["off"];
  }
}

function thinkingLevelsByModel(models: unknown[]): Record<string, string[]> {
  const levels: Record<string, string[]> = {};
  for (const candidate of models as Json[]) {
    if (!candidate || typeof candidate !== "object") continue;
    if (typeof candidate.provider !== "string" || typeof candidate.id !== "string") continue;
    levels[`${candidate.provider}/${candidate.id}`] = supportedThinkingLevels(candidate);
  }
  return levels;
}

function normalizeCommands(value: unknown): SlashCommandInfo[] {
  if (!Array.isArray(value)) return [];
  const commands: SlashCommandInfo[] = [];
  const seen = new Set<string>();
  for (const candidate of value as Json[]) {
    if (!candidate || typeof candidate !== "object" || typeof candidate.name !== "string") continue;
    const name = candidate.name.trim().replace(/^\/+/, "");
    const source = candidate.source;
    if (!name || name === INTERNAL_TREE_COMMAND || name === INTERNAL_RELOAD_COMMAND || seen.has(name) || (source !== "extension" && source !== "prompt" && source !== "skill")) continue;
    seen.add(name);
    commands.push({
      name,
      description: typeof candidate.description === "string" ? stripAnsi(candidate.description) : undefined,
      source,
      sourceInfo: candidate.sourceInfo && typeof candidate.sourceInfo === "object" ? candidate.sourceInfo as Json : undefined,
    });
  }
  return commands;
}

function cachedCommands(cwd?: string): SlashCommandInfo[] {
  return cwd ? commandCache.get(cwd) ?? [] : [...commandCache.values()][0] ?? [];
}

function applyCachedCommands(record: RuntimeSession): void {
  if (record.commands.length === 0) record.commands = cachedCommands(record.cwd);
}

function bootstrapCommands(): SlashCommandInfo[] {
  const currentRecord = state.currentSessionId ? sessions.get(state.currentSessionId) : undefined;
  const currentWorkspace = state.currentWorkspaceId
    ? state.workspaces.find((workspace) => workspace.id === state.currentWorkspaceId)
    : undefined;
  return cachedCommands(currentRecord?.cwd ?? currentWorkspace?.path);
}

function bootstrapModelInfo(): Json {
  const currentRecord = state.currentSessionId ? sessions.get(state.currentSessionId) : undefined;
  const currentWorkspace = state.currentWorkspaceId
    ? state.workspaces.find((workspace) => workspace.id === state.currentWorkspaceId)
    : undefined;
  const cached = cachedModelInfo(currentRecord?.cwd ?? currentWorkspace?.path);
  const models = cached?.models ?? [];
  return {
    models,
    thinkingLevels: cached?.thinkingLevels ?? [],
    thinkingLevelsByModel: thinkingLevelsByModel(models),
    state: {
      model: cached?.defaultModel ?? null,
      thinkingLevel: cached?.thinkingLevel ?? "off",
    },
  };
}

function setSessionNeedsAttention(record: RuntimeSession, needsAttention: boolean): void {
  record.needsAttention = needsAttention;
  const stored = state.sessions.find((s) => s.id === record.id);
  if (stored) stored.needsAttention = needsAttention;
  scheduleSave();
}

function updateStoredSession(record: RuntimeSession): void {
  const stored = state.sessions.find((s) => s.id === record.id);
  if (!stored) return;
  stored.title = record.title;
  stored.sessionFile = record.sessionFile;
  stored.model = record.pendingModel ?? stored.model;
  stored.thinkingLevel = record.pendingThinkingLevel ?? stored.thinkingLevel;
  stored.needsAttention = record.needsAttention;
  stored.updatedAt = nowIso();
  const ws = state.workspaces.find((w) => w.id === record.workspaceId);
  if (ws) ws.updatedAt = stored.updatedAt;
  scheduleSave();
}

// ---------------------------------------------------------------------------
// runtime refresh
// ---------------------------------------------------------------------------

async function refreshState(record: RuntimeSession): Promise<void> {
  if (!record.proc) return;
  try {
    const response = await record.proc.send<Json>({ type: "get_state" });
    record.state = (response.data ?? {}) as Json;
    if (record.state.isStreaming === true) record.streaming = true;
    else if (record.status !== "running") record.streaming = false;
    if (typeof record.state.sessionFile === "string") {
      record.sessionFile = record.state.sessionFile;
      const stored = state.sessions.find((s) => s.id === record.id);
      if (stored) stored.sessionFile = record.state.sessionFile;
      scheduleSave();
    }
    if (typeof record.state.sessionName === "string" && record.state.sessionName.trim()) {
      record.title = record.state.sessionName;
      const stored = state.sessions.find((s) => s.id === record.id);
      if (stored) stored.title = record.title;
      scheduleSave();
    }
  } catch (error) {
    console.error("[pi-web] get_state failed:", error);
  }
}

async function refreshMessages(record: RuntimeSession): Promise<void> {
  if (!record.proc) return;
  try {
    const response = await record.proc.send<Json>({ type: "get_entries" });
    const data = (response.data ?? {}) as Json;
    record.messages = renderSessionEntries(data.entries, data.leafId);
  } catch (entriesError) {
    try {
      const response = await record.proc.send<Json>({ type: "get_messages" });
      record.messages = renderTranscript((response.data as Json)?.messages);
    } catch (messagesError) {
      console.error("[pi-web] transcript refresh failed:", entriesError, messagesError);
    }
  }
}

function cachedModelInfo(cwd?: string): ModelInfo | undefined {
  return (cwd ? modelInfoCache.get(cwd) : undefined) ?? [...modelInfoCache.values()][0];
}

function persistModelInfo(cwd: string, info: ModelInfo): void {
  modelInfoCache.set(cwd, info);
  state.modelCache = Object.fromEntries(modelInfoCache);
  scheduleSave();
}

function findCatalogModel(models: unknown[], candidate: unknown): Json | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  const value = candidate as Json;
  const id = value.id ?? value.modelId;
  if (typeof value.provider !== "string" || typeof id !== "string") return undefined;
  return (models as Json[]).find((model) => model?.provider === value.provider && model.id === id);
}

function modelInfoFromCatalog(
  catalog: ModelCatalog,
  preferredModel?: unknown,
  preferredThinkingLevel?: string,
): ModelInfo {
  const defaultModel = findCatalogModel(catalog.models, preferredModel)
    ?? findCatalogModel(catalog.models, catalog.defaultModel)
    ?? catalog.models[0];
  const thinkingLevels = supportedThinkingLevels(defaultModel);
  const requestedLevel = preferredThinkingLevel ?? catalog.thinkingLevel ?? "off";
  const thinkingLevel = thinkingLevels.includes(requestedLevel)
    ? requestedLevel
    : thinkingLevels.includes("off") ? "off" : thinkingLevels[0] ?? "off";
  return { models: catalog.models, thinkingLevels, defaultModel, thinkingLevel };
}

function sameModelCatalog(left: unknown[], right: unknown[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function discoverFreshModelCatalog(cwd: string): Promise<ModelCatalog> {
  if (shuttingDown) throw new Error("pi-web 正在关闭，无法启动模型探测进程");
  const key = normalizePath(cwd);
  const existing = modelCatalogRefreshes.get(key);
  if (existing) return existing;
  const task = (async () => {
    const probe = spawnPiRpc({ cwd: key, noSession: true, proxy: terminalProxy });
    try {
      const [modelsResponse, stateResponse] = await Promise.all([
        probe.send<Json>({ type: "get_available_models" }),
        probe.send<Json>({ type: "get_state" }),
      ]);
      return {
        models: (modelsResponse.data?.models ?? []) as unknown[],
        defaultModel: stateResponse.data?.model,
        thinkingLevel: typeof stateResponse.data?.thinkingLevel === "string"
          ? stateResponse.data.thinkingLevel
          : undefined,
      };
    } finally {
      await probe.close();
    }
  })();
  modelCatalogRefreshes.set(key, task);
  try {
    return await task;
  } finally {
    modelCatalogRefreshes.delete(key);
  }
}

function applyModelInfo(record: RuntimeSession, info: ModelInfo): void {
  record.models = info.models;
  record.thinkingLevels = info.thinkingLevels;
  record.state = {
    ...(record.state ?? {}),
    model: info.defaultModel,
    thinkingLevel: info.thinkingLevel ?? "off",
  };
  persistModelInfo(record.cwd, info);
}

async function refreshModelsFresh(record: RuntimeSession): Promise<void> {
  if (record.starting) await record.starting;
  if (record.streaming || hasRunningBackgroundJobs(record)) {
    await refreshModels(record);
    return;
  }
  const catalog = await discoverFreshModelCatalog(record.cwd);
  if (record.proc) {
    try {
      const runtimeResponse = await record.proc.send<Json>({ type: "get_available_models" }, 8000);
      const runtimeModels = (runtimeResponse.data?.models ?? []) as unknown[];
      if (!sameModelCatalog(runtimeModels, catalog.models)) {
        await Promise.allSettled([refreshState(record), refreshMessages(record)]);
        if (record.streaming || hasRunningBackgroundJobs(record)) {
          await refreshModels(record);
          return;
        }
        await stopSessionProcess(record);
      }
    } catch (error) {
      console.error("[pi-web] runtime model refresh failed:", error);
      if (record.streaming || hasRunningBackgroundJobs(record)) return;
      await stopSessionProcess(record);
    }
  }
  applyModelInfo(record, modelInfoFromCatalog(
    catalog,
    record.state?.model,
    typeof record.state?.thinkingLevel === "string" ? record.state.thinkingLevel : undefined,
  ));
}

async function refreshModels(record: RuntimeSession): Promise<void> {
  if (!record.proc) return;
  if (record.modelRefresh) return record.modelRefresh;
  const task = (async () => {
    try {
      const models = await record.proc!.send<Json>({ type: "get_available_models" });
      record.models = (models.data?.models ?? []) as unknown[];
      const levels = await record.proc!.send<Json>({ type: "get_available_thinking_levels" });
      record.thinkingLevels = (levels.data?.levels ?? ["off"]) as string[];
      persistModelInfo(record.cwd, {
        models: record.models,
        thinkingLevels: record.thinkingLevels,
        defaultModel: record.state?.model,
        thinkingLevel: typeof record.state?.thinkingLevel === "string" ? record.state.thinkingLevel : undefined,
      });
      const current = state.currentSessionId ? sessions.get(state.currentSessionId) : undefined;
      if (current && current !== record && current.models.length === 0) {
        applyCachedModelInfo(current);
        broadcastSessionSnapshot(current);
      }
    } catch (error) {
      console.error("[pi-web] model refresh failed:", error);
    } finally {
      record.modelRefresh = undefined;
    }
  })();
  record.modelRefresh = task;
  return task;
}

async function refreshCommands(record: RuntimeSession): Promise<void> {
  if (!record.proc) return;
  if (record.commandRefresh) return record.commandRefresh;
  const task = (async () => {
    try {
      const response = await record.proc!.send<Json>({ type: "get_commands" });
      record.commands = normalizeCommands(response.data?.commands);
      commandCache.set(record.cwd, record.commands);
    } catch (error) {
      console.error("[pi-web] command refresh failed:", error);
    } finally {
      record.commandRefresh = undefined;
    }
  })();
  record.commandRefresh = task;
  return task;
}

function applyCachedModelInfo(record: RuntimeSession): void {
  const cached = cachedModelInfo(record.cwd);
  if (cached && record.models.length === 0) record.models = cached.models;
  if (cached && record.thinkingLevels.length === 0) record.thinkingLevels = cached.thinkingLevels;
  if (cached?.defaultModel && !record.state?.model) {
    record.state = {
      ...(record.state ?? {}),
      model: cached.defaultModel,
      thinkingLevel: record.state?.thinkingLevel ?? cached.thinkingLevel ?? "off",
    };
  }
  const stateModel = record.state?.model as Json | null | undefined;
  if (stateModel && record.models.length > 0) {
    const full = (record.models as Json[]).find((m) => {
      if (!m || typeof m !== "object") return false;
      const stateId = stateModel.id ?? stateModel.modelId;
      return m.provider === stateModel.provider && m.id === stateId;
    });
    if (full) record.state = { ...(record.state ?? {}), model: full };
  }
  applyStatsContextWindow(record);
}

function applyStatsContextWindow(record: RuntimeSession): void {
  if (!record.stats?.contextUsage || typeof record.stats.contextUsage !== "object") return;
  const context = record.stats.contextUsage as Json;
  if (!("tokens" in context)) return;
  const model = record.state?.model && typeof record.state.model === "object" ? record.state.model as Json : {};
  const contextWindow = finiteNumber(context.contextWindow) || finiteNumber(model.contextWindow);
  if (contextWindow <= 0) return;
  const tokens = typeof context.tokens === "number" && Number.isFinite(context.tokens) ? context.tokens : null;
  record.stats = {
    ...record.stats,
    contextUsage: {
      ...context,
      tokens,
      contextWindow,
      percent: tokens == null ? null : (tokens / contextWindow) * 100,
    },
  };
}

async function refreshStats(record: RuntimeSession): Promise<void> {
  if (!record.proc) return;
  const revision = record.statsRevision ?? 0;
  try {
    const stats = await record.proc.send<Json>({ type: "get_session_stats" });
    if ((record.statsRevision ?? 0) === revision) record.stats = (stats.data ?? {}) as Json;
  } catch {
    // stats are optional
  }
}

function finiteNumber(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function readLiveUsage(value: unknown): LiveUsageSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Json;
  const cost = usage.cost && typeof usage.cost === "object"
    ? finiteNumber((usage.cost as Json).total)
    : finiteNumber(usage.cost);
  const input = finiteNumber(usage.input);
  const output = finiteNumber(usage.output);
  const cacheRead = finiteNumber(usage.cacheRead);
  const cacheWrite = finiteNumber(usage.cacheWrite);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: finiteNumber(usage.totalTokens) || input + output + cacheRead + cacheWrite,
    cost,
  };
}

function applyLiveUsage(record: RuntimeSession, value: unknown): void {
  const current = readLiveUsage(value);
  if (!current) return;
  const previous = record.liveUsage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
  const stats: Json = { ...(record.stats ?? {}) };
  const existingTokens = stats.tokens && typeof stats.tokens === "object" ? (stats.tokens as Json) : {};
  const tokens: Json = { ...existingTokens };
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    tokens[key] = Math.max(0, finiteNumber(existingTokens[key]) + current[key] - previous[key]);
  }
  tokens.total = finiteNumber(tokens.input) + finiteNumber(tokens.output) + finiteNumber(tokens.cacheRead) + finiteNumber(tokens.cacheWrite);
  stats.tokens = tokens;
  stats.cost = Math.max(0, finiteNumber(stats.cost) + current.cost - previous.cost);

  const context = stats.contextUsage && typeof stats.contextUsage === "object" ? (stats.contextUsage as Json) : {};
  const model = record.state?.model && typeof record.state.model === "object" ? (record.state.model as Json) : {};
  const contextWindow = finiteNumber(context.contextWindow) || finiteNumber(model.contextWindow);
  if (contextWindow > 0 && current.totalTokens > 0) {
    stats.contextUsage = {
      tokens: current.totalTokens,
      contextWindow,
      percent: (current.totalTokens / contextWindow) * 100,
    };
  }
  record.stats = stats;
  record.liveUsage = current;
  record.statsRevision = (record.statsRevision ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// live event application
// ---------------------------------------------------------------------------

function assistantErrorText(message: Json): string | undefined {
  const isError = message.stopReason === "error" || typeof message.errorMessage === "string";
  if (!isError) return undefined;
  return typeof message.errorMessage === "string" && message.errorMessage.trim()
    ? stripAnsi(message.errorMessage)
    : "模型调用失败，但 Pi 未返回错误详情";
}

function applyMessageEvent(record: RuntimeSession, event: Json): void {
  if (event.type === "message_update") {
    applyAssistantDelta(record.messages, event);
    return;
  }
  const message = (event.message ?? {}) as Json;
  if (event.type === "message_start") {
    if (message.role === "user") {
      const rendered = renderMessage(message);
      if (rendered) record.messages.push(rendered);
    }
    return;
  }
  if (event.type === "message_end") {
    if (message.role === "assistant") {
      const rendered = renderAssistantMessage(message);
      const idx = findLast(record.messages, (m) => m.kind === "assistant" && m.streaming === true);
      if (idx >= 0) record.messages[idx] = rendered;
      else record.messages.push(rendered);
      record.messages = attachToolResults(record.messages);
      return;
    }
    const rendered = renderMessage(message);
    if (rendered) {
      const last = record.messages[record.messages.length - 1];
      if (last && last.kind === rendered.kind && last.timestamp === rendered.timestamp && last.text === rendered.text) {
        record.messages[record.messages.length - 1] = rendered;
      } else {
        record.messages.push(rendered);
      }
      record.messages = attachToolResults(record.messages);
    }
  }
}

function bindSessionEvents(record: RuntimeSession, proc: PiRpc): void {
  proc.onEvent((event) => {
    if (event.type === "extension_ui_request") {
      if (handlePendingTreeRestoreDialog(record, proc, event)) return;
      const method = event.method;
      if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
        const dialog: ExtensionDialog = {
          id: typeof event.id === "string" ? event.id : randomUUID(),
          method,
          title: typeof event.title === "string" ? event.title : undefined,
          message: typeof event.message === "string" ? event.message : undefined,
          placeholder: typeof event.placeholder === "string" ? event.placeholder : undefined,
          options: Array.isArray(event.options) ? (event.options as string[]) : undefined,
          prefill: typeof event.prefill === "string" ? event.prefill : undefined,
          timeout: typeof event.timeout === "number" ? event.timeout : undefined,
          createdAt: Date.now(),
        };
        if (dialog.timeout && dialog.timeout > 0) dialog.expiresAt = dialog.createdAt + dialog.timeout;
        record.dialogs = [...record.dialogs.filter((d) => d.id !== dialog.id), dialog];
        setSessionNeedsAttention(record, state.currentSessionId !== record.id);
        broadcastSessionSnapshot(record);
        broadcastWorkspaces();
        if (dialog.expiresAt) {
          const timer = setTimeout(() => {
            const active = record.dialogs.find((candidate) => candidate.id === dialog.id);
            if (!active || active.expiresAt !== dialog.expiresAt) return;
            record.dialogs = record.dialogs.filter((candidate) => candidate.id !== dialog.id);
            broadcastSessionSnapshot(record);
            broadcastWorkspaces();
          }, Math.max(1, dialog.expiresAt - Date.now()));
          timer.unref();
        }
      } else if (method === "setStatus" && typeof event.statusKey === "string") {
        if (typeof event.statusText === "string" && event.statusText.length > 0) {
          record.extensionStatuses[event.statusKey] = stripAnsi(event.statusText);
        } else {
          delete record.extensionStatuses[event.statusKey];
        }
        broadcastSessionSnapshot(record);
      } else if (method === "notify" && typeof event.message === "string") {
        broadcastEvent({
          type: "extension_notify",
          sessionId: record.id,
          message: stripAnsi(event.message),
          notifyType: event.notifyType === "error" || event.notifyType === "warning" ? event.notifyType : "info",
        });
      } else if (method === "set_editor_text" && typeof event.text === "string") {
        broadcastEvent({ type: "editor_text", sessionId: record.id, text: stripAnsi(event.text) });
      }
      return;
    }
    if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
      const message = event.message && typeof event.message === "object" ? (event.message as Json) : {};
      if (event.type === "message_start" && message.role === "assistant") {
        record.liveUsage = undefined;
        record.statsRevision = (record.statsRevision ?? 0) + 1;
      }
      applyMessageEvent(record, event);
      if (event.type === "message_update") applyLiveUsage(record, event.usage);
      else if (event.type === "message_end" && message.role === "assistant") applyLiveUsage(record, message.usage);
      broadcastSessionSnapshot(record);
      if (event.type === "message_end" && message.role === "assistant") {
        const errorMessage = assistantErrorText(message);
        if (errorMessage) {
          broadcastEvent({ type: "session_error", sessionId: record.id, message: errorMessage });
        }
      }
    } else if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      applyToolExecution(record.messages, event);
      broadcastSessionSnapshot(record);
    } else if (event.type === "queue_update") {
      const steering = Array.isArray(event.steering)
        ? event.steering.filter((message): message is string => typeof message === "string")
        : [];
      const followUp = Array.isArray(event.followUp)
        ? event.followUp.filter((message): message is string => typeof message === "string")
        : [];
      setPendingQueue(record, { steering, followUp });
      broadcastSessionSnapshot(record);
    } else if (event.type === "agent_start") {
      record.status = "running";
      record.streaming = true;
      setSessionNeedsAttention(record, false);
      record.liveUsage = undefined;
      record.statsRevision = (record.statsRevision ?? 0) + 1;
      broadcastSessionSnapshot(record);
    } else if (event.type === "agent_end") {
      broadcastSessionSnapshot(record);
    } else if (event.type === "compaction_start") {
      const reason = typeof event.reason === "string" ? event.reason : undefined;
      record.state = { ...(record.state ?? {}), isCompacting: true };
      record.compactionNoticeIndex = record.messages.length;
      record.compactionNotice = {
        kind: "compaction",
        id: `compaction-running:${Date.now()}`,
        status: "running",
        reason,
        timestamp: Date.now(),
      };
      broadcastSessionSnapshot(record);
    } else if (event.type === "compaction_end") {
      const reason = typeof event.reason === "string" ? event.reason : undefined;
      const result = event.result && typeof event.result === "object" ? event.result as Json : undefined;
      record.state = { ...(record.state ?? {}), isCompacting: false };
      const notice: RenderedMessage = result
        ? {
            ...renderCompaction({ ...result, timestamp: Date.now() }),
            id: `compaction-complete:${Date.now()}`,
            reason,
            willRetry: event.willRetry === true,
          }
        : {
            kind: "compaction",
            id: `compaction-failed:${Date.now()}`,
            status: event.aborted === true ? "aborted" : "error",
            reason,
            errorMessage: typeof event.errorMessage === "string"
              ? stripAnsi(event.errorMessage)
              : event.aborted === true ? "压缩已取消" : "未返回错误详情",
            willRetry: event.willRetry === true,
            timestamp: Date.now(),
          };
      record.compactionNotice = notice;
      record.compactionNoticeIndex = record.messages.length;
      broadcastSessionSnapshot(record);
      if (result) {
        Promise.allSettled([refreshMessages(record), refreshStats(record)]).then(() => {
          broadcastSessionSnapshot(record);
        });
      }
    } else if (event.type === "agent_settled") {
      record.streaming = false;
      record.status = "idle";
      setPendingQueue(record, { steering: [], followUp: [] });
      setSessionNeedsAttention(record, state.currentSessionId !== record.id);
      record.liveUsage = undefined;
      record.statsRevision = (record.statsRevision ?? 0) + 1;
      refreshMessages(record).then(() => broadcastSessionSnapshot(record));
      refreshState(record).then(() => broadcastSessionSnapshot(record));
      refreshStats(record).then(() => broadcastSessionSnapshot(record));
      updateStoredSession(record);
      broadcastWorkspaces();
      evictIdleProcesses();
    } else if (event.type === "process_exit") {
      if (record.proc !== proc) return;
      record.proc = undefined;
      record.status = "error";
      record.error = "pi rpc process exited";
      record.streaming = false;
      record.extensionStatuses = {};
      record.dialogs = [];
      broadcastSessionSnapshot(record);
      broadcastWorkspaces();
    } else if (event.type === "spawn_error") {
      record.status = "error";
      record.error = typeof event.error === "string" ? event.error : String(event.error);
      record.streaming = false;
      record.extensionStatuses = {};
      record.dialogs = [];
      broadcastSessionSnapshot(record);
      broadcastWorkspaces();
    }
  });
}

// ---------------------------------------------------------------------------
// session lifecycle
// ---------------------------------------------------------------------------

function hasRunningBackgroundJobs(record: RuntimeSession): boolean {
  // pi-pwsh-notify clears this live status only after its last background job exits.
  return Boolean(record.extensionStatuses["pwsh-bg"]);
}

function evictIdleProcesses(): void {
  const idle: RuntimeSession[] = [];
  for (const record of sessions.values()) {
    if (record.proc && !record.streaming && !hasRunningBackgroundJobs(record) && record.status !== "running" && record.status !== "starting" && record.dialogs.length === 0 && record.id !== state.currentSessionId) {
      idle.push(record);
    }
  }
  if (idle.length <= MAX_IDLE_PROCESSES) return;
  idle.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
  for (const record of idle.slice(0, idle.length - MAX_IDLE_PROCESSES)) {
    record.proc?.close();
    record.proc = undefined;
    if (record.status !== "error") record.status = "stopped";
    broadcastSessionSnapshot(record);
  }
}

async function applyPendingSettings(record: RuntimeSession): Promise<void> {
  const proc = record.proc;
  if (!proc) return;
  if (record.pendingModel) {
    const pending = record.pendingModel;
    try {
      await proc.send({ type: "set_model", provider: pending.provider, modelId: pending.modelId });
      record.pendingModel = undefined;
    } catch (error) {
      throw new Error(`无法使用模型 ${pending.provider}/${pending.modelId}，请在模型菜单中选择当前可用的模型：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (record.pendingThinkingLevel) {
    const level = record.pendingThinkingLevel;
    try {
      await proc.send({ type: "set_thinking_level", level });
      record.pendingThinkingLevel = undefined;
    } catch (error) {
      console.error("[pi-web] applying pending thinking level failed:", error);
      record.pendingThinkingLevel = undefined;
    }
  }
  if (record.pendingName) {
    const name = record.pendingName;
    try {
      await proc.send({ type: "set_session_name", name });
      record.pendingName = undefined;
    } catch (error) {
      console.error("[pi-web] applying pending session name failed:", error);
      record.pendingName = undefined;
    }
  }
}

async function ensureProcess(record: RuntimeSession): Promise<void> {
  if (shuttingDown) throw new Error("pi-web 正在关闭，无法启动会话进程");
  record.lastUsed = Date.now();
  if (record.proc) return;
  if (record.starting) return record.starting;
  record.status = "starting";
  record.error = undefined;
  record.extensionStatuses = {};
  broadcastSessionSnapshot(record);

  const task = (async () => {
    const proc = spawnPiRpc({
      cwd: record.cwd,
      proxy: terminalProxy,
      sessionId: record.sessionFile ? undefined : record.id,
      sessionFile: record.sessionFile,
      name: record.title === "新会话" ? undefined : record.title,
    });
    record.proc = proc;
    bindSessionEvents(record, proc);
    try {
      await applyPendingSettings(record);
      await refreshState(record);
      await refreshMessages(record);
      refreshModels(record).then(() => broadcastSessionSnapshot(record));
      refreshCommands(record).then(() => broadcastSessionSnapshot(record));
      refreshStats(record).then(() => broadcastSessionSnapshot(record));
      record.status = record.streaming ? "running" : "idle";
      updateStoredSession(record);
      broadcastSessionSnapshot(record);
      broadcastWorkspaces();
      evictIdleProcesses();
    } catch (error) {
      if (record.proc === proc) record.proc = undefined;
      try {
        await proc.close(2500);
      } catch (closeError) {
        console.error("[pi-web] closing failed session process:", closeError);
      }
      record.status = "error";
      record.error = error instanceof Error ? error.message : String(error);
      broadcastSessionSnapshot(record);
      throw error;
    } finally {
      record.starting = undefined;
    }
  })();
  record.starting = task;
  return task;
}

async function openSessionRecord(record: RuntimeSession): Promise<void> {
  record.lastUsed = Date.now();
  applyCachedCommands(record);
  setSessionNeedsAttention(record, false);
  state.currentSessionId = record.id;
  const ws = state.workspaces.find((w) => w.id === record.workspaceId);
  if (ws) state.currentWorkspaceId = ws.id;
  scheduleSave();
  broadcastWorkspaces();
  evictIdleProcesses();

  // Missing session file: report instead of spawning a pi process just to
  // browse an empty/removed session.
  if ((!record.proc || record.status === "starting") && record.sessionFile && !existsSync(record.sessionFile)) {
    record.messages = [];
    record.state = { sessionFile: record.sessionFile, isStreaming: false };
    record.stats = null;
    record.status = "error";
    record.error = "会话文件不存在（可能已在终端中删除）";
    applyCachedModelInfo(record);
    broadcastSessionSnapshot(record);
    return;
  }

  // Fast path: show the transcript straight from disk. No pi process needed
  // just for browsing, which is why switching feels as fast as DSH. This also
  // covers the window where a background pi process is still booting.
  if (record.sessionFile && existsSync(record.sessionFile) && (!record.proc || record.status === "starting")) {
    try {
      const local = loadLocalSession(record.sessionFile, record.cwd);
      record.messages = local.messages;
      record.state = { ...local.state, ...(record.state ?? {}) };
      record.state.isStreaming = Boolean(record.streaming);
      record.state.isCompacting = false;
      if (local.title) {
        record.title = local.title;
        const stored = state.sessions.find((x) => x.id === record.id);
        if (stored) stored.title = local.title;
      }
      record.stats = local.stats ?? record.stats;
      record.sessionFile = local.sessionFile ?? record.sessionFile;
      applyCachedModelInfo(record);
      record.status = record.streaming ? "running" : record.proc ? "idle" : "stopped";
      record.error = undefined;
      scheduleSave();
      broadcastSessionSnapshot(record);
      broadcastWorkspaces();
      return;
    } catch (error) {
      console.error("[pi-web] local session load failed, falling back to rpc:", error);
      record.error = error instanceof Error ? error.message : String(error);
    }
  }

  if (!record.sessionFile) {
    // Keep a brand-new session virtual until the first RPC-backed action.
    applyCachedModelInfo(record);
    record.status = "stopped";
    broadcastSessionSnapshot(record);
    return;
  }

  if (!record.proc) {
    await ensureProcess(record);
  } else {
    await Promise.allSettled([refreshState(record), refreshMessages(record)]);
  }
  if (record.models.length === 0) {
    try {
      await refreshModels(record);
    } catch {
      // model picker will populate on a later retry/refresh
    }
  }
  applyCachedModelInfo(record);
  refreshStats(record).then(() => broadcastSessionSnapshot(record));
  broadcastSessionSnapshot(record);
}

async function stopSessionProcess(record: RuntimeSession): Promise<void> {
  const proc = record.proc;
  record.proc = undefined;
  if (proc) {
    try {
      await proc.close(2500);
    } catch (error) {
      console.error("[pi-web] stop session process failed:", error);
    }
  }
  record.status = "stopped";
  record.streaming = false;
  record.dialogs = [];
  record.extensionStatuses = {};
  record.starting = undefined;
}

async function deleteWorkspaceSession(workspace: Workspace, sessionId: string): Promise<void> {
  if (!workspace.sessionIds.includes(sessionId)) throw new Error("session is not in this workspace");
  const record = sessions.get(sessionId);
  const stored = state.sessions.find((session) => session.id === sessionId);
  if (!record && !stored) throw new Error("session not found");

  if (record?.proc && !record.sessionFile) {
    await refreshState(record).catch(() => {});
  }
  const knownFile = record?.sessionFile ?? stored?.sessionFile;
  const discovered = (await SessionManager.list(workspace.path)).find((session) => session.id === sessionId);
  const knownExists = Boolean(knownFile && existsSync(knownFile));
  const comparablePath = (path: string) => {
    const normalized = normalizePath(path);
    return platform() === "win32" ? normalized.toLowerCase() : normalized;
  };
  if (knownExists && (!discovered || comparablePath(discovered.path) !== comparablePath(knownFile!))) {
    throw new Error("无法确认会话文件属于当前工作区，已取消删除");
  }

  if (record) await stopSessionProcess(record);
  if (discovered?.path) {
    try {
      await unlink(discovered.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const updatedAt = nowIso();
  for (const candidate of state.workspaces) {
    if (!candidate.sessionIds.includes(sessionId)) continue;
    candidate.sessionIds = candidate.sessionIds.filter((id) => id !== sessionId);
    candidate.updatedAt = updatedAt;
  }
  state.sessions = state.sessions.filter((session) => session.id !== sessionId);
  snapshotScheduler.cancel(sessionId);
  sessions.delete(sessionId);
  if (state.currentSessionId === sessionId) state.currentSessionId = undefined;
  scheduleSave();
  broadcastWorkspaces();
}

async function createSession(
  workspaceId: string,
  title?: string,
  preferences: NewSessionPreferences = {},
): Promise<RuntimeSession> {
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws) throw new Error("workspace not found");
  const info = modelInfoFromCatalog(
    await discoverFreshModelCatalog(ws.path),
    preferences.model,
    preferences.thinkingLevel,
  );
  const selected = info.defaultModel as Json | undefined;
  const model = selected && typeof selected.provider === "string" && typeof selected.id === "string"
    ? { provider: selected.provider, modelId: selected.id }
    : undefined;
  const id = randomUUID();
  const cleanTitle = (title ?? "").trim().replace(/\s+/g, " ").slice(0, 60) || "新会话";
  const stored: StoredSession = {
    id,
    workspaceId,
    title: cleanTitle,
    model,
    thinkingLevel: info.thinkingLevel,
    needsAttention: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  state.sessions.unshift(stored);
  ws.sessionIds.unshift(id);
  ws.updatedAt = stored.updatedAt;
  const record: RuntimeSession = {
    id,
    workspaceId,
    title: cleanTitle,
    cwd: ws.path,
    status: "stopped",
    messages: [],
    state: null,
    stats: null,
    models: [],
    thinkingLevels: [],
    commands: [],
    extensionStatuses: {},
    dialogs: [],
    streaming: false,
    needsAttention: false,
    lastUsed: Date.now(),
    pendingModel: model,
    pendingThinkingLevel: info.thinkingLevel,
  };
  applyModelInfo(record, info);
  applyCachedCommands(record);
  sessions.set(id, record);
  scheduleSave();
  broadcastWorkspaces();
  return record;
}

async function importSessionsForWorkspace(ws: Workspace): Promise<number> {
  const infos = await scanPiSessions(ws.path);
  let added = 0;
  for (const info of infos) {
    if (!info.id) continue;
    const existing = state.sessions.find((s) => s.id === info.id);
    if (existing) {
      if (!ws.sessionIds.includes(info.id)) ws.sessionIds.push(info.id);
      continue;
    }
    const title = firstMessageTitle(info);
    const stored: StoredSession = {
      id: info.id,
      workspaceId: ws.id,
      title,
      sessionFile: info.path,
      needsAttention: false,
      createdAt: info.created.toISOString(),
      updatedAt: info.modified.toISOString(),
    };
    state.sessions.push(stored);
    ws.sessionIds.push(info.id);
    sessions.set(info.id, {
      id: info.id,
      workspaceId: ws.id,
      title,
      sessionFile: info.path,
      cwd: ws.path,
      status: "stopped",
      messages: [],
      state: null,
      stats: null,
      models: [],
      thinkingLevels: [],
      commands: [],
      extensionStatuses: {},
      dialogs: [],
      streaming: false,
      needsAttention: false,
      lastUsed: 0,
    });
    added += 1;
  }
  if (added > 0) {
    ws.updatedAt = nowIso();
    scheduleSave();
  }
  return added;
}

async function addWorkspace(path: string): Promise<Workspace> {
  const cwd = normalizePath(path);
  const existing = state.workspaces.find((w) => normalizePath(w.path) === cwd);
  if (existing) return existing;
  const ws: Workspace = {
    id: randomUUID(),
    path: cwd,
    title: pathTitle(cwd),
    sessionIds: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  state.workspaces.push(ws);
  if (state.workspaces.length === 1 && !state.currentWorkspaceId) state.currentWorkspaceId = ws.id;
  scheduleSave();
  await importSessionsForWorkspace(ws);
  scheduleSave();
  broadcastWorkspaces();
  return ws;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, value: unknown): boolean {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
  return true;
}

function readJsonBody(req: import("node:http").IncomingMessage, limit = 12 * 1024 * 1024): Promise<Json> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolveBody({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolveBody(parsed && typeof parsed === "object" ? (parsed as Json) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function findRecord(id: string): RuntimeSession | undefined {
  return sessions.get(id);
}

function findSessionFromRequest(req: import("node:http").IncomingMessage): RuntimeSession | undefined {
  const match = /^\/api\/sessions\/([^/]+)/.exec(req.url ?? "");
  if (!match) return undefined;
  return findRecord(decodeURIComponent(match[1]));
}

function fsRoots(): Json {
  if (platform() === "win32") {
    const drives: Json[] = [];
    for (let i = 65; i <= 90; i += 1) {
      const letter = String.fromCharCode(i);
      const root = `${letter}:\\`;
      if (existsSync(root)) drives.push({ name: root, path: root });
    }
    return { roots: drives, home: homedir() };
  }
  return { roots: [{ name: "/", path: "/" }], home: homedir() };
}

function runPickerCommand(command: string, args: string[], cancelCodes: number[]): Promise<Json> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill();
      resolve({ error: "directory picker timed out" });
    }, 600_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") resolve({ error: `no native directory picker found: ${command}` });
      else resolve({ error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const path = stdout.trim();
      if (path) resolve({ path });
      else if (typeof code === "number" && cancelCodes.includes(code)) resolve({ cancelled: true });
      else if (stderr.trim()) resolve({ error: stderr.trim() });
      else resolve({ cancelled: true });
    });
  });
}

/** Open the platform's native directory chooser (DSH native-picker port). */
async function pickNativeDirectory(): Promise<Json> {
  if (platform() === "win32") {
    // The WinForms FolderBrowserDialog lives in a separate powershell.exe
    // process, so Windows' foreground lock can leave it behind the browser.
    // While ShowDialog() runs its modal loop we poll for the dialog window
    // (by title, scoped to this process) and raise it to TOPMOST.
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type @\"",
      "using System;",
      "using System.Text;",
      "using System.Runtime.InteropServices;",
      "public static class PickerWin32 {",
      "  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);",
      "  [DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);",
      "  [DllImport(\"user32.dll\")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);",
      "  [DllImport(\"user32.dll\")] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int max);",
      "  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);",
      "  [DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);",
      "  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);",
      "  public static bool EnumProc(IntPtr hWnd, IntPtr lParam) {",
      "    uint pid;",
      "    GetWindowThreadProcessId(hWnd, out pid);",
      "    if (pid != (uint)System.Diagnostics.Process.GetCurrentProcess().Id) return true;",
      "    StringBuilder sb = new StringBuilder(512);",
      "    GetClassName(hWnd, sb, 512);",
      "    if (sb.ToString() == \"#32770\") {",
      "      SetWindowPos(hWnd, new IntPtr(-1), 0, 0, 0, 0, 0x0002 | 0x0001);",
      "      SetForegroundWindow(hWnd);",
      "      return false;",
      "    }",
      "    return true;",
      "  }",
      "  public static void ForceOnTop() {",
      "    EnumWindows(new EnumWindowsProc(EnumProc), IntPtr.Zero);",
      "  }",
      "}",
      "\"@",
      "$f = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$f.Description = 'Select Workspace Directory'",
      "$f.ShowNewFolderButton = $true",
      "$t = New-Object System.Windows.Forms.Timer",
      "$t.Interval = 300",
      "$t.Add_Tick({ [PickerWin32]::ForceOnTop() })",
      "$t.Start()",
      "$r = $f.ShowDialog()",
      "$t.Stop()",
      "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.SelectedPath) }",
    ].join("\n");
    return await runPickerCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], []);
  }
  if (platform() === "darwin") {
    return await runPickerCommand(
      "osascript",
      ["-e", "set selectedFolder to choose folder with prompt \"Select Workspace Directory\"", "-e", "POSIX path of selectedFolder"],
      [1],
    );
  }
  if (platform() === "linux") {
    const zenity = await runPickerCommand("zenity", ["--file-selection", "--directory", "--title=Select Workspace Directory"], [1]);
    if (!(zenity as { error?: string }).error) return zenity;
    return await runPickerCommand("kdialog", ["--getexistingdirectory", ".", "--title", "Select Workspace Directory"], [1]);
  }
  return { error: `native directory picker is unsupported on ${platform()}` };
}

async function listDirectories(input: string): Promise<Json> {
  const target = normalizePath(input);
  const home = homedir();
  const st = await stat(target);
  if (!st.isDirectory()) throw new Error("not a directory");
  const entries = await readdir(target, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, path: join(target, e.name), hidden: e.name.startsWith(".") }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  const crumbs: { name: string; path: string; hidden: boolean }[] = [];
  {
    const parts: string[] = [];
    let current = target;
    for (;;) {
      parts.unshift(current);
      const up = dirname(current);
      if (up === current) break;
      current = up;
    }
    let acc = parts[0];
    crumbs.push({ name: parts[0], path: parts[0], hidden: false });
    for (const part of parts.slice(1)) {
      acc = join(acc, part);
      crumbs.push({ name: part, path: acc, hidden: part.startsWith(".") });
    }
  }
  const parent = dirname(target) === target ? null : dirname(target);
  return { path: target, home, parent, crumbs, entries: dirs, truncated: false };
}

async function openWindowsExplorerOnTop(target: string, directory: string, selectFile: boolean): Promise<void> {
  const script = [
    "Add-Type @\"",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class ExplorerForeground {",
    "  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);",
    "  static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);",
    "  const uint SWP_NOSIZE = 0x0001;",
    "  const uint SWP_NOMOVE = 0x0002;",
    "  const uint SWP_SHOWWINDOW = 0x0040;",
    "  [DllImport(\"user32.dll\")] static extern bool ShowWindow(IntPtr hWnd, int command);",
    "  [DllImport(\"user32.dll\")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);",
    "  [DllImport(\"user32.dll\")] static extern bool BringWindowToTop(IntPtr hWnd);",
    "  [DllImport(\"user32.dll\")] static extern bool SetForegroundWindow(IntPtr hWnd);",
    "  [DllImport(\"user32.dll\")] static extern IntPtr GetForegroundWindow();",
    "  [DllImport(\"user32.dll\")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);",
    "  [DllImport(\"kernel32.dll\")] static extern uint GetCurrentThreadId();",
    "  [DllImport(\"user32.dll\")] static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);",
    "  [DllImport(\"user32.dll\")] static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);",
    "  public static void Raise(IntPtr hWnd) {",
    "    uint ignored;",
    "    uint currentThread = GetCurrentThreadId();",
    "    uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);",
    "    uint targetThread = GetWindowThreadProcessId(hWnd, out ignored);",
    "    if (currentThread != foregroundThread) AttachThreadInput(currentThread, foregroundThread, true);",
    "    if (currentThread != targetThread) AttachThreadInput(currentThread, targetThread, true);",
    "    ShowWindow(hWnd, 9);",
    "    SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);",
    "    BringWindowToTop(hWnd);",
    "    keybd_event(0x12, 0, 0, UIntPtr.Zero);",
    "    SetForegroundWindow(hWnd);",
    "    keybd_event(0x12, 0, 0x0002, UIntPtr.Zero);",
    "    System.Threading.Thread.Sleep(120);",
    "    SetWindowPos(hWnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);",
    "    BringWindowToTop(hWnd);",
    "    SetForegroundWindow(hWnd);",
    "    if (currentThread != targetThread) AttachThreadInput(currentThread, targetThread, false);",
    "    if (currentThread != foregroundThread) AttachThreadInput(currentThread, foregroundThread, false);",
    "  }",
    "}",
    "\"@",
    "$target = $env:PI_WEB_REVEAL_TARGET",
    "$directory = $env:PI_WEB_REVEAL_DIRECTORY",
    "$selectFile = $env:PI_WEB_REVEAL_SELECT -eq '1'",
    "$shell = New-Object -ComObject Shell.Application",
    "function Normalize-Folder([string]$path) {",
    "  $full = [IO.Path]::GetFullPath($path)",
    "  if ($full.Length -gt 3) { $full = $full.TrimEnd('\\') }",
    "  return $full",
    "}",
    "$directoryKey = Normalize-Folder $directory",
    "function Find-TargetWindows {",
    "  foreach ($window in @($shell.Windows())) {",
    "    try {",
    "      $windowPath = Normalize-Folder ([string]$window.Document.Folder.Self.Path)",
    "      if ($windowPath -eq $directoryKey) { [Int64]$window.HWND }",
    "    } catch {}",
    "  }",
    "}",
    "$before = @(Find-TargetWindows)",
    "$arguments = if ($selectFile) { '/select,\"' + $target.Replace('\"', '\"\"') + '\"' } else { '\"' + $directory.Replace('\"', '\"\"') + '\"' }",
    "$startInfo = New-Object System.Diagnostics.ProcessStartInfo",
    "$startInfo.FileName = 'explorer.exe'",
    "$startInfo.Arguments = $arguments",
    "$startInfo.UseShellExecute = $true",
    "[void][System.Diagnostics.Process]::Start($startInfo)",
    "$handle = 0",
    "for ($attempt = 0; $attempt -lt 40 -and $handle -eq 0; $attempt++) {",
    "  Start-Sleep -Milliseconds 100",
    "  $matches = @(Find-TargetWindows)",
    "  $fresh = @($matches | Where-Object { $before -notcontains $_ })",
    "  if ($fresh.Count) { $handle = $fresh[-1] }",
    "  elseif ($matches.Count -and $attempt -ge 10) { $handle = $matches[-1] }",
    "}",
    "if ($handle -eq 0) { [Console]::Error.Write('Explorer window not found'); exit 2 }",
    "[ExplorerForeground]::Raise([IntPtr]$handle)",
  ].join("\n");

  await new Promise<void>((resolveOpen, rejectOpen) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: {
        ...process.env,
        PI_WEB_REVEAL_TARGET: target,
        PI_WEB_REVEAL_DIRECTORY: directory,
        PI_WEB_REVEAL_SELECT: selectFile ? "1" : "0",
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (data: Buffer) => (stderr += data.toString()));
    const timer = setTimeout(() => {
      child.kill();
      rejectOpen(new Error("timed out while bringing Explorer to the foreground"));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectOpen(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveOpen();
      else rejectOpen(new Error(stderr.trim() || `Explorer foreground helper exited with code ${code}`));
    });
  });
}

async function revealInFileManager(input: string): Promise<string> {
  const target = normalizePath(input);
  const info = await stat(target);
  const isDirectory = info.isDirectory();
  const directory = isDirectory ? target : dirname(target);
  const currentPlatform = platform();

  if (currentPlatform === "win32") {
    await openWindowsExplorerOnTop(target, directory, !isDirectory);
    return directory;
  }

  const command = currentPlatform === "darwin" ? "open" : "xdg-open";
  const args = currentPlatform === "darwin" && !isDirectory ? ["-R", target] : [directory];
  await new Promise<void>((resolveStart, rejectStart) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", rejectStart);
    child.once("spawn", () => {
      child.unref();
      resolveStart();
    });
  });
  return directory;
}

function filePathFromUrl(url: string): string {
  const clean = url.split("?")[0].split("#")[0];
  const relative = clean === "/" ? "index.html" : clean.replace(/^\/+/, "");
  const path = resolve(WEB_DIR, relative);
  if (path !== WEB_DIR && !path.startsWith(`${WEB_DIR}${sep}`)) return join(WEB_DIR, "index.html");
  return path;
}

async function serveStatic(res: ServerResponse, url: string): Promise<void> {
  const filePath = filePathFromUrl(url);
  try {
    const data = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}

function escapeFileViewHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]!);
}

function renderFileView(filePath: string, data: Buffer): string {
  const preview = buildFilePreview(filePath, data);
  const title = escapeFileViewHtml(preview.name);
  const displayPath = escapeFileViewHtml(filePath);
  const numbers = Array.from({ length: preview.lineCount }, (_, index) => index + 1).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title} - Pi Web</title><style>
:root{color-scheme:light dark;font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;background:#fff;color:#1f2328}*{box-sizing:border-box}body{margin:0;background:inherit;color:inherit}.header{position:sticky;top:0;z-index:2;padding:10px 16px;border-bottom:1px solid #d0d7de;background:#f6f8fa;color:#59636e;font:12px/20px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.source{display:grid;grid-template-columns:auto max-content;min-width:100%;width:max-content;padding:8px 0 40px}.source pre{margin:0;font:13px/20px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre}.numbers{position:sticky;left:0;z-index:1;padding:0 14px 0 8px;background:inherit;color:#8c959f;text-align:right;user-select:none}.code{min-width:100%;padding-right:24px}.hljs-comment,.hljs-quote{color:#6e7781}.hljs-keyword,.hljs-selector-tag,.hljs-literal{color:#cf222e}.hljs-string,.hljs-attr,.hljs-regexp{color:#0a3069}.hljs-title,.hljs-title.function_,.hljs-section{color:#8250df}.hljs-number,.hljs-symbol,.hljs-variable,.hljs-template-variable{color:#0550ae}.hljs-type,.hljs-built_in,.hljs-selector-class{color:#953800}.hljs-meta,.hljs-doctag{color:#57606a}@media(prefers-color-scheme:dark){:root{background:#0d1117;color:#e6edf3}.header{background:#161b22;border-color:#30363d;color:#8d96a0}.numbers{color:#6e7681}.hljs-comment,.hljs-quote{color:#8b949e}.hljs-keyword,.hljs-selector-tag,.hljs-literal{color:#ff7b72}.hljs-string,.hljs-attr,.hljs-regexp{color:#a5d6ff}.hljs-title,.hljs-title.function_,.hljs-section{color:#d2a8ff}.hljs-number,.hljs-symbol,.hljs-variable,.hljs-template-variable{color:#79c0ff}.hljs-type,.hljs-built_in,.hljs-selector-class{color:#ffa657}.hljs-meta,.hljs-doctag{color:#8b949e}}
</style></head><body><header class="header">${displayPath}</header><main class="source"><pre class="numbers" aria-hidden="true">${numbers}</pre><pre class="code"><code class="hljs language-${escapeFileViewHtml(preview.language)}">${preview.highlightedHtml}</code></pre></main><script>const line=Number(location.hash.match(/^#L(\\d+)$/)?.[1]);if(line>0)scrollTo(0,Math.max(0,(line-1)*20-80));</script></body></html>`;
}

function maintenanceBlocker(): RuntimeSession | undefined {
  return [...sessions.values()].find((record) => (
    record.streaming
    || record.status === "starting"
    || Boolean(record.operationChain)
    || record.dialogs.length > 0
  ));
}

function maintenanceOutput(result: MaintenanceCommandResult): string {
  return stripAnsi([result.stdout, result.stderr].filter(Boolean).join("\n").trim()).slice(-8000);
}

function scheduleRuntimeReload(): void {
  const callback = reloadRuntime;
  const timer = setTimeout(() => {
    void callback?.().catch((error) => {
      maintenanceRunning = false;
      const message = error instanceof Error ? error.message : String(error);
      console.error("[pi-web] runtime reload failed:", error);
      broadcastEvent({ type: "maintenance_error", message });
    });
  }, 100);
  timer.unref();
}

async function handleApi(req: import("node:http").IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? "GET";
  if (!webAccess.trusted(req)) return sendJson(res, 403, { error: "forbidden origin" });
  res.setHeader("cache-control", "no-store");
  if (method === "GET" && path === "/api/auth") {
    return sendJson(res, 200, { passwordConfigured: webAccess.passwordConfigured });
  }
  if (method === "POST" && path === "/api/auth") {
    const body = await readJsonBody(req, 2048);
    if (!webAccess.passwordConfigured) {
      return sendJson(res, 503, { error: "请先在电脑网页的设置中设置访问密码" });
    }
    if (!webAccess.remoteEnabled || !await webAccess.acceptsPassword(body.password)) {
      return sendJson(res, 401, { error: "密码不正确" });
    }
    res.setHeader("set-cookie", webAccess.cookie(req));
    return sendJson(res, 200, { ok: true });
  }
  if (!webAccess.authorized(req)) {
    return sendJson(res, 401, { error: "请输入访问密码" });
  }
  if (method === "POST" && path === "/api/auth/password") {
    if (!isLocalRequest(req)) return sendJson(res, 403, { error: "请在电脑本机网页设置密码" });
    if (networkApplying) return sendJson(res, 409, { error: "网络设置正在应用，请稍后保存密码" });
    networkApplying = true;
    try {
      const body = await readJsonBody(req, 2048);
      await webAccess.setPassword(body.password, AUTH_FILE);
    } catch (error) {
      return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      networkApplying = false;
    }
    for (const client of [...sseClients]) {
      closeSseClient(client);
      (client.res as ServerResponse).end();
    }
    sseClients.clear();
    return sendJson(res, 200, { ok: true });
  }

  if (path === "/api/extensions" && (method === "GET" || method === "POST")) {
    if (!isLocalRequest(req)) return sendJson(res, 403, { error: "请在电脑本机网页管理扩展" });
    if (extensionSettingsSaving || maintenanceRunning) return sendJson(res, 409, { error: "扩展配置或维护操作正在执行，请稍后重试" });
    extensionSettingsSaving = true;
    try {
      let change: { scope: "global" | "project"; source: string; enabled: boolean } | undefined;
      if (method === "POST") {
        const body = await readJsonBody(req, 16 * 1024);
        if ((body.scope !== "global" && body.scope !== "project") || typeof body.source !== "string" || !body.source || typeof body.enabled !== "boolean") {
          return sendJson(res, 400, { error: "扩展配置参数无效" });
        }
        change = { scope: body.scope, source: body.source, enabled: body.enabled };
      }
      return sendJson(res, 200, await extensionSettings(extensionSettingsCwd, change));
    } catch (error) {
      return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      extensionSettingsSaving = false;
    }
  }

  if (path === "/api/terminal-proxy") {
    if (!isLocalRequest(req)) return sendJson(res, 403, { error: "请在电脑本机网页配置终端代理" });
    if (method === "GET") return sendJson(res, 200, { settings: terminalProxy });
    if (method === "POST") {
      if (terminalProxySaving) return sendJson(res, 409, { error: "终端代理正在保存，请稍后重试" });
      terminalProxySaving = true;
      try {
        const next = validateTerminalProxy(await readJsonBody(req, 4096));
        await saveTerminalProxy(TERMINAL_PROXY_FILE, next);
        terminalProxy = next;
        return sendJson(res, 200, { settings: terminalProxy });
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      } finally {
        terminalProxySaving = false;
      }
    }
  }

  if (path === "/api/network" || path === "/api/network/server-files") {
    if (!isLocalRequest(req)) return sendJson(res, 403, { error: "请在电脑本机网页配置网络访问" });
    if (method === "GET" && path === "/api/network/server-files") {
      if (!networkSettings.relay) return sendJson(res, 400, { error: "请先保存服务器中转配置" });
      return sendJson(res, 200, { files: relayServerFiles(networkSettings.relay) });
    }
    if (method === "GET" && path === "/api/network") return sendJson(res, 200, networkView());
    if (method === "POST" && path === "/api/network") {
      if (networkApplying) return sendJson(res, 409, { error: "网络设置正在应用" });
      networkApplying = true;
      try {
        const next = updateNetworkSettings(await readJsonBody(req, 16 * 1024), networkSettings);
        if (next.mode === "relay") await resolveFrpc(next.relay!.frpcPath, dirname(NETWORK_FILE));
        await saveNetworkSettings(NETWORK_FILE, next);
        networkSettings = next;
        networkError = undefined;
        sendJson(res, 200, networkView());
        networkChange = new Promise<void>((resolveChange) => setImmediate(resolveChange)).then(async () => {
          if (!shuttingDown) await applyNetworkSettings();
        }).catch((error) => {
          networkError = error instanceof Error ? error.message : String(error);
        }).finally(() => {
          networkApplying = false;
          broadcastEvent({ type: "network_changed" });
        });
        return true;
      } catch (error) {
        networkApplying = false;
        return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  if (method === "GET" && path === "/api/bootstrap") {
    return sendJson(res, 200, {
      workspaces: serializeWorkspaces(),
      currentWorkspaceId: state.currentWorkspaceId ?? null,
      currentSessionId: state.currentSessionId ?? null,
      modelInfo: bootstrapModelInfo(),
      commands: bootstrapCommands(),
      url: serverUrl,
      instanceId: serverInstanceId,
      localClient: isLocalRequest(req),
      lanEnabled: webAccess.remoteEnabled,
      passwordConfigured: webAccess.passwordConfigured,
      lanUrls: isLocalRequest(req) ? getWebLanUrls() : [],
    });
  }

  if (method === "POST" && (path === "/api/maintenance/update-and-reload" || path === "/api/maintenance/reload")) {
    if (maintenanceRunning || extensionSettingsSaving) return sendJson(res, 409, { error: "维护操作或扩展配置正在执行" });
    if (!reloadRuntime || (path.endsWith("update-and-reload") && !updateExtensions)) {
      return sendJson(res, 503, { error: "当前 Pi 运行时不支持 Web 维护操作，请先执行一次 /reload" });
    }
    const blocker = maintenanceBlocker();
    if (blocker) {
      return sendJson(res, 409, { error: `会话“${blocker.title}”仍在运行或等待输入，请处理完成后重试` });
    }

    maintenanceRunning = true;
    let output = "";
    try {
      if (path.endsWith("update-and-reload")) {
        const result = await updateExtensions!();
        output = maintenanceOutput(result);
        if (result.code !== 0 || result.killed) {
          const detail = output || `pi update --extensions 退出码 ${result.code}`;
          throw new Error(detail);
        }
      }
      sendJson(res, 200, { ok: true, output, instanceId: serverInstanceId });
      scheduleRuntimeReload();
      return true;
    } catch (error) {
      maintenanceRunning = false;
      return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (method === "POST" && path === "/api/clipboard/paste") {
    try {
      return sendJson(res, 200, await pasteSystemClipboard());
    } catch (error) {
      return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (method === "POST" && path === "/api/attachments") {
    const body = await readJsonBody(req, 21 * 1024 * 1024);
    if (typeof body.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.data)) {
      return sendJson(res, 400, { error: "文件数据无效" });
    }
    try {
      const attachment = await attachments.create(Buffer.from(body.data, "base64"), typeof body.name === "string" ? body.name : undefined);
      return sendJson(res, 200, { attachment: { ...attachment, url: `/api/attachments/${attachment.id}` } });
    } catch (error) {
      return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  const attachmentMatch = /^\/api\/attachments\/([a-f0-9-]+)$/.exec(path);
  if (attachmentMatch && (method === "GET" || method === "HEAD")) {
    try {
      const { meta, bytes } = await attachments.read(attachmentMatch[1]);
      res.writeHead(200, {
        "content-type": meta.mimeType,
        ...(meta.kind === "document" ? { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}` } : {}),
        "content-length": bytes.byteLength,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(method === "HEAD" ? undefined : bytes);
      return true;
    } catch (error) {
      return sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (attachmentMatch && method === "DELETE") {
    const removed = await attachments.remove(attachmentMatch[1]);
    return sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: "attachment not found" });
  }

  if (method === "GET" && path === "/api/fs/roots") {
    return sendJson(res, 200, fsRoots());
  }

  if (method === "GET" && path === "/api/fs/list") {
    const input = url.searchParams.get("path") ?? "";
    try {
      return sendJson(res, 200, await listDirectories(input));
    } catch (error) {
      return sendJson(res, 200, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (method === "POST" && path === "/api/fs/reveal") {
    const body = await readJsonBody(req);
    const input = typeof body.path === "string" ? body.path.trim() : "";
    if (!input) return sendJson(res, 400, { error: "path is required" });
    try {
      const directory = await revealInFileManager(input);
      return sendJson(res, 200, { ok: true, path: directory });
    } catch (error) {
      return sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (method === "GET" && path === "/api/fs/view") {
    const input = url.searchParams.get("path")?.trim();
    if (!input) return sendJson(res, 400, { error: "path is required" });
    try {
      const target = normalizePath(input);
      const info = await stat(target);
      if (!info.isFile()) return sendJson(res, 400, { error: "path is not a file" });
      const image = url.searchParams.get("format") === "image";
      if (info.size > (image ? MAX_IMAGE_VIEW_BYTES : MAX_FILE_VIEW_BYTES)) return sendJson(res, 413, { error: "file is too large to preview" });
      const data = await readFile(target);
      if (image) {
        const mimeType = await detectImageMimeType(target, data);
        if (!mimeType) return sendJson(res, 415, { error: "file is not a supported image" });
        res.writeHead(200, {
          "content-type": mimeType,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(data);
        return true;
      }
      if (data.includes(0)) return sendJson(res, 415, { error: "binary files cannot be previewed" });
      if (url.searchParams.get("format") === "json") {
        return sendJson(res, 200, buildFilePreview(target, data));
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
        "x-content-type-options": "nosniff",
      });
      res.end(renderFileView(target, data));
      return true;
    } catch (error) {
      return sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (method === "POST" && path === "/api/fs/mkdir") {
    const body = await readJsonBody(req);
    const parentPath = typeof body.path === "string" ? body.path.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!parentPath || !name) return sendJson(res, 400, { error: "path and name are required" });
    try {
      const created = join(normalizePath(parentPath), name);
      await mkdir(created);
      return sendJson(res, 200, { path: created });
    } catch (error) {
      return sendJson(res, 200, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (method === "POST" && path === "/api/fs/pick") {
    return sendJson(res, 200, await pickNativeDirectory());
  }

  const exportMatch = method === "GET" ? /^\/api\/exports\/([a-f0-9-]+)$/.exec(path) : null;
  if (exportMatch) {
    const token = exportMatch[1];
    const download = exportDownloads.get(token);
    exportDownloads.delete(token);
    if (!download || download.expiresAt < Date.now()) return sendJson(res, 404, { error: "export not found or expired" });
    try {
      const data = await readFile(download.path);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": `attachment; filename="pi-session.html"; filename*=UTF-8''${encodeURIComponent(download.filename)}`,
        "content-length": String(data.byteLength),
        "cache-control": "no-store",
      });
      res.end(data);
      return true;
    } catch (error) {
      return sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      unlink(download.path).catch(() => {});
    }
  }

  if (method === "GET" && path === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    let client: SseClient;
    const removeClient = () => {
      closeSseClient(client);
      sseClients.delete(client);
    };
    client = createSseClient(res, removeClient);
    sseClients.add(client);
    req.on("close", removeClient);
    return true;
  }

  if (method === "POST" && path === "/api/workspaces") {
    const body = await readJsonBody(req);
    const inputPath = typeof body.path === "string" ? body.path.trim() : "";
    if (!inputPath) return sendJson(res, 400, { error: "path is required" });
    try {
      const info = await stat(inputPath);
      if (!info.isDirectory()) return sendJson(res, 400, { error: "not a directory" });
    } catch {
      return sendJson(res, 400, { error: "directory does not exist" });
    }
    const ws = await addWorkspace(inputPath);
    return sendJson(res, 200, { workspace: serializeWorkspaces().find((w) => w.id === ws.id) });
  }

  if (method === "POST" && path === "/api/workspaces/reorder") {
    const body = await readJsonBody(req) as ReorderWorkspaceInput;
    const workspaceIds = Array.isArray(body.workspaceIds)
      ? body.workspaceIds.filter((id): id is string => typeof id === "string")
      : [];
    const currentIds = state.workspaces.map((workspace) => workspace.id);
    const uniqueIds = new Set(workspaceIds);
    if (
      workspaceIds.length !== currentIds.length
      || uniqueIds.size !== currentIds.length
      || currentIds.some((id) => !uniqueIds.has(id))
    ) {
      return sendJson(res, 400, { error: "workspaceIds must contain every workspace exactly once" });
    }
    const byId = new Map(state.workspaces.map((workspace) => [workspace.id, workspace]));
    state.workspaces = workspaceIds.map((id) => byId.get(id)!);
    scheduleSave();
    broadcastWorkspaces();
    return sendJson(res, 200, { ok: true, workspaces: serializeWorkspaces() });
  }

  if (method === "DELETE" && /^\/api\/workspaces\/([^/]+)$/.test(path)) {
    const id = decodeURIComponent(path.split("/")[3]);
    const ws = state.workspaces.find((w) => w.id === id);
    if (!ws) return sendJson(res, 404, { error: "workspace not found" });
    const removed = new Set(ws.sessionIds);
    for (const sessionId of removed) {
      const rec = sessions.get(sessionId);
      if (rec) await stopSessionProcess(rec);
    }
    state.workspaces = state.workspaces.filter((w) => w.id !== id);
    if (state.currentWorkspaceId === id) state.currentWorkspaceId = state.workspaces[0]?.id;
    if (state.currentSessionId && state.sessions.find((s) => s.id === state.currentSessionId)?.workspaceId === id) {
      state.currentSessionId = undefined;
    }
    scheduleSave();
    broadcastWorkspaces();
    return sendJson(res, 200, { ok: true });
  }

  if (method === "POST" && /^\/api\/workspaces\/([^/]+)\/discover$/.test(path)) {
    const ws = state.workspaces.find((w) => w.id === decodeURIComponent(path.split("/")[3]));
    if (!ws) return sendJson(res, 404, { error: "workspace not found" });
    const added = await importSessionsForWorkspace(ws);
    broadcastWorkspaces();
    return sendJson(res, 200, { added });
  }

  if (method === "POST" && /^\/api\/workspaces\/([^/]+)\/models$/.test(path)) {
    const ws = state.workspaces.find((w) => w.id === decodeURIComponent(path.split("/")[3]));
    if (!ws) return sendJson(res, 404, { error: "workspace not found" });
    try {
      const body = await readJsonBody(req);
      const catalog = await discoverFreshModelCatalog(ws.path);
      const info = modelInfoFromCatalog(
        catalog,
        body.model,
        typeof body.thinkingLevel === "string" ? body.thinkingLevel : undefined,
      );
      persistModelInfo(ws.path, info);
      return sendJson(res, 200, {
        state: { model: info.defaultModel ?? null, thinkingLevel: info.thinkingLevel ?? "off" },
        models: info.models,
        thinkingLevels: info.thinkingLevels,
        thinkingLevelsByModel: thinkingLevelsByModel(info.models),
      });
    } catch (error) {
      return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (method === "POST" && /^\/api\/workspaces\/([^/]+)\/sessions$/.test(path)) {
    const ws = state.workspaces.find((w) => w.id === decodeURIComponent(path.split("/")[3]));
    if (!ws) return sendJson(res, 404, { error: "workspace not found" });
    const body = await readJsonBody(req);
    const requestedModel = body.model as Json | undefined;
    const model = requestedModel
      && typeof requestedModel.provider === "string"
      && typeof requestedModel.modelId === "string"
      ? { provider: requestedModel.provider, modelId: requestedModel.modelId }
      : undefined;
    let record: RuntimeSession;
    try {
      record = await createSession(
        ws.id,
        typeof body.title === "string" ? body.title : undefined,
        {
          model,
          thinkingLevel: typeof body.thinkingLevel === "string" ? body.thinkingLevel : undefined,
        },
      );
    } catch (error) {
      return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    state.currentWorkspaceId = ws.id;
    state.currentSessionId = record.id;
    scheduleSave();
    broadcastWorkspaces();
    return sendJson(res, 200, {
      session: sessionSummary(record),
      state: record.state,
      messages: browserMessages(record.messages),
      pendingQueue: pendingQueueSnapshot(record),
      models: record.models,
      thinkingLevels: record.thinkingLevels,
      thinkingLevelsByModel: thinkingLevelsByModel(record.models),
      commands: record.commands,
      extensionStatuses: record.extensionStatuses,
      stats: record.stats,
    });
  }

  if (method === "POST" && /^\/api\/workspaces\/([^/]+)\/remove-session$/.test(path)) {
    const ws = state.workspaces.find((w) => w.id === decodeURIComponent(path.split("/")[3]));
    const body = await readJsonBody(req);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (!ws) return sendJson(res, 404, { error: "workspace not found" });
    await deleteWorkspaceSession(ws, sessionId);
    return sendJson(res, 200, { ok: true });
  }

  const session = findSessionFromRequest(req);
  if (session) {
    const match = /^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    const action = match?.[2] ?? "";

    if (method === "GET" && action === "background-jobs") {
      const jobs = collectBackgroundJobs(session.messages);
      const requested = url.searchParams.get("job");
      const job = requested ? jobs.find((item) => item.id === requested) : jobs[0];
      if (requested && !job) return sendJson(res, 404, { error: "当前会话中找不到此后台任务" });
      const visible = ({ logPath: _logPath, ...item }: typeof jobs[number]) => item;
      const data = { jobs: jobs.map(visible), job: job ? visible(job) : null };
      if (!job) return sendJson(res, 200, { ...data, output: "", truncated: false });
      try {
        return sendJson(res, 200, { ...data, ...await readBackgroundJobLog(job.logPath) });
      } catch (error) {
        return sendJson(res, 200, { ...data, output: "", truncated: false, error: (error as NodeJS.ErrnoException).code === "ENOENT" ? "日志文件已被清理或尚未创建" : "无法读取任务日志" });
      }
    }

    if (method === "POST" && action === "models") {
      try {
        await refreshModelsFresh(session);
        broadcastSessionSnapshot(session);
        return sendJson(res, 200, {
          state: session.state,
          models: session.models,
          thinkingLevels: session.thinkingLevels,
          thinkingLevelsByModel: thinkingLevelsByModel(session.models),
        });
      } catch (error) {
        return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (method === "POST" && action === "open") {
      await openSessionRecord(session);
      return sendJson(res, 200, {
        session: sessionSummary(session),
        state: session.state,
        messages: browserMessages(snapshotMessages(session)),
        pendingQueue: pendingQueueSnapshot(session),
        models: session.models,
        thinkingLevels: session.thinkingLevels,
        thinkingLevelsByModel: thinkingLevelsByModel(session.models),
        commands: session.commands,
        extensionStatuses: session.extensionStatuses,
        stats: session.stats,
        dialogs: session.dialogs,
      });
    }

    if (method === "POST" && action === "history") {
      try {
        return sendJson(res, 200, await sessionHistory(session));
      } catch (error) {
        return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (method === "POST" && action === "navigate_tree") {
      const body = await readJsonBody(req);
      const entryId = typeof body.entryId === "string" ? body.entryId.trim() : "";
      const restoreMode = body.restoreMode === "conversation" || body.restoreMode === "all"
        ? body.restoreMode as TreeRestoreMode
        : undefined;
      if (!entryId) return sendJson(res, 400, { error: "entryId is required" });
      if (body.restoreMode !== undefined && !restoreMode) return sendJson(res, 400, { error: "restoreMode is invalid" });
      try {
        return await withSessionOperation(session, async () => {
          if (session.streaming) return sendJson(res, 409, { error: "请等待当前生成结束后再回溯会话" });
          const history = await sessionHistory(session);
          const target = history.nodes.find((node) => node.id === entryId);
          if (!target) return sendJson(res, 404, { error: "会话树节点不存在" });
          if (!target.navigable) return sendJson(res, 400, { error: "已经位于这个会话节点" });
          const editorText = historyEditorText(session, entryId);
          await ensureProcess(session);
          const commandsResponse = await session.proc!.send<Json>({ type: "get_commands" });
          const commands = commandsResponse.data?.commands;
          const hasNavigationCommand = Array.isArray(commands)
            && (commands as Json[]).some((command) => command?.name === INTERNAL_TREE_COMMAND);
          if (!hasNavigationCommand) throw new Error("当前 RPC 会话尚未加载 Web 回溯命令，请重启 pi-web 后重试");
          if (restoreMode === "all") {
            if (!hasPiRewindCommand(commands)) {
              return sendJson(res, 409, { error: "文件回溯需要启用 pi-rewind 扩展" });
            }
            if (!await isGitWorkingTree(session.cwd)) {
              return sendJson(res, 409, { error: "当前工作区不是 Git 仓库，无法回溯文件" });
            }
          }

          const pendingNavigation: PendingTreeNavigation | undefined = restoreMode
            ? { restoreMode, restoreDialogHandled: false }
            : undefined;
          if (pendingNavigation) session.pendingTreeNavigation = pendingNavigation;
          try {
            await session.proc!.send({ type: "prompt", message: `/${INTERNAL_TREE_COMMAND} ${entryId}` });
          } catch (error) {
            if (pendingNavigation?.error) throw new Error(pendingNavigation.error);
            throw error;
          } finally {
            if (session.pendingTreeNavigation === pendingNavigation) session.pendingTreeNavigation = undefined;
          }
          if (pendingNavigation?.error) throw new Error(pendingNavigation.error);

          session.liveUsage = undefined;
          session.statsRevision = (session.statsRevision ?? 0) + 1;
          await Promise.allSettled([refreshState(session), refreshMessages(session), refreshStats(session)]);
          const nextHistory = await sessionHistory(session);
          const leaf = nextHistory.nodes.find((node) => node.current);
          if (leaf?.customType !== "pi-web-tree-navigation" || leaf.navigationTargetId !== entryId) {
            throw new Error("会话回溯未能持久化，请重试");
          }
          broadcastSessionSnapshot(session);
          return sendJson(res, 200, {
            editorText,
            restoreMode: restoreMode ?? null,
            history: nextHistory,
            session: sessionSummary(session),
            state: session.state,
            messages: browserMessages(snapshotMessages(session)),
            pendingQueue: pendingQueueSnapshot(session),
            stats: session.stats,
          });
        });
      } catch (error) {
        return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (method === "POST" && action === "reload") {
      try {
        return await withSessionOperation(session, async () => {
          await ensureProcess(session);
          if (session.streaming || session.state?.isCompacting || session.dialogs.length > 0) {
            return sendJson(res, 409, { error: "请等待当前会话运行结束并处理完交互后再重载" });
          }
          const proc = session.proc!;
          const commandsResponse = await proc.send<Json>({ type: "get_commands" });
          const commands = commandsResponse.data?.commands;
          if (!Array.isArray(commands) || !commands.some((command) => command?.name === INTERNAL_RELOAD_COMMAND)) {
            return sendJson(res, 409, { error: "当前会话未加载 Web 重载命令，请重启 Pi Web 后重试" });
          }
          let commandError: string | undefined;
          const unsubscribe = proc.onEvent((event) => {
            if (event.type === "extension_error" && event.extensionPath === `command:${INTERNAL_RELOAD_COMMAND}`) {
              commandError = String(event.error || "会话重载失败");
            }
          });
          try {
            await proc.send({ type: "prompt", message: `/${INTERNAL_RELOAD_COMMAND}` });
            if (commandError) throw new Error(commandError);
          } finally {
            unsubscribe();
          }
          await Promise.all([refreshState(session), refreshCommands(session), refreshModels(session)]);
          broadcastSessionSnapshot(session);
          return sendJson(res, 200, { ok: true, reloaded: true });
        });
      } catch (error) {
        return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (method === "POST" && action === "prompt") {
      const body = await readJsonBody(req);
      const message = typeof body.message === "string" ? body.message : "";
      const attachmentIds = Array.isArray(body.attachmentIds)
        ? body.attachmentIds.filter((id): id is string => typeof id === "string")
        : [];
      if (!message.trim() && attachmentIds.length === 0) {
        return sendJson(res, 400, { error: "请输入消息或添加文件附件" });
      }
      const parsedCommand = parseSlashCommand(message);
      const builtinError = parsedCommand ? builtinCommandError(parsedCommand.name) : null;
      if (builtinError) return sendJson(res, 400, { error: builtinError });
      try {
        return await withSessionOperation(session, async () => {
          await ensureProcess(session);
          const wasStreaming = session.streaming;
          if (attachmentIds.length > 0 && wasStreaming) {
            return sendJson(res, 409, { error: "生成过程中暂不支持排队附件，请停止当前生成后再发送" });
          }
          if (attachmentIds.length > 0 && message.trimStart().startsWith("/")) {
            return sendJson(res, 400, { error: "斜杠命令不能附带附件" });
          }
          const model = session.state?.model;
          const modelInput = model && typeof model === "object" && Array.isArray((model as Json).input)
            ? (model as Json).input as unknown[]
            : [];
          let prepared: Awaited<ReturnType<AttachmentStore["promptForRpc"]>>;
          try {
            prepared = await attachments.promptForRpc(attachmentIds, message);
          } catch (error) {
            return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
          }
          const { images, message: promptMessage } = prepared;
          if (images.length > 0 && !modelInput.includes("image")) {
            return sendJson(res, 400, { error: "当前模型不支持图片输入，请切换视觉模型" });
          }
          const slash = /^\/([^\s]+)(?:\s|$)/.exec(promptMessage.trim());
          if (promptMessage.trimStart().startsWith("/")) {
            const response = await session.proc!.send<Json>({ type: "get_commands" });
            session.commands = normalizeCommands(response.data?.commands);
            commandCache.set(session.cwd, session.commands);
            if (!slash || !session.commands.some((command) => command.name === slash[1])) {
              return sendJson(res, 400, { error: `未知或不可用的命令：${slash ? `/${slash[1]}` : "/"}。请输入 / 查看可用命令；普通消息请勿以 / 开头。` });
            }
          }
          const immediateCommand = isImmediateExtensionCommand(session, promptMessage);
          const optimisticStreaming = !wasStreaming && !immediateCommand;
          const command: Json = { type: "prompt", message: slash ? promptMessage.trim() : promptMessage };
          if (images.length > 0) command.images = images;
          if (wasStreaming) command.streamingBehavior = "steer";
          if (optimisticStreaming) {
            session.streaming = true;
            session.status = "running";
            broadcastSessionSnapshot(session);
          }
          try {
            const response = await session.proc!.send(command);
            await Promise.all(attachmentIds.map((id) => attachments.remove(id)));
            if (!immediateCommand && (!session.title || session.title === "新会话")) {
              const nextTitle = message.trim().replace(/\s+/g, " ").slice(0, 60) || "文件会话";
              session.title = nextTitle;
              updateStoredSession(session);
              session.proc?.send({ type: "set_session_name", name: nextTitle }).catch(() => {});
              broadcastWorkspaces();
            }
            return sendJson(res, 200, { ok: true, response, queued: wasStreaming && !immediateCommand });
          } catch (error) {
            if (optimisticStreaming) {
              session.streaming = false;
              session.status = session.proc ? "idle" : "stopped";
              broadcastSessionSnapshot(session);
            }
            throw error;
          }
        });
      } catch (error) {
        return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (method === "POST" && action === "dequeue") {
      try {
        return await withSessionOperation(session, async () => {
          const proc = session.proc;
          if (!proc) {
            const queue = pendingQueueSnapshot(session);
            const restoredMessages = [...queue.steering, ...queue.followUp];
            setPendingQueue(session, { steering: [], followUp: [] });
            broadcastSessionSnapshot(session);
            return sendJson(res, 200, {
              ok: true,
              restoredMessages,
              pendingQueue: pendingQueueSnapshot(session),
            });
          }
          const cleared = await requestRpcClearQueue(proc, ABORT_RPC_TIMEOUT_MS);
          if (!cleared.supported) {
            return sendJson(res, 409, {
              error: "当前 Pi 版本不支持恢复队列消息",
              cause: cleared.errorMessage,
            });
          }
          setPendingQueue(session, { steering: [], followUp: [] });
          broadcastSessionSnapshot(session);
          return sendJson(res, 200, {
            ok: true,
            restoredMessages: [...cleared.steering, ...cleared.followUp],
            pendingQueue: pendingQueueSnapshot(session),
          });
        });
      } catch (error) {
        return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (method === "POST" && action === "withdraw_queue") {
      const body = await readJsonBody(req);
      const kind: RpcQueueKind | undefined = body.kind === "steering" || body.kind === "followUp"
        ? body.kind
        : undefined;
      const index = typeof body.index === "number" && Number.isInteger(body.index) ? body.index : -1;
      const message = typeof body.message === "string" ? body.message : "";
      if (!kind || index < 0 || !message) {
        return sendJson(res, 400, { error: "kind, index, and message are required" });
      }
      try {
        return await withSessionOperation(session, async () => {
          const proc = session.proc;
          if (!proc) return sendJson(res, 409, { error: "消息队列已不可用，目标消息可能已经发出" });
          const result = await requestRpcWithdrawQueueItem(proc, { kind, index, message }, ABORT_RPC_TIMEOUT_MS);
          if (!result.supported) {
            return sendJson(res, 409, {
              error: "当前 Pi 版本不支持安全撤回队列消息",
              cause: result.errorMessage,
            });
          }

          broadcastSessionSnapshot(session);
          const unrestoredMessages = [...result.unrestored.steering, ...result.unrestored.followUp];
          if (unrestoredMessages.length > 0) {
            return sendJson(res, 500, {
              error: "撤回后未能恢复全部剩余消息，未恢复内容已放回输入框",
              cause: result.errorMessage,
              withdrawn: result.withdrawn,
              pendingQueue: pendingQueueSnapshot(session),
              unrestoredMessages,
            });
          }
          if (!result.withdrawn) {
            return sendJson(res, 409, {
              error: "目标消息已发出或队列顺序已变化，请重试",
              pendingQueue: pendingQueueSnapshot(session),
            });
          }
          return sendJson(res, 200, {
            ok: true,
            pendingQueue: pendingQueueSnapshot(session),
          });
        });
      } catch (error) {
        return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (method === "POST" && action === "abort") {
      const proc = session.proc;
      if (!proc) {
        const pendingQueue = session.pendingQueue ?? { steering: [], followUp: [] };
        const restoredMessages = [...pendingQueue.steering, ...pendingQueue.followUp];
        setPendingQueue(session, { steering: [], followUp: [] });
        session.streaming = false;
        session.status = "stopped";
        session.dialogs = [];
        broadcastSessionSnapshot(session);
        broadcastWorkspaces();
        return sendJson(res, 200, { ok: true, forced: false, alreadyStopped: true, restoredMessages });
      }

      const fallbackQueue = session.pendingQueue ?? { steering: [], followUp: [] };
      const clearedQueue = await requestRpcClearQueue(proc, ABORT_RPC_TIMEOUT_MS);
      const restoredMessages = clearedQueue.supported
        ? [...clearedQueue.steering, ...clearedQueue.followUp]
        : [...fallbackQueue.steering, ...fallbackQueue.followUp];
      setPendingQueue(session, { steering: [], followUp: [] });

      const abort = await requestRpcAbort(proc, ABORT_RPC_TIMEOUT_MS);
      const mustCloseForLegacyQueue = !clearedQueue.supported && restoredMessages.length > 0;
      if (abort.acknowledged && !mustCloseForLegacyQueue) {
        broadcastSessionSnapshot(session);
        return sendJson(res, 200, {
          ok: true,
          forced: false,
          response: abort.response,
          restoredMessages,
        });
      }

      // A wedged tool, or an older Pi that cannot clear queued messages, needs
      // this session process replaced so restored drafts cannot run twice.
      if (session.proc === proc) {
        session.proc = undefined;
        await proc.close().catch((error) => {
          console.error("[pi-web] forced session close failed:", error);
        });
      }
      session.status = "stopped";
      session.streaming = false;
      session.dialogs = [];
      session.extensionStatuses = {};
      session.starting = undefined;
      session.error = undefined;
      if (session.state) session.state = { ...session.state, isStreaming: false };
      broadcastSessionSnapshot(session);
      broadcastWorkspaces();
      return sendJson(res, 200, {
        ok: true,
        forced: true,
        warning: mustCloseForLegacyQueue
          ? "当前 Pi 不支持清空消息队列，已重启会话并恢复待处理消息"
          : "生成未响应，已关闭该会话进程；下次发送消息时会自动恢复",
        cause: abort.errorMessage ?? clearedQueue.errorMessage,
        restoredMessages,
      });
    }

    if (method === "POST" && action === "set_model") {
      const body = await readJsonBody(req);
      const provider = typeof body.provider === "string" ? body.provider : "";
      const modelId = typeof body.modelId === "string" ? body.modelId : "";
      if (!provider || !modelId) return sendJson(res, 400, { error: "provider and modelId are required" });
      session.lastUsed = Date.now();
      if (!session.proc) {
        session.pendingModel = { provider, modelId };
        const full = (session.models as Json[]).find(
          (model) => model && typeof model === "object" && model.provider === provider && model.id === modelId,
        );
        session.state = { ...(session.state ?? {}), model: full ?? { provider, id: modelId, name: modelId } };
        if (full) {
          session.thinkingLevels = supportedThinkingLevels(full);
          const currentLevel = typeof session.state.thinkingLevel === "string" ? session.state.thinkingLevel : "off";
          if (!session.thinkingLevels.includes(currentLevel)) {
            session.state.thinkingLevel = session.thinkingLevels.includes("off") ? "off" : session.thinkingLevels[0] ?? "off";
            session.pendingThinkingLevel = session.state.thinkingLevel as string;
          }
        }
        persistModelInfo(session.cwd, {
          models: session.models,
          thinkingLevels: session.thinkingLevels,
          defaultModel: session.state.model,
          thinkingLevel: typeof session.state.thinkingLevel === "string" ? session.state.thinkingLevel : undefined,
        });
        updateStoredSession(session);
        broadcastSessionSnapshot(session);
        return sendJson(res, 200, { ok: true, pending: true });
      }
      try {
        const response = await session.proc!.send({ type: "set_model", provider, modelId });
        session.pendingModel = undefined;
        await refreshState(session);
        await refreshModels(session);
        broadcastSessionSnapshot(session);
        return sendJson(res, 200, { ok: true, response });
      } catch (error) {
        return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (method === "POST" && action === "set_thinking_level") {
      const body = await readJsonBody(req);
      const level = typeof body.level === "string" ? body.level : "";
      if (!level) return sendJson(res, 400, { error: "level is required" });
      session.lastUsed = Date.now();
      if (!session.proc) {
        session.pendingThinkingLevel = level;
        session.state = { ...(session.state ?? {}), thinkingLevel: level };
        persistModelInfo(session.cwd, {
          models: session.models,
          thinkingLevels: session.thinkingLevels,
          defaultModel: session.state.model,
          thinkingLevel: level,
        });
        updateStoredSession(session);
        broadcastSessionSnapshot(session);
        return sendJson(res, 200, { ok: true, pending: true });
      }
      try {
        const response = await session.proc!.send({ type: "set_thinking_level", level });
        session.pendingThinkingLevel = undefined;
        await refreshState(session);
        persistModelInfo(session.cwd, {
          models: session.models,
          thinkingLevels: session.thinkingLevels,
          defaultModel: session.state?.model,
          thinkingLevel: typeof session.state?.thinkingLevel === "string" ? session.state.thinkingLevel : undefined,
        });
        broadcastSessionSnapshot(session);
        return sendJson(res, 200, { ok: true, response });
      } catch (error) {
        return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (method === "POST" && action === "set_name") {
      const body = await readJsonBody(req);
      const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ").slice(0, 60) : "";
      if (!name) return sendJson(res, 400, { error: "name is required" });
      try {
        if (session.proc) {
          await session.proc.send({ type: "set_session_name", name });
          session.pendingName = undefined;
        } else {
          session.pendingName = name;
        }
        session.title = name;
        updateStoredSession(session);
        broadcastWorkspaces();
        broadcastSessionSnapshot(session);
        return sendJson(res, 200, { ok: true });
      } catch (error) {
        return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (method === "POST" && action === "compact") {
      const body = await readJsonBody(req);
      const customInstructions = typeof body.customInstructions === "string" ? body.customInstructions.trim() : "";
      try {
        return await withSessionOperation(session, async () => {
          await ensureProcess(session);
          if (session.streaming || session.state?.isCompacting || session.dialogs.length > 0) {
            return sendJson(res, 409, { error: "请等待当前会话运行结束并处理完交互后再压缩" });
          }
          const response = await session.proc!.send({ type: "compact", ...(customInstructions ? { customInstructions } : {}) });
          await Promise.all([refreshState(session), refreshMessages(session), refreshStats(session)]);
          broadcastSessionSnapshot(session);
          return sendJson(res, 200, { ok: true, response });
        });
      } catch (error) {
        return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (method === "POST" && action === "export_html") {
      await ensureProcess(session);
      const filename = exportFilename(session.title);
      const outputPath = join(tmpdir(), `${randomUUID()}-${filename}`);
      try {
        const response = await session.proc!.send<Json>({ type: "export_html", outputPath });
        const exportedPath = typeof response.data?.path === "string" ? response.data.path : outputPath;
        const token = randomUUID();
        const download: ExportDownload = { path: exportedPath, filename, expiresAt: Date.now() + 5 * 60_000 };
        exportDownloads.set(token, download);
        const expiry = setTimeout(() => {
          if (exportDownloads.get(token) !== download) return;
          exportDownloads.delete(token);
          unlink(download.path).catch(() => {});
        }, 5 * 60_000);
        expiry.unref();
        return sendJson(res, 200, { ok: true, filename, downloadUrl: `/api/exports/${token}` });
      } catch (error) {
        unlink(outputPath).catch(() => {});
        return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (method === "POST" && action === "extension_ui_response") {
      const body = await readJsonBody(req);
      const dialog = session.dialogs.find((d) => d.id === body.id);
      if (!dialog) return sendJson(res, 404, { error: "dialog not found" });
      if (dialog.expiresAt && dialog.expiresAt <= Date.now()) {
        session.dialogs = session.dialogs.filter((d) => d.id !== body.id);
        broadcastSessionSnapshot(session);
        broadcastWorkspaces();
        return sendJson(res, 410, { error: "dialog expired" });
      }
      session.dialogs = session.dialogs.filter((d) => d.id !== body.id);
      const response: Json = { type: "extension_ui_response", id: body.id };
      if (body.cancelled === true) response.cancelled = true;
      else if (dialog.method === "confirm") response.confirmed = Boolean(body.confirmed);
      else response.value = body.value ?? "";
      try {
        session.proc!.write(response);
        broadcastSessionSnapshot(session);
        broadcastWorkspaces();
        return sendJson(res, 200, { ok: true });
      } catch (error) {
        broadcastSessionSnapshot(session);
        broadcastWorkspaces();
        return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (method === "POST" && action === "commands") {
      await ensureProcess(session);
      await refreshCommands(session);
      broadcastSessionSnapshot(session);
      return sendJson(res, 200, { commands: session.commands });
    }

    if (method === "POST" && action === "refresh") {
      await ensureProcess(session);
      await Promise.allSettled([refreshState(session), refreshMessages(session), refreshModels(session), refreshStats(session)]);
      return sendJson(res, 200, {
        session: sessionSummary(session),
        state: session.state,
        messages: browserMessages(snapshotMessages(session)),
        pendingQueue: pendingQueueSnapshot(session),
        models: session.models,
        thinkingLevels: session.thinkingLevels,
        thinkingLevelsByModel: thinkingLevelsByModel(session.models),
        commands: session.commands,
        extensionStatuses: session.extensionStatuses,
        stats: session.stats,
        dialogs: session.dialogs,
      });
    }

    if (method === "DELETE") {
      const ws = state.workspaces.find((workspace) => workspace.sessionIds.includes(session.id));
      if (!ws) return sendJson(res, 404, { error: "workspace not found" });
      await deleteWorkspaceSession(ws, session.id);
      return sendJson(res, 200, { ok: true });
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// server lifecycle
// ---------------------------------------------------------------------------

function networkView() {
  const status = networkError ? { state: "error", message: networkError }
    : networkSettings.mode === "relay" ? frpProcess.status
    : { state: networkSettings.mode === "lan" ? "connected" : "stopped", message: networkSettings.mode === "lan" ? "局域网访问已开启" : "仅本机访问" };
  return { settings: publicNetworkSettings(networkSettings), status, urls: getWebLanUrls(), applying: networkApplying };
}

function disconnectWebClients(): void {
  for (const client of [...sseClients]) {
    closeSseClient(client);
    (client.res as ServerResponse).end();
  }
  sseClients.clear();
}

async function stopRelay(): Promise<void> {
  await frpProcess.stop();
  if (frpRuntimeDir) await rm(frpRuntimeDir, { recursive: true, force: true });
  frpRuntimeDir = undefined;
}

async function startRelay(): Promise<void> {
  if (networkSettings.mode !== "relay" || !networkSettings.relay || !serverUrl) return;
  const relay = networkSettings.relay;
  const executable = await resolveFrpc(relay.frpcPath, dirname(NETWORK_FILE));
  const runtimeRoot = join(dirname(NETWORK_FILE), "runtime");
  await mkdir(runtimeRoot, { recursive: true });
  frpRuntimeDir = await mkdtemp(join(runtimeRoot, "frpc-"));
  const configPath = join(frpRuntimeDir, "frpc.toml");
  await writeTextAtomically(configPath, frpcConfig(relay, Number(new URL(serverUrl).port)));
  await chmod(configPath, 0o600);
  await frpProcess.start({ executable, args: ["-c", configPath], cwd: dirname(NETWORK_FILE) });
}

async function applyNetworkSettings(): Promise<void> {
  if (!server || !serverUrl) return;
  await stopRelay();
  const next = await WebAccess.load(networkSettings.mode === "lan", AUTH_FILE, proxyForNetwork(networkSettings));
  disconnectWebClients();
  if (next.lan !== webAccess.lan) {
    const port = Number(new URL(serverUrl).port);
    const previousHost = webAccess.lan ? "0.0.0.0" : HOST;
    const app = server;
    await new Promise<void>((resolveClose) => {
      app.close(() => resolveClose());
      app.closeAllConnections();
    });
    try {
      await listenOn(app, port, next.lan ? "0.0.0.0" : HOST, false);
    } catch (error) {
      await listenOn(app, port, previousHost, false);
      throw error;
    }
  }
  webAccess = next;
  await startRelay();
}

function listenOn(app: ReturnType<typeof createServer>, preferredPort: number, host = HOST, allowFallback = true): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (allowFallback && error.code === "EADDRINUSE" && preferredPort !== 0) {
        app.removeListener("error", onError);
        listenOn(app, 0, host).then(resolvePort, reject);
        return;
      }
      app.removeListener("error", onError);
      reject(error);
    };
    app.once("error", onError);
    app.listen(preferredPort, host, () => {
      app.removeListener("error", onError);
      const address = app.address();
      resolvePort(address && typeof address === "object" ? address.port : preferredPort);
    });
  });
}

function openBrowser(url: string): void {
  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

function exitHook(): void {
  frpProcess.kill();
  for (const record of sessions.values()) {
    try {
      record.proc?.close();
    } catch {
      // ignore
    }
  }
  void attachments.close();
}

function sigintHook(): void {
  void shutdown();
}

function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = shutdownServer();
  return shutdownPromise;
}

async function shutdownServer(): Promise<void> {
  snapshotScheduler.clear();
  await networkChange;
  await stopRelay();
  for (const client of [...sseClients]) {
    closeSseClient(client);
    try {
      (client.res as ServerResponse).end();
    } catch {
      // ignore
    }
  }
  sseClients.clear();
  await Promise.all([...sessions.values()].map(stopSessionProcess));
  await closeAllPiRpcs();
  for (const download of exportDownloads.values()) unlink(download.path).catch(() => {});
  exportDownloads.clear();
  await attachments.close();
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = undefined;
  await saveStateNow().catch(() => {});
  const activeServer = server;
  server = undefined;
  serverUrl = undefined;
  serverInstanceId = undefined;
  updateExtensions = undefined;
  reloadRuntime = undefined;
  maintenanceRunning = false;
  if (activeServer) {
    await new Promise<void>((resolveClose) => {
      activeServer.close(() => resolveClose());
    });
  }
  process.off("exit", exitHook);
  process.off("SIGINT", sigintHook);
  process.off("SIGTERM", sigintHook);
}

export async function startWebServer(options: {
  defaultCwd?: string;
  port?: number;
  open?: boolean;
  lan?: boolean;
  mode?: NetworkMode;
  initialModelInfo?: ModelInfo;
  initialCommands?: unknown[];
  updateExtensions?: () => Promise<MaintenanceCommandResult>;
  reloadRuntime?: () => Promise<void>;
} = {}): Promise<string> {
  if (shutdownPromise) await shutdownPromise;
  const initialCwd = normalizePath(options.defaultCwd ?? process.cwd());
  extensionSettingsCwd = initialCwd;
  updateExtensions = options.updateExtensions;
  reloadRuntime = options.reloadRuntime;
  const mode = options.mode ?? (options.lan === undefined ? undefined : options.lan ? "lan" : "local");
  if (serverUrl && server) {
    await networkChange;
    if (mode !== undefined) {
      networkSettings = updateNetworkSettings({ mode }, networkSettings);
      await saveNetworkSettings(NETWORK_FILE, networkSettings);
      networkError = undefined;
      await applyNetworkSettings();
      broadcastEvent({ type: "network_changed" });
    }
    if (options.initialCommands?.length) commandCache.set(initialCwd, normalizeCommands(options.initialCommands));
    if (options.open !== false) openBrowser(serverUrl);
    return serverUrl;
  }
  shutdownPromise = undefined;
  shuttingDown = false;
  await loadState();
  if (options.initialModelInfo?.models.length) {
    persistModelInfo(initialCwd, {
      models: options.initialModelInfo.models,
      thinkingLevels: options.initialModelInfo.thinkingLevels,
      defaultModel: options.initialModelInfo.defaultModel,
      thinkingLevel: options.initialModelInfo.thinkingLevel,
    });
  }
  if (options.initialCommands?.length) commandCache.set(initialCwd, normalizeCommands(options.initialCommands));
  if (state.workspaces.length === 0 && options.defaultCwd) await addWorkspace(options.defaultCwd);
  const requestedPort = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error("端口必须是 0–65535 之间的整数");
  }
  terminalProxy = await loadTerminalProxy(TERMINAL_PROXY_FILE);
  networkSettings = await loadNetworkSettings(NETWORK_FILE);
  if (mode !== undefined) {
    networkSettings = updateNetworkSettings({ mode }, networkSettings);
    await saveNetworkSettings(NETWORK_FILE, networkSettings);
  }
  networkApplying = false;
  networkError = undefined;
  webAccess = await WebAccess.load(networkSettings.mode === "lan", AUTH_FILE, proxyForNetwork(networkSettings));
  const app = createServer(async (req, res) => {
    try {
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("x-frame-options", "DENY");
      if (shuttingDown) return sendJson(res, 503, { error: "pi-web 正在关闭" });
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${HOST}:${requestedPort}`}`);
      if (url.pathname.startsWith("/api/")) {
        const handled = await handleApi(req, res, url);
        if (!handled) sendJson(res, 404, { error: "not found" });
        return;
      }
      await serveStatic(res, url.pathname);
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      else res.end();
    }
  });
  const port = await listenOn(app, requestedPort, webAccess.lan ? "0.0.0.0" : HOST);
  server = app;
  serverUrl = `http://${HOST}:${port}`;
  serverInstanceId = randomUUID();
  heartbeat = setInterval(() => broadcastEvent({ type: "heartbeat", at: Date.now() }), 25_000);
  process.on("exit", exitHook);
  process.on("SIGINT", sigintHook);
  process.on("SIGTERM", sigintHook);
  try { await startRelay(); } catch (error) {
    networkError = error instanceof Error ? error.message : String(error);
  }
  if (options.open !== false) openBrowser(serverUrl);
  return serverUrl;
}

export async function stopWebServer(): Promise<void> {
  await shutdown();
}

export function getWebUrl(): string | undefined {
  return serverUrl;
}

export function getWebLanUrls(): string[] {
  return serverUrl ? webAccess.urls(Number(new URL(serverUrl).port)) : [];
}

export function getWebConnectionOptions(): { port: number; lan: boolean; mode: NetworkMode } | undefined {
  return serverUrl ? { port: Number(new URL(serverUrl).port), lan: webAccess.lan, mode: networkSettings.mode } : undefined;
}
