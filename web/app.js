"use strict";

const SESSION_PREVIEW_LIMIT = 5;
const MODEL_REFRESH_TTL_MS = 60_000;
const WORKSPACE_ORDER_STORAGE_KEY = "pi-web-workspace-order";

const S = {
  workspaces: [],
  workspaceDragId: null,
  workspaceDragOverId: null,
  workspaceDragPosition: null,
  workspaceDragPending: false,
  currentWorkspaceId: null,
  currentSessionId: null,
  snapshots: new Map(),
  newSessionSnapshot: null,
  collapsed: new Set(),
  expandedSessionLists: new Set(),
  sidebarCollapsed: localStorage.getItem("pi-web-sidebar-collapsed") === "1",
  mobileSidebarOpen: false,
  sidebarWidth: Number(localStorage.getItem("pi-web-sidebar-width")) || 280,
  filePreview: null,
  filePreviewWidth: Number(localStorage.getItem("pi-web-file-preview-width")) || 520,
  filePreviewGeneration: 0,
  expandedTools: new Set(),
  expandedCompactions: new Set(),
  search: "",
  searchOpen: false,
  loadingSession: null,
  pendingSends: new Map(),
  withdrawingQueueItems: new Set(),
  dequeueSessions: new Set(),
  drafts: new Map(),
  failedDrafts: new Map(),
  attachmentDrafts: new Map(),
  failedAttachmentDrafts: new Map(),
  openGeneration: 0,
  draft: "",
  draftAttachments: [],
  commandMenuOpen: false,
  commandLoading: false,
  commandSelected: 0,
  commandGeneration: 0,
  modelRefreshes: new Map(),
  modelRefreshedAt: new Map(),
  conversationTab: "conversation",
  historyView: null,
  historyGeneration: 0,
  clipboardBusy: false,
  settingsOpen: false,
  maintenanceBusy: null,
  maintenanceMessage: null,
  maintenanceGeneration: 0,
  serverInstanceId: null,
  localClient: true,
  lanEnabled: false,
  lanUrls: [],
  passwordConfigured: false,
  theme: localStorage.getItem("pi-web-theme") || "system",
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

async function api(path, options = {}) {
  const request = () => fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  let res = await request();
  if (res.status === 401 && path !== "/api/auth") {
    await requireLogin();
    res = await request();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `${res.status} ${res.statusText}`);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

function post(path, body) {
  return api(path, { method: "POST", body: JSON.stringify(body || {}) });
}

function timeLabel(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}天`;
  return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function sessionsByRecency(workspace) {
  return [...(workspace?.sessions || [])].sort((a, b) =>
    (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)
  );
}

function clockLabel(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function shortPath(path, max = 34) {
  if (!path) return "";
  return path.length > max ? `…${path.slice(path.length - max)}` : path;
}

function setTheme(theme) {
  S.theme = theme;
  localStorage.setItem("pi-web-theme", theme);
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  document.body.toggleAttribute("data-ds-dark-theme", dark);
}

function toggleTheme() {
  setTheme(document.body.hasAttribute("data-ds-dark-theme") ? "light" : "dark");
}

const ICONS = {
  logo: `<svg width="30" height="30" viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="12" fill="var(--dsw-alias-brand-primary, #3964fe)"/><text x="25" y="34" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="30" font-weight="700" fill="var(--dsw-alias-bg-base, #fff)">π</text></svg>`,
  wordmark: `<span class="pi-brandLogo"><svg width="30" height="30" viewBox="0 0 50 50" fill="none" aria-hidden="true"><rect width="50" height="50" rx="12" fill="var(--dsw-alias-brand-primary, #3964fe)"/><text x="25" y="34" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="30" font-weight="700" fill="var(--dsw-alias-bg-base, #fff)">π</text></svg><span class="pi-brandName">Pi</span></span>`,
  panel: `<svg class="hHd-Xa_panelIcon" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-9Z" stroke="currentColor" stroke-width="1.4"/><path d="M6 2v12" stroke="currentColor" stroke-width="1.4"/></svg>`,
  plus: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 1.5V14.5M1.5 8H14.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  search: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5.4" stroke="currentColor" stroke-width="1.4"/><path d="M11 11L15 15" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  folder: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2.5 3.5C2.5 2.95 2.95 2.5 3.5 2.5H6L7.5 4.5H12.5C13.05 4.5 13.5 4.95 13.5 5.5V12.5C13.5 13.05 13.05 13.5 12.5 13.5H3.5C2.95 13.5 2.5 13.05 2.5 12.5V3.5Z" stroke="currentColor" stroke-width="1.2"/></svg>`,
  grip: `<svg width="12" height="16" viewBox="0 0 12 16" fill="none" aria-hidden="true"><circle cx="3" cy="4" r="1" fill="currentColor"/><circle cx="9" cy="4" r="1" fill="currentColor"/><circle cx="3" cy="8" r="1" fill="currentColor"/><circle cx="9" cy="8" r="1" fill="currentColor"/><circle cx="3" cy="12" r="1" fill="currentColor"/><circle cx="9" cy="12" r="1" fill="currentColor"/></svg>`,
  chevron: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M4.25 2.83V11.17C4.25 11.66 4.84 11.91 5.19 11.56L9.36 7.39C9.58 7.17 9.58 6.83 9.36 6.61L5.19 2.44C4.84 2.09 4.25 2.34 4.25 2.83Z" fill="currentColor"/></svg>`,
  gear: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.5V3M8 13V14.5M14.5 8H13M3 8H1.5M12.6 3.4L11.5 4.5M4.5 11.5L3.4 12.6M12.6 12.6L11.5 11.5M4.5 4.5L3.4 3.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  send: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none"><path d="M1.5 14.5L14.5 8L1.5 1.5L4.5 8L1.5 14.5Z" fill="currentColor"/></svg>`,
  stop: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none"><rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor"/></svg>`,
  down: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none"><path d="M3 6L8 11L13 6M3 13.5H13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  copy: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M11 5V3.5C11 2.67 10.33 2 9.5 2H3.5C2.67 2 2 2.67 2 3.5V9.5C2 10.33 2.67 11 3.5 11H5" stroke="currentColor" stroke-width="1.3"/></svg>`,
  dots: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="3.5" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="12.5" cy="8" r="1.2" fill="currentColor"/></svg>`,
  bash: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="1.5" width="12" height="11" rx="2.5" stroke="currentColor" stroke-width="1.3"/><path d="M4 5.5L6 7L4 8.5M7 9H10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  think: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.3"/><path d="M8 5.5V8.5L10.5 10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  compact: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 2.5V6H6.5M13 2.5V6H9.5M3 13.5V10H6.5M13 13.5V10H9.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.4 5.6L6.3 2.7M12.6 5.6L9.7 2.7M3.4 10.4L6.3 13.3M12.6 10.4L9.7 13.3" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/></svg>`,
  check: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2.5 8.5L6 12L13.5 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  edit: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M11.5 2.5L13.5 4.5L6 12L3 13L4 10L11.5 2.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
  image: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" stroke-width="1.3"/><circle cx="5.25" cy="5.75" r="1.15" fill="currentColor"/><path d="M3.5 11L6.4 8.2L8.4 10L10.2 8.4L12.5 11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  close: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  history: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M3 4.5h6.5a3.5 3.5 0 1 1 0 7H7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M5 2.5L3 4.5l2 2M7 9.5l-2 2 2 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  refresh: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M13.2 6.2A5.5 5.5 0 1 0 13 10.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M10.4 3.2h3.2v3.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  folderOpen: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2.5 3.5C2.5 2.95 2.95 2.5 3.5 2.5H6L7.5 4.5H12.5C13.05 4.5 13.5 4.95 13.5 5.5V6H3V5.5C3 4.67 3.67 4 4.5 4H5.2L3.5 2.5Z" stroke="currentColor" stroke-width="1.2"/><path d="M3 6H13.5C14.05 6 14.5 6.45 14.5 7V12.5C14.5 13.05 14.05 13.5 13.5 13.5H2.5C1.95 13.5 1.5 13.05 1.5 12.5V6.5C1.5 6.22 1.72 6 2 6H3Z" stroke="currentColor" stroke-width="1.2"/></svg>`,
};

function snapshotFor(id) {
  if (!id && S.newSessionSnapshot) return S.newSessionSnapshot;
  return S.snapshots.get(id) || { session: null, state: null, stats: null, models: [], thinkingLevels: [], thinkingLevelsByModel: {}, commands: [], extensionStatuses: {}, messages: [], pendingQueue: { steering: [], followUp: [] }, dialogs: [] };
}

function currentWorkspace() {
  return S.workspaces.find((w) => w.id === S.currentWorkspaceId) || S.workspaces[0] || null;
}

function savedWorkspaceOrder() {
  try {
    const value = JSON.parse(localStorage.getItem(WORKSPACE_ORDER_STORAGE_KEY) || "[]");
    return Array.isArray(value) ? value.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function applySavedWorkspaceOrder(workspaces) {
  const incoming = Array.isArray(workspaces) ? workspaces : [];
  const byId = new Map(incoming.map((workspace) => [workspace.id, workspace]));
  const seen = new Set();
  const ordered = [];
  for (const id of savedWorkspaceOrder()) {
    const workspace = byId.get(id);
    if (!workspace || seen.has(id)) continue;
    seen.add(id);
    ordered.push(workspace);
  }
  for (const workspace of incoming) {
    if (seen.has(workspace.id)) continue;
    seen.add(workspace.id);
    ordered.push(workspace);
  }
  return ordered;
}

function saveWorkspaceOrder(workspaces) {
  localStorage.setItem(WORKSPACE_ORDER_STORAGE_KEY, JSON.stringify(workspaces.map((workspace) => workspace.id)));
}

function currentSnapshot() {
  if (!S.currentSessionId) return snapshotFor(null);
  return snapshotFor(S.currentSessionId);
}

function draftKey(sessionId = S.currentSessionId, workspaceId = S.currentWorkspaceId) {
  return sessionId ? `session:${sessionId}` : `new:${workspaceId || "default"}`;
}

function rememberCurrentDraft() {
  const key = draftKey();
  if (S.draft) S.drafts.set(key, S.draft);
  else S.drafts.delete(key);
  if (S.draftAttachments.length) S.attachmentDrafts.set(key, [...S.draftAttachments]);
  else S.attachmentDrafts.delete(key);
}

function setDraftValue(value) {
  S.draft = String(value ?? "");
  rememberCurrentDraft();
}

function setDraftAttachments(attachments) {
  S.draftAttachments = Array.isArray(attachments) ? [...attachments] : [];
  rememberCurrentDraft();
}

function loadCurrentDraftValue() {
  const key = draftKey();
  S.draftAttachments = [...(S.attachmentDrafts.get(key) || [])];
  setDraftValue(S.drafts.get(key) || "");
}

function modelSupportsImages(model = currentSnapshot().state?.model) {
  return Array.isArray(model?.input) && model.input.includes("image");
}

function modelLabel(model) {
  const label = model?.name || model?.id;
  if (!label) return "选择模型";
  return model.provider ? `${model.provider} / ${label}` : label;
}

function thinkingLabel(level) {
  if (!level) return "";
  return { off: "Off", minimal: "Min", low: "Low", medium: "Med", high: "High", xhigh: "X-High", max: "Max" }[level] || level;
}

const WEB_SLASH_COMMANDS = [
  { name: "settings", description: "打开界面与运行时设置", source: "builtin", local: true },
  { name: "model", description: "选择当前模型", source: "builtin", local: true },
  { name: "export", description: "将当前会话导出为 HTML", source: "builtin", local: true },
  { name: "copy", description: "复制最后一条助手回复", source: "builtin", local: true },
  { name: "name", description: "设置当前会话名称", source: "builtin", local: true },
  { name: "session", description: "显示会话统计信息", source: "builtin", local: true },
  { name: "new", description: "在当前工作区创建新会话", source: "builtin", local: true },
  { name: "rewind", description: "回溯对话，可选择同步恢复文件", source: "builtin", local: true },
  { name: "tree", description: "打开当前会话的分支树", source: "builtin", local: true },
  { name: "compact", description: "手动压缩当前会话上下文", source: "builtin", local: true },
];

function commandSourceLabel(source) {
  return { builtin: "内置", prompt: "模板", extension: "扩展", skill: "技能" }[source] || source || "命令";
}

function slashCommandContext(value = S.draft) {
  const firstLine = String(value ?? "").split("\n", 1)[0];
  const match = /^\/([^\s/]*)$/.exec(firstLine);
  return match && firstLine.length === String(value ?? "").length ? { query: match[1] } : null;
}

function fuzzyCommandScore(value, query) {
  const text = String(value || "").toLowerCase();
  const needle = String(query || "").toLowerCase();
  if (!needle) return 0;
  if (text === needle) return -100;
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of needle) {
    const index = text.indexOf(char, from);
    if (index < 0) return null;
    score += index;
    if (index === previous + 1) score -= 4;
    if (index === 0 || /[-_:.]/.test(text[index - 1])) score -= 3;
    previous = index;
    from = index + 1;
  }
  return score + text.length * 0.05;
}

function availableSlashCommands(snap = currentSnapshot()) {
  const sourceOrder = { builtin: 0, prompt: 1, extension: 2, skill: 3 };
  const combined = [...WEB_SLASH_COMMANDS, ...(snap.commands || [])];
  const seen = new Set();
  return combined
    .filter((command) => command?.name && !seen.has(command.name) && seen.add(command.name))
    .sort((a, b) => (sourceOrder[a.source] ?? 9) - (sourceOrder[b.source] ?? 9));
}

function commandSuggestions(snap = currentSnapshot()) {
  const context = slashCommandContext();
  if (!context) return [];
  return availableSlashCommands(snap)
    .map((command, order) => ({ command, order, score: fuzzyCommandScore(command.name, context.query) }))
    .filter((item) => item.score != null)
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .slice(0, 20)
    .map((item) => item.command);
}

function clampPanelWidth(value, min, max) {
  return Math.min(Math.max(Number(value) || min, min), Math.max(min, max));
}

function usesMobileSidebar() {
  return matchMedia("(max-width: 640px)").matches;
}

function usesTouchInput() {
  return matchMedia("(pointer: coarse)").matches;
}

function updateViewport() {
  const viewport = window.visualViewport;
  if (viewport && viewport.scale !== 1) return;
  document.documentElement.style.setProperty("--pi-viewport-height", `${viewport?.height || window.innerHeight}px`);
  document.documentElement.style.setProperty("--pi-viewport-top", `${viewport?.offsetTop || 0}px`);
}

function closeMobileSidebar() {
  S.mobileSidebarOpen = false;
  applyFrameLayout();
}

function currentPanelWidths() {
  const frame = $(".pI_x6G_frame");
  const frameWidth = frame?.clientWidth || window.innerWidth;
  const sidebarWidth = usesMobileSidebar()
    ? 0
    : S.sidebarCollapsed
      ? 56
      : clampPanelWidth(S.sidebarWidth, 220, Math.min(420, frameWidth - 420));
  const maxPreviewWidth = Math.min(960, Math.max(320, frameWidth - sidebarWidth - 360));
  const previewWidth = S.filePreview ? clampPanelWidth(S.filePreviewWidth, 320, maxPreviewWidth) : 0;
  return { sidebarWidth, previewWidth };
}

function applyFrameLayout() {
  const frame = $(".pI_x6G_frame");
  if (!frame) return;
  const mobileSidebar = usesMobileSidebar();
  const { sidebarWidth, previewWidth } = currentPanelWidths();
  frame.dataset.sidebarCollapsed = String(mobileSidebar || S.sidebarCollapsed);
  frame.toggleAttribute("data-mobile-sidebar-open", mobileSidebar && S.mobileSidebarOpen);
  const sidebar = $(".pI_x6G_sidebarCol", frame);
  if (sidebar) sidebar.inert = mobileSidebar && !S.mobileSidebarOpen;
  frame.toggleAttribute("data-details-collapsed", !S.filePreview);
  frame.style.setProperty("--pi-sidebar-width", `${sidebarWidth}px`);
  frame.style.setProperty("--pi-details-width", `${previewWidth}px`);
  frame.style.gridTemplateColumns = `${sidebarWidth}px minmax(0px, 1fr) ${previewWidth}px`;
  const sidebarHandle = $(".pI_x6G_handle[data-side=sidebar]", frame);
  const detailsHandle = $(".pI_x6G_handle[data-side=details]", frame);
  if (sidebarHandle) {
    sidebarHandle.hidden = mobileSidebar || S.sidebarCollapsed;
    sidebarHandle.setAttribute("aria-valuenow", String(Math.round(sidebarWidth)));
  }
  if (detailsHandle) {
    detailsHandle.hidden = !S.filePreview;
    detailsHandle.setAttribute("aria-valuenow", String(Math.round(previewWidth)));
  }
}

function fileNameFromPath(path) {
  return String(path || "").split(/[\\/]/).filter(Boolean).pop() || "文件";
}

function formatFileBytes(size) {
  const bytes = Number(size) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes >= 100 * 1024 ? 0 : 1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderFilePreview() {
  const mount = $("#filePreviewMount");
  if (!mount) return;
  const preview = S.filePreview;
  if (!preview) {
    mount.innerHTML = "";
    return;
  }
  const name = preview.name || fileNameFromPath(preview.path);
  const metadata = preview.loading
    ? "正在读取"
    : preview.error
      ? "无法预览"
      : `${preview.language || "plaintext"} · ${preview.lineCount} 行 · ${formatFileBytes(preview.size)}`;
  let body = `<div class="pi-filePreviewState"><span class="pi-filePreviewSpinner" aria-hidden="true"></span>正在加载文件…</div>`;
  if (preview.error) {
    body = `<div class="pi-filePreviewState pi-filePreviewError"><strong>文件预览失败</strong><span>${esc(preview.error)}</span></div>`;
  } else if (!preview.loading) {
    const lineCount = Math.max(1, Number(preview.lineCount) || 1);
    const requestedLine = Number(preview.line);
    const line = Number.isFinite(requestedLine) && requestedLine > 0
      ? Math.min(Math.max(1, requestedLine), lineCount)
      : null;
    const numbers = Array.from({ length: lineCount }, (_, index) => index + 1).join("\n");
    const digits = String(lineCount).length;
    const sourceState = line
      ? `data-active-line="${line}" style="--pi-active-line-top:${12 + (line - 1) * 21}px;--pi-line-digits:${digits}"`
      : `style="--pi-line-digits:${digits}"`;
    body = `<div class="pi-filePreviewScroll" tabindex="0" aria-label="${esc(name)} 源代码">
      <div class="pi-filePreviewSource" ${sourceState}>
        <pre class="pi-filePreviewNumbers" aria-hidden="true">${numbers}</pre>
        <pre class="pi-filePreviewCode"><code class="hljs language-${esc(preview.language || "plaintext")}">${preview.highlightedHtml || " "}</code></pre>
      </div>
    </div>`;
  }
  mount.innerHTML = `<section class="pi-filePreview" aria-label="文件预览">
    <header class="pi-filePreviewHeader">
      <div class="pi-filePreviewHeading">
        <strong title="${esc(preview.path)}">${esc(name)}</strong>
        <span title="${esc(preview.path)}">${esc(preview.path)}</span>
      </div>
      <div class="pi-filePreviewActions">
        <button type="button" class="pi-filePreviewIcon" data-action="file-preview-reveal" title="在系统文件管理器中定位" aria-label="在系统文件管理器中定位">${ICONS.folderOpen}</button>
        <button type="button" class="pi-filePreviewIcon pi-filePreviewClose" data-action="file-preview-close" title="关闭预览" aria-label="关闭预览">×</button>
      </div>
    </header>
    <div class="pi-filePreviewMeta">${esc(metadata)}${!preview.loading && !preview.error && !preview.highlighted ? " · 纯文本模式" : ""}</div>
    <div class="pi-filePreviewBody">${body}</div>
  </section>`;
}

function scrollFilePreviewToLine() {
  const preview = S.filePreview;
  const scroll = $(".pi-filePreviewScroll");
  if (!preview || !scroll || !preview.line) return;
  const lineTop = (Math.max(1, Number(preview.line)) - 1) * 21 + 12;
  scroll.scrollTop = Math.max(0, lineTop - scroll.clientHeight / 3);
}

async function openFilePreview(path, line, href) {
  const requestedLine = Number(line);
  const normalizedLine = Number.isFinite(requestedLine) && requestedLine > 0 ? Math.max(1, requestedLine) : null;
  if (S.filePreview?.path === path && !S.filePreview.error) {
    S.filePreview = { ...S.filePreview, line: normalizedLine, href };
    applyFrameLayout();
    renderFilePreview();
    requestAnimationFrame(scrollFilePreviewToLine);
    return;
  }

  const generation = ++S.filePreviewGeneration;
  S.filePreview = { path, line: normalizedLine, href, name: fileNameFromPath(path), loading: true };
  applyFrameLayout();
  renderFilePreview();
  try {
    const data = await api(`/api/fs/view?path=${encodeURIComponent(path)}&format=json`);
    if (generation !== S.filePreviewGeneration) return;
    const activeLine = S.filePreview?.path === path ? S.filePreview.line : normalizedLine;
    S.filePreview = { ...data, path, line: activeLine, href, loading: false, error: null };
  } catch (error) {
    if (generation !== S.filePreviewGeneration) return;
    S.filePreview = { ...S.filePreview, loading: false, error: error.message || String(error) };
  }
  renderFilePreview();
  requestAnimationFrame(scrollFilePreviewToLine);
}

function closeFilePreview() {
  ++S.filePreviewGeneration;
  S.filePreview = null;
  renderFilePreview();
  applyFrameLayout();
}

function renderApp() {
  const root = $("#root");
  const { sidebarWidth, previewWidth } = currentPanelWidths();
  root.innerHTML = `
    <div class="pI_x6G_frame" ${S.filePreview ? "" : "data-details-collapsed"} data-sidebar-collapsed="${usesMobileSidebar() || S.sidebarCollapsed}" ${S.mobileSidebarOpen ? "data-mobile-sidebar-open" : ""} style="--pi-sidebar-width:${sidebarWidth}px;--pi-details-width:${previewWidth}px;grid-template-columns:${sidebarWidth}px minmax(0px,1fr) ${previewWidth}px">
      <div class="pI_x6G_sidebarCol"><div id="sidebarMount"></div></div>
      <button type="button" class="pi-mobileSidebarBackdrop" aria-label="关闭侧边栏" data-action="close-mobile-sidebar"></button>
      <div class="pI_x6G_centerCol"><div id="conversationMount" class="wSkVaW_root"></div></div>
      <div class="pI_x6G_detailsCol"><div id="filePreviewMount"></div></div>
      <div class="pI_x6G_overlayLayer" id="overlayMount"></div>
      <div class="pI_x6G_handle" data-side="sidebar" role="separator" aria-label="调整侧边栏宽度" aria-orientation="vertical" aria-valuemin="220" aria-valuemax="420" tabindex="0"></div>
      <div class="pI_x6G_handle" data-side="details" role="separator" aria-label="调整文件预览宽度" aria-orientation="vertical" aria-valuemin="320" aria-valuemax="960" tabindex="0"></div>
    </div>`;
  applyFrameLayout();
  renderSidebar();
  renderConversation();
  renderFilePreview();
  renderOverlay();
}

function renderSidebar() {
  const mount = $("#sidebarMount");
  if (!mount) return;
  const previousSearch = $("#sessionSearchInput");
  const searchWasFocused = document.activeElement === previousSearch;
  const searchSelectionStart = previousSearch?.selectionStart ?? null;
  const searchSelectionEnd = previousSearch?.selectionEnd ?? null;
  const expanded = usesMobileSidebar() || !S.sidebarCollapsed;
  const query = S.search.trim().toLowerCase();
  const searchOpen = Boolean(query) || S.searchOpen;
  const activeWs = currentWorkspace();
  const workspacesHtml = S.workspaces.map((ws) => {
    const isDragging = S.workspaceDragId === ws.id;
    const dragState = isDragging ? " YDXeBa_dragSource" : "";
    const dragAttrs = query ? "" : ` draggable="true" data-workspace-draggable="1" tabindex="0" aria-label="${esc(ws.title)}，可拖动排序"`;
    const dragHandle = query ? "" : `<span class="YDXeBa_dragHandle" aria-hidden="true">${ICONS.grip}</span>`;
    const blank = ws.id === activeWs?.id && !S.currentSessionId && !query
      ? `<div class="YDXeBa_sessionRow YDXeBa_selected" role="treeitem" aria-selected="true" data-new-session="1" data-workspace="${esc(ws.id)}"><span class="YDXeBa_slot"></span><span class="YDXeBa_title">新会话</span></div>`
      : "";
    const allSessions = sessionsByRecency(ws);
    const matchingSessions = allSessions.filter((s) => !query || `${s.title} ${s.id}`.toLowerCase().includes(query));
    const sessionListExpanded = S.expandedSessionLists.has(ws.id);
    const visibleSessions = query || sessionListExpanded
      ? matchingSessions
      : matchingSessions.slice(0, SESSION_PREVIEW_LIMIT);
    const rows = visibleSessions.map((s) => {
      const cls = ["YDXeBa_sessionRow"];
      if (S.currentSessionId === s.id) cls.push("YDXeBa_selected");
      if (s.waitingForUser || s.dialogCount) cls.push("YDXeBa_waiting");
      else if (s.streaming) cls.push("YDXeBa_running");
      else if (s.needsAttention && S.currentSessionId !== s.id) cls.push("YDXeBa_completed");
      return `<div class="${cls.join(" ")}" role="treeitem" aria-selected="${S.currentSessionId === s.id}" data-session="${esc(s.id)}">
        <span class="YDXeBa_slot"></span>
        <span class="YDXeBa_title">${esc(s.title)}</span>
        <span class="YDXeBa_time">${esc(timeLabel(s.updatedAt))}</span>
        ${s.dialogCount ? `<span class="YDXeBa_pending">等待输入</span>` : ""}
        <span class="YDXeBa_rowActions"><span class="_root_19372_1"><button type="button" class="YDXeBa_iconButton" data-action="session-menu" data-session="${esc(s.id)}" aria-label="会话操作">${ICONS.dots}</button></span></span>
      </div>`;
    }).join("");
    const hiddenSessionCount = Math.max(0, allSessions.length - SESSION_PREVIEW_LIMIT);
    const overflow = !query && hiddenSessionCount
      ? `<button type="button" class="qDHVXG_sessionOverflowButton" data-action="toggle-session-list" data-workspace="${esc(ws.id)}" aria-expanded="${sessionListExpanded}">
          <span>${sessionListExpanded ? `收起至最近 ${SESSION_PREVIEW_LIMIT} 个` : `展开其余 ${hiddenSessionCount} 个`}</span>
          <span class="pi-sessionOverflowChevron ${sessionListExpanded ? "pi-sessionOverflowChevronExpanded" : ""}" aria-hidden="true">${ICONS.chevron}</span>
        </button>`
      : "";
    const collapsed = !query && S.collapsed.has(ws.id);
    const contents = blank + rows + overflow;
    return `<div class="qDHVXG_groupSection" data-workspace-group="${esc(ws.id)}">
      <div class="YDXeBa_projectRow${dragState}" role="treeitem" aria-expanded="${!collapsed}" data-workspace="${esc(ws.id)}"${dragAttrs}>
        ${dragHandle}
        <span class="YDXeBa_slot YDXeBa_folder ${S.currentWorkspaceId === ws.id ? "YDXeBa_folderActive" : ""}">${ICONS.folder}</span>
        <span class="YDXeBa_slot YDXeBa_chevron"><svg width="14" height="14" class="YDXeBa_arrow ${collapsed ? "" : "YDXeBa_arrowOpen"}" viewBox="0 0 14 14" fill="none"><path d="M4.25 2.83V11.17C4.25 11.66 4.84 11.91 5.19 11.56L9.36 7.39C9.58 7.17 9.58 6.83 9.36 6.61L5.19 2.44C4.84 2.09 4.25 2.34 4.25 2.83Z" fill="currentColor"/></svg></span>
        <span class="YDXeBa_projectText"><span class="YDXeBa_title">${esc(ws.title)}</span></span>
        <span class="YDXeBa_rowActions">
          <span class="_root_19372_1"><button type="button" class="YDXeBa_iconButton" data-action="workspace-menu" data-workspace="${esc(ws.id)}" aria-label="工作区操作">${ICONS.dots}</button></span>
          <button type="button" class="YDXeBa_iconButton" data-action="new-session-in-workspace" data-workspace="${esc(ws.id)}" aria-label="新建会话">${ICONS.plus}</button>
        </span>
      </div>
      ${collapsed ? "" : contents || `<div class="YDXeBa_empty">${query ? "没有匹配的会话" : "暂无会话"}</div>`}
    </div>`;
  }).join("");
  const listHtml = workspacesHtml || `<div class="qDHVXG_searchWarning">没有工作区。点击 + 添加一个目录。</div>`;

  const shellHtml = expanded ? `
    <aside class="hHd-Xa_root hHd-Xa_quietBars" style="width:280px;">
      <div class="hHd-Xa_logoRow">
        <button class="hHd-Xa_brand hHd-Xa_wide" type="button" aria-label="Pi Web" data-action="brand">${ICONS.wordmark}</button>
        <button class="hHd-Xa_iconButton hHd-Xa_toggle" type="button" aria-label="收起侧边栏" data-action="collapse-sidebar">${ICONS.panel}</button>
      </div>
      <button type="button" class="hHd-Xa_newSession" aria-label="新建会话" data-action="new-session">${ICONS.plus}<span class="hHd-Xa_newSessionLabel hHd-Xa_wide">新会话</span></button>
      <div class="hHd-Xa_regionArea">
        <div class="qDHVXG_root">
          <div class="qDHVXG_sectionHeader">
            <span class="qDHVXG_sectionLabel qDHVXG_wide">工作区</span>
            <div class="qDHVXG_searchSlot ${searchOpen ? "qDHVXG_searchSlotExpanded" : ""}">
              <div class="qDHVXG_search ${searchOpen ? "qDHVXG_searchExpanded" : ""}">
                <button type="button" class="qDHVXG_searchButton" aria-label="搜索会话" data-action="focus-search">${ICONS.search}</button>
                <input class="qDHVXG_searchInput" id="sessionSearchInput" type="text" placeholder="搜索会话…">
              </div>
            </div>
            <div class="qDHVXG_headerActions"><span class="_root_19372_1"><button type="button" class="qDHVXG_iconButton qDHVXG_wide" aria-label="视图选项" data-action="view-options">${ICONS.dots}</button></span><button type="button" class="qDHVXG_iconButton" aria-label="添加工作区" data-action="add-workspace">${ICONS.plus}</button></div><span class="_root_19372_1"></span>
          </div>
          <div class="qDHVXG_listArea"><div class="qDHVXG_treeBody qDHVXG_wide"><div class="qDHVXG_list" id="sessionListMount" role="tree" aria-label="会话"></div><span class="qDHVXG_fade"></span></div></div>
        </div>
      </div>
      <div class="hHd-Xa_footArea">
        <div class="hHd-Xa_settingsArea">
          <button type="button" class="VOzbGW_trigger" aria-haspopup="menu" aria-expanded="false" data-action="settings">${ICONS.gear}<span class="UQsH_q_triggerLabel">设置</span></button>
        </div>
      </div>
    </aside>` : `
    <aside class="hHd-Xa_root hHd-Xa_collapsed hHd-Xa_quietBars hHd-Xa_railIn" style="width:56px;">
      <div class="hHd-Xa_logoRow">
        <button class="hHd-Xa_iconButton hHd-Xa_toggle" type="button" aria-label="展开侧边栏" title="展开侧边栏" data-action="collapse-sidebar"><span class="hHd-Xa_railFish">${ICONS.logo}</span>${ICONS.panel}</button>
      </div>
      <button type="button" class="hHd-Xa_newSession" aria-label="新建会话" title="新建会话" data-action="new-session">${ICONS.plus}</button>
      <div class="hHd-Xa_regionArea pi-sidebarRail">
        <div class="pi-sidebarRailWorkspaces">
          ${S.workspaces.map((ws) => `<button type="button" class="pi-sidebarRailButton ${ws.id === activeWs?.id ? "pi-sidebarRailButtonActive" : ""}" aria-label="${esc(ws.title)}" title="${esc(ws.title)}" data-action="select-workspace" data-workspace="${esc(ws.id)}">${ICONS.folder}</button>`).join("")}
          <button type="button" class="pi-sidebarRailButton" aria-label="添加工作区" title="添加工作区" data-action="add-workspace">${ICONS.plus}</button>
        </div>
      </div>
      <div class="hHd-Xa_footArea"><div class="hHd-Xa_settingsArea"><button type="button" class="VOzbGW_trigger VOzbGW_rail" aria-label="设置" title="设置" data-action="settings">${ICONS.gear}</button></div></div>
    </aside>`;
  // Keep the sidebar DOM stable: rebuild the shell only when it actually
  // changes, and the session list only when its rows change. This avoids the
  // startup flicker caused by repeated workspace broadcasts rebuilding the
  // whole sidebar.
  if (mount.dataset.shell !== shellHtml) {
    mount.innerHTML = shellHtml;
    mount.dataset.shell = shellHtml;
  }
  const listMount = $("#sessionListMount");
  if (listMount && listMount.dataset.list !== listHtml) {
    listMount.innerHTML = listHtml;
    listMount.dataset.list = listHtml;
  }
  const searchInput = $("#sessionSearchInput");
  if (searchInput && !searchInput.dataset.bound) {
    searchInput.value = S.search;
    searchInput.dataset.bound = "1";
    searchInput.addEventListener("compositionstart", () => {
      searchInput.dataset.composing = "1";
    });
    searchInput.addEventListener("compositionend", () => {
      delete searchInput.dataset.composing;
      S.search = searchInput.value;
      renderSidebar();
    });
    searchInput.addEventListener("input", () => {
      if (searchInput.dataset.composing) return;
      S.search = searchInput.value;
      renderSidebar();
    });
  }
  if (searchWasFocused) {
    searchInput?.focus({ preventScroll: true });
    if (searchSelectionStart != null && searchSelectionEnd != null) {
      searchInput.setSelectionRange(searchSelectionStart, searchSelectionEnd);
    }
  }
}

function renderWorkspacePicker() {
  const ws = currentWorkspace();
  return `<button type="button" class="pXSMma_workspace" aria-label="选择工作区" aria-haspopup="menu" data-action="hero-workspace">
    ${ICONS.folder}<span class="pXSMma_workspaceLabel">${esc(ws?.title || "选择工作区")}</span>
    <svg width="12" height="12" class="pXSMma_chevron" viewBox="0 0 14 14" fill="none"><path d="M11.85 5.5L11.42 5.92L8.7 8.65C8.44 8.91 8.22 9.13 8.01 9.3C7.8 9.47 7.56 9.62 7.25 9.67C7.08 9.69 6.92 9.69 6.75 9.67C6.44 9.62 6.2 9.47 5.99 9.3C5.78 9.13 5.56 8.91 5.3 8.65L2.58 5.92L2.15 5.5L3 4.65L3.42 5.08L6.15 7.8C6.43 8.08 6.6 8.25 6.74 8.36C6.87 8.47 6.92 8.48 6.94 8.48C6.98 8.49 7.02 8.49 7.06 8.48C7.08 8.48 7.13 8.47 7.26 8.36C7.4 8.25 7.57 8.08 7.85 7.8L10.58 5.08L11 4.65L11.85 5.5Z" fill="currentColor"/></svg>
  </button>`;
}

function renderHero() {
  const ws = currentWorkspace();
  return `
    <div class="wSkVaW_scrollBody" data-conversation-scroll="">
      <div class="wSkVaW_composerSeat" data-composer-seat="">
        <div class="wSkVaW_composerStack wSkVaW_composerHero">
          <svg class="wSkVaW_heroGlow" viewBox="0 0 1051 468" fill="none" aria-hidden="true">
            <defs><filter id="pi-empty-glow" x="0" y="0" width="1051" height="468" filterUnits="userSpaceOnUse"><feGaussianBlur stdDeviation="50"/></filter></defs>
            <g filter="url(#pi-empty-glow)"><ellipse cx="525.5" cy="234" rx="425.5" ry="134" fill="#6187D8" fill-opacity="0.08"></ellipse></g>
          </svg>
          <div class="pXSMma_root"><div class="pXSMma_stack">
            <div class="pXSMma_headline">
              <span class="pXSMma_fishHitbox">${ICONS.logo}</span>
              <span class="pXSMma_headlineText">和你的代码库对话</span>
              <span class="pXSMma_previewBadge">Web 预览版</span>
            </div>
            <div class="pXSMma_body"></div>
          </div></div>
          <div class="wSkVaW_heroWorkspaceRow">
            <div class="pXSMma_workspaceRow">${renderWorkspacePicker()}</div>
            <button type="button" class="cubgiG_seat" aria-haspopup="menu" aria-expanded="false" title="这个会话由 pi coding agent 驱动" data-action="pi-agent-chip">
              <svg width="16" height="16" class="cubgiG_seatIcon" viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="12" fill="var(--dsw-alias-brand-primary,#3964fe)"/><text x="25" y="34" text-anchor="middle" font-family="Georgia,serif" font-size="30" font-weight="700" fill="#fff">π</text></svg>
              Pi Agent
              <svg width="14" height="14" class="cubgiG_chevron" viewBox="0 0 14 14" fill="none"><path d="M11.85 5.5L11.42 5.92L8.7 8.65C8.44 8.91 8.22 9.13 8.01 9.3C7.8 9.47 7.56 9.62 7.25 9.67C7.08 9.69 6.92 9.69 6.75 9.67C6.44 9.62 6.2 9.47 5.99 9.3C5.78 9.13 5.56 8.91 5.3 8.65L2.58 5.92L2.15 5.5L3 4.65L3.42 5.08L6.15 7.8C6.43 8.08 6.6 8.25 6.74 8.36C6.87 8.47 6.92 8.48 6.94 8.48C6.98 8.49 7.02 8.49 7.06 8.48C7.08 8.48 7.13 8.47 7.26 8.36C7.4 8.25 7.57 8.08 7.85 7.8L10.58 5.08L11 4.65L11.85 5.5Z" fill="currentColor"/></svg>
            </button>
          </div>
          ${renderComposer(true)}
        </div>
      </div>
    </div>`;
}

function renderCommandMenu(snap = currentSnapshot()) {
  if (!S.commandMenuOpen || !slashCommandContext()) return "";
  const commands = commandSuggestions(snap);
  if (S.commandSelected >= commands.length) S.commandSelected = Math.max(0, commands.length - 1);
  const rows = commands.map((command, index) => `<button type="button" role="option" aria-selected="${index === S.commandSelected}" class="_3e4SsG_item ${index === S.commandSelected ? "_3e4SsG_active" : ""}" data-action="choose-command" data-command="${esc(command.name)}">
    <span class="_3e4SsG_itemIcon">/</span>
    <span class="_3e4SsG_itemName">${esc(command.name)}</span>
    <span class="_3e4SsG_itemDescription">${esc(command.description || commandSourceLabel(command.source))}</span>
    <span class="pi-commandSource">${esc(commandSourceLabel(command.source))}</span>
  </button>`).join("");
  const status = S.commandLoading && commands.length === 0
    ? `<div class="_3e4SsG_loading">正在加载命令…</div>`
    : commands.length === 0 ? `<div class="_3e4SsG_loading">没有匹配的命令</div>` : "";
  return `<div class="_3e4SsG_menu pi-commandMenu" role="listbox" aria-label="斜杠命令"><div class="_3e4SsG_viewport">${rows || status}</div></div>`;
}

function renderDraftAttachments(model) {
  if (!S.draftAttachments.length) return "";
  const items = S.draftAttachments.map((attachment, index) => `<div class="pi-attachmentItem">
    <img src="${esc(attachment.url)}" alt="附件图片 ${index + 1}">
    <span class="pi-attachmentMeta">${index + 1}</span>
    <button type="button" class="pi-attachmentRemove" data-action="remove-attachment" data-attachment-id="${esc(attachment.id)}" aria-label="移除第 ${index + 1} 张图片" title="移除图片">${ICONS.close}</button>
  </div>`).join("");
  const warning = modelSupportsImages(model) ? "" : `<span class="pi-attachmentWarning">当前模型不支持图片输入</span>`;
  return `<div class="pi-attachmentTray" aria-label="待发送图片">${items}${warning}</div>`;
}

function renderComposerBar(hero = false) {
  const snap = currentSnapshot();
  const state = snap.state || {};
  const model = state.model || null;
  const level = state.thinkingLevel || null;
  const streaming = Boolean(snap.session?.streaming);
  const waitingForDialog = Boolean(snap.dialogs?.length);
  const disabled = (!S.currentSessionId && !hero) || Boolean(S.loadingSession && !hero) || waitingForDialog;
  const inputPlaceholder = waitingForDialog ? "请先回答对话中的问题" : "给智能体发消息";
  const rawContextPct = snap.stats?.contextUsage?.percent;
  const hasContextPct = typeof rawContextPct === "number" && Number.isFinite(rawContextPct);
  const contextPct = hasContextPct ? Math.max(0, Math.min(100, rawContextPct)) : 0;
  const contextLabel = hasContextPct ? `上下文已用 ${Math.round(rawContextPct)}%` : "上下文占用待更新";
  return `
      <div class="uV2eYG_root ${hero ? "uV2eYG_hero" : ""}">
        <div class="uV2eYG_card" data-composer-card="true">
          ${renderCommandMenu(snap)}
          ${renderDraftAttachments(model)}
          <div class="uV2eYG_scroll" data-input-scroll="true"><div class="uV2eYG_grow">
            <div aria-hidden="true" class="uV2eYG_backdrop"></div>
            <textarea class="uV2eYG_input" id="composerInput" data-phase="plain" data-session-id="${esc(S.currentSessionId || "")}" placeholder="${inputPlaceholder}" rows="1" ${disabled ? "disabled" : ""}></textarea>
            <div aria-hidden="true" class="uV2eYG_mirror"></div>
          </div></div>
          <div class="uV2eYG_row">
            <div class="uV2eYG_tools">
              <button type="button" class="uV2eYG_add" aria-label="命令" title="命令" data-action="commands" ${disabled ? "disabled" : ""}>${ICONS.plus}</button>
              <button type="button" class="uV2eYG_add pi-imagePaste" aria-label="${S.localClient ? "粘贴剪贴板图片" : "选择图片"}" title="${modelSupportsImages(model) ? (S.localClient ? "粘贴剪贴板图片（Alt+V）" : "从手机选择图片") : "当前模型不支持图片输入"}" data-action="paste-image" ${disabled || S.clipboardBusy || !modelSupportsImages(model) ? "disabled" : ""}>${ICONS.image}</button>
            </div>
            <div class="uV2eYG_trailing">
              <div class="_7KE1Ra_root pi-modelControl">
                <button type="button" class="_7KE1Ra_trigger" aria-haspopup="menu" aria-expanded="false" title="选择模型" data-action="model-menu" ${disabled ? "disabled" : ""}>
                  <span class="_7KE1Ra_triggerLabel">${esc(modelLabel(model))}</span>
                  <svg width="14" height="14" class="_7KE1Ra_chevron" viewBox="0 0 14 14" fill="none"><path d="M11.85 5.5L11.42 5.92L8.7 8.65C8.44 8.91 8.22 9.13 8.01 9.3C7.8 9.47 7.56 9.62 7.25 9.67C7.08 9.69 6.92 9.69 6.75 9.67C6.44 9.62 6.2 9.47 5.99 9.3C5.78 9.13 5.56 8.91 5.3 8.65L2.58 5.92L2.15 5.5L3 4.65L3.42 5.08L6.15 7.8C6.43 8.08 6.6 8.25 6.74 8.36C6.87 8.47 6.92 8.48 6.94 8.48C6.98 8.49 7.02 8.49 7.06 8.48C7.08 8.48 7.13 8.47 7.26 8.36C7.4 8.25 7.57 8.08 7.85 7.8L10.58 5.08L11 4.65L11.85 5.5Z" fill="currentColor"/></svg>
                </button>
              </div>
              <div class="_7KE1Ra_root pi-thinkingControl">
                <button type="button" class="_7KE1Ra_trigger pi-thinkingTrigger" aria-haspopup="menu" aria-expanded="false" title="选择思考强度" data-action="thinking-menu" ${disabled ? "disabled" : ""}>
                  <span class="pi-thinkingIcon">${ICONS.think}</span>
                  <span class="_7KE1Ra_triggerLabel">${esc(thinkingLabel(level || "off"))}</span>
                  <svg width="14" height="14" class="_7KE1Ra_chevron" viewBox="0 0 14 14" fill="none"><path d="M11.85 5.5L11.42 5.92L8.7 8.65C8.44 8.91 8.22 9.13 8.01 9.3C7.8 9.47 7.56 9.62 7.25 9.67C7.08 9.69 6.92 9.69 6.75 9.67C6.44 9.62 6.2 9.47 5.99 9.3C5.78 9.13 5.56 8.91 5.3 8.65L2.58 5.92L2.15 5.5L3 4.65L3.42 5.08L6.15 7.8C6.43 8.08 6.6 8.25 6.74 8.36C6.87 8.47 6.92 8.48 6.94 8.48C6.98 8.49 7.02 8.49 7.06 8.48C7.08 8.48 7.13 8.47 7.26 8.36C7.4 8.25 7.57 8.08 7.85 7.8L10.58 5.08L11 4.65L11.85 5.5Z" fill="currentColor"/></svg>
                </button>
              </div>
              ${hero ? "" : `<span class="JObwrW_root"><button type="button" class="JObwrW_trigger" aria-label="${contextLabel}" title="${contextLabel}" data-action="context-info"><svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><circle class="JObwrW_track" cx="7" cy="7" r="5.5"></circle><circle class="JObwrW_fill" cx="7" cy="7" r="5.5" stroke-dasharray="${(contextPct * 34.56 / 100).toFixed(2)} 34.56" transform="rotate(-90 7 7)"></circle></svg></button></span>`}
              <span class="pi-composerActions">
                ${streaming ? `<button type="button" class="pi-abortButton" aria-label="停止生成" title="停止生成" data-action="abort">${ICONS.stop}</button>` : ""}
                <button type="button" class="uV2eYG_primary" aria-label="${streaming ? "插入消息" : "发送消息"}" title="${streaming ? "插入消息" : "发送消息"}" data-action="send" ${disabled ? "disabled" : ""}>${ICONS.send}</button>
              </span>
            </div>
          </div>
        </div>
      </div>`;
}

function renderComposer(hero = false) {
  const bar = renderComposerBar(hero);
  if (hero) return bar;
  const snap = currentSnapshot();
  return `<div class="wSkVaW_composerStack">${bar}${renderStats(snap)}</div>`;
}

function extensionStatusClass(text) {
  const value = String(text || "").toLowerCase();
  if (/^(✓|✔)|\b(done|ready|complete|success)\b/.test(value)) return "FJxK0a_extensionStatus FJxK0a_statusSuccess";
  if (/^(⚠|!)|\b(warn|waiting|pending)\b/.test(value)) return "FJxK0a_extensionStatus FJxK0a_statusWarning";
  if (/^(✗|×)|\b(error|failed|failure)\b/.test(value)) return "FJxK0a_extensionStatus FJxK0a_statusError";
  return "FJxK0a_extensionStatus";
}

function renderStats(snap) {
  const stats = snap.stats || {};
  const tokens = stats.tokens || {};
  const cu = stats.contextUsage || {};
  const parts = [];
  const add = (text, className = "") => {
    if (text !== "" && text != null) parts.push({ text: String(text), className });
  };
  if (cu.tokens != null) add(`上下文 ${fmtNum(cu.tokens)}/${fmtNum(cu.contextWindow ?? 0)} (${Math.round(cu.percent ?? 0)}%)`, "FJxK0a_context");
  const pendingMessages = Number(snap.state?.pendingMessageCount ?? 0);
  if (pendingMessages > 0) add(`待处理 ${pendingMessages}`, "FJxK0a_statusWarning");
  if (tokens.input != null || tokens.output != null) add(`输入 ${fmtNum(tokens.input ?? 0)} · 输出 ${fmtNum(tokens.output ?? 0)} tok`);
  const cacheParts = [];
  if (Number(tokens.cacheRead) > 0) cacheParts.push(`缓存读 ${fmtNum(tokens.cacheRead)}`);
  if (Number(tokens.cacheWrite) > 0) cacheParts.push(`写 ${fmtNum(tokens.cacheWrite)}`);
  if (cacheParts.length) add(cacheParts.join(" · "));
  if (typeof stats.cost === "number") add(formatCost(stats.cost));
  for (const [, text] of Object.entries(snap.extensionStatuses || {}).sort(([a], [b]) => a.localeCompare(b))) {
    add(text, extensionStatusClass(text));
  }
  if (!parts.length) return "";
  return `<div class="FJxK0a_root" role="status">${parts.map((part) => `<span class="${part.className}" title="${esc(part.text)}">${esc(part.text)}</span>`).join('<span class="FJxK0a_sep" aria-hidden="true">|</span>')}</div>`;
}

function formatCost(cost) {
  if (cost > 0 && cost < 0.000001) return "<$0.000001";
  return `$${cost.toFixed(cost > 0 && cost < 0.001 ? 6 : 3)}`;
}

function fmtNum(n) {
  if (!Number.isFinite(Number(n))) return String(n ?? 0);
  const v = Number(n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

function renderHeader() {
  const snap = currentSnapshot();
  const session = snap.session || {};
  const historyActive = S.conversationTab === "history";
  return `<header class="wSkVaW_header">
    <button type="button" class="pi-mobileSidebarButton" aria-label="打开侧边栏" data-action="open-mobile-sidebar">${ICONS.panel}</button>
    <div class="wSkVaW_titleRow"><div class="wSkVaW_titleCluster">
      <nav class="wSkVaW_crumbs" aria-label="会话层级"><span class="wSkVaW_crumbSeg"><button type="button" class="wSkVaW_crumb wSkVaW_crumbCurrent" disabled>${esc(session.title || "新会话")}</button></span></nav>
    </div></div>
    <div class="wSkVaW_tabs" role="tablist">
      <button type="button" role="tab" aria-selected="${!historyActive}" class="wSkVaW_tab ${historyActive ? "" : "wSkVaW_tabActive"}" data-action="conversation-tab">对话</button>
      <button type="button" role="tab" aria-selected="${historyActive}" class="wSkVaW_tab ${historyActive ? "wSkVaW_tabActive" : ""}" data-action="history-current">会话历史</button>
    </div>
  </header>`;
}

function flowRevision(value) {
  const text = JSON.stringify(value) || "";
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

function queueItemBusyKey(sessionId, kind, index, message) {
  return `${sessionId}:${kind}:${index}:${flowRevision(message)}`;
}

function pendingQueueEntries(snap = currentSnapshot()) {
  const queue = snap.pendingQueue || {};
  return [
    ...(Array.isArray(queue.steering) ? queue.steering : []).map((message, index) => ({ kind: "steering", index, message })),
    ...(Array.isArray(queue.followUp) ? queue.followUp : []).map((message, index) => ({ kind: "followUp", index, message })),
  ];
}

function renderPendingQueueMessage(entry, busy) {
  const label = entry.kind === "steering" ? "待插入" : "待后续处理";
  return `<div class="Md3f7G_flowItem" data-chat-flow-kind="queued-user">
    <div class="gdEzaW_userRow pi-queuedMessageRow"><div class="gdEzaW_userStack pi-queuedMessageStack">
      <div class="gdEzaW_bubble pi-queuedMessageBubble"><div class="_text_1pfhk_1 pi-queuedMessageText">${esc(entry.message)}</div></div>
      <div class="pi-queuedMessageMeta">
        <span class="pi-queuedMessageLabel">${label}</span>
        <button type="button" class="pi-queuedMessageWithdraw" data-action="withdraw-queued-message" data-queue-kind="${entry.kind}" data-queue-index="${entry.index}" aria-label="撤回并重新编辑这条消息" title="撤回并重新编辑" ${busy ? "disabled data-loading=true" : ""}>${ICONS.close}</button>
      </div>
    </div></div>
  </div>`;
}

function messageFlowParts() {
  const snap = currentSnapshot();
  const messages = snap.messages || [];
  const dialog = snap.dialogs?.[0];
  const streaming = Boolean(snap.session?.streaming);
  const waitingForUser = Boolean(snap.session?.waitingForUser || snap.dialogs?.length);
  const loading = S.loadingSession === S.currentSessionId;
  const connecting = loading || ((S.pendingSends.get(S.currentSessionId) || 0) > 0 && !streaming);
  let conversationNumber = 0;
  const parts = messages.map((message, index) => {
    const key = `message:${index}`;
    const revision = flowRevision(message);
    const anchor = message.kind === "user"
      ? ` data-conversation-anchor="${++conversationNumber}"`
      : "";
    return {
      key,
      revision,
      render: () => `<div class="pi-messageGroup" data-flow-key="${key}" data-flow-revision="${revision}"${anchor}>${renderMessage(message, index)}</div>`,
    };
  });
  for (const entry of pendingQueueEntries(snap)) {
    const busyKey = queueItemBusyKey(S.currentSessionId, entry.kind, entry.index, entry.message);
    const busy = S.dequeueSessions.has(S.currentSessionId) || S.withdrawingQueueItems.has(busyKey);
    const key = `queue:${entry.kind}:${entry.index}:${flowRevision(entry.message)}`;
    const revision = flowRevision({ ...entry, busy });
    parts.push({
      key,
      revision,
      render: () => `<div class="pi-messageGroup pi-queuedMessageGroup" data-flow-key="${key}" data-flow-revision="${revision}">${renderPendingQueueMessage(entry, busy)}</div>`,
    });
  }
  if (parts.length === 0) {
    parts.push({
      key: "status:empty",
      revision: "empty",
      render: () => `<div class="Md3f7G_flowItem" data-flow-key="status:empty" data-flow-revision="empty"><div class="osXY9a_root"></div></div>`,
    });
  }
  if (dialog) {
    const key = `dialog:${dialog.id}`;
    const revision = flowRevision(dialog);
    parts.push({
      key,
      revision,
      render: () => `<div class="Md3f7G_flowItem pi-dialogFlowItem" data-flow-key="${esc(key)}" data-flow-revision="${revision}">${renderDialogCard(dialog)}</div>`,
    });
  } else if (waitingForUser) {
    parts.push({
      key: "status:waiting",
      revision: "waiting",
      render: () => `<div class="Md3f7G_flowItem" data-flow-key="status:waiting" data-flow-revision="waiting"><div class="gdEzaW_retryRow"><span class="gdEzaW_retryText">等待你的输入…</span></div></div>`,
    });
  } else if (streaming) {
    parts.push({
      key: "status:streaming",
      revision: "streaming",
      render: () => `<div class="Md3f7G_flowItem" data-flow-key="status:streaming" data-flow-revision="streaming"><div class="gdEzaW_retryRow"><span class="gdEzaW_retryText">正在生成…</span></div></div>`,
    });
  }
  if (connecting) {
    const text = loading ? "正在加载会话…" : "正在启动 Pi…";
    parts.push({
      key: "status:connecting",
      revision: text,
      render: () => `<div class="Md3f7G_flowItem" data-flow-key="status:connecting" data-flow-revision="${text}"><div class="gdEzaW_retryRow"><span class="gdEzaW_retryText">${text}</span></div></div>`,
    });
  }
  return parts;
}

function renderMessageFlow() {
  const flow = messageFlowParts().map((part) => part.render()).join("");
  return `<div class="Md3f7G_root"><div class="Md3f7G_scroll"><div class="Md3f7G_column" data-chat-flow="">${flow}</div></div></div>`;
}

function conversationTurns() {
  return (currentSnapshot().messages || [])
    .map((message, messageIndex) => ({ message, messageIndex }))
    .filter(({ message }) => message.kind === "user")
    .map(({ message, messageIndex }, index) => ({
      number: index + 1,
      key: `message:${messageIndex}`,
      text: String(message.text || "").trim() || "（空消息）",
      timestamp: message.timestamp,
    }));
}

function conversationPreviewText(text, limit = 600) {
  const value = String(text || "");
  if (value.length <= limit) return value;
  return `${value.slice(0, limit).trimEnd()}…`;
}

function renderConversationNavigator() {
  const turns = conversationTurns();
  if (turns.length < 2) return "";
  const revision = flowRevision(turns.map(({ key, text, timestamp }) => ({ key, text, timestamp })));
  const markers = turns.map((turn, index) => {
    const fallbackPosition = turns.length === 1 ? 50 : (index / (turns.length - 1)) * 100;
    const time = clockLabel(turn.timestamp);
    const preview = conversationPreviewText(turn.text);
    const label = `跳到第 ${turn.number} 次对话：${preview.replace(/\s+/g, " ").slice(0, 80)}`;
    return `<button type="button" class="pi-turnNavMarker" data-action="jump-conversation" data-turn-target="${esc(turn.key)}" data-turn-number="${turn.number}" style="--turn-position:${fallbackPosition.toFixed(3)}%" aria-label="${esc(label)}">
      <span class="pi-turnNavLine" aria-hidden="true"></span>
      <span class="pi-turnTooltip" role="tooltip">
        <span class="pi-turnTooltipMeta"><strong>第 ${turn.number} 次对话</strong>${time ? `<span>${esc(time)}</span>` : ""}</span>
        <span class="pi-turnTooltipText">${esc(preview)}</span>
      </span>
    </button>`;
  }).join("");
  return `<nav class="pi-turnNav" data-conversation-nav="" data-turn-nav-revision="${revision}" aria-label="用户对话导航">
    <div class="pi-turnNavTrack">${markers}</div>
  </nav>`;
}

function renderScrollToBottomButton() {
  return `<button type="button" class="pi-scrollBottom" data-action="scroll-bottom" data-scroll-bottom="" aria-label="回到对话底部" title="回到对话底部">${ICONS.down}</button>`;
}

function reconcileMessageFlow(activeView) {
  const currentColumn = $("[data-chat-flow]", activeView);
  if (!currentColumn) {
    activeView.replaceChildren(el(renderMessageFlow()));
    return;
  }
  const existingByKey = new Map(
    [...currentColumn.children].map((node) => [node.dataset.flowKey, node]),
  );
  const retained = new Set();
  let cursor = currentColumn.firstElementChild;
  for (const part of messageFlowParts()) {
    const existing = existingByKey.get(part.key);
    const node = existing?.dataset.flowRevision === part.revision ? existing : el(part.render());
    retained.add(node);
    if (node === cursor) cursor = cursor.nextElementSibling;
    else currentColumn.insertBefore(node, cursor);
  }
  for (const node of [...currentColumn.children]) {
    if (!retained.has(node)) node.remove();
  }
}

function reconcileConversationNavigator(stage) {
  const current = $("[data-conversation-nav]", stage);
  const html = renderConversationNavigator();
  if (!html) {
    current?.remove();
    return;
  }
  const next = el(html);
  if (current?.dataset.turnNavRevision === next.dataset.turnNavRevision) return;
  if (current) current.replaceWith(next);
  else stage.append(next);
}

let conversationNavFrame = 0;
let conversationNavScroll = null;
let conversationNavObserver = null;

function conversationTargetTop(scroll, target) {
  const scrollRect = scroll.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  return targetRect.top - scrollRect.top + scroll.scrollTop;
}

function updateConversationNavigator() {
  const scroll = $("[data-conversation-scroll]");
  if (!scroll) return;
  const bottomButton = $("[data-scroll-bottom]");
  const distanceFromBottom = Math.max(0, scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop);
  bottomButton?.toggleAttribute("data-visible", distanceFromBottom > 120);
  const nav = $("[data-conversation-nav]");
  if (!nav) return;
  const markers = $$(".pi-turnNavMarker", nav);
  const groupsByKey = new Map(
    $$('[data-conversation-anchor]', scroll).map((node) => [node.dataset.flowKey, node]),
  );
  const contentHeight = Math.max(1, scroll.scrollHeight);
  const activationLine = scroll.scrollTop + Math.min(scroll.clientHeight * 0.32, 200);
  let activeMarker = markers[0] || null;

  for (const marker of markers) {
    const group = groupsByKey.get(marker.dataset.turnTarget);
    const target = group?.querySelector('[data-chat-flow-kind="user"]');
    if (!target) continue;
    const top = conversationTargetTop(scroll, target);
    const position = Math.min(0.985, Math.max(0.015, top / contentHeight));
    marker.style.setProperty("--turn-position", `${(position * 100).toFixed(3)}%`);
    if (position < 0.13) marker.dataset.tooltipEdge = "top";
    else if (position > 0.87) marker.dataset.tooltipEdge = "bottom";
    else delete marker.dataset.tooltipEdge;
    if (top <= activationLine) activeMarker = marker;
  }

  for (const marker of markers) {
    const active = marker === activeMarker;
    marker.classList.toggle("pi-turnNavMarkerActive", active);
    if (active) marker.setAttribute("aria-current", "step");
    else marker.removeAttribute("aria-current");
  }
}

function scheduleConversationNavigatorLayout() {
  if (conversationNavFrame) return;
  conversationNavFrame = requestAnimationFrame(() => {
    conversationNavFrame = 0;
    updateConversationNavigator();
  });
}

function bindConversationNavigator() {
  const scroll = $("[data-conversation-scroll]");
  const nav = $("[data-conversation-nav]");
  const bottomButton = $("[data-scroll-bottom]");
  const nextScroll = nav || bottomButton ? scroll : null;
  if (conversationNavScroll !== nextScroll) {
    conversationNavScroll?.removeEventListener("scroll", scheduleConversationNavigatorLayout);
    conversationNavScroll = nextScroll;
    conversationNavScroll?.addEventListener("scroll", scheduleConversationNavigatorLayout, { passive: true });
  }
  conversationNavObserver?.disconnect();
  conversationNavObserver = null;
  if (!nextScroll) return;
  if (typeof ResizeObserver === "function") {
    conversationNavObserver = new ResizeObserver(scheduleConversationNavigatorLayout);
    conversationNavObserver.observe(scroll);
    const column = $("[data-chat-flow]", scroll);
    if (column) conversationNavObserver.observe(column);
  }
  scheduleConversationNavigatorLayout();
}

function scrollConversationToBottom() {
  const scroll = $("[data-conversation-scroll]");
  if (!scroll) return;
  scroll.scrollTo({
    top: scroll.scrollHeight,
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
  scheduleConversationNavigatorLayout();
}

function jumpToConversationTurn(key) {
  const scroll = $("[data-conversation-scroll]");
  const group = scroll && $$('[data-conversation-anchor]', scroll)
    .find((node) => node.dataset.flowKey === key);
  const target = group?.querySelector('[data-chat-flow-kind="user"]');
  if (!scroll || !target) return;
  const top = Math.max(0, conversationTargetTop(scroll, target) - 20);
  scroll.scrollTo({
    top,
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
  group.classList.remove("pi-turnTargetFlash");
  requestAnimationFrame(() => group.classList.add("pi-turnTargetFlash"));
  setTimeout(() => group.classList.remove("pi-turnTargetFlash"), 900);
}

function patchComposerState(activeComposer) {
  const nextComposer = el(renderComposer(false));
  const replaceSlot = (selector) => {
    const current = $(selector, activeComposer);
    const next = $(selector, nextComposer);
    if (current && next && !current.isEqualNode(next)) current.replaceWith(next);
    else if (current && !next) current.remove();
  };
  replaceSlot(".pi-modelControl");
  replaceSlot(".pi-thinkingControl");
  replaceSlot(".JObwrW_root");
  replaceSlot(".pi-composerActions");
  const commandButton = $('[data-action="commands"]', activeComposer);
  const nextCommandButton = $('[data-action="commands"]', nextComposer);
  if (commandButton && nextCommandButton) commandButton.disabled = nextCommandButton.disabled;
  const imageButton = $('[data-action="paste-image"]', activeComposer);
  const nextImageButton = $('[data-action="paste-image"]', nextComposer);
  if (imageButton && nextImageButton) {
    imageButton.disabled = nextImageButton.disabled;
    imageButton.title = nextImageButton.title;
  }
  const currentTray = $(".pi-attachmentTray", activeComposer);
  const nextTray = $(".pi-attachmentTray", nextComposer);
  if (currentTray && nextTray && !currentTray.isEqualNode(nextTray)) currentTray.replaceWith(nextTray);
  else if (currentTray && !nextTray) currentTray.remove();
  else if (!currentTray && nextTray) {
    const card = $("[data-composer-card]", activeComposer);
    const inputScroll = $("[data-input-scroll]", activeComposer);
    if (card && inputScroll) card.insertBefore(nextTray, inputScroll);
  }
  const currentInput = $("#composerInput", activeComposer);
  const nextInput = $("#composerInput", nextComposer);
  if (currentInput && nextInput) {
    currentInput.disabled = nextInput.disabled;
    currentInput.placeholder = nextInput.placeholder;
  }
  const currentStats = $(".FJxK0a_root", activeComposer);
  const nextStats = $(".FJxK0a_root", nextComposer);
  if (currentStats && nextStats && !currentStats.isEqualNode(nextStats)) currentStats.replaceWith(nextStats);
  else if (currentStats && !nextStats) currentStats.remove();
  else if (!currentStats && nextStats) $(".wSkVaW_composerStack", activeComposer)?.append(nextStats);
}

function renderActive() {
  if (S.conversationTab === "history") return renderHistoryView(S.historyView);
  return `
    <div class="wSkVaW_scrollBody">
      <div class="pi-conversationStage">
        <div class="wSkVaW_viewArea" data-conversation-scroll="">${renderMessageFlow()}</div>
        ${renderConversationNavigator()}
        ${renderScrollToBottomButton()}
      </div>
      <div class="wSkVaW_composerSeat" data-composer-seat="">${renderComposer(false)}</div>
    </div>`;
}

let conversationRenderGeneration = 0;
function renderConversation() {
  const renderGeneration = ++conversationRenderGeneration;
  const mount = $("#conversationMount");
  if (!mount) return;
  const previousInput = $("#composerInput");
  const previousSessionId = previousInput?.dataset.sessionId || "";
  const inputWasFocused = document.activeElement === previousInput;
  const selectionStart = previousInput?.selectionStart ?? null;
  const selectionEnd = previousInput?.selectionEnd ?? null;
  const previousScroll = $("[data-conversation-scroll]", mount);
  const distanceFromBottom = previousScroll
    ? Math.max(0, previousScroll.scrollHeight - previousScroll.clientHeight - previousScroll.scrollTop)
    : 0;
  const scrollState = previousScroll && previousSessionId === S.currentSessionId
    ? {
        top: previousScroll.scrollTop,
        distanceFromBottom,
        nearBottom: distanceFromBottom <= 96,
      }
    : null;
  const activeRoot = $('.wSkVaW_root[data-phase="active"]', mount);
  const activeHeader = activeRoot && $(".wSkVaW_header", activeRoot);
  const activeStage = activeRoot && $(".pi-conversationStage", activeRoot);
  const activeView = activeRoot && $(".wSkVaW_viewArea", activeRoot);
  const activeComposer = activeRoot && $("[data-composer-seat]", activeRoot);
  const canPatchActive = Boolean(
    S.currentSessionId
      && S.conversationTab === "conversation"
      && previousSessionId === S.currentSessionId
      && activeHeader
      && activeStage
      && activeView
      && activeComposer,
  );

  let patchedActive = false;
  if (!S.currentSessionId) {
    mount.innerHTML = `<div class="wSkVaW_root" data-phase="hero">${renderHeaderPlaceholder()}${renderHero()}</div>`;
  } else if (canPatchActive) {
    const nextHeader = el(renderHeader());
    if (!activeHeader.isEqualNode(nextHeader)) activeHeader.replaceWith(nextHeader);
    reconcileMessageFlow(activeView);
    reconcileConversationNavigator(activeStage);
    patchComposerState(activeComposer);
    patchedActive = true;
  } else {
    mount.innerHTML = `<div class="wSkVaW_root" data-phase="active">${renderHeader()}${renderActive()}</div>`;
  }
  if (!patchedActive) {
    const nextInput = $("#composerInput");
    if (previousInput && nextInput && previousInput.dataset.sessionId === nextInput.dataset.sessionId) {
      nextInput.replaceWith(previousInput);
    }
    restoreDraft();
    bindComposerInput();
    if (inputWasFocused) {
      const input = $("#composerInput");
      input?.focus({ preventScroll: true });
      if (input && selectionStart != null && selectionEnd != null) {
        input.setSelectionRange(selectionStart, selectionEnd);
      }
    }
  }
  bindConversationNavigator();
  const renderedSessionId = S.currentSessionId;
  const restoreScroll = () => {
    const scroll = $("[data-conversation-scroll]", mount);
    if (!scroll || S.currentSessionId !== renderedSessionId || renderGeneration !== conversationRenderGeneration) return;
    const maxScrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    if (!scrollState) {
      scroll.scrollTop = maxScrollTop;
    } else {
      scroll.scrollTop = scrollState.nearBottom
        ? Math.max(0, maxScrollTop - scrollState.distanceFromBottom)
        : Math.min(scrollState.top, maxScrollTop);
    }
    scheduleConversationNavigatorLayout();
  };
  if (scrollState || (S.currentSessionId && S.conversationTab === "conversation")) {
    restoreScroll();
    requestAnimationFrame(restoreScroll);
  }
}

function renderHeaderPlaceholder() {
  return `<header class="wSkVaW_header wSkVaW_headerHidden" aria-hidden="true"></header>`;
}

function renderLoading() {
  return `<div class="wSkVaW_scrollBody"><div class="wSkVaW_composerSeat"><div class="wSkVaW_composerStack wSkVaW_composerHero"><div class="pXSMma_root"><div class="pXSMma_stack"><div class="pXSMma_headline"><span class="pXSMma_fishHitbox">${ICONS.logo}</span><span class="pXSMma_headlineText">正在启动 pi…</span></div></div></div></div></div></div>`;
}

function compactionReasonLabel(reason) {
  return { manual: "手动触发", threshold: "达到上下文阈值", overflow: "上下文溢出恢复" }[reason] || "上下文维护";
}

function compactionPreview(text) {
  return String(text || "")
    .replace(/<\/?(?:read|modified)-files>/gi, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+(?:\[[ xX]\]\s*)?/gm, "")
    .replace(/[*_`]/g, "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(" · ")
    .slice(0, 180);
}

function compactionUsageSummary(usage) {
  if (!usage || typeof usage !== "object") return null;
  const totalTokens = Number.isFinite(usage.totalTokens)
    ? usage.totalTokens
    : [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
      .filter(Number.isFinite)
      .reduce((total, value) => total + value, 0);
  const rawCost = typeof usage.cost === "number" ? usage.cost : usage.cost?.total;
  const cost = Number.isFinite(rawCost) ? rawCost : null;
  if (!totalTokens && cost == null) return null;
  return {
    totalTokens,
    cost,
    text: [`摘要用量 ${fmtNum(totalTokens)} tok`, cost == null ? "" : `$${cost.toFixed(4)}`].filter(Boolean).join(" · "),
  };
}

function renderCompactionMessage(msg) {
  const status = msg.status || "complete";
  const compactionKey = `compaction:${msg.id || msg.timestamp || msg.tokensBefore || "context"}`;
  const detailText = status === "complete" ? msg.text || "" : msg.errorMessage || "";
  const expandable = status !== "running" && detailText !== "";
  const expanded = expandable && S.expandedCompactions.has(compactionKey);
  const reason = compactionReasonLabel(msg.reason);
  const title = status === "running"
    ? "正在压缩上下文"
    : status === "complete"
      ? "上下文已压缩"
      : status === "aborted" ? "上下文压缩已取消" : "上下文压缩失败";
  const metrics = [];
  const usage = compactionUsageSummary(msg.usage);
  if (status === "running") {
    metrics.push(reason, "正在生成会话摘要，请稍候");
  } else if (status === "complete") {
    if (Number.isFinite(msg.tokensBefore) && Number.isFinite(msg.estimatedTokensAfter)) {
      metrics.push(`${fmtNum(msg.tokensBefore)} → 约 ${fmtNum(msg.estimatedTokensAfter)} tok`);
    } else if (Number.isFinite(msg.tokensBefore)) {
      metrics.push(`压缩前 ${fmtNum(msg.tokensBefore)} tok`);
    }
    metrics.push(reason);
    if (usage) metrics.push(usage.text);
    if (msg.willRetry) metrics.push("压缩后自动重试");
    const preview = compactionPreview(msg.text);
    if (preview) metrics.push(preview);
  } else {
    metrics.push(reason, msg.errorMessage || "未返回错误详情");
    if (msg.willRetry) metrics.push("原请求仍会重试");
  }
  const meta = [];
  if (Number.isFinite(msg.tokensBefore)) meta.push(`<span>压缩前 <strong>${esc(fmtNum(msg.tokensBefore))}</strong> tok</span>`);
  if (Number.isFinite(msg.estimatedTokensAfter)) meta.push(`<span>压缩后约 <strong>${esc(fmtNum(msg.estimatedTokensAfter))}</strong> tok</span>`);
  if (usage) meta.push(`<span>摘要实际消耗 <strong>${esc(fmtNum(usage.totalTokens))}</strong> tok${usage.cost == null ? "" : ` · $${esc(usage.cost.toFixed(4))}`}</span>`);
  if (msg.reason) meta.push(`<span>${esc(reason)}</span>`);
  const detail = expandable ? `<div class="gdEzaW_compactionBody pi-compactionBody" ${expanded ? "" : "hidden"}>
    ${meta.length ? `<div class="pi-compactionMeta">${meta.join("")}</div>` : ""}
    ${status === "complete"
      ? `<div class="pi-compactionBodyTitle">会话摘要</div><div class="pi-compactionMarkdown _markdown_1nba0_5">${markdown(detailText)}</div>`
      : `<div class="pi-compactionErrorDetail">${esc(detailText)}</div>`}
  </div>` : "";
  return `<div class="Md3f7G_flowItem" data-chat-flow-kind="compaction">
    <div class="gdEzaW_compactionRow pi-compactionCard" data-state="${esc(status)}" data-compaction-key="${esc(compactionKey)}" role="status" aria-live="polite">
      <button type="button" class="gdEzaW_compactionButton" ${expandable ? `data-action="toggle-compaction" aria-expanded="${expanded}"` : "disabled"}>
        <span class="gdEzaW_compactionLeading">
          <span class="gdEzaW_compactionContextIcon">${ICONS.compact}</span>
          <span class="gdEzaW_compactionDisclosureIcon">${ICONS.chevron}</span>
        </span>
        <span class="gdEzaW_compactionTitle">${esc(title)}</span>
        <span class="gdEzaW_compactionSep"></span>
        <span class="gdEzaW_compactionSummary">${esc(metrics.filter(Boolean).join(" · "))}</span>
        ${status === "complete" ? `<span class="pi-compactionBadge">已完成</span>` : ""}
      </button>
      ${detail}
    </div>
  </div>`;
}

function renderAssistantError(msg) {
  const message = msg.errorMessage || "模型调用失败，但 Pi 未返回错误详情";
  const source = [msg.provider, msg.model].filter(Boolean).join(" / ");
  return `<div class="Md3f7G_flowItem" data-chat-flow-kind="assistant-error">
    <div class="pi-assistantError" role="alert" aria-live="assertive">
      <span class="pi-assistantErrorIcon" aria-hidden="true">!</span>
      <div class="pi-assistantErrorCopy">
        <div class="pi-assistantErrorTitle">生成失败</div>
        <div class="pi-assistantErrorMessage">${esc(message)}</div>
        ${source ? `<div class="pi-assistantErrorMeta">${esc(source)}</div>` : ""}
      </div>
    </div>
  </div>`;
}

function assistantMessageText(msg) {
  return (msg?.blocks || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text || "")
    .join("\n")
    .trim();
}

function renderMessage(msg, messageIndex) {
  if (msg.kind === "compaction") return renderCompactionMessage(msg);
  if (msg.kind === "user") {
    return `<div class="Md3f7G_flowItem" data-chat-flow-kind="user">
      <div class="gdEzaW_userRow" data-time-hover-root="true"><div class="gdEzaW_userStack">
        <div class="gdEzaW_bubble"><div class="_text_1pfhk_1">${esc(msg.text || "")}</div></div>
      </div>
      <div class="p-xYUq_actions"><span class="p-xYUq_timeStart">${esc(clockLabel(msg.timestamp))}</span><button type="button" class="p-xYUq_action" aria-label="复制" data-action="copy-text" data-text="${esc(msg.text || "")}">${ICONS.copy}</button></div>
      </div>
    </div>`;
  }
  if (msg.kind === "assistant") {
    const blocks = msg.blocks || [];
    const content = blocks.map((b, i) => renderBlock(b, msg, i)).join("");
    const error = msg.isError || msg.stopReason === "error" || msg.errorMessage
      ? renderAssistantError(msg)
      : "";
    const copyText = assistantMessageText(msg);
    const hasToolCall = blocks.some((block) => block.type === "toolCall");
    const actions = copyText && !hasToolCall && !msg.streaming
      ? `<div class="Md3f7G_flowItem pi-assistantMessageActions" data-chat-flow-kind="assistant-actions"><button type="button" class="p-xYUq_action pi-assistantCopyButton" aria-label="复制本条 AI 回复" title="复制本条 AI 回复" data-action="copy-assistant-message" data-message-index="${messageIndex}">${ICONS.copy}</button></div>`
      : "";
    return `<div class="pi-assistantMessageGroup">${content}${error}${actions}</div>`;
  }
  if (msg.kind === "toolResult") {
    const output = msg.text || "";
    const lineCount = output ? output.split("\n").length : 0;
    const hasDetail = output !== "";
    const toolKey = `result:${msg.toolCallId || msg.timestamp || msg.toolName || "tool"}`;
    const expanded = hasDetail && S.expandedTools.has(toolKey);
    return `<div class="Md3f7G_flowItem" data-chat-flow-kind="tool-result"><div class="ztWv_q_callRow" data-tool-key="${esc(toolKey)}"><div class="CY-8Ka_card">
      <div class="CY-8Ka_root" data-state="${msg.isError ? "error" : "ok"}" ${hasDetail ? `role="button" data-expandable aria-expanded="${expanded}" data-action="toggle-tool"` : ""}>
        <span class="CY-8Ka_leading">${ICONS.bash}</span><span class="CY-8Ka_title">${esc(msg.toolName || "Tool")}</span><span class="CY-8Ka_sep"></span>
        <span class="CY-8Ka_summary ${msg.isError ? "CY-8Ka_errorSummary" : ""}">${msg.isError ? "失败" : "完成"}${lineCount ? ` · ${lineCount} 行输出` : ""}</span>
      </div>
      ${hasDetail ? `<div class="Sxvs8a_root" ${expanded ? "" : "hidden"}><div class="Sxvs8a_body"><pre class="Y0dWHa_payload ${msg.isError ? "Y0dWHa_payloadError" : ""}">${esc(output)}</pre></div></div>` : ""}
    </div></div></div>`;
  }
  if (msg.kind === "bashExecution") {
    const output = msg.output || "";
    const lineCount = output ? output.split("\n").length : 0;
    const hasDetail = output !== "";
    const toolKey = `bash:${msg.timestamp || msg.command || "command"}`;
    const expanded = hasDetail && S.expandedTools.has(toolKey);
    return `<div class="Md3f7G_flowItem" data-chat-flow-kind="bash"><div class="ztWv_q_callRow" data-tool-key="${esc(toolKey)}"><div class="CY-8Ka_card"><div class="CY-8Ka_root" data-sample="bash" data-variant="bash" ${hasDetail ? `role="button" data-expandable aria-expanded="${expanded}" data-action="toggle-tool"` : ""}><span class="CY-8Ka_leading">${ICONS.bash}</span><span class="CY-8Ka_title">Bash</span><span class="CY-8Ka_sep"></span><span class="CY-8Ka_summary">${esc(msg.command || "")}${lineCount ? ` · ${lineCount} 行输出` : ""}</span></div>
      ${hasDetail ? `<div class="Sxvs8a_root" ${expanded ? "" : "hidden"}><div class="Sxvs8a_body"><pre class="Y0dWHa_payload">${esc(output)}</pre></div></div>` : ""}
    </div></div></div>`;
  }
  return "";
}

function renderBlock(block, msg, idx) {
  if (block.type === "thinking") {
    const summary = (block.thinking || "").replace(/\s+/g, " ").slice(0, 160);
    return `<div class="Md3f7G_flowItem" data-chat-flow-kind="assistant-step">
      <div class="Sxvs8a_root"><div class="Sxvs8a_body">
        <div class="QWLzlG_root" data-variant="think" data-state="ok">
          <div class="_root_9cl6j_3"><div class="_row_9cl6j_10 QWLzlG_row" role="button" aria-expanded="false" data-action="toggle-thinking">
            <span class="_leading_9cl6j_23 QWLzlG_leading"><span class="_iconIdle_9cl6j_42">${ICONS.think}</span></span>
            <span class="_title_9cl6j_64 QWLzlG_title">Think</span><span class="QWLzlG_separator"></span>
            <span class="QWLzlG_summary">${esc(summary)}</span>
          </div><div class="QWLzlG_detail" hidden><div class="Y0dWHa_thinkingQuote"><pre class="Y0dWHa_payload">${esc(block.thinking || "")}</pre></div></div></div>
        </div>
      </div></div>
    </div>`;
  }
  if (block.type === "toolCall") {
    const result = block.result;
    const state = result ? (result.isError ? "error" : "ok") : block.running ? "running" : "ok";
    const argsText = block.argumentsText || "";
    const resultText = result?.content || "";
    const resultLines = resultText ? resultText.split("\n").length : 0;
    const hasDetail = argsText !== "" || resultText !== "";
    const resultHint = resultLines ? `${resultLines} 行输出` : state === "running" ? "运行中" : "";
    const summary = [argsText, resultHint].filter(Boolean).join(" · ");
    const toolKey = `call:${block.id || `${block.name || "tool"}:${idx}`}`;
    const expanded = hasDetail && S.expandedTools.has(toolKey);
    return `<div class="Md3f7G_flowItem" data-chat-flow-kind="tool-call">
      <div class="ztWv_q_callRow" data-call-id="${esc(block.id || "")}" data-tool-key="${esc(toolKey)}">
        <div class="CY-8Ka_card"><div class="CY-8Ka_root" data-sample="${esc(block.name || "tool")}" data-variant="${esc(block.name || "tool")}" data-state="${state}" ${hasDetail ? `role="button" data-expandable aria-expanded="${expanded}" data-action="toggle-tool"` : ""}>
          <span class="CY-8Ka_leading"><span class="CY-8Ka_iconIdle">${ICONS.bash}</span></span>
          <span class="CY-8Ka_visuallyHidden">${state === "error" ? "失败" : state === "running" ? "运行中" : "完成"}</span>
          <span class="CY-8Ka_title">${esc(block.name || "Tool")}</span><span class="CY-8Ka_sep"></span>
          <span class="CY-8Ka_summary ${result?.isError ? "CY-8Ka_errorSummary" : ""}">${esc(summary)}</span>
        </div>
        ${hasDetail ? `<div class="Sxvs8a_root" ${expanded ? "" : "hidden"}><div class="Sxvs8a_body">
          ${argsText ? `<pre class="Y0dWHa_payload">${esc(argsText)}</pre>` : ""}
          ${resultText ? `<pre class="Y0dWHa_payload ${result?.isError ? "Y0dWHa_payloadError" : ""}">${esc(resultText)}</pre>` : ""}
        </div></div>` : ""}
        </div>
      </div>
    </div>`;
  }
  if (block.type === "text") {
    return `<div class="Md3f7G_flowItem" data-chat-flow-kind="assistant-text">
      <div class="Sxvs8a_root"><div class="Sxvs8a_body"><div class="Y0dWHa_assistantOutput Y0dWHa_markdownPayload"><div class="_markdown_1nba0_5">${markdown(block.text || "")}</div></div></div></div>
    </div>`;
  }
  return "";
}

function splitMarkdownTableRow(line) {
  const text = String(line ?? "").trim();
  const cells = [];
  let cell = "";
  let codeFence = 0;
  let separators = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\\" && text[i + 1] === "|") {
      cell += "|";
      i += 1;
      continue;
    }
    if (char === "`") {
      let count = 1;
      while (text[i + count] === "`") count += 1;
      codeFence = codeFence === 0 ? count : codeFence === count ? 0 : codeFence;
      cell += "`".repeat(count);
      i += count - 1;
      continue;
    }
    if (char === "|" && codeFence === 0) {
      cells.push(cell.trim());
      cell = "";
      separators += 1;
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  if (cells.length > 1 && cells[0] === "") cells.shift();
  if (cells.length > 1 && cells[cells.length - 1] === "") cells.pop();
  return { cells, separators };
}

function markdownTableStart(lines, index) {
  if (index + 1 >= lines.length) return null;
  const header = splitMarkdownTableRow(lines[index]);
  if (header.separators === 0 || header.cells.length === 0) return null;
  const delimiter = splitMarkdownTableRow(lines[index + 1]);
  if (delimiter.separators === 0 || delimiter.cells.length !== header.cells.length) return null;
  if (!delimiter.cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;
  const alignments = delimiter.cells.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return "";
  });
  return { headers: header.cells, alignments };
}

function renderMarkdownTable(lines, index, table) {
  const rows = [];
  let nextIndex = index + 2;
  while (nextIndex < lines.length && lines[nextIndex].trim() !== "") {
    const parsed = splitMarkdownTableRow(lines[nextIndex]);
    if (parsed.separators === 0) break;
    const cells = parsed.cells.slice(0, table.headers.length);
    while (cells.length < table.headers.length) cells.push("");
    rows.push(cells);
    nextIndex += 1;
  }
  const cellHtml = (tag, value, column) => {
    const alignment = table.alignments[column];
    const alignAttribute = alignment ? ` data-align="${alignment}"` : "";
    return `<${tag}${alignAttribute}>${inlineMarkdown(value)}</${tag}>`;
  };
  const head = table.headers.map((cell, column) => cellHtml("th", cell, column)).join("");
  const body = rows.map((row) => `<tr>${row.map((cell, column) => cellHtml("td", cell, column)).join("")}</tr>`).join("");
  return {
    html: `<div class="md-table-wrap"><table><thead><tr>${head}</tr></thead>${body ? `<tbody>${body}</tbody>` : ""}</table></div>`,
    nextIndex,
  };
}

function markdown(src) {
  const lines = String(src ?? "").replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const buf = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1;
      const code = buf.join("\n");
      html += `<pre class="md-code-block"><code>${esc(code)}</code></pre>`;
      continue;
    }
    const table = markdownTableStart(lines, i);
    if (table) {
      const rendered = renderMarkdownTable(lines, i, table);
      html += rendered.html;
      i = rendered.nextIndex;
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      const m = line.match(/^(#{1,6})\s+(.*)$/);
      const level = m[1].length;
      html += `<h${level}>${inlineMarkdown(m[2])}</h${level}>`;
      i += 1;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(`<li>${inlineMarkdown(lines[i].replace(/^\s*[-*]\s+/, ""))}</li>`);
        i += 1;
      }
      html += `<ul>${items.join("")}</ul>`;
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(`<li>${inlineMarkdown(lines[i].replace(/^\s*\d+[.)]\s+/, ""))}</li>`);
        i += 1;
      }
      html += `<ol>${items.join("")}</ol>`;
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      html += "<hr/>";
      i += 1;
      continue;
    }
    if (/^&gt;\s?/.test(line) || /^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && (/^>\s?/.test(lines[i]) || /^&gt;\s?/.test(lines[i]))) {
        buf.push(lines[i].replace(/^(&gt;|>)\s?/, ""));
        i += 1;
      }
      html += `<blockquote>${inlineMarkdown(buf.join("\n"))}</blockquote>`;
      continue;
    }
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const para = [];
    while (
      i < lines.length
      && lines[i].trim() !== ""
      && !/^(#{1,6}\s+|```|\s*[-*]\s+|\s*\d+[.)]\s+|\s*(---|\*\*\*)\s*$|>\s?)/.test(lines[i])
      && !markdownTableStart(lines, i)
    ) {
      para.push(lines[i]);
      i += 1;
    }
    html += `<p>${inlineMarkdown(para.join("\n"))}</p>`;
  }
  return html;
}

function localFileLink(target) {
  let value = String(target ?? "").trim();
  let line = null;
  const fragment = /#L(\d+)(?:C\d+)?$/i.exec(value);
  if (fragment) {
    line = Number(fragment[1]);
    value = value.slice(0, fragment.index);
  } else {
    const location = /:(\d+)(?::\d+)?$/.exec(value);
    if (location) {
      line = Number(location[1]);
      value = value.slice(0, location.index);
    }
  }
  if (/^file:\/\/\//i.test(value)) {
    try {
      value = decodeURIComponent(new URL(value).pathname).replace(/^\/([A-Za-z]:[\\/])/, "$1");
    } catch {
      return null;
    }
  }
  if (!/^[A-Za-z]:[\\/]/.test(value) && !/^\\\\[^\\]+\\[^\\]+/.test(value)) return null;
  const href = `/api/fs/view?path=${encodeURIComponent(value)}${line ? `#L${line}` : ""}`;
  return { path: value, line, href };
}

function inlineMarkdown(src) {
  const links = [];
  const withLinkTokens = String(src ?? "").replace(
    /\[([^\]\n]+)\]\((<[^>\n]+>|[^)\s]+)\)/g,
    (match, label, wrappedTarget) => {
      const target = wrappedTarget.startsWith("<") ? wrappedTarget.slice(1, -1) : wrappedTarget;
      const local = localFileLink(target);
      if (local) {
        const location = `${local.path}${local.line ? `:${local.line}` : ""}`;
        links.push(`<a class="md-local-file" href="${esc(local.href)}" data-file-path="${esc(local.path)}" data-file-line="${local.line || ""}" title="${esc(location)}">${esc(label)}</a>`);
      } else if (/^https?:\/\//i.test(target)) {
        links.push(`<a href="${esc(target)}" target="_blank" rel="noreferrer">${esc(label)}</a>`);
      } else {
        return match;
      }
      return `\u0001${links.length - 1}\u0002`;
    },
  );
  return esc(withLinkTokens)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\u0001(\d+)\u0002/g, (_, index) => links[Number(index)] || "")
    .replace(/\n/g, "<br/>");
}

function renderWorkspaceMenu() {
  const ws = currentWorkspace();
  return `<div class="_7KE1Ra_menu pi-popover" role="menu"><div class="_7KE1Ra_groups scrollable">
    ${S.workspaces.map((w) => `<button type="button" role="menuitemradio" aria-checked="${w.id === ws?.id}" class="_7KE1Ra_option ${w.id === ws?.id ? "_7KE1Ra_selected" : ""}" data-action="select-workspace" data-workspace="${esc(w.id)}"><span class="_7KE1Ra_optionCopy"><span class="_7KE1Ra_modelName">${esc(w.title)}</span><span class="_7KE1Ra_modelPath">${esc(shortPath(w.path, 42))}</span></span><span class="_7KE1Ra_check">${w.id === ws?.id ? ICONS.check : ""}</span></button>`).join("")}
    <button type="button" role="menuitem" class="_7KE1Ra_cell" data-action="add-workspace"><span class="_7KE1Ra_cellLabel">添加工作区</span><span class="_7KE1Ra_cellValue"></span></button>
  </div></div>`;
}


function fuzzyMatchText(query, text) {
  const normalizedQuery = query.toLowerCase();
  const normalizedText = text.toLowerCase();
  const matchQuery = (candidate) => {
    if (!candidate) return { matches: true, score: 0 };
    if (candidate.length > normalizedText.length) return { matches: false, score: 0 };

    let queryIndex = 0;
    let score = 0;
    let lastMatchIndex = -1;
    let consecutiveMatches = 0;
    for (let i = 0; i < normalizedText.length && queryIndex < candidate.length; i += 1) {
      if (normalizedText[i] !== candidate[queryIndex]) continue;
      const wordBoundary = i === 0 || /[\s\-_./:]/.test(normalizedText[i - 1]);
      if (lastMatchIndex === i - 1) {
        consecutiveMatches += 1;
        score -= consecutiveMatches * 5;
      } else {
        consecutiveMatches = 0;
        if (lastMatchIndex >= 0) score += (i - lastMatchIndex - 1) * 2;
      }
      if (wordBoundary) score -= 10;
      score += i * 0.1;
      lastMatchIndex = i;
      queryIndex += 1;
    }
    if (queryIndex < candidate.length) return { matches: false, score: 0 };
    if (candidate === normalizedText) score -= 100;
    return { matches: true, score };
  };

  const primary = matchQuery(normalizedQuery);
  if (primary.matches) return primary;
  const alphaNumeric = normalizedQuery.match(/^([a-z]+)([0-9]+)$/);
  const numericAlpha = normalizedQuery.match(/^([0-9]+)([a-z]+)$/);
  const swapped = alphaNumeric
    ? `${alphaNumeric[2]}${alphaNumeric[1]}`
    : numericAlpha
      ? `${numericAlpha[2]}${numericAlpha[1]}`
      : "";
  if (!swapped) return primary;
  const fallback = matchQuery(swapped);
  return fallback.matches ? { matches: true, score: fallback.score + 5 } : primary;
}

function modelSelectorSearchText(model) {
  const provider = model.provider || "";
  const id = model.id || "";
  const name = model.name ? ` ${model.name}` : "";
  return `${provider} ${provider}/${id} ${provider} ${id}${name}`;
}

function fuzzyFilterModels(models, query) {
  const tokens = query.trim().split(/[\s/]+/).filter(Boolean);
  if (tokens.length === 0) return models;
  return models
    .map((model, index) => {
      const text = modelSelectorSearchText(model);
      let score = 0;
      for (const token of tokens) {
        const match = fuzzyMatchText(token, text);
        if (!match.matches) return null;
        score += match.score;
      }
      return { model, index, score };
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((result) => result.model);
}

function renderModelOption(model, state) {
  const selected = model.provider === state.model?.provider && model.id === state.model?.id;
  const label = model.name || model.id;
  const path = `${model.provider}/${model.id}`;
  return `<button type="button" role="option" aria-selected="false" aria-current="${selected}" tabindex="-1" title="${esc(path)}" class="_7KE1Ra_option ${selected ? "_7KE1Ra_selected" : ""}" data-action="choose-model" data-provider="${esc(model.provider)}" data-model="${esc(model.id)}"><span class="_7KE1Ra_optionCopy"><span class="_7KE1Ra_modelName">${esc(label)}</span>${label !== path ? `<span class="_7KE1Ra_description">${esc(path)}</span>` : ""}</span><span class="_7KE1Ra_check">${selected ? ICONS.check : ""}</span></button>`;
}

function modelMenuMatches(snap, query) {
  const models = snap.models || [];
  return query.trim() ? fuzzyFilterModels(models, query) : models;
}

function renderModelMenuResults(snap, query) {
  const models = modelMenuMatches(snap, query);
  if (models.length === 0) {
    return `<div class="_7KE1Ra_status">${(snap.models || []).length ? "没有匹配的模型" : "暂无可用模型"}</div>`;
  }
  if (query.trim()) return models.map((model) => renderModelOption(model, snap.state || {})).join("");

  const groups = new Map();
  for (const model of models) {
    const key = model.provider || "Other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(model);
  }
  return [...groups.entries()].map(([provider, providerModels]) => {
    const name = providerModels[0]?.providerName || provider;
    return `<section role="group" aria-label="${esc(name)}" class="_7KE1Ra_group"><div class="_7KE1Ra_groupTitle">${esc(name)}</div>${providerModels.map((model) => renderModelOption(model, snap.state || {})).join("")}</section>`;
  }).join("");
}

function renderModelMenu(snap, loading = false) {
  const state = snap.state || {};
  const results = loading
    ? `<div class="_7KE1Ra_status">正在加载模型…</div>`
    : renderModelMenuResults(snap, "");
  return `<div class="_7KE1Ra_menu pi-popover pi-modelMenu" role="dialog" aria-label="选择模型">
    <div class="_7KE1Ra_cell pi-modelMenuHeader"><span class="_7KE1Ra_cellLabel">模型</span><span class="_7KE1Ra_cellValue" title="${esc(modelLabel(state.model))}">${esc(modelLabel(state.model))}</span></div>
    <label class="pi-modelSearch">${ICONS.search}<input class="pi-modelSearchInput" type="search" role="combobox" aria-label="模糊搜索模型" aria-controls="pi-modelMenuResults" aria-expanded="true" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="模糊搜索模型…" ${loading ? "disabled" : ""}></label>
    <div class="_7KE1Ra_groups scrollable pi-modelMenuResults" id="pi-modelMenuResults" role="listbox">${results}</div>
    <div class="pi-modelSearchHint">↑↓ 选择 · Enter 确认 · Esc 关闭</div>
  </div>`;
}

function bindModelMenu(popover, snap, anchor) {
  const input = $(".pi-modelSearchInput", popover);
  const results = $(".pi-modelMenuResults", popover);
  if (!input || !results || input.disabled) return null;
  let menuSnapshot = snap;
  let selectedIndex = 0;
  let matches = [];

  const setActive = (index, scroll = true) => {
    const options = $$("[data-action=choose-model]", results);
    if (options.length === 0) {
      selectedIndex = -1;
      return;
    }
    selectedIndex = (index + options.length) % options.length;
    options.forEach((option, optionIndex) => {
      const active = optionIndex === selectedIndex;
      option.classList.toggle("pi-modelOptionActive", active);
      option.setAttribute("aria-selected", String(active));
    });
    if (scroll) options[selectedIndex].scrollIntoView({ block: "nearest" });
  };

  const updateResults = () => {
    matches = modelMenuMatches(menuSnapshot, input.value);
    results.innerHTML = renderModelMenuResults(menuSnapshot, input.value);
    const currentIndex = matches.findIndex((model) => model.provider === menuSnapshot.state?.model?.provider && model.id === menuSnapshot.state?.model?.id);
    setActive(input.value.trim() ? 0 : Math.max(0, currentIndex), false);
  };

  input.addEventListener("input", updateResults);
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      setActive(selectedIndex + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter") {
      const option = $$("[data-action=choose-model]", results)[selectedIndex];
      if (option) {
        event.preventDefault();
        event.stopPropagation();
        option.click();
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePopovers();
      anchor?.focus({ preventScroll: true });
    }
  });
  results.addEventListener("pointermove", (event) => {
    const option = event.target.closest?.("[data-action=choose-model]");
    if (!option) return;
    const options = $$("[data-action=choose-model]", results);
    setActive(options.indexOf(option), false);
  });
  updateResults();
  requestAnimationFrame(() => input.focus({ preventScroll: true }));

  return (nextSnapshot) => {
    menuSnapshot = nextSnapshot;
    const value = $(".pi-modelMenuHeader ._7KE1Ra_cellValue", popover);
    if (value) {
      value.textContent = modelLabel(nextSnapshot.state?.model);
      value.title = modelLabel(nextSnapshot.state?.model);
    }
    updateResults();
  };
}

function renderThinkingMenu(snap, loading = false) {
  const state = snap.state || {};
  const levels = snap.thinkingLevels || [];
  const body = levels.length > 0
    ? levels.map((level) => `<button type="button" role="menuitemradio" aria-checked="${level === state.thinkingLevel}" class="_7KE1Ra_option ${level === state.thinkingLevel ? "_7KE1Ra_selected" : ""}" data-action="choose-thinking" data-level="${esc(level)}"><span class="_7KE1Ra_optionCopy"><span class="_7KE1Ra_modelName">${esc(thinkingLabel(level))}</span><span class="_7KE1Ra_description">${level === "off" ? "关闭额外推理" : `推理强度：${level}`}</span></span><span class="_7KE1Ra_check">${level === state.thinkingLevel ? ICONS.check : ""}</span></button>`).join("")
    : `<div class="_7KE1Ra_status">${loading ? "正在加载思考强度…" : "当前模型没有可用思考强度"}</div>`;
  return `<div class="_7KE1Ra_menu pi-popover pi-thinkingMenu" role="menu" aria-label="思考强度">
    <div class="_7KE1Ra_cell pi-modelMenuHeader"><span class="_7KE1Ra_cellLabel">思考强度</span><span class="_7KE1Ra_cellValue">${esc(thinkingLabel(state.thinkingLevel || "off"))}</span></div>
    <div class="_7KE1Ra_groups scrollable">${body}</div>
  </div>`;
}

function renderSessionMenu(session) {
  return `<div class="_7KE1Ra_menu pi-popover pi-menu" role="menu">
    <button type="button" role="menuitem" class="_7KE1Ra_cell" data-action="history-open" data-session="${esc(session.id)}"><span class="_7KE1Ra_cellLabel">回溯与会话树</span></button>
    <button type="button" role="menuitem" class="_7KE1Ra_cell" data-action="rename-session" data-session="${esc(session.id)}"><span class="_7KE1Ra_cellLabel">重命名</span></button>
    <button type="button" role="menuitem" class="_7KE1Ra_cell" data-action="export-session" data-session="${esc(session.id)}"><span class="_7KE1Ra_cellLabel">导出 HTML</span></button>
    <button type="button" role="menuitem" class="_7KE1Ra_cell" data-action="remove-session" data-session="${esc(session.id)}"><span class="_7KE1Ra_cellLabel">删除会话</span></button>
  </div>`;
}

function openPopover(anchor, html) {
  closePopovers();
  const pop = el(`<div class="pi-popoverAnchor">${html}</div>`);
  const menu = $(".pi-popover", pop);
  const rect = anchor.getBoundingClientRect();
  pop.style.zIndex = "120";
  document.body.appendChild(pop);
  pop.replaceChildren(menu);

  menu.style.position = "fixed";
  menu.style.inset = "auto";
  menu.style.left = "0";
  menu.style.top = "0";
  menu.style.visibility = "hidden";
  const spaceAbove = Math.max(0, rect.top - 8);
  const spaceBelow = Math.max(0, innerHeight - rect.bottom - 8);
  menu.style.maxHeight = `${Math.max(120, Math.min(520, Math.max(spaceAbove, spaceBelow)))}px`;

  const width = menu.offsetWidth || 320;
  const height = menu.offsetHeight || 120;
  let left = rect.left;
  if (left + width > innerWidth - 8) left = rect.right - width;
  left = Math.max(8, Math.min(left, innerWidth - width - 8));
  const openAbove = spaceAbove > spaceBelow && spaceAbove >= Math.min(height, 160);
  let top = openAbove ? rect.top - height - 6 : rect.bottom + 6;
  top = Math.max(8, Math.min(top, innerHeight - height - 8));

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = "visible";
  return pop;
}

function closePopovers() {
  $$(".pi-popoverAnchor").forEach((n) => n.remove());
}

function renderCommandMenuInPlace() {
  const card = $("[data-composer-card]");
  if (!card) return;
  const current = $(".pi-commandMenu", card);
  const html = renderCommandMenu(currentSnapshot());
  if (!html) {
    current?.remove();
    return;
  }
  const next = el(html);
  if (current) current.replaceWith(next);
  else card.prepend(next);
  requestAnimationFrame(() => $("._3e4SsG_active", next)?.scrollIntoView({ block: "nearest" }));
}

function closeCommandMenu() {
  S.commandMenuOpen = false;
  S.commandLoading = false;
  S.commandSelected = 0;
  S.commandGeneration += 1;
  $(".pi-commandMenu")?.remove();
}

async function refreshCommandsForCurrent() {
  const sessionId = S.currentSessionId;
  if (!sessionId) return;
  const generation = ++S.commandGeneration;
  S.commandLoading = true;
  renderCommandMenuInPlace();
  try {
    const data = await post(`/api/sessions/${encodeURIComponent(sessionId)}/commands`);
    if (generation !== S.commandGeneration || sessionId !== S.currentSessionId) return;
    const snap = snapshotFor(sessionId);
    S.snapshots.set(sessionId, { ...snap, commands: data.commands || [] });
  } catch (error) {
    if (generation === S.commandGeneration) showToast(`命令加载失败：${error.message}`, "warning");
  } finally {
    if (generation === S.commandGeneration) {
      S.commandLoading = false;
      renderCommandMenuInPlace();
    }
  }
}

function openCommandMenu() {
  if (!slashCommandContext()) return closeCommandMenu();
  S.commandMenuOpen = true;
  S.commandSelected = 0;
  renderCommandMenuInPlace();
  void refreshCommandsForCurrent();
}

async function applyCommandSuggestion(command, submit = false) {
  if (!command) return;
  setDraftValue(`/${command.name}${submit ? "" : " "}`);
  const input = $("#composerInput");
  if (input) {
    input.value = S.draft;
    input.setSelectionRange(input.value.length, input.value.length);
    syncComposerInput();
  }
  closeCommandMenu();
  if (submit) await sendDraft();
  else input?.focus();
}

function openModelPopover(anchor, snap, loading = false) {
  const popover = openPopover(anchor, renderModelMenu(snap, loading));
  const updateSnapshot = bindModelMenu(popover, snap, anchor);
  return { popover, updateSnapshot };
}

function modelRefreshKey(sessionId, workspaceId) {
  return sessionId ? `session:${sessionId}` : `workspace:${workspaceId}`;
}

function refreshModelCatalog(sessionId, workspaceId, snap) {
  const key = modelRefreshKey(sessionId, workspaceId);
  const existing = S.modelRefreshes.get(key);
  if (existing) return existing;

  const path = sessionId
    ? `/api/sessions/${encodeURIComponent(sessionId)}/models`
    : `/api/workspaces/${encodeURIComponent(workspaceId)}/models`;
  const model = snap.state?.model;
  const request = post(path, {
    model: model?.provider && model?.id ? { provider: model.provider, id: model.id } : undefined,
    thinkingLevel: snap.state?.thinkingLevel,
  }).then((data) => {
    if (sessionId) {
      S.snapshots.set(sessionId, { ...snapshotFor(sessionId), ...data });
    } else if (!S.currentSessionId && S.currentWorkspaceId === workspaceId) {
      S.newSessionSnapshot = { ...snapshotFor(null), ...data };
    }
    S.modelRefreshedAt.set(key, Date.now());
    return data;
  }).finally(() => {
    S.modelRefreshes.delete(key);
  });
  S.modelRefreshes.set(key, request);
  return request;
}

async function openModelSelector(anchor) {
  const snap = currentSnapshot();
  const sessionId = S.currentSessionId;
  const workspaceId = S.currentWorkspaceId || currentWorkspace()?.id;
  const hasCachedModels = (snap.models || []).length > 0;
  const menu = openModelPopover(anchor, snap, !hasCachedModels);
  if (!sessionId && !workspaceId) return;

  const key = modelRefreshKey(sessionId, workspaceId);
  const refreshedAt = S.modelRefreshedAt.get(key) || 0;
  if (hasCachedModels && Date.now() - refreshedAt < MODEL_REFRESH_TTL_MS) return;

  try {
    await refreshModelCatalog(sessionId, workspaceId, snap);
    const sameContext = sessionId
      ? S.currentSessionId === sessionId
      : !S.currentSessionId && S.currentWorkspaceId === workspaceId;
    if (sameContext && document.body.contains(menu.popover)) {
      const nextSnapshot = sessionId ? snapshotFor(sessionId) : snapshotFor(null);
      if (menu.updateSnapshot) {
        menu.updateSnapshot(nextSnapshot);
      } else {
        const nextAnchor = $('[data-action="model-menu"]');
        if (nextAnchor) openModelPopover(nextAnchor, nextSnapshot);
      }
    }
  } catch (error) {
    if (!document.body.contains(menu.popover)) return;
    if (hasCachedModels) {
      showToast(`模型刷新失败，继续使用缓存：${error.message}`, "warning");
    } else {
      const status = menu.popover.querySelector("._7KE1Ra_status");
      if (status) status.textContent = `模型加载失败：${error.message}`;
    }
  }
}

async function openThinkingSelector(anchor) {
  const snap = currentSnapshot();
  const sessionId = S.currentSessionId;
  if ((snap.thinkingLevels || []).length > 0 || !sessionId) {
    openPopover(anchor, renderThinkingMenu(snap));
    return;
  }
  const loadingPopover = openPopover(anchor, renderThinkingMenu(snap, true));
  try {
    const data = await post(`/api/sessions/${encodeURIComponent(sessionId)}/refresh`);
    S.snapshots.set(sessionId, { ...snapshotFor(sessionId), ...data });
    if (document.body.contains(loadingPopover)) {
      const nextAnchor = $('[data-action="thinking-menu"]');
      if (nextAnchor) openPopover(nextAnchor, renderThinkingMenu(snapshotFor(sessionId)));
    }
  } catch (error) {
    if (document.body.contains(loadingPopover)) {
      loadingPopover.querySelector("._7KE1Ra_status").textContent = `思考强度加载失败：${error.message}`;
    }
  }
}

function renderDialogCard(dialog) {
  if (!dialog) return "";
  const title = dialog.title || (dialog.method === "confirm" ? "请确认" : dialog.method === "input" ? "请输入" : "请选择");
  const msg = dialog.message || "";
  let body = "";
  if (dialog.method === "select") {
    body = `<div class="pi-dialogOptions">${(dialog.options || []).map((o) => `<button type="button" class="pi-dialogOption" data-action="dialog-select" data-value="${esc(o)}">${esc(o)}</button>`).join("")}</div>`;
  } else if (dialog.method === "confirm") {
    body = `<div class="pi-dialogOptions"><button type="button" class="pi-dialogOption" data-action="dialog-confirm" data-value="true">确认</button><button type="button" class="pi-dialogOption" data-action="dialog-confirm" data-value="false">取消</button></div>`;
  } else if (dialog.method === "input" || dialog.method === "editor") {
    body = `<textarea class="pXSMma_modalInput pi-dialogInput" placeholder="${esc(dialog.placeholder || "")}" rows="3">${esc(dialog.prefill || "")}</textarea>
      <div class="pi-dialogOptions"><button type="button" class="pi-dialogOption" data-action="dialog-input">确定</button><button type="button" class="pi-dialogOption" data-action="dialog-cancel">取消</button></div>`;
  }
  return `<section class="pi-dialogCard pi-dialogInline" role="region" aria-label="${esc(title)}" aria-live="polite">
    <div class="pi-dialogTitle">${esc(title)}</div>
    ${msg ? `<div class="pi-dialogMessage">${esc(msg)}</div>` : ""}
    ${body}
  </section>`;
}

function historyNodeLabel(node) {
  if (node.customType === "pi-web-tree-navigation") return "回溯点";
  if (node.role === "user") return "用户";
  if (node.role === "assistant") return "助手";
  if (node.role === "toolResult") return "工具";
  return {
    compaction: "压缩",
    branch_summary: "分支摘要",
    model_change: "模型",
    thinking_level_change: "思考",
    session_info: "会话",
    custom_message: "扩展消息",
    custom: "扩展状态",
    label: "标签",
  }[node.type] || "节点";
}

function historyRewindNodes(nodes) {
  return nodes.filter((node) => node.rewindable)
    .sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));
}

function renderHistoryView(view) {
  const dialog = view || { mode: "rewind", loading: true, nodes: [] };
  const nodes = dialog.nodes || [];
  let body = "";
  let decision = "";
  if (dialog.loading) {
    body = `<div class="pi-historyState">正在读取会话树…</div>`;
  } else if (dialog.error && nodes.length === 0) {
    body = `<div class="pi-historyState pi-historyError">${esc(dialog.error)}</div>`;
  } else if (dialog.mode === "rewind") {
    const prompts = historyRewindNodes(nodes);
    body = prompts.length > 0 ? prompts.map((node, index) => `
      <button type="button" class="pi-historyPrompt ${dialog.selectedEntryId === node.id ? "pi-historyPromptSelected" : ""}" data-action="history-choose-rewind" data-entry="${esc(node.id)}" data-role="${esc(node.role || "")}" aria-pressed="${dialog.selectedEntryId === node.id}" ${!node.navigable || dialog.busyEntryId ? "disabled" : ""}>
        <span class="pi-historyPromptIndex">${index === 0 ? "最近" : `-${index}`}</span>
        <span class="pi-historyPromptCopy"><span class="pi-historyPromptText">${esc(node.text || "（空消息）")}</span><span class="pi-historyPromptMeta">${esc(clockLabel(node.timestamp))} · ${node.active ? "当前路径" : "历史分支"}</span></span>
      </button>`).join("") : `<div class="pi-historyState">当前会话还没有可回溯的用户消息</div>`;
  } else {
    body = nodes.length > 0 ? nodes.map((node) => {
      const depth = Math.min(7, Math.max(0, Number(node.branchDepth) || 0));
      const disabled = !node.navigable || dialog.busyEntryId;
      return `<button type="button" class="pi-historyTreeRow ${node.active ? "pi-historyTreeActive" : ""} ${node.current ? "pi-historyTreeCurrent" : ""} ${dialog.selectedEntryId === node.id ? "pi-historyPromptSelected" : ""}" style="--history-indent:${12 + depth * 18}px" data-action="history-choose-rewind" data-entry="${esc(node.id)}" data-role="${esc(node.role || "")}" aria-pressed="${dialog.selectedEntryId === node.id}" ${disabled ? "disabled" : ""}>
        <span class="pi-historyRail"><span class="pi-historyDot"></span></span>
        <span class="pi-historyKind">${esc(historyNodeLabel(node))}</span>
        <span class="pi-historyTreeCopy"><span class="pi-historyTreeText">${esc(node.text || historyNodeLabel(node))}</span><span class="pi-historyTreeMeta">${esc(clockLabel(node.timestamp))}${node.branchCount > 1 ? ` · ${node.branchCount} 个分支` : ""}${node.current ? " · 当前位置" : node.active ? " · 当前路径" : " · 历史分支"}</span></span>
        ${node.label ? `<span class="pi-historyLabel">${esc(node.label)}</span>` : ""}
      </button>`;
    }).join("") : `<div class="pi-historyState">当前会话树为空</div>`;
  }
  if (!dialog.loading) {
    const selected = nodes.find((node) => node.id === dialog.selectedEntryId && node.navigable);
    if (selected) {
      decision = `<div class="pi-historyDecisionWrap"><div class="pi-historyDecision">
        <div class="pi-historyDecisionCopy"><div class="pi-historyDecisionTitle">选择回溯范围</div><div class="pi-historyDecisionText">${esc(selected.text || "（空消息）")}</div></div>
        <div class="pi-historyDecisionActions">
          <button type="button" class="pi-historyDecisionButton" data-action="history-rewind-mode" data-entry="${esc(selected.id)}" data-role="${esc(selected.role || "")}" data-restore-mode="conversation" ${dialog.busyEntryId ? "disabled" : ""}><span>仅回溯对话</span><small>保留工作区当前文件</small></button>
          <button type="button" class="pi-historyDecisionButton pi-historyDecisionPrimary" data-action="history-rewind-mode" data-entry="${esc(selected.id)}" data-role="${esc(selected.role || "")}" data-restore-mode="all" ${dialog.busyEntryId ? "disabled" : ""}><span>对话和文件一起回溯</span><small>文件恢复到该时点最近的 pi-rewind 检查点</small></button>
          <button type="button" class="pi-historyDecisionCancel" data-action="history-rewind-cancel" ${dialog.busyEntryId ? "disabled" : ""}>取消</button>
        </div>
      </div></div>`;
    }
  }
  const current = nodes.find((node) => node.current);
  const previous = nodes.find((node) => node.id === current?.navigationFromId && node.navigable);
  const returnButton = previous ? `<button type="button" class="pi-historyReturn" data-action="history-choose-rewind" data-entry="${esc(previous.id)}" data-role="${esc(previous.role || "")}" ${dialog.busyEntryId ? "disabled" : ""}>${ICONS.history}<span>返回切换前的位置</span></button>` : "";
  const errorBanner = dialog.error && nodes.length > 0 ? `<div class="pi-historyErrorBanner" role="alert">${esc(dialog.error)}</div>` : "";
  const busyText = dialog.busyRestoreMode === "all" ? "正在回溯对话和文件…" : "正在切换会话分支…";
  return `<section class="pi-historyView" role="tabpanel" aria-label="会话历史">
    <div class="pi-historyHeader"><div><div class="pi-historyTitle">会话历史</div><div class="pi-historySubtitle">${nodes.filter((node) => node.rewindable).length} 条用户消息 · ${nodes.filter((node) => !node.active).length} 个历史分支节点</div></div><div class="pi-historyActions">${returnButton}<button type="button" class="nL4_yW_sessionLogButton" data-action="export-current"><span>导出记录</span></button></div></div>
    <div class="pi-historyTabs" role="tablist">
      <button type="button" role="tab" aria-selected="${dialog.mode === "rewind"}" class="pi-historyTab ${dialog.mode === "rewind" ? "pi-historyTabActive" : ""}" data-action="history-mode" data-mode="rewind">回溯</button>
      <button type="button" role="tab" aria-selected="${dialog.mode === "tree"}" class="pi-historyTab ${dialog.mode === "tree" ? "pi-historyTabActive" : ""}" data-action="history-mode" data-mode="tree">会话树</button>
    </div>
    <div class="pi-historyBody"><div class="pi-historyBodyInner">${errorBanner}${body}</div></div>
    ${decision}
    ${dialog.busyEntryId ? `<div class="pi-historyBusy" role="status">${busyText}</div>` : ""}
  </section>`;
}

async function openHistoryView(mode = "rewind") {
  const sessionId = S.currentSessionId;
  if (!sessionId) {
    showToast("请先打开一个会话", "warning");
    return;
  }
  const generation = ++S.historyGeneration;
  S.conversationTab = "history";
  S.historyView = { sessionId, mode, loading: true, nodes: [], error: null, busyEntryId: null };
  queueRender(true, { sidebar: false, conversation: true, overlay: false });
  try {
    const data = await post(`/api/sessions/${encodeURIComponent(sessionId)}/history`);
    if (generation !== S.historyGeneration || S.historyView?.sessionId !== sessionId) return;
    S.historyView = { ...S.historyView, loading: false, nodes: data.nodes || [], leafId: data.leafId || null };
  } catch (error) {
    if (generation !== S.historyGeneration || S.historyView?.sessionId !== sessionId) return;
    S.historyView = { ...S.historyView, loading: false, error: error.message || String(error) };
  }
  queueRender(true, { sidebar: false, conversation: true, overlay: false });
}

function showConversationView() {
  S.conversationTab = "conversation";
  queueRender(true, { sidebar: false, conversation: true, overlay: false });
  requestAnimationFrame(() => $("#composerInput")?.focus({ preventScroll: true }));
}

async function navigateHistory(entryId, role, restoreMode) {
  const view = S.historyView;
  const sessionId = view?.sessionId;
  if (!view || !sessionId || view.busyEntryId) return;
  if (S.draft.trim()) {
    const replacesDraft = role === "user" || role === "custom";
    if (!confirm(replacesDraft ? "当前输入框草稿将被历史消息替换，继续回溯？" : "切换会话节点将清空当前输入框草稿，继续？")) return;
  }
  S.historyView = { ...view, busyEntryId: entryId, busyRestoreMode: restoreMode || null, error: null };
  renderConversation();
  try {
    const data = await post(`/api/sessions/${encodeURIComponent(sessionId)}/navigate_tree`, { entryId, restoreMode });
    if (S.currentSessionId !== sessionId) return;
    const snap = snapshotFor(sessionId);
    S.snapshots.set(sessionId, { ...snap, session: data.session, state: data.state, messages: data.messages || [], stats: data.stats });
    if (typeof data.editorText === "string") setDraftValue(data.editorText);
    ++S.historyGeneration;
    S.conversationTab = "conversation";
    S.historyView = null;
    queueRender(true);
    requestAnimationFrame(() => {
      const input = $("#composerInput");
      input?.focus({ preventScroll: true });
      input?.setSelectionRange(input.value.length, input.value.length);
    });
    if (restoreMode === "all") showToast(role === "user" ? "已回溯对话和文件，可编辑后重新发送" : "已切换会话节点并恢复文件");
    else if (restoreMode === "conversation") showToast("已回溯对话，工作区文件保持不变");
    else showToast(role === "user" ? "已回溯到所选消息，可编辑后重新发送" : "已切换到所选会话节点");
  } catch (error) {
    if (S.historyView?.sessionId === sessionId) {
      S.historyView = { ...S.historyView, busyEntryId: null, busyRestoreMode: null, error: error.message || String(error) };
      renderConversation();
    }
  }
}

const networkSettings = { data: null, form: null, dirty: false, saving: false, loading: false, error: "", request: 0 };

function networkForm() {
  if (networkSettings.form) return networkSettings.form;
  const form = el(`<form id="webNetworkForm" class="pi-networkForm">
    <label>访问方式<select name="mode" class="pi-passwordInput"><option value="local">仅本机</option><option value="lan">局域网</option><option value="relay">服务器中转</option></select></label>
    <div class="pi-networkRelay" hidden>
      <label>服务器地址<input name="serverAddr" class="pi-passwordInput" placeholder="服务器 IP 或域名" autocomplete="off"></label>
      <label>frps 端口<input name="serverPort" class="pi-passwordInput" type="number" min="1" max="65535" value="7000"></label>
      <label>认证密钥<input name="token" class="pi-passwordInput" type="password" autocomplete="new-password" placeholder="输入认证密钥"></label>
      <label>HTTPS 手机入口<input name="origin" class="pi-passwordInput" type="url" placeholder="https://pi.example.com" autocomplete="off"></label>
      <label>frpc 原生路径<input name="frpcPath" class="pi-passwordInput" placeholder="frpc" autocomplete="off"></label>
      <p>首次使用请<a href="https://github.com/fatedier/frp/releases" target="_blank" rel="noopener noreferrer">下载原生 frpc</a>。路径为空时使用 PATH 中的 frpc，扩展会托管该进程。</p>
      <details><summary>高级设置</summary><div class="pi-networkAdvanced">
        <label>隧道名<input name="proxyName" class="pi-passwordInput" autocomplete="off" placeholder="使用默认名称"></label>
        <label>服务器内部端口<input name="visitorPort" class="pi-passwordInput" type="number" min="1" max="65535" value="13000"></label>
      </div></details>
    </div>
    <p class="pi-networkHint">选择模式后保存生效。</p>
    <button type="submit" class="pi-settingsAction pi-settingsActionPrimary">保存设置</button>
    <div class="pi-networkStatus pi-settingsStatus" role="status"></div>
    <div class="pi-networkUrls"></div>
    <div class="pi-networkDownloads" hidden><p>下载已保存的服务器配置，证书路径请按服务器修改。</p><div class="pi-networkDownloadButtons">${["frps.toml", "visitor.toml", "nginx.conf"].map((name) => `<button type="button" class="pi-settingsAction" data-network-file="${name}">下载 ${name}</button>`).join("")}</div></div>
  </form>`);
  networkSettings.form = form;
  form.oninput = form.onchange = () => {
    networkSettings.dirty = true;
    updateNetworkForm();
  };
  form.onsubmit = saveNetworkSettings;
  form.querySelectorAll("[data-network-file]").forEach((button) => {
    button.onclick = async () => {
      if (button.disabled || !S.localClient) return;
      button.disabled = true;
      try {
        const { files } = await api("/api/network/server-files");
        const name = button.dataset.networkFile;
        if (typeof files?.[name] !== "string") throw new Error("服务器未返回此配置文件");
        const url = URL.createObjectURL(new Blob([files[name]], { type: "text/plain;charset=utf-8" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (error) {
        networkSettings.error = error.message || String(error);
      } finally {
        button.disabled = false;
        updateNetworkForm();
      }
    };
  });
  return form;
}

function updateNetworkForm(sync = false) {
  if (!S.localClient) return;
  const form = networkForm();
  const state = networkSettings;
  if (sync && state.data && !state.dirty && !state.saving) {
    const { settings } = state.data;
    const relay = settings.relay || {};
    const values = { mode: settings.mode, serverAddr: relay.serverAddr || "", serverPort: relay.serverPort || 7000, token: "", origin: relay.origin || "", frpcPath: relay.frpcPath || "", proxyName: relay.proxyName || "", visitorPort: relay.visitorPort || 13000 };
    for (const [name, value] of Object.entries(values)) form.elements.namedItem(name).value = value;
  }
  const relayMode = form.elements.namedItem("mode").value === "relay";
  $(".pi-networkRelay", form).hidden = !relayMode;
  form.querySelectorAll("input[name],select[name]").forEach((input) => {
    input.disabled = state.saving || !state.data || (input.tagName === "INPUT" && !relayMode);
  });
  for (const name of ["serverAddr", "serverPort", "origin"]) form.elements.namedItem(name).required = relayMode;
  form.elements.namedItem("token").placeholder = state.data?.settings.relay?.tokenConfigured ? "已设置，留空保留现有密钥" : "输入认证密钥";
  const submit = $('button[type="submit"]', form);
  submit.disabled = state.saving || !state.data || Boolean(state.data.applying);
  submit.textContent = state.saving ? "保存中…" : state.data?.applying ? "正在应用…" : relayMode ? "保存并连接" : "保存设置";
  const status = $(".pi-networkStatus", form);
  const labels = { stopped: "未连接", connecting: "连接中", connected: "已连接", error: "连接失败" };
  status.textContent = state.error || (state.loading && !state.data ? "正在加载网络设置…" : state.data ? state.data.applying ? "正在应用配置…" : state.data.status.message || labels[state.data.status.state] : "正在加载网络设置…");
  status.classList.toggle("pi-settingsStatus-error", Boolean(state.error || state.data?.status.state === "error"));
  const urls = $(".pi-networkUrls", form);
  const urlsKey = JSON.stringify(state.data?.urls || []);
  if (urls.dataset.urls !== urlsKey) {
    urls.dataset.urls = urlsKey;
    urls.innerHTML = (state.data?.urls || []).map((url) => `<div class="pi-settingsActionRow"><input class="pi-lanUrl" aria-label="手机访问链接" readonly value="${esc(url)}"><button type="button" class="pi-settingsAction" data-action="copy-text" data-text="${esc(url)}">复制链接</button></div>`).join("");
  }
  $(".pi-networkDownloads", form).hidden = state.data?.settings.mode !== "relay";
}

async function loadNetworkSettings() {
  if (!S.localClient || networkSettings.saving) return;
  const state = networkSettings;
  const request = ++state.request;
  state.loading = true;
  updateNetworkForm();
  try {
    const data = await api("/api/network");
    if (request !== state.request) return;
    state.data = data;
    state.error = "";
    updateNetworkForm(true);
  } catch (error) {
    if (request !== state.request) return;
    state.error = error.status === 404 ? "重新加载运行时以启用网络设置。" : `加载网络设置失败：${error.message || String(error)}。重新打开设置可重试。`;
  } finally {
    if (request === state.request) {
      state.loading = false;
      updateNetworkForm();
    }
  }
}

async function saveNetworkSettings(event) {
  event.preventDefault();
  const state = networkSettings;
  if (!S.localClient || state.saving || !state.data || state.data.applying) return;
  const form = event.currentTarget;
  const value = (name) => form.elements.namedItem(name).value;
  const mode = value("mode");
  const body = { mode };
  if (mode === "relay") body.relay = {
    serverAddr: value("serverAddr").trim(), serverPort: Number(value("serverPort")), token: value("token"),
    origin: value("origin").trim(), frpcPath: value("frpcPath").trim() || "frpc",
    proxyName: value("proxyName").trim() || undefined, visitorPort: Number(value("visitorPort") || 13000),
  };
  ++state.request;
  state.dirty = true;
  state.saving = true;
  state.error = "";
  updateNetworkForm();
  try {
    state.data = await post("/api/network", body);
    state.dirty = false;
    form.elements.namedItem("token").value = "";
  } catch (error) {
    state.error = `保存失败：${error.message || String(error)}`;
  } finally {
    state.saving = false;
    updateNetworkForm(!state.dirty);
    if (!state.dirty) void loadNetworkSettings();
  }
}

function renderSettings() {
  const busy = Boolean(S.maintenanceBusy);
  const themes = [
    ["system", "跟随系统"],
    ["light", "浅色"],
    ["dark", "深色"],
  ];
  const status = S.maintenanceMessage
    ? `<div class="pi-settingsStatus pi-settingsStatus-${esc(S.maintenanceMessage.type || "info")}" role="status">${esc(S.maintenanceMessage.text || "")}</div>`
    : "";
  return `<div class="pi-settingsBackdrop">
    <div class="pi-settingsPanel" role="dialog" aria-modal="true" aria-labelledby="pi-settings-title">
      <header class="pi-settingsHeader">
        <h2 id="pi-settings-title">设置</h2>
        <button type="button" class="pi-settingsClose" data-action="settings-close" aria-label="关闭设置" title="关闭" ${busy ? "disabled" : ""}>×</button>
      </header>
      <section class="pi-settingsSection" aria-labelledby="pi-settings-appearance">
        <h3 id="pi-settings-appearance">外观</h3>
        <div class="pi-settingsTheme" role="group" aria-label="界面主题">
          ${themes.map(([value, label]) => `<button type="button" data-action="choose-theme" data-theme="${value}" aria-pressed="${S.theme === value}" ${busy ? "disabled" : ""}>${label}</button>`).join("")}
        </div>
      </section>
      <section class="pi-settingsSection" aria-labelledby="pi-settings-network">
        <h3 id="pi-settings-network">手机访问</h3>
        ${S.localClient ? '<div id="webNetworkMount"></div>' : '<p>已连接远程服务</p>'}
        ${S.localClient ? `<form id="webPasswordForm" class="pi-passwordForm">
          <label for="webPassword">${S.passwordConfigured ? "更换访问密码" : "设置访问密码"}</label>
          <div class="pi-settingsActionRow"><input id="webPassword" class="pi-passwordInput" type="password" name="password" autocomplete="new-password" maxlength="256" required placeholder="${S.passwordConfigured ? "输入新密码" : "输入固定密码"}"><button type="submit" class="pi-settingsAction">保存密码</button></div>
          <p class="pi-passwordStatus" role="status">${S.passwordConfigured ? "已设置密码，修改后手机需重新登录。" : "设置后，手机可用此密码登录。"}</p>
        </form>` : ""}
      </section>
      <section class="pi-settingsSection" aria-labelledby="pi-settings-maintenance">
        <h3 id="pi-settings-maintenance">Pi 维护</h3>
        <div class="pi-settingsActionRow">
          <div class="pi-settingsActionCopy"><strong>更新扩展并重载</strong><code>pi update --extensions</code></div>
          <button type="button" class="pi-settingsAction pi-settingsActionPrimary" data-action="maintenance-update-reload" ${busy ? "disabled" : ""}>${S.maintenanceBusy === "update" ? '<span class="pi-settingsSpinner"></span>更新中' : `${ICONS.refresh}<span>更新并重载</span>`}</button>
        </div>
        <div class="pi-settingsActionRow">
          <div class="pi-settingsActionCopy"><strong>重新加载运行时</strong><code>/reload</code></div>
          <button type="button" class="pi-settingsAction" data-action="maintenance-reload" ${busy ? "disabled" : ""}>${S.maintenanceBusy === "reload" ? '<span class="pi-settingsSpinner"></span>重载中' : `${ICONS.refresh}<span>重新加载</span>`}</button>
        </div>
        ${status}
      </section>
    </div>
  </div>`;
}

function renderOverlay() {
  const overlay = $("#overlayMount");
  if (!overlay) return;
  if (S.settingsOpen) {
    const passwordForm = $("#webPasswordForm", overlay);
    const focused = overlay.contains(document.activeElement) ? document.activeElement : null;
    const scrollTop = $(".pi-settingsPanel", overlay)?.scrollTop || 0;
    passwordForm?.remove();
    networkSettings.form?.remove();
    overlay.innerHTML = renderSettings();
    const nextForm = $("#webPasswordForm", overlay);
    if (passwordForm && nextForm) {
      $("label", passwordForm).textContent = $("label", nextForm).textContent;
      $(".pi-passwordStatus", passwordForm).textContent = $(".pi-passwordStatus", nextForm).textContent;
      $("#webPassword", passwordForm).placeholder = $("#webPassword", nextForm).placeholder;
      nextForm.replaceWith(passwordForm);
    }
    const form = $("#webPasswordForm", overlay);
    if (form) form.onsubmit = saveWebPassword;
    const networkMount = $("#webNetworkMount", overlay);
    if (networkMount) {
      networkMount.replaceWith(networkForm());
      updateNetworkForm();
    }
    if (focused?.isConnected) focused.focus({ preventScroll: true });
    $(".pi-settingsPanel", overlay).scrollTop = scrollTop;
    return;
  }
  overlay.innerHTML = "";
}

async function saveWebPassword(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const input = $("#webPassword", form);
  const button = $("button", form);
  if (input.disabled) return;
  const password = input.value;
  input.disabled = true;
  button.disabled = true;
  try {
    await post("/api/auth/password", { password });
    input.value = "";
    S.passwordConfigured = true;
    renderOverlay();
    showToast("访问密码已保存");
  } catch (error) {
    showToast(error.message || String(error), "error");
  } finally {
    input.disabled = false;
    button.disabled = false;
  }
}

function syncComposerInput() {
  const input = $("#composerInput");
  if (!input) return;
  const grow = input.closest(".uV2eYG_grow");
  const mirror = grow?.querySelector(".uV2eYG_mirror");
  const backdrop = grow?.querySelector(".uV2eYG_backdrop");
  // The DSH composer paints the visible text in the backdrop (the textarea
  // itself is transparent) and sizes the row from the hidden mirror.
  if (mirror) mirror.textContent = `${input.value}\n`;
  if (backdrop) backdrop.textContent = input.value;
  // The mirror must keep the full draft height; the outer scrollport owns the 336px cap.
  if (grow) grow.style.removeProperty("height");
}

function bindComposerInput() {
  const input = $("#composerInput");
  if (!input) return;
  if (!input.dataset.bound) {
    input.dataset.bound = "1";
    input.value = S.draft;
    input.addEventListener("input", () => {
      setDraftValue(input.value);
      syncComposerInput();
      if (slashCommandContext()) {
        if (!S.commandMenuOpen) openCommandMenu();
        else {
          S.commandSelected = 0;
          renderCommandMenuInPlace();
        }
      } else {
        closeCommandMenu();
      }
    });
    input.addEventListener("paste", (event) => {
      const hasImage = [...(event.clipboardData?.items || [])].some((item) => item.type.startsWith("image/"));
      if (!hasImage) return;
      event.preventDefault();
      if (S.localClient) void pasteSystemClipboard();
      else void uploadImages([...(event.clipboardData?.items || [])].filter((item) => item.type.startsWith("image/")).map((item) => item.getAsFile()).filter(Boolean));
    });
    input.addEventListener("keydown", (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter" && usesTouchInput() && !event.ctrlKey && !event.metaKey) return;
      if (S.commandMenuOpen) {
        const commands = commandSuggestions();
        if ((event.key === "ArrowUp" || event.key === "ArrowDown") && commands.length > 0) {
          event.preventDefault();
          const delta = event.key === "ArrowDown" ? 1 : -1;
          S.commandSelected = (S.commandSelected + delta + commands.length) % commands.length;
          renderCommandMenuInPlace();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          closeCommandMenu();
          return;
        }
        if ((event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) && commands.length > 0) {
          event.preventDefault();
          void applyCommandSuggestion(commands[S.commandSelected], event.key === "Enter");
          return;
        }
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void sendDraft();
      }
    });
  }
  syncComposerInput();
}

function restoreDraft() {
  const input = $("#composerInput");
  if (input) input.value = S.draft;
}

let renderFrame = 0;
let pendingRender = { sidebar: true, conversation: true, overlay: true };
function queueRender(force = false, parts = null) {
  const requested = parts || { sidebar: true, conversation: true, overlay: true };
  pendingRender.sidebar ||= requested.sidebar;
  pendingRender.conversation ||= requested.conversation;
  pendingRender.overlay ||= requested.overlay;

  const run = () => {
    renderFrame = 0;
    const current = pendingRender;
    pendingRender = { sidebar: false, conversation: false, overlay: false };
    if (current.sidebar) renderSidebar();
    if (current.conversation) renderConversation();
    if (current.overlay) renderOverlay();
    bindGlobalEvents();
  };
  if (force) {
    if (renderFrame) cancelAnimationFrame(renderFrame);
    run();
  } else if (!renderFrame) {
    renderFrame = requestAnimationFrame(run);
  }
}

function updateSnapshotFromEvent(event) {
  const id = event.sessionId;
  if (!id) return;
  const existing = snapshotFor(id);
  if (event.type === "snapshot") {
    S.snapshots.set(id, { ...existing, ...event });
  } else if (event.type === "session_event") {
    const inner = event.event || {};
    if (inner.type === "notify") {
      const snap = snapshotFor(id);
      S.snapshots.set(id, { ...snap });
    }
  }
}

async function loadBootstrap() {
  const boot = await api("/api/bootstrap");
  S.workspaces = applySavedWorkspaceOrder(boot.workspaces || []);
  S.collapsed = new Set(S.workspaces.map((workspace) => workspace.id));
  const savedSessionId = sessionStorage.getItem("pi-web-current-session");
  S.currentSessionId = S.workspaces.some((workspace) => workspace.sessions?.some((session) => session.id === savedSessionId))
    ? savedSessionId : boot.currentSessionId;
  S.serverInstanceId = boot.instanceId || null;
  S.localClient = boot.localClient !== false;
  S.lanEnabled = boot.lanEnabled === true;
  S.lanUrls = boot.lanUrls || [];
  S.passwordConfigured = boot.passwordConfigured === true;
  S.currentWorkspaceId = S.workspaces.find((workspace) => workspace.sessions?.some((session) => session.id === S.currentSessionId))?.id
    || boot.currentWorkspaceId || S.workspaces[0]?.id || null;
  S.newSessionSnapshot = {
    session: null,
    state: boot.modelInfo?.state || null,
    stats: null,
    models: boot.modelInfo?.models || [],
    thinkingLevels: boot.modelInfo?.thinkingLevels || [],
    thinkingLevelsByModel: boot.modelInfo?.thinkingLevelsByModel || {},
    commands: boot.commands || [],
    extensionStatuses: {},
    messages: [],
    dialogs: [],
  };
  renderApp();
  if (S.currentSessionId) await openSession(S.currentSessionId, { silent: true });
}

async function openSession(id, opts = {}) {
  closeMobileSidebar();
  sessionStorage.setItem("pi-web-current-session", id);
  closeCommandMenu();
  ++S.historyGeneration;
  S.conversationTab = "conversation";
  S.historyView = null;
  const generation = ++S.openGeneration;
  if (!opts.skipRemember) rememberCurrentDraft();
  S.currentSessionId = id;
  S.loadingSession = id;
  if (!opts.silent) {
    const key = draftKey(id);
    const savedDraft = S.drafts.get(key) || "";
    const failedDrafts = S.failedDrafts.get(id) || [];
    const attachments = [...(S.attachmentDrafts.get(key) || []), ...(S.failedAttachmentDrafts.get(id) || [])];
    S.draftAttachments = [...new Map(attachments.map((attachment) => [attachment.id, attachment])).values()];
    setDraftValue([savedDraft, ...failedDrafts].filter(Boolean).join("\n\n"));
    S.failedDrafts.delete(id);
    S.failedAttachmentDrafts.delete(id);
  } else {
    setDraftValue(S.draft);
  }
  renderSidebar();
  renderConversation();
  try {
    const data = await post(`/api/sessions/${encodeURIComponent(id)}/open`);
    S.snapshots.set(id, data);
    if (generation !== S.openGeneration) return;
    const ws = data.session?.workspaceId;
    if (ws) S.currentWorkspaceId = ws;
  } catch (error) {
    S.snapshots.set(id, { ...snapshotFor(id), session: { id, title: "会话", status: "error" }, error: String(error) });
  } finally {
    if (generation === S.openGeneration) {
      S.loadingSession = null;
      queueRender(true);
    }
  }
}

async function createAndOpenSession(workspaceId, title, options = {}) {
  try {
    const source = currentSnapshot();
    const model = source.state?.model;
    const data = await post(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`, {
      title,
      model: model?.provider && model?.id ? { provider: model.provider, modelId: model.id } : undefined,
      thinkingLevel: source.state?.thinkingLevel || undefined,
    });
    const id = data.session?.id;
    if (!id) throw new Error("create session failed");
    S.snapshots.set(id, data);
    if (!options.keepDraft) {
      rememberCurrentDraft();
      S.draft = "";
      S.draftAttachments = [];
    }
    S.currentWorkspaceId = workspaceId;
    await openSession(id, { silent: true, skipRemember: !options.keepDraft });
    return id;
  } catch (error) {
    alert(`新建会话失败：${error.message}`);
    return null;
  }
}

async function ensureWorkspaceThen(action) {
  let ws = currentWorkspace();
  if (!ws) {
    ws = await promptWorkspace();
    if (!ws) return null;
  }
  return action(ws);
}

// ---------------------------------------------------------------------------
// Workspace directory browser (port of DSH ui-directory-picker-browse)
// ---------------------------------------------------------------------------
let browser = null;
let pickerResolve = null;
let browserKeyHandler = null;

async function adoptWorkspacePath(path) {
  const added = await post("/api/workspaces", { path });
  S.workspaces = await refreshWorkspaces();
  return S.workspaces.find((w) => w.id === added.workspace?.id) || S.workspaces.find((w) => w.path === path) || null;
}

async function promptWorkspace() {
  closePopovers();
  if (!S.localClient) return promptWorkspaceBrowse();
  try {
    const data = await post("/api/fs/pick");
    if (data.error) throw new Error(data.error);
    if (!data.path) return null;
    return await adoptWorkspacePath(data.path);
  } catch {
    // Native picker unavailable (unsupported platform, missing command):
    // fall back to the in-app directory browser.
    return promptWorkspaceBrowse();
  }
}

function promptWorkspaceBrowse() {
  closePopovers();
  return new Promise((resolve) => {
    pickerResolve = resolve;
    browser = {
      parent: null,
      selected: null,
      child: null,
      home: "",
      loading: true,
      error: null,
      pathDraft: null,
      showHidden: false,
      folderDraft: null,
      creatingFolder: false,
      createError: null,
      busy: false,
    };
    renderBrowser();
    browserKeyHandler = (event) => {
      if (event.key !== "Escape" || !browser) return;
      if (browser.folderDraft !== null && !browser.creatingFolder) {
        browser.folderDraft = null;
        browser.createError = null;
        renderBrowser();
        return;
      }
      if (browser.pathDraft !== null) {
        cancelPathEdit();
        return;
      }
      if (!browser.busy) {
        const resolvePicker = pickerResolve;
        closeWorkspacePicker();
        resolvePicker?.(null);
      }
    };
    document.addEventListener("keydown", browserKeyHandler);
    api("/api/fs/roots")
      .then((data) => {
        if (!browser) return;
        browser.home = data.home || "";
        navigate(browser.home || data.roots?.[0]?.path || "");
      })
      .catch((error) => {
        if (!browser) return;
        browser.loading = false;
        browser.error = error.message || String(error);
        renderBrowser();
      });
  });
}

function closeWorkspacePicker() {
  if (browserKeyHandler) {
    document.removeEventListener("keydown", browserKeyHandler);
    browserKeyHandler = null;
  }
  browser = null;
  pickerResolve = null;
  $("#workspacePickerMount")?.remove();
}

function separatorOf() {
  return browser?.home?.includes("\\") ? "\\" : "/";
}

function levelDirectory(listing) {
  const sep = separatorOf();
  return listing.path.endsWith(sep) ? listing.path : `${listing.path}${sep}`;
}

function displayCrumbs(listing) {
  const homeIndex = listing.crumbs.findIndex((crumb) => crumb.path === listing.home);
  if (homeIndex === -1) return listing.crumbs;
  return [{ name: "主页", path: listing.home, hidden: false }, ...listing.crumbs.slice(homeIndex + 1)];
}

function draftDirectory(draft) {
  const sep = separatorOf();
  const cut = sep === "\\" ? Math.max(draft.lastIndexOf("\\"), draft.lastIndexOf("/")) : draft.lastIndexOf("/");
  return cut === -1 ? null : draft.slice(0, cut + 1);
}

function readDraft(listing, draft) {
  const directory = draftDirectory(draft);
  if (directory === null) return { directory: null, tail: null };
  const answers = directory === levelDirectory(listing);
  return { directory, tail: answers ? draft.slice(directory.length) : null };
}

function visibleEntries(entries, selectedPath, showHidden, filterPrefix) {
  const needle = filterPrefix === null ? "" : filterPrefix.toLowerCase();
  const displayable = (entry) => showHidden || !entry.hidden || needle.startsWith(".");
  const matches = (entry) => displayable(entry) && entry.name.toLowerCase().startsWith(needle);
  const narrowing = needle !== "" && entries.some(matches);
  return entries.filter((entry) => {
    if (entry.path === selectedPath) return true;
    if (narrowing) return matches(entry);
    return showHidden || !entry.hidden;
  });
}

function renderRows(entries, selectedPath, action, filterPrefix) {
  const visible = visibleEntries(entries, selectedPath, browser.showHidden, filterPrefix);
  const parentInert = browser.busy || browser.folderDraft !== null;
  return visible
    .map((entry) => {
      const selected = entry.path === selectedPath;
      return `<span class="db-rowSeat" role="listitem">
        <button type="button" ${selected ? "aria-current=\"true\"" : ""} class="db-row ${selected ? "db-rowSelected" : ""}" data-action="${action}" data-path="${esc(entry.path)}" ${parentInert ? "disabled" : ""}>
          ${selected ? ICONS.folderOpen : ICONS.folder}<span class="db-rowName">${esc(entry.name)}</span>${ICONS.chevron}
        </button>
      </span>`;
    })
    .join("");
}

function browserCrumbs() {
  const source = browser?.child ?? browser?.parent;
  return source ? displayCrumbs(source) : [];
}

function browserTargetPath() {
  return browser?.selected?.path ?? browser?.parent?.path ?? null;
}

async function navigate(path) {
  if (!browser || !path) return;
  browser.loading = true;
  browser.error = null;
  browser.selected = null;
  browser.child = null;
  renderBrowser();
  let target = null;
  try {
    const data = await api(`/api/fs/list?path=${encodeURIComponent(path)}`);
    if (!browser) return;
    if (data.error) throw new Error(data.error);
    target = data;
    browser.home = data.home || browser.home;
    browser.parent = data;
    browser.pathDraft = null;
    browser.loading = false;
    renderBrowser();
  } catch (error) {
    if (!browser) return;
    browser.loading = false;
    browser.error = error.message || String(error);
    renderBrowser();
    return;
  }
  // Two-pane landing away from the display root: anchor the target on its
  // parent level (a crumb jump reads as stepping back one pane).
  const crumbs = displayCrumbs(target);
  const parentCrumb = crumbs[crumbs.length - 2];
  if (!parentCrumb) return;
  try {
    const data = await api(`/api/fs/list?path=${encodeURIComponent(parentCrumb.path)}`);
    if (!browser || data.error) return;
    const sep = separatorOf();
    const fold = (value) => (sep === "\\" ? value.toLowerCase() : value);
    const match = (data.entries || []).find((entry) => fold(entry.path) === fold(target.path));
    if (!match) return;
    browser.parent = data;
    browser.selected = match;
    browser.child = target;
    renderBrowser();
  } catch {
    // Parent leg failed: keep the single-pane landing.
  }
}

async function selectEntry(entry) {
  if (!browser) return;
  browser.selected = entry;
  browser.child = null;
  browser.loading = true;
  browser.error = null;
  renderBrowser();
  try {
    const data = await api(`/api/fs/list?path=${encodeURIComponent(entry.path)}`);
    if (!browser) return;
    if (data.error) throw new Error(data.error);
    browser.child = data;
    browser.loading = false;
    renderBrowser();
  } catch (error) {
    if (!browser) return;
    browser.loading = false;
    browser.error = error.message || String(error);
    browser.selected = null;
    renderBrowser();
  }
}

function advanceEntry(entry) {
  if (!browser?.child) return;
  browser.parent = browser.child;
  selectEntry(entry);
}

function openPathEditor() {
  if (!browser?.parent) return;
  const sep = separatorOf();
  const base = browser.selected?.path ?? browser.parent.path;
  browser.pathDraft = base.endsWith(sep) ? base : `${base}${sep}`;
  browser.error = null;
  renderBrowser();
}

function cancelPathEdit() {
  if (!browser) return;
  browser.pathDraft = null;
  browser.error = null;
  renderBrowser();
}

async function createFolder() {
  if (!browser || browser.folderDraft === null || browser.creatingFolder) return;
  const name = browser.folderDraft;
  const target = browserTargetPath();
  if (!target || name.trim() === "") return;
  browser.creatingFolder = true;
  browser.createError = null;
  renderBrowser();
  try {
    const data = await post("/api/fs/mkdir", { path: target, name });
    if (!browser) return;
    if (data.error) throw new Error(data.error);
    const createdPath = data.path;
    browser.creatingFolder = false;
    browser.folderDraft = null;
    browser.selected = null;
    browser.child = null;
    browser.loading = true;
    renderBrowser();
    const level = await api(`/api/fs/list?path=${encodeURIComponent(target)}`);
    if (!browser) return;
    if (level.error) throw new Error(level.error);
    browser.parent = level;
    browser.home = level.home || browser.home;
    browser.loading = false;
    renderBrowser();
    await selectEntry({ name, path: createdPath, hidden: name.startsWith(".") });
  } catch (error) {
    if (!browser) return;
    browser.creatingFolder = false;
    browser.createError = error.message || String(error);
    renderBrowser();
  }
}

async function adoptWorkspace() {
  const path = browserTargetPath();
  if (!browser || !path || browser.busy || browser.pathDraft !== null) return;
  const resolve = pickerResolve;
  pickerResolve = null;
  browser.busy = true;
  renderBrowser();
  try {
    const ws = await adoptWorkspacePath(path);
    closeWorkspacePicker();
    resolve?.(ws);
  } catch (error) {
    if (!browser) return;
    browser.busy = false;
    browser.error = error.message || String(error);
    renderBrowser();
    resolve?.(null);
  }
}

function renderBrowser() {
  let mount = $("#workspacePickerMount");
  if (!mount) {
    mount = el(`<div id="workspacePickerMount"></div>`);
    document.body.appendChild(mount);
  }
  if (!browser) {
    mount.innerHTML = "";
    return;
  }
  const b = browser;
  const parentInert = b.busy || b.folderDraft !== null;
  const draftPending = b.pathDraft !== null;
  const twoPane = b.selected !== null;
  const crumbSource = b.child ?? b.parent;
  const crumbs = browserCrumbs();
  const typedPrefix = crumbSource === null || b.pathDraft === null
    ? null
    : readDraft(crumbSource, b.pathDraft).tail;
  const targetPath = browserTargetPath();
  const targetName = b.selected?.name ?? (b.parent === null ? "" : (crumbs[crumbs.length - 1]?.name ?? b.parent.path));

  const crumbsHtml = b.pathDraft === null
    ? `<span class="db-crumbTrail" role="navigation">${crumbs.map((crumb, index) => `
        <span class="db-crumbSeat">${index > 0 ? `<span class="db-crumbChevron">${ICONS.chevron}</span>` : ""}
          <button type="button" class="db-crumb" data-action="db-crumb" data-path="${esc(crumb.path)}" ${parentInert ? "disabled" : ""}>${esc(crumb.name)}</button>
        </span>`).join("")}
      </span>
      <button type="button" class="db-crumbEditZone" data-action="db-edit" title="编辑路径" aria-label="编辑路径" ${parentInert ? "disabled" : ""}>${ICONS.edit}</button>`
    : `<input id="dbPathInput" class="db-pathInput" value="${esc(b.pathDraft)}" aria-label="编辑路径" spellcheck="false">`;

  const leftFilter = twoPane ? null : typedPrefix;
  const rightFilter = twoPane ? typedPrefix : null;
  const leftHtml = `<div class="db-column">${b.parent === null ? "" : renderRows(b.parent.entries || [], b.selected?.path ?? null, "db-pick", leftFilter)}</div>`;
  const rightHtml = twoPane && b.child !== null
    ? `<span class="db-divider"></span><div class="db-column">${renderRows(b.child.entries || [], null, "db-advance", rightFilter)}</div>`
    : "";

  const createDialog = b.folderDraft !== null ? `
    <div class="db-modal db-modalNested">
      <div class="db-modalMask" data-action="db-create-cancel"></div>
      <div class="db-modalCard db-createDialog" role="dialog" aria-modal="true">
        <div class="db-createBody">
          <h3 class="db-createTitle">新建文件夹</h3>
          <p class="db-createIn">在 ${esc(targetName)} 中创建</p>
          <input id="dbCreateInput" class="db-createInput" value="${esc(b.folderDraft)}" placeholder="未命名文件夹" ${b.creatingFolder ? "disabled" : ""}>
          ${b.createError ? `<div class="db-error" role="alert">${esc(b.createError)}</div>` : ""}
          <div class="db-createActions">
            <button type="button" class="db-btn db-btnOutline" data-action="db-create-cancel" ${b.creatingFolder ? "disabled" : ""}>取消</button>
            <button type="button" class="db-btn db-btnPrimary" data-action="db-create" ${b.creatingFolder || b.folderDraft.trim() === "" ? "disabled" : ""}>创建</button>
          </div>
        </div>
      </div>
    </div>` : "";

  mount.innerHTML = `
    <div class="db-modal">
      <div class="db-modalMask" data-action="db-cancel"></div>
      <div class="db-modalCard db-dialog" role="dialog" aria-modal="true" aria-label="选择工作区目录">
        <div class="db-header">
          <h2 class="db-title">选择工作区目录</h2>
          <div class="db-crumbBar">${crumbsHtml}</div>
        </div>
        <div class="db-content">
          <div class="db-millerRow">${leftHtml}${rightHtml}</div>
          ${b.loading ? `<div class="db-status db-loadingFloat" role="status">加载中…</div>` : ""}
          ${b.error ? `<div class="db-error" role="alert">${esc(b.error)}</div>` : ""}
        </div>
        <div class="db-footerBar">
          <button type="button" class="db-btn db-btnOutline" data-action="db-new-folder" ${b.parent === null || b.loading || parentInert || draftPending ? "disabled" : ""}>${ICONS.plus}<span>新建文件夹</span></button>
          <button type="button" class="db-showHiddenToggle ${b.showHidden ? "db-showHiddenToggleActive" : ""}" aria-pressed="${b.showHidden}" data-action="db-toggle-hidden" ${parentInert ? "disabled" : ""}>显示隐藏文件${b.showHidden ? ICONS.check : ""}</button>
          <span class="db-footerGap"></span>
          <button type="button" class="db-btn db-btnOutline db-footerAction" data-action="db-cancel">取消</button>
          <button type="button" class="db-btn db-btnPrimary db-footerAction" data-action="db-open" ${targetPath === null || b.loading || parentInert || draftPending ? "disabled" : ""}>打开</button>
        </div>
      </div>
    </div>
    ${createDialog}`;

  const pathInput = $("#dbPathInput");
  if (pathInput) {
    const start = pathInput.selectionStart;
    const end = pathInput.selectionEnd;
    pathInput.focus();
    if (start != null && end != null && start === end) pathInput.setSelectionRange(start, end);
    pathInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        const value = pathInput.value;
        if (value.trim() !== "") navigate(value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelPathEdit();
      }
    });
    pathInput.addEventListener("input", () => {
      const caret = pathInput.selectionStart ?? pathInput.value.length;
      b.pathDraft = pathInput.value;
      renderBrowser();
      const next = $("#dbPathInput");
      if (next) next.setSelectionRange(caret, caret);
    });
  }
  const createInput = $("#dbCreateInput");
  if (createInput) {
    createInput.focus();
    createInput.addEventListener("input", () => {
      b.folderDraft = createInput.value;
      const createBtn = mount.querySelector('[data-action="db-create"]');
      if (createBtn) createBtn.disabled = b.creatingFolder || b.folderDraft.trim() === "";
    });
    createInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        createFolder();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!b.creatingFolder) {
          b.folderDraft = null;
          b.createError = null;
          renderBrowser();
        }
      }
    });
  }
}

async function refreshWorkspaces() {
  const boot = await api("/api/bootstrap");
  S.workspaces = applySavedWorkspaceOrder(boot.workspaces || []);
  return S.workspaces;
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const previous = document.activeElement;
    const field = document.createElement("textarea");
    field.value = value;
    field.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px";
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    previous?.focus({ preventScroll: true });
    if (copied) return true;
    const dialog = el(`<div class="pi-dialogBackdrop"><div class="pi-dialogCard" role="dialog" aria-label="手动复制"><div class="pi-dialogTitle">长按文本复制</div><textarea class="pi-copyField" readonly>${esc(value)}</textarea><button type="button" class="pi-settingsAction">关闭</button></div></div>`);
    dialog.querySelector("button").onclick = () => dialog.remove();
    document.body.appendChild(dialog);
    return false;
  }
}

let toastTimer = 0;
function showToast(message, type = "info") {
  $(".pi-toast")?.remove();
  const toast = el(`<div class="pi-toast pi-toast-${esc(type)}" role="status">${esc(message)}</div>`);
  document.body.appendChild(toast);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.remove(), 3600);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRuntimeReload(previousInstanceId, generation) {
  const deadline = Date.now() + 60_000;
  let sawOffline = false;
  while (Date.now() < deadline && generation === S.maintenanceGeneration) {
    await delay(300);
    try {
      const boot = await api(`/api/bootstrap?reload=${Date.now()}`);
      const changed = boot.instanceId && boot.instanceId !== previousInstanceId;
      if (changed || (sawOffline && !boot.instanceId)) {
        location.reload();
        return;
      }
    } catch {
      sawOffline = true;
    }
  }
  if (generation === S.maintenanceGeneration) throw new Error("重新加载超时，请刷新页面后重试");
}

async function runMaintenance(kind) {
  if (S.maintenanceBusy) return;
  const generation = ++S.maintenanceGeneration;
  S.maintenanceBusy = kind;
  S.maintenanceMessage = {
    type: "info",
    text: kind === "update" ? "正在更新扩展，请勿关闭页面…" : "正在重新加载 Pi 运行时…",
  };
  renderOverlay();
  try {
    const endpoint = kind === "update"
      ? "/api/maintenance/update-and-reload"
      : "/api/maintenance/reload";
    const data = await post(endpoint);
    const previousInstanceId = data.instanceId || S.serverInstanceId;
    S.maintenanceMessage = {
      type: "success",
      text: kind === "update" ? "扩展更新完成，正在应用新版本…" : "重载已启动，正在恢复 Web UI…",
    };
    renderOverlay();
    await waitForRuntimeReload(previousInstanceId, generation);
  } catch (error) {
    if (generation !== S.maintenanceGeneration) return;
    S.maintenanceBusy = null;
    S.maintenanceMessage = { type: "error", text: error.message || String(error) };
    renderOverlay();
  }
}

async function exportSessionLog(sessionId) {
  if (!sessionId) {
    showToast("当前没有可导出的会话", "warning");
    return;
  }
  const data = await post(`/api/sessions/${encodeURIComponent(sessionId)}/export_html`);
  if (data.downloadUrl) {
    const link = document.createElement("a");
    link.href = data.downloadUrl;
    link.download = data.filename || "pi-session.html";
    document.body.appendChild(link);
    link.click();
    link.remove();
    showToast(`已下载到浏览器下载目录：${data.filename || "pi-session.html"}`);
  } else if (data.path) {
    showToast(`已导出：${data.path}`);
  } else {
    showToast("会话导出失败", "error");
  }
}

function insertComposerText(text) {
  if (!text) return;
  const input = $("#composerInput");
  const current = input?.value ?? S.draft;
  const start = input?.selectionStart ?? current.length;
  const end = input?.selectionEnd ?? start;
  const before = current.slice(0, start);
  const after = current.slice(end);
  const prefix = before && !/\s$/.test(before) ? " " : "";
  const suffix = after && !/^\s/.test(after) ? " " : "";
  const insertion = `${prefix}${text}${suffix}`;
  setDraftValue(`${before}${insertion}${after}`);
  closeCommandMenu();
  if (input) {
    input.value = S.draft;
    const cursor = before.length + insertion.length;
    input.setSelectionRange(cursor, cursor);
    input.focus({ preventScroll: true });
    syncComposerInput();
  }
}

function setClipboardBusy(busy) {
  S.clipboardBusy = busy;
  const button = $('[data-action="paste-image"]');
  if (button) {
    button.disabled = busy;
    button.toggleAttribute("data-loading", busy);
  }
}

async function deleteImageAttachment(id) {
  if (!id) return;
  await api(`/api/attachments/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
}

function readImageData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("无法读取图片"));
    reader.readAsDataURL(file);
  });
}

async function uploadImages(files) {
  if (S.clipboardBusy || !files.length) return;
  if (!modelSupportsImages()) return showToast("当前模型不支持图片输入，请先切换视觉模型", "warning");
  if (S.draftAttachments.length + files.length > 4) return showToast("每条消息最多附加 4 张图片", "warning");
  if (files.some((file) => file.size > 15 * 1024 * 1024)) return showToast("图片不能超过 15 MB", "warning");
  const key = draftKey();
  setClipboardBusy(true);
  try {
    for (const file of files) {
      const data = await post("/api/attachments", { data: await readImageData(file) });
      if (draftKey() !== key) {
        await deleteImageAttachment(data.attachment?.id);
        showToast("会话已切换，本次上传已取消", "warning");
        break;
      }
      setDraftAttachments([...S.draftAttachments, data.attachment]);
    }
    queueRender(true, { conversation: true });
  } catch (error) {
    showToast(error.message || String(error), "error");
  } finally {
    setClipboardBusy(false);
  }
}

async function pasteSystemClipboard() {
  if (!S.localClient) {
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = "image/png,image/jpeg,image/gif,image/webp,image/bmp";
    picker.multiple = true;
    picker.addEventListener("change", () => { void uploadImages([...picker.files]); });
    picker.click();
    return;
  }
  if (S.clipboardBusy) return;
  if (!modelSupportsImages()) {
    showToast("当前模型不支持图片输入，请先切换视觉模型", "warning");
    return;
  }
  if (S.draftAttachments.length >= 4) {
    showToast("每条消息最多附加 4 张图片", "warning");
    return;
  }
  const sessionId = S.currentSessionId;
  setClipboardBusy(true);
  try {
    const data = await post("/api/clipboard/paste");
    if (S.currentSessionId !== sessionId) {
      if (data.kind === "image") await deleteImageAttachment(data.attachment?.id);
      showToast("会话已切换，本次粘贴已取消", "warning");
      return;
    }
    if (data.kind === "image") {
      if (!data.attachment?.id || !data.attachment?.url) throw new Error("服务端未返回有效图片附件");
      setDraftAttachments([...S.draftAttachments, data.attachment]);
      queueRender(true, { conversation: true });
      showToast("图片已附加到消息");
    } else {
      if (!data.text) throw new Error("剪贴板内容为空");
      insertComposerText(data.text);
      showToast("已粘贴剪贴板文本");
    }
  } catch (error) {
    showToast(error.message || String(error), "error");
  } finally {
    setClipboardBusy(false);
  }
}

function restoreMessagesToDraft(sessionId, messages) {
  const restored = Array.isArray(messages)
    ? messages.filter((message) => typeof message === "string" && message.trim())
    : [];
  if (!restored.length) return 0;
  const restoredText = restored.join("\n\n");
  if (S.currentSessionId === sessionId) {
    setDraftValue([S.draft, restoredText].filter((value) => value?.trim()).join("\n\n"));
    const input = $("#composerInput");
    if (input) {
      input.value = S.draft;
      input.setSelectionRange(input.value.length, input.value.length);
      syncComposerInput();
    }
  } else {
    const failedDrafts = S.failedDrafts.get(sessionId) || [];
    failedDrafts.push(...restored);
    S.failedDrafts.set(sessionId, failedDrafts);
  }
  return restored.length;
}

function applyPendingQueueSnapshot(sessionId, pendingQueue) {
  if (!sessionId || !pendingQueue) return;
  const snapshot = snapshotFor(sessionId);
  const steering = Array.isArray(pendingQueue.steering) ? pendingQueue.steering : [];
  const followUp = Array.isArray(pendingQueue.followUp) ? pendingQueue.followUp : [];
  S.snapshots.set(sessionId, {
    ...snapshot,
    pendingQueue: { steering, followUp },
    state: {
      ...(snapshot.state || {}),
      pendingMessageCount: steering.length + followUp.length,
    },
  });
}

function focusComposerEnd() {
  requestAnimationFrame(() => {
    const input = $("#composerInput");
    input?.focus({ preventScroll: true });
    input?.setSelectionRange(input.value.length, input.value.length);
  });
}

async function withdrawQueuedMessage(target) {
  const sessionId = S.currentSessionId;
  const kind = target.dataset.queueKind;
  const index = Number(target.dataset.queueIndex);
  const queue = snapshotFor(sessionId).pendingQueue?.[kind];
  const message = Array.isArray(queue) && Number.isInteger(index) ? queue[index] : undefined;
  if (!sessionId || (kind !== "steering" && kind !== "followUp") || typeof message !== "string") {
    showToast("队列已经变化，请重试", "warning");
    return;
  }

  const busyKey = queueItemBusyKey(sessionId, kind, index, message);
  if (S.withdrawingQueueItems.has(busyKey) || S.dequeueSessions.has(sessionId)) return;
  S.withdrawingQueueItems.add(busyKey);
  queueRender(true, { sidebar: false, conversation: true, overlay: false });
  try {
    const result = await post(`/api/sessions/${encodeURIComponent(sessionId)}/withdraw_queue`, { kind, index, message });
    applyPendingQueueSnapshot(sessionId, result.pendingQueue);
    restoreMessagesToDraft(sessionId, [message]);
    showToast("消息已撤回到输入框");
    focusComposerEnd();
  } catch (error) {
    applyPendingQueueSnapshot(sessionId, error.data?.pendingQueue);
    const restored = [
      ...(error.data?.withdrawn ? [message] : []),
      ...(Array.isArray(error.data?.unrestoredMessages) ? error.data.unrestoredMessages : []),
    ];
    const restoredCount = restoreMessagesToDraft(sessionId, restored);
    showToast(
      restoredCount > 0 ? `${error.message}；${restoredCount} 条消息已恢复到输入框` : error.message,
      "error",
    );
    if (restoredCount > 0) focusComposerEnd();
  } finally {
    S.withdrawingQueueItems.delete(busyKey);
    queueRender(true, { sidebar: false, conversation: true, overlay: false });
  }
}

async function restoreAllQueuedMessages() {
  const sessionId = S.currentSessionId;
  if (!sessionId || S.dequeueSessions.has(sessionId)) return;
  if (pendingQueueEntries(snapshotFor(sessionId)).length === 0) {
    showToast("没有待恢复的队列消息", "warning");
    return;
  }

  S.dequeueSessions.add(sessionId);
  queueRender(true, { sidebar: false, conversation: true, overlay: false });
  try {
    const result = await post(`/api/sessions/${encodeURIComponent(sessionId)}/dequeue`);
    applyPendingQueueSnapshot(sessionId, result.pendingQueue || { steering: [], followUp: [] });
    const restoredCount = restoreMessagesToDraft(sessionId, result.restoredMessages);
    showToast(`${restoredCount} 条队列消息已恢复到输入框`);
    focusComposerEnd();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    S.dequeueSessions.delete(sessionId);
    queueRender(true, { sidebar: false, conversation: true, overlay: false });
  }
}

function clearComposerDraft(options = {}) {
  setDraftValue("");
  if (options.attachments) setDraftAttachments([]);
  closeCommandMenu();
  const input = $("#composerInput");
  if (input) {
    input.value = "";
    syncComposerInput();
  }
}

async function executeLocalSlashCommand(text) {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return false;
  const name = match[1];
  const args = (match[2] || "").trim();
  if (!WEB_SLASH_COMMANDS.some((command) => command.name === name) && name !== "thinking") return false;

  const sessionId = S.currentSessionId;
  clearComposerDraft();
  if (name === "model") {
    await openModelSelector($('[data-action="model-menu"]'));
  } else if (name === "thinking") {
    await openThinkingSelector($('[data-action="thinking-menu"]'));
  } else if (name === "settings") {
    S.settingsOpen = true;
    closePopovers();
    renderOverlay();
    void loadNetworkSettings();
  } else if (name === "new") {
    await ensureWorkspaceThen((ws) => createAndOpenSession(ws.id, ""));
  } else if (name === "rewind" || name === "tree") {
    await openHistoryView(name === "tree" ? "tree" : "rewind");
  } else if (name === "compact") {
    if (!sessionId) showToast("当前没有可压缩的会话", "warning");
    else {
      showToast("正在压缩当前会话…");
      await post(`/api/sessions/${encodeURIComponent(sessionId)}/compact`);
      showToast("上下文压缩完成");
    }
  } else if (name === "name") {
    if (!sessionId) showToast("请先创建会话", "warning");
    else {
      const value = args || prompt("会话名称：", snapshotFor(sessionId).session?.title || "");
      if (value?.trim()) {
        await post(`/api/sessions/${encodeURIComponent(sessionId)}/set_name`, { name: value.trim() });
        showToast("会话名称已更新");
      }
    }
  } else if (name === "export") {
    await exportSessionLog(sessionId);
  } else if (name === "copy") {
    const assistant = [...(currentSnapshot().messages || [])].reverse().find((message) => message.kind === "assistant");
    const value = assistantMessageText(assistant);
    if (!value) showToast("暂无可复制的助手回复", "warning");
    else {
      if (await copyText(value)) showToast("已复制最后一条助手回复");
    }
  } else if (name === "session") {
    const snap = currentSnapshot();
    const stats = snap.stats || {};
    const tokens = stats.tokens || {};
    const cu = stats.contextUsage || {};
    alert([
      `会话：${snap.session?.title || "新会话"}`,
      `路径：${snap.session?.cwd || "-"}`,
      `模型：${snap.state?.model?.provider || "-"}/${snap.state?.model?.id || "-"} · 思考 ${thinkingLabel(snap.state?.thinkingLevel || "off")}`,
      `上下文：${fmtNum(cu.tokens ?? 0)} / ${fmtNum(cu.contextWindow ?? 0)} tok（${Math.round(cu.percent ?? 0)}%）`,
      `输入 ${fmtNum(tokens.input ?? 0)} · 输出 ${fmtNum(tokens.output ?? 0)} tok · 成本 ${typeof stats.cost === "number" ? formatCost(stats.cost) : "-"}`,
    ].join("\n"));
  }
  return true;
}

async function sendDraft() {
  const text = S.draft.trim();
  const attachments = [...S.draftAttachments];
  if (!text && attachments.length === 0) return;
  if (attachments.length > 0) {
    if (currentSnapshot().session?.streaming) {
      showToast("生成过程中暂不支持排队图片，请停止当前生成后再发送", "warning");
      return;
    }
    if (!modelSupportsImages()) {
      showToast("当前模型不支持图片输入，请切换视觉模型", "warning");
      return;
    }
    if (text.startsWith("/")) {
      showToast("斜杠命令不能附带图片", "warning");
      return;
    }
  }
  try {
    if (attachments.length === 0 && await executeLocalSlashCommand(text)) return;
  } catch (error) {
    showToast(error.message || String(error), "error");
    return;
  }
  let sessionId = S.currentSessionId;
  if (!sessionId) {
    const ws = currentWorkspace();
    if (!ws) {
      const added = await promptWorkspace();
      if (!added) return;
      S.currentWorkspaceId = added.id;
    }
    const title = text.slice(0, 40) || "图片会话";
    sessionId = await createAndOpenSession(S.currentWorkspaceId || currentWorkspace().id, title, { keepDraft: true });
    if (!sessionId) return;
  }
  clearComposerDraft({ attachments: true });
  S.pendingSends.set(sessionId, (S.pendingSends.get(sessionId) || 0) + 1);
  queueRender(true);
  try {
    const result = await post(`/api/sessions/${encodeURIComponent(sessionId)}/prompt`, {
      message: text,
      attachmentIds: attachments.map((attachment) => attachment.id),
    });
    if (result?.queued && S.currentSessionId === sessionId) {
      showToast("消息已加入当前执行队列");
    }
  } catch (error) {
    const isCurrentSession = S.currentSessionId === sessionId;
    if (isCurrentSession) {
      const currentDraft = S.draft.trim();
      if (text) {
        if (!currentDraft) setDraftValue(text);
        else setDraftValue(`${S.draft}\n\n${text}`);
      }
      const knownIds = new Set(S.draftAttachments.map((attachment) => attachment.id));
      setDraftAttachments([...S.draftAttachments, ...attachments.filter((attachment) => !knownIds.has(attachment.id))]);
      const input = $("#composerInput");
      if (input) {
        input.value = S.draft;
        input.setSelectionRange(input.value.length, input.value.length);
        syncComposerInput();
      }
    } else {
      if (text) {
        const failedDrafts = S.failedDrafts.get(sessionId) || [];
        failedDrafts.push(text);
        S.failedDrafts.set(sessionId, failedDrafts);
      }
      const failedAttachments = S.failedAttachmentDrafts.get(sessionId) || [];
      failedAttachments.push(...attachments);
      S.failedAttachmentDrafts.set(sessionId, failedAttachments);
    }
    showToast(`发送失败，消息已保留${isCurrentSession ? "在输入框中" : "到原会话草稿"}：${error.message}`, "error");
  } finally {
    const pending = Math.max(0, (S.pendingSends.get(sessionId) || 1) - 1);
    if (pending > 0) S.pendingSends.set(sessionId, pending);
    else S.pendingSends.delete(sessionId);
    queueRender(true);
  }
}

async function respondDialog(id, payload) {
  const sid = S.currentSessionId;
  if (!sid) return;
  try {
    await post(`/api/sessions/${encodeURIComponent(sid)}/extension_ui_response`, { id, ...payload });
  } catch (error) {
    alert(error.message);
  }
  queueRender(true);
}

let globalClickHandler = null;
let globalWarmHandler = null;
let globalKeyHandler = null;
let globalPointerHandler = null;
let globalDragStartHandler = null;
let globalDragOverHandler = null;
let globalDropHandler = null;
let globalDragEndHandler = null;
function bindGlobalEvents() {
  if (globalClickHandler) document.removeEventListener("click", globalClickHandler, true);
  globalClickHandler = onClick;
  document.addEventListener("click", globalClickHandler, true);
  if (globalWarmHandler) document.removeEventListener("pointerover", globalWarmHandler, true);
  globalWarmHandler = onWarmHover;
  document.addEventListener("pointerover", globalWarmHandler, true);
  if (globalKeyHandler) document.removeEventListener("keydown", globalKeyHandler, true);
  globalKeyHandler = onGlobalKeydown;
  document.addEventListener("keydown", globalKeyHandler, true);
  if (globalPointerHandler) document.removeEventListener("pointerdown", globalPointerHandler, true);
  globalPointerHandler = onPanelResizeStart;
  document.addEventListener("pointerdown", globalPointerHandler, true);
  if (globalDragStartHandler) document.removeEventListener("dragstart", globalDragStartHandler, true);
  globalDragStartHandler = onWorkspaceDragStart;
  document.addEventListener("dragstart", globalDragStartHandler, true);
  if (globalDragOverHandler) document.removeEventListener("dragover", globalDragOverHandler, true);
  globalDragOverHandler = onWorkspaceDragOver;
  document.addEventListener("dragover", globalDragOverHandler, true);
  if (globalDropHandler) document.removeEventListener("drop", globalDropHandler, true);
  globalDropHandler = onWorkspaceDrop;
  document.addEventListener("drop", globalDropHandler, true);
  if (globalDragEndHandler) document.removeEventListener("dragend", globalDragEndHandler, true);
  globalDragEndHandler = onWorkspaceDragEnd;
  document.addEventListener("dragend", globalDragEndHandler, true);
}

function persistPanelWidth(side) {
  if (side === "sidebar") localStorage.setItem("pi-web-sidebar-width", String(Math.round(S.sidebarWidth)));
  else localStorage.setItem("pi-web-file-preview-width", String(Math.round(S.filePreviewWidth)));
}

function updatePanelWidth(side, value, persist = false) {
  const frame = $(".pI_x6G_frame");
  if (!frame) return;
  const frameWidth = frame.clientWidth || window.innerWidth;
  const { sidebarWidth, previewWidth } = currentPanelWidths();
  if (side === "sidebar") {
    const max = Math.min(420, Math.max(220, frameWidth - previewWidth - 360));
    S.sidebarWidth = clampPanelWidth(value, 220, max);
  } else {
    const max = Math.min(960, Math.max(320, frameWidth - sidebarWidth - 360));
    S.filePreviewWidth = clampPanelWidth(value, 320, max);
  }
  applyFrameLayout();
  if (persist) persistPanelWidth(side);
}

function onPanelResizeStart(event) {
  const handle = event.target.closest(".pI_x6G_handle[data-side]");
  if (!handle || event.button !== 0 || matchMedia("(max-width: 900px)").matches) return;
  const side = handle.dataset.side;
  if ((side === "sidebar" && S.sidebarCollapsed) || (side === "details" && !S.filePreview)) return;
  const frame = handle.closest(".pI_x6G_frame");
  const rect = frame.getBoundingClientRect();
  event.preventDefault();
  frame.toggleAttribute("data-dragging", true);
  handle.dataset.dragging = "true";
  document.body.toggleAttribute("data-panel-resizing", true);

  const move = (moveEvent) => {
    const width = side === "sidebar" ? moveEvent.clientX - rect.left : rect.right - moveEvent.clientX;
    updatePanelWidth(side, width);
    moveEvent.preventDefault();
  };
  const finish = () => {
    document.removeEventListener("pointermove", move, true);
    document.removeEventListener("pointerup", finish, true);
    document.removeEventListener("pointercancel", finish, true);
    frame.removeAttribute("data-dragging");
    delete handle.dataset.dragging;
    document.body.removeAttribute("data-panel-resizing");
    persistPanelWidth(side);
  };
  document.addEventListener("pointermove", move, true);
  document.addEventListener("pointerup", finish, true);
  document.addEventListener("pointercancel", finish, true);
}

function onGlobalKeydown(event) {
  const workspaceRow = event.target.closest?.(".YDXeBa_projectRow[data-workspace][draggable=true]");
  if (workspaceRow && event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
    if (moveWorkspaceByOffset(workspaceRow.dataset.workspace, event.key === "ArrowUp" ? -1 : 1)) {
      event.preventDefault();
    }
    return;
  }
  const panelHandle = event.target.closest?.(".pI_x6G_handle[data-side]");
  if (panelHandle && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    event.preventDefault();
    const side = panelHandle.dataset.side;
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const current = side === "sidebar" ? S.sidebarWidth : S.filePreviewWidth;
    updatePanelWidth(side, current + (side === "sidebar" ? direction : -direction) * 24, true);
    return;
  }
  if (S.settingsOpen) {
    if (event.key === "Escape" && !S.maintenanceBusy) {
      event.preventDefault();
      S.settingsOpen = false;
      renderOverlay();
    }
    return;
  }
  if (S.historyView) {
    const activeTab = event.target?.closest?.(".pi-historyTab");
    if (activeTab && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      const mode = activeTab.dataset.mode === "rewind" ? "tree" : "rewind";
      S.historyView = { ...S.historyView, mode, error: null };
      renderConversation();
      requestAnimationFrame(() => $(`.pi-historyTab[data-mode="${mode}"]`)?.focus());
      return;
    }
    return;
  }
  const composerInput = $("#composerInput");
  if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "q" && document.activeElement === composerInput) {
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) void restoreAllQueuedMessages();
    return;
  }
  if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "v" && document.activeElement === composerInput && !currentSnapshot().dialogs?.length) {
    event.preventDefault();
    event.stopPropagation();
    void pasteSystemClipboard();
  }
}

function onWarmHover(ev) {
  const row = ev.target?.closest?.(".YDXeBa_sessionRow[data-session]");
  if (!row || row.dataset.newSession) return;
  const id = row.dataset.session;
  if (!id || S.warmSent?.has(id)) return;
  S.warmSent = S.warmSent || new Set();
  S.warmSent.add(id);
  post(`/api/sessions/${encodeURIComponent(id)}/warm`).catch(() => {
    S.warmSent.delete(id);
  });
}

async function onClick(ev) {
  if (S.searchOpen && !ev.target.closest(".qDHVXG_search")) {
    S.searchOpen = false;
    S.search = "";
    queueMicrotask(renderSidebar);
  }
  const fileLink = ev.target.closest("a.md-local-file");
  if (fileLink && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && !ev.altKey) {
    ev.preventDefault();
    closePopovers();
    await openFilePreview(
      fileLink.dataset.filePath,
      fileLink.dataset.fileLine ? Number(fileLink.dataset.fileLine) : null,
      fileLink.href,
    );
    return;
  }
  if (S.commandMenuOpen && !ev.target.closest(".pi-commandMenu, #composerInput, [data-action=commands]")) closeCommandMenu();
  const target = ev.target.closest("[data-action]");
  if (!target) {
    const newRow = ev.target.closest(".YDXeBa_sessionRow[data-new-session]");
    if (newRow) {
      closePopovers();
      await createAndOpenSession(newRow.dataset.workspace, "");
      return;
    }
    const sessionRow = ev.target.closest(".YDXeBa_sessionRow[data-session]");
    if (sessionRow) {
      closePopovers();
      await openSession(sessionRow.dataset.session);
      return;
    }
    const projectRow = ev.target.closest(".YDXeBa_projectRow[data-workspace]");
    if (projectRow) {
      const id = projectRow.dataset.workspace;
      if (S.collapsed.has(id)) S.collapsed.delete(id);
      else S.collapsed.add(id);
      queueRender(true);
      return;
    }
    if (!ev.target.closest(".pi-popover") && !ev.target.closest(".pi-popoverAnchor")) closePopovers();
    return;
  }
  const action = target.dataset.action;
  const sessionId = target.dataset.session || S.currentSessionId;
  if (action === "jump-conversation") {
    jumpToConversationTurn(target.dataset.turnTarget);
  } else if (action === "scroll-bottom") {
    scrollConversationToBottom();
  } else if (action === "file-preview-close") {
    closeFilePreview();
  } else if (action === "file-preview-reveal") {
    const path = S.filePreview?.path;
    if (!path) return;
    target.disabled = true;
    try {
      const result = await post("/api/fs/reveal", { path });
      showToast(`已在系统文件管理器中打开 ${result.path}`, "success");
    } catch (error) {
      showToast(error.message || String(error), "error");
    } finally {
      target.disabled = false;
    }
  } else if (action === "toggle-session-list") {
    const workspaceId = target.dataset.workspace;
    if (S.expandedSessionLists.has(workspaceId)) S.expandedSessionLists.delete(workspaceId);
    else S.expandedSessionLists.add(workspaceId);
    renderSidebar();
  } else if (action === "new-session") {
    await ensureWorkspaceThen(async (ws) => {
      await createAndOpenSession(ws.id, "");
    });
  } else if (action === "new-session-in-workspace") {
    const workspaceId = target.dataset.workspace;
    S.collapsed.delete(workspaceId);
    renderSidebar();
    await createAndOpenSession(workspaceId, "");
  } else if (action === "add-workspace" || action === "hero-workspace") {
    await promptWorkspace();
  } else if (action === "select-workspace") {
    rememberCurrentDraft();
    S.currentWorkspaceId = target.dataset.workspace;
    const ws = S.workspaces.find((w) => w.id === S.currentWorkspaceId);
    const first = sessionsByRecency(ws)[0];
    if (first) await openSession(first.id);
    else {
      ++S.openGeneration;
      S.currentSessionId = null;
      S.loadingSession = null;
      loadCurrentDraftValue();
      queueRender(true);
    }
  } else if (action === "brand") {
    if (S.currentSessionId) {
      rememberCurrentDraft();
      ++S.openGeneration;
      S.currentSessionId = null;
      S.loadingSession = null;
      loadCurrentDraftValue();
    }
    queueRender(true);
  } else if (action === "open-mobile-sidebar") {
    S.mobileSidebarOpen = true;
    applyFrameLayout();
    renderSidebar();
  } else if (action === "close-mobile-sidebar") {
    S.mobileSidebarOpen = false;
    applyFrameLayout();
  } else if (action === "collapse-sidebar") {
    if (usesMobileSidebar()) {
      S.mobileSidebarOpen = false;
    } else {
      S.sidebarCollapsed = !S.sidebarCollapsed;
      localStorage.setItem("pi-web-sidebar-collapsed", S.sidebarCollapsed ? "1" : "0");
    }
    applyFrameLayout();
    renderSidebar();
  } else if (action === "settings") {
    S.settingsOpen = true;
    closePopovers();
    renderOverlay();
    void loadNetworkSettings();
  } else if (action === "settings-close") {
    if (!S.maintenanceBusy) {
      S.settingsOpen = false;
      S.maintenanceMessage = null;
      renderOverlay();
    }
  } else if (action === "choose-theme") {
    setTheme(target.dataset.theme || "system");
    renderOverlay();
  } else if (action === "maintenance-update-reload") {
    await runMaintenance("update");
  } else if (action === "maintenance-reload") {
    await runMaintenance("reload");
  } else if (action === "focus-search") {
    S.searchOpen = !S.searchOpen;
    if (!S.searchOpen) S.search = "";
    queueRender(true, { sidebar: true });
    if (S.searchOpen) {
      const input = $("#sessionSearchInput");
      input?.focus();
    }
  } else if (action === "send") {
    await sendDraft();
  } else if (action === "paste-image") {
    await pasteSystemClipboard();
  } else if (action === "remove-attachment") {
    const attachmentId = target.dataset.attachmentId;
    setDraftAttachments(S.draftAttachments.filter((attachment) => attachment.id !== attachmentId));
    await deleteImageAttachment(attachmentId);
    queueRender(true, { conversation: true });
  } else if (action === "withdraw-queued-message") {
    await withdrawQueuedMessage(target);
  } else if (action === "conversation-tab") {
    showConversationView();
  } else if (action === "history-current" || action === "history-open") {
    closePopovers();
    if (sessionId && sessionId !== S.currentSessionId) await openSession(sessionId);
    await openHistoryView("rewind");
  } else if (action === "history-mode") {
    if (S.historyView) {
      S.historyView = { ...S.historyView, mode: target.dataset.mode === "tree" ? "tree" : "rewind", selectedEntryId: null, error: null };
      renderConversation();
    }
  } else if (action === "history-choose-rewind") {
    if (S.historyView && !S.historyView.busyEntryId) {
      S.historyView = { ...S.historyView, selectedEntryId: target.dataset.entry, error: null };
      renderConversation();
    }
  } else if (action === "history-rewind-mode") {
    await navigateHistory(target.dataset.entry, target.dataset.role, target.dataset.restoreMode);
  } else if (action === "history-rewind-cancel") {
    if (S.historyView && !S.historyView.busyEntryId) {
      S.historyView = { ...S.historyView, selectedEntryId: null, error: null };
      renderConversation();
    }
  } else if (action === "abort") {
    if (sessionId) {
      target.disabled = true;
      try {
        const result = await post(`/api/sessions/${encodeURIComponent(sessionId)}/abort`);
        const restoredCount = restoreMessagesToDraft(sessionId, result.restoredMessages);
        const message = restoredCount
          ? `已停止生成，${restoredCount} 条待处理消息已恢复到输入框`
          : result.forced ? result.warning || "生成未响应，已重启该会话" : "已请求停止生成";
        showToast(message, result.forced ? "warning" : "info");
      } catch (error) {
        showToast(error.message, "error");
      } finally {
        target.disabled = false;
        queueRender(true);
      }
    }
  } else if (action === "model-menu") {
    await openModelSelector(target);
  } else if (action === "thinking-menu") {
    await openThinkingSelector(target);
  } else if (action === "choose-model") {
    const snap = currentSnapshot();
    const selected = (snap.models || []).find(
      (model) => model.provider === target.dataset.provider && model.id === target.dataset.model,
    );
    const key = `${target.dataset.provider}/${target.dataset.model}`;
    const thinkingLevels = snap.thinkingLevelsByModel?.[key] || (selected?.reasoning === false ? ["off"] : snap.thinkingLevels || ["off"]);
    const thinkingLevel = thinkingLevels.includes(snap.state?.thinkingLevel) ? snap.state.thinkingLevel : thinkingLevels.includes("off") ? "off" : thinkingLevels[0] || "off";
    if (sessionId) {
      try {
        await post(`/api/sessions/${encodeURIComponent(sessionId)}/set_model`, { provider: target.dataset.provider, modelId: target.dataset.model });
      } catch (error) {
        showToast(error.message, "error");
        return;
      }
      if (selected) {
        S.snapshots.set(sessionId, { ...snap, state: { ...(snap.state || {}), model: selected, thinkingLevel }, thinkingLevels });
      }
    } else if (selected) {
      S.newSessionSnapshot = {
        ...snap,
        state: { ...(snap.state || {}), model: selected, thinkingLevel },
        thinkingLevels,
      };
    }
    closePopovers();
    queueRender(true);
  } else if (action === "choose-thinking") {
    if (sessionId) {
      try {
        await post(`/api/sessions/${encodeURIComponent(sessionId)}/set_thinking_level`, { level: target.dataset.level });
      } catch (error) {
        showToast(error.message, "error");
        return;
      }
      const snap = snapshotFor(sessionId);
      S.snapshots.set(sessionId, { ...snap, state: { ...(snap.state || {}), thinkingLevel: target.dataset.level } });
    } else if (S.newSessionSnapshot) {
      S.newSessionSnapshot = {
        ...S.newSessionSnapshot,
        state: { ...(S.newSessionSnapshot.state || {}), thinkingLevel: target.dataset.level },
      };
    }
    closePopovers();
    queueRender(true);
  } else if (action === "choose-command") {
    const command = availableSlashCommands().find((item) => item.name === target.dataset.command);
    await applyCommandSuggestion(command, false);
  } else if (action === "copy-text") {
    if (await copyText(target.dataset.text || "")) showToast("已复制");
  } else if (action === "copy-assistant-message") {
    const messageIndex = Number.parseInt(target.dataset.messageIndex || "", 10);
    const message = currentSnapshot().messages?.[messageIndex];
    const value = message?.kind === "assistant" ? assistantMessageText(message) : "";
    if (!value) {
      showToast("这条 AI 回复没有可复制的正文", "warning");
      return;
    }
    try {
      if (await copyText(value)) showToast("已复制本条 AI 回复");
    } catch (error) {
      showToast(`复制失败：${error.message || String(error)}`, "error");
    }
  } else if (action === "toggle-tool") {
    const card = target.closest(".CY-8Ka_root");
    const row = target.closest(".ztWv_q_callRow");
    const detail = row?.querySelector(".Sxvs8a_root");
    const expanded = detail ? !detail.hidden : false;
    if (detail) detail.hidden = expanded;
    card?.setAttribute("aria-expanded", String(!expanded));
    const toolKey = row?.dataset.toolKey;
    if (toolKey) {
      if (expanded) S.expandedTools.delete(toolKey);
      else S.expandedTools.add(toolKey);
    }
  } else if (action === "toggle-thinking") {
    const detail = target.closest(".QWLzlG_root")?.querySelector(".QWLzlG_detail");
    const row = target.closest(".QWLzlG_row");
    if (detail) {
      detail.hidden = !detail.hidden;
      row?.setAttribute("aria-expanded", String(!detail.hidden));
    }
  } else if (action === "toggle-compaction") {
    const row = target.closest(".pi-compactionCard");
    const detail = row?.querySelector(".gdEzaW_compactionBody");
    if (detail) {
      detail.hidden = !detail.hidden;
      target.setAttribute("aria-expanded", String(!detail.hidden));
      const key = row.dataset.compactionKey;
      if (key) {
        if (detail.hidden) S.expandedCompactions.delete(key);
        else S.expandedCompactions.add(key);
      }
    }
  } else if (action === "session-menu") {
    const snap = snapshotFor(sessionId);
    openPopover(target, renderSessionMenu(snap.session || { id: sessionId }));
  } else if (action === "session-menu-main") {
    const snap = currentSnapshot();
    openPopover(target, renderSessionMenu(snap.session || { id: sessionId }));
  } else if (action === "export-current") {
    try {
      await exportSessionLog(sessionId);
    } catch (error) {
      showToast(error.message || String(error), "error");
    }
  } else if (action === "rename-session") {
    const name = prompt("会话名称：", snapshotFor(sessionId).session?.title || "");
    if (name && sessionId) {
      await post(`/api/sessions/${encodeURIComponent(sessionId)}/set_name`, { name });
      closePopovers();
      queueRender(true);
    }
  } else if (action === "export-session") {
    if (sessionId) {
      try {
        await exportSessionLog(sessionId);
      } catch (error) {
        showToast(error.message || String(error), "error");
      }
      closePopovers();
    }
  } else if (action === "remove-session") {
    if (!sessionId) return;
    if (!confirm("永久删除这个会话？磁盘上的 pi 会话文件也会被删除，此操作不可撤销。")) return;
    const ws = S.workspaces.find((w) => w.sessions?.some((s) => s.id === sessionId));
    if (ws) {
      try {
        await post(`/api/workspaces/${encodeURIComponent(ws.id)}/remove-session`, { sessionId });
      } catch (error) {
        showToast(`删除会话失败：${error.message || String(error)}`, "error");
        return;
      }
      if (S.currentSessionId === sessionId) {
        const nextSessionId = ws.sessions?.find((s) => s.id !== sessionId)?.id || null;
        if (nextSessionId) await openSession(nextSessionId);
        else {
          rememberCurrentDraft();
          S.currentSessionId = null;
          S.loadingSession = null;
          loadCurrentDraftValue();
        }
      }
      const sessionDraftKey = draftKey(sessionId);
      const orphanedAttachments = [
        ...(S.attachmentDrafts.get(sessionDraftKey) || []),
        ...(S.failedAttachmentDrafts.get(sessionId) || []),
      ];
      await Promise.all(orphanedAttachments.map((attachment) => deleteImageAttachment(attachment.id)));
      S.snapshots.delete(sessionId);
      S.drafts.delete(sessionDraftKey);
      S.failedDrafts.delete(sessionId);
      S.attachmentDrafts.delete(sessionDraftKey);
      S.failedAttachmentDrafts.delete(sessionId);
      S.pendingSends.delete(sessionId);
      closePopovers();
      queueRender(true);
    }
  } else if (action === "dialog-select") {
    await respondDialog(currentSnapshot().dialogs?.[0]?.id, { value: target.dataset.value });
  } else if (action === "dialog-confirm") {
    await respondDialog(currentSnapshot().dialogs?.[0]?.id, { confirmed: target.dataset.value === "true" });
  } else if (action === "dialog-input") {
    const value = $(".pi-dialogInput")?.value || "";
    await respondDialog(currentSnapshot().dialogs?.[0]?.id, { value });
  } else if (action === "dialog-cancel") {
    await respondDialog(currentSnapshot().dialogs?.[0]?.id, { cancelled: true });
  } else if (action === "db-pick") {
    const entry = browser?.parent?.entries?.find((e) => e.path === target.dataset.path);
    if (entry) selectEntry(entry);
  } else if (action === "db-advance") {
    const entry = browser?.child?.entries?.find((e) => e.path === target.dataset.path);
    if (entry) advanceEntry(entry);
  } else if (action === "db-crumb") {
    if (target.dataset.path) navigate(target.dataset.path);
  } else if (action === "db-edit") {
    openPathEditor();
  } else if (action === "db-new-folder") {
    if (browser) {
      browser.folderDraft = "";
      browser.createError = null;
      renderBrowser();
    }
  } else if (action === "db-create") {
    createFolder();
  } else if (action === "db-create-cancel") {
    if (browser && !browser.creatingFolder) {
      browser.folderDraft = null;
      browser.createError = null;
      renderBrowser();
    }
  } else if (action === "db-toggle-hidden") {
    if (browser) {
      browser.showHidden = !browser.showHidden;
      renderBrowser();
    }
  } else if (action === "db-open") {
    adoptWorkspace();
  } else if (action === "db-cancel") {
    const resolve = pickerResolve;
    closeWorkspacePicker();
    resolve?.(null);
  } else if (action === "context-info") {
    const stats = currentSnapshot().stats;
    if (!stats) {
      alert("暂无统计");
      return;
    }
    const tokens = stats.tokens || {};
    const cu = stats.contextUsage || {};
    const hasContextUsage = typeof cu.tokens === "number" && Number.isFinite(cu.tokens)
      && typeof cu.contextWindow === "number" && Number.isFinite(cu.contextWindow) && cu.contextWindow > 0;
    const contextLine = hasContextUsage
      ? `上下文 ${fmtNum(cu.tokens)} / ${fmtNum(cu.contextWindow)} tok（${Math.round(cu.percent ?? 0)}%）`
      : cu.contextWindow ? `上下文占用待更新 / ${fmtNum(cu.contextWindow)} tok` : "上下文占用暂无统计";
    const lines = [
      contextLine,
      `输入 ${fmtNum(tokens.input ?? 0)} · 输出 ${fmtNum(tokens.output ?? 0)} · 缓存读 ${fmtNum(tokens.cacheRead ?? 0)} · 缓存写 ${fmtNum(tokens.cacheWrite ?? 0)} tok`,
      `消息 ${stats.totalMessages ?? "?"}（用户 ${stats.userMessages ?? "?"} / 助手 ${stats.assistantMessages ?? "?"} / 工具 ${stats.toolCalls ?? "?"}）`,
      typeof stats.cost === "number" ? `成本 ${formatCost(stats.cost)}` : "",
    ].filter(Boolean);
    alert(lines.join("\n"));
  } else if (action === "view-options") {
    const ws = currentWorkspace();
    openPopover(target, `<div class="_7KE1Ra_menu pi-popover pi-menu" role="menu">
      <button type="button" role="menuitem" class="_7KE1Ra_cell" data-action="add-workspace"><span class="_7KE1Ra_cellLabel">添加工作区</span></button>
      ${ws ? `<button type="button" role="menuitem" class="_7KE1Ra_cell" data-action="discover-workspace" data-workspace="${esc(ws.id)}"><span class="_7KE1Ra_cellLabel">扫描当前工作区的 pi 会话</span></button>
      <button type="button" role="menuitem" class="_7KE1Ra_cell" data-action="remove-workspace" data-workspace="${esc(ws.id)}"><span class="_7KE1Ra_cellLabel">移除当前工作区</span></button>` : ""}
      <button type="button" role="menuitem" class="_7KE1Ra_cell" data-action="settings"><span class="_7KE1Ra_cellLabel">设置</span></button>
    </div>`);
  } else if (action === "pi-agent-chip") {
    alert("该 Web UI 由 pi coding agent 的 RPC 会话驱动。");
  } else if (action === "commands") {
    const input = $("#composerInput");
    setDraftValue("/");
    if (input) {
      input.value = S.draft;
      input.focus();
      input.setSelectionRange(1, 1);
      syncComposerInput();
    }
    openCommandMenu();
  } else if (action === "workspace-menu") {
    const ws = S.workspaces.find((w) => w.id === target.dataset.workspace);
    if (ws) {
      openPopover(target, `<div class="_7KE1Ra_menu pi-popover pi-menu" role="menu">
        <button type="button" role="menuitem" class="_7KE1Ra_cell" data-action="discover-workspace" data-workspace="${esc(ws.id)}"><span class="_7KE1Ra_cellLabel">扫描 pi 会话</span></button>
        <button type="button" role="menuitem" class="_7KE1Ra_cell" data-action="remove-workspace" data-workspace="${esc(ws.id)}"><span class="_7KE1Ra_cellLabel">移除工作区</span></button>
      </div>`);
    }
  } else if (action === "discover-workspace") {
    await post(`/api/workspaces/${encodeURIComponent(target.dataset.workspace)}/discover`);
    await refreshWorkspaces();
    closePopovers();
    queueRender(true);
  } else if (action === "remove-workspace") {
    if (!confirm("从侧边栏移除该工作区？磁盘上的会话文件会保留。")) return;
    await api(`/api/workspaces/${encodeURIComponent(target.dataset.workspace)}`, { method: "DELETE" });
    await refreshWorkspaces();
    const currentStillExists = S.workspaces.some((w) => w.sessions?.some((s) => s.id === S.currentSessionId));
    if (!currentStillExists) {
      const nextWorkspace = S.workspaces.find((w) => w.sessions?.length) || S.workspaces[0] || null;
      const nextSessionId = nextWorkspace?.sessions?.[0]?.id || null;
      if (nextWorkspace) S.currentWorkspaceId = nextWorkspace.id;
      if (nextSessionId) await openSession(nextSessionId);
      else {
        rememberCurrentDraft();
        S.currentSessionId = null;
        S.loadingSession = null;
        loadCurrentDraftValue();
        queueRender(true);
      }
    } else {
      queueRender(true);
    }
  }
}

function moveWorkspace(workspaceId, targetId, position) {
  if (!workspaceId || !targetId || workspaceId === targetId) return;
  const next = [...S.workspaces];
  const fromIndex = next.findIndex((workspace) => workspace.id === workspaceId);
  if (fromIndex < 0) return;
  const [moved] = next.splice(fromIndex, 1);
  const targetIndex = next.findIndex((workspace) => workspace.id === targetId);
  if (targetIndex < 0) return;
  next.splice(position === "after" ? targetIndex + 1 : targetIndex, 0, moved);
  const unchanged = next.every((workspace, index) => workspace.id === S.workspaces[index]?.id);
  return unchanged ? undefined : next;
}

function clearWorkspaceDropIndicators() {
  $$(".qDHVXG_workspaceDropBefore,.qDHVXG_workspaceDropAfter").forEach((section) => {
    section.classList.remove("qDHVXG_workspaceDropBefore", "qDHVXG_workspaceDropAfter");
  });
}

function resetWorkspaceDrag() {
  clearWorkspaceDropIndicators();
  $(".YDXeBa_dragSource")?.classList.remove("YDXeBa_dragSource");
  document.body.removeAttribute("data-workspace-dragging");
  S.workspaceDragId = null;
  S.workspaceDragOverId = null;
  S.workspaceDragPosition = null;
}

function workspaceDropRow(target) {
  const list = target.closest?.("#sessionListMount");
  if (!list) return null;
  const section = target.closest?.(".qDHVXG_groupSection") || $$(".qDHVXG_groupSection", list).at(-1);
  return section?.querySelector(":scope > .YDXeBa_projectRow[data-workspace]") || null;
}

async function commitWorkspaceOrder(next, focusWorkspaceId = null) {
  if (!next || S.workspaceDragPending) return;
  S.workspaceDragPending = true;
  S.workspaces = next;
  saveWorkspaceOrder(next);
  renderSidebar();
  if (focusWorkspaceId) {
    requestAnimationFrame(() => {
      $$(`.YDXeBa_projectRow[data-workspace]`).find((row) => row.dataset.workspace === focusWorkspaceId)?.focus();
    });
  }
  try {
    await post("/api/workspaces/reorder", { workspaceIds: next.map((workspace) => workspace.id) });
  } catch (error) {
    if (!/404|not found/i.test(error.message || String(error))) {
      showToast(`工作区顺序已保存在当前浏览器，服务端同步失败：${error.message || String(error)}`, "warning");
    }
  } finally {
    S.workspaceDragPending = false;
  }
}

function moveWorkspaceByOffset(workspaceId, offset) {
  if (!workspaceId || S.search || S.workspaceDragPending) return false;
  const fromIndex = S.workspaces.findIndex((workspace) => workspace.id === workspaceId);
  const targetIndex = fromIndex + offset;
  if (fromIndex < 0 || targetIndex < 0 || targetIndex >= S.workspaces.length) return false;
  const next = [...S.workspaces];
  [next[fromIndex], next[targetIndex]] = [next[targetIndex], next[fromIndex]];
  void commitWorkspaceOrder(next, workspaceId);
  return true;
}

function onWorkspaceDragStart(event) {
  const row = event.target.closest?.(".YDXeBa_projectRow[data-workspace][draggable=true]");
  if (!row || event.target.closest?.("button,input,textarea") || S.search || S.workspaceDragPending) return;
  S.workspaceDragId = row.dataset.workspace;
  S.workspaceDragOverId = null;
  S.workspaceDragPosition = null;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", row.dataset.workspace);
  row.classList.add("YDXeBa_dragSource");
  document.body.setAttribute("data-workspace-dragging", "");
}

function onWorkspaceDragOver(event) {
  if (!S.workspaceDragId) return;
  const row = workspaceDropRow(event.target);
  if (!row) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const list = row.closest("#sessionListMount");
  if (list) {
    const listRect = list.getBoundingClientRect();
    if (event.clientY < listRect.top + 32) list.scrollBy({ top: -20 });
    else if (event.clientY > listRect.bottom - 32) list.scrollBy({ top: 20 });
  }
  clearWorkspaceDropIndicators();
  if (row.dataset.workspace === S.workspaceDragId) {
    row.classList.add("YDXeBa_dragSource");
    S.workspaceDragOverId = null;
    S.workspaceDragPosition = null;
    document.body.setAttribute("data-workspace-dragging", "");
    return;
  }
  const rect = row.getBoundingClientRect();
  const position = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
  const section = row.closest(".qDHVXG_groupSection");
  section?.classList.add(position === "before" ? "qDHVXG_workspaceDropBefore" : "qDHVXG_workspaceDropAfter");
  S.workspaceDragOverId = row.dataset.workspace;
  S.workspaceDragPosition = position;
  document.body.setAttribute("data-workspace-dragging", "");
}

function onWorkspaceDrop(event) {
  if (!S.workspaceDragId) return;
  const row = workspaceDropRow(event.target);
  if (!row) return;
  event.preventDefault();
  const workspaceId = event.dataTransfer.getData("text/plain") || S.workspaceDragId;
  const targetId = S.workspaceDragOverId || row.dataset.workspace;
  const position = S.workspaceDragPosition || "after";
  const next = moveWorkspace(workspaceId, targetId, position);
  resetWorkspaceDrag();
  if (next) void commitWorkspaceOrder(next);
}

function onWorkspaceDragEnd() {
  resetWorkspaceDrag();
}

let loginPromise;

function requireLogin() {
  if (loginPromise) return loginPromise;
  eventSource?.close();
  loginPromise = (async () => {
    let { passwordConfigured } = await api("/api/auth");
    const dialog = el(`<div class="pi-loginBackdrop">
      <form class="pi-loginCard" aria-labelledby="pi-login-title">
        <h1 id="pi-login-title">登录 Pi Web</h1>
        <p class="pi-loginMessage" role="status">${passwordConfigured ? "输入访问密码，继续使用会话。" : "请先在电脑网页的「设置 → 手机访问」中设置密码。"}</p>
        <label for="pi-login-password">访问密码</label>
        <input id="pi-login-password" class="pi-passwordInput" type="password" name="password" autocomplete="current-password" maxlength="256" required ${passwordConfigured ? "" : "disabled"}>
        <button type="submit" class="pi-settingsAction pi-settingsActionPrimary">${passwordConfigured ? "登录" : "重新检查"}</button>
      </form>
    </div>`);
    const root = $("#root");
    root.inert = true;
    document.body.appendChild(dialog);
    const form = $("form", dialog);
    const input = $("input", dialog);
    const button = $("button", dialog);
    const message = $(".pi-loginMessage", dialog);
    await new Promise((resolve) => {
      form.onsubmit = async (event) => {
        event.preventDefault();
        if (button.disabled) return;
        button.disabled = true;
        try {
          if (!passwordConfigured) {
            ({ passwordConfigured } = await api("/api/auth"));
            input.disabled = !passwordConfigured;
            button.textContent = passwordConfigured ? "登录" : "重新检查";
            if (passwordConfigured) {
              message.textContent = "输入访问密码，继续使用会话。";
              input.focus();
            }
            return;
          }
          await post("/api/auth", { password: input.value });
          input.value = "";
          dialog.remove();
          root.inert = false;
          resolve();
        } catch (error) {
          message.textContent = error.message || String(error);
          input.focus();
        } finally {
          button.disabled = false;
        }
      };
    });
    if (eventSource) connectEvents();
  })().finally(() => { loginPromise = null; });
  return loginPromise;
}

let eventSource;
let resyncPending;

async function resyncAfterReconnect() {
  if (resyncPending) return resyncPending;
  resyncPending = (async () => {
    const boot = await api("/api/bootstrap");
    S.workspaces = applySavedWorkspaceOrder(boot.workspaces || []);
    S.serverInstanceId = boot.instanceId || null;
    S.lanEnabled = boot.lanEnabled === true;
    S.lanUrls = boot.lanUrls || [];
    S.passwordConfigured = boot.passwordConfigured === true;
    if (S.settingsOpen || networkSettings.data) void loadNetworkSettings();
    const id = S.currentSessionId;
    const generation = S.openGeneration;
    if (id && S.workspaces.some((workspace) => workspace.sessions?.some((session) => session.id === id))) {
      const before = S.snapshots.get(id);
      const data = await post(`/api/sessions/${encodeURIComponent(id)}/open`);
      if (S.snapshots.get(id) === before) S.snapshots.set(id, data);
    } else if (id && generation === S.openGeneration) {
      rememberCurrentDraft();
      ++S.openGeneration;
      S.currentSessionId = null;
      S.loadingSession = null;
      loadCurrentDraftValue();
    }
    queueRender(true);
  })().catch((error) => {
    if (error.status === 401) showToast(error.message, "error");
  }).finally(() => { resyncPending = null; });
  return resyncPending;
}

function connectEvents() {
  eventSource?.close();
  const es = new EventSource("/api/events");
  eventSource = es;
  es.onopen = () => { void resyncAfterReconnect(); };
  es.onmessage = (ev) => {
    try {
      const event = JSON.parse(ev.data);
      if (event.type === "heartbeat") return;
      if (event.type === "network_changed") {
        void loadNetworkSettings();
        return;
      }
      if (event.type === "maintenance_error") {
        S.maintenanceGeneration += 1;
        S.maintenanceBusy = null;
        S.maintenanceMessage = { type: "error", text: event.message || "重新加载失败" };
        if (S.settingsOpen) renderOverlay();
        else showToast(S.maintenanceMessage.text, "error");
        return;
      }
      if (event.type === "extension_notify") {
        if (event.sessionId === S.currentSessionId) showToast(event.message || "", event.notifyType || "info");
        return;
      }
      if (event.type === "session_error") {
        if (event.sessionId === S.currentSessionId) showToast(event.message || "模型调用失败", "error");
        return;
      }
      if (event.type === "editor_text") {
        if (event.sessionId === S.currentSessionId && event.text !== S.draft) {
          restoreMessagesToDraft(event.sessionId, [event.text]);
          closeCommandMenu();
          queueRender(true, { sidebar: false, conversation: true, overlay: false });
        }
        return;
      }
      if (event.type === "snapshot") {
        if (!event.sessionId) return;
        S.snapshots.set(event.sessionId, { ...snapshotFor(event.sessionId), ...event });
        const current = event.sessionId === S.currentSessionId;
        queueRender(false, { sidebar: false, conversation: current, overlay: current });
        return;
      }
      if (event.type === "workspaces") {
        const next = applySavedWorkspaceOrder(event.workspaces || []);
        const unchanged = JSON.stringify(next) === JSON.stringify(S.workspaces);
        S.workspaces = next;
        resetWorkspaceDrag();
        let conversationChanged = false;
        if (S.currentSessionId && !S.workspaces.some((w) => w.sessions?.some((s) => s.id === S.currentSessionId))) {
          rememberCurrentDraft();
          const nextSessionId = S.workspaces[0]?.sessions?.[0]?.id || null;
          if (nextSessionId) {
            void openSession(nextSessionId);
          } else {
            ++S.openGeneration;
            S.currentSessionId = null;
            S.loadingSession = null;
            loadCurrentDraftValue();
            conversationChanged = true;
          }
        }
        if (unchanged && !conversationChanged) return;
        queueRender(false, { sidebar: true, conversation: conversationChanged, overlay: conversationChanged });
      }
    } catch {
      // ignore malformed event
    }
  };
  es.onerror = () => { void resyncAfterReconnect(); };
}

window.addEventListener("resize", () => { updateViewport(); applyFrameLayout(); });
window.visualViewport?.addEventListener("resize", updateViewport);
window.visualViewport?.addEventListener("scroll", updateViewport);
window.addEventListener("online", () => { if (eventSource && !loginPromise) connectEvents(); });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && eventSource && !loginPromise) connectEvents();
});
updateViewport();
bindGlobalEvents();
async function startApp() {
  await loadBootstrap();
  connectEvents();
}
startApp().catch((error) => {
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div class="pi-dialogBackdrop"><div class="pi-dialogCard"><div class="pi-dialogTitle">无法连接到 pi-web</div><div class="pi-dialogMessage">${esc(error.message)}</div></div></div>`,
  );
});
