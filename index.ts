import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getPackageDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { NetworkMode } from "./network-settings.ts";

interface MaintenanceCommandResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

interface WebServerModule {
  startWebServer(options?: {
    defaultCwd?: string;
    port?: number;
    open?: boolean;
    lan?: boolean;
    mode?: NetworkMode;
    initialModelInfo?: {
      models: unknown[];
      thinkingLevels: string[];
      defaultModel?: unknown;
      thinkingLevel?: string;
    };
    initialCommands?: unknown[];
    updateExtensions?: () => Promise<MaintenanceCommandResult>;
    reloadRuntime?: () => Promise<void>;
  }): Promise<string>;
  stopWebServer(): Promise<void>;
  getWebUrl(): string | undefined;
  getWebLanUrls(): string[];
  getWebConnectionOptions(): { port: number; lan: boolean; mode: NetworkMode } | undefined;
}

interface ReloadState {
  resumeWebAfterReload: boolean;
  connection?: { port: number; lan: boolean; mode: NetworkMode };
}

const RELOAD_STATE_KEY = Symbol.for("@oversk7/pi-web-dsh-style/reload-state");
const processState = globalThis as typeof globalThis & { [key: symbol]: unknown };
const reloadState = (processState[RELOAD_STATE_KEY] ??= { resumeWebAfterReload: false }) as ReloadState;

let serverPromise: Promise<WebServerModule> | undefined;

function piCliEntry(): string {
  if (process.env.PI_WEB_PI_CLI) return resolve(process.env.PI_WEB_PI_CLI);
  const packageDir = getPackageDir();
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const target = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
  if (!target) throw new Error("Pi package does not declare a CLI entry");
  return resolve(packageDir, target);
}

function parseArgs(args?: string): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--stop") out.stop = true;
    else if (token === "--no-open") out.open = "false";
    else if (token === "--lan") out.mode = "lan";
    else if (token === "--local") out.mode = "local";
    else if (token === "--relay") out.mode = "relay";
    else if (token === "--port" && tokens[i + 1]) {
      out.port = tokens[++i];
    }
  }
  return out;
}

async function startServer(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: Record<string, string | boolean> = {},
): Promise<void> {
  try {
    serverPromise ??= import("./server.ts") as Promise<WebServerModule>;
    const mod = await serverPromise;
    const availableModels = ctx.modelRegistry.getAvailable();
    const initialModels = availableModels.length > 0 ? availableModels : ctx.model ? [ctx.model] : [];
    const url = await mod.startWebServer({
      defaultCwd: ctx.cwd,
      port: typeof options.port === "string" ? Number(options.port) : undefined,
      open: options.open !== "false",
      mode: options.mode as NetworkMode | undefined,
      initialModelInfo: {
        models: initialModels,
        thinkingLevels: ctx.model ? getSupportedThinkingLevels(ctx.model) : [],
        defaultModel: ctx.model,
        thinkingLevel: ctx.thinkingLevel,
      },
      initialCommands: pi.getCommands(),
      updateExtensions: () => pi.exec(process.execPath, [piCliEntry(), "update", "--extensions"], {
        cwd: ctx.cwd,
        timeout: 10 * 60_000,
      }),
      reloadRuntime: async () => {
        reloadState.resumeWebAfterReload = true;
        try {
          pi.sendUserMessage("/pi-web-reload-runtime", {
            deliverAs: "followUp",
            expandPromptTemplates: true,
          });
        } catch (error) {
          reloadState.resumeWebAfterReload = false;
          throw error;
        }
      },
    });
    ctx.ui.notify(`pi-web: ${url}`, "info");
    for (const lanUrl of mod.getWebLanUrls()) ctx.ui.notify(`手机访问: ${lanUrl}`, "info");
  } catch (error) {
    serverPromise = undefined;
    ctx.ui.notify(`pi-web failed: ${String(error)}`, "error");
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pi-web-reload-runtime", {
    description: "Internal command used by pi-web to reload the Pi runtime",
    handler: async (_args, ctx) => {
      try {
        await ctx.reload();
      } catch (error) {
        reloadState.resumeWebAfterReload = false;
        throw error;
      }
    },
  });

  pi.registerCommand("pi-web-navigate-tree", {
    description: "Internal command used by pi-web for same-session tree navigation",
    handler: async (args, ctx) => {
      const targetId = args.trim();
      if (!targetId || !ctx.sessionManager.getEntry(targetId)) throw new Error("会话树节点不存在");
      await ctx.waitForIdle();
      const fromId = ctx.sessionManager.getLeafId();
      const result = await ctx.navigateTree(targetId, { summarize: false });
      if (result.cancelled) throw new Error("会话回溯已取消");
      pi.appendEntry("pi-web-tree-navigation", { targetId, fromId });
    },
  });

  pi.registerFlag("web", {
    description: "Start the pi agent web UI and open it in the browser",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("web-lan", {
    description: "Start the web UI with authenticated LAN access for phones",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("web-relay", {
    description: "Start the web UI with the configured native frp relay",
    type: "boolean",
    default: false,
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode === "rpc") await ctx.modelRegistry.refresh({ allowNetwork: false });
    const resumeAfterReload = reloadState.resumeWebAfterReload;
    const connection = reloadState.connection;
    reloadState.resumeWebAfterReload = false;
    reloadState.connection = undefined;
    if (pi.getFlag("web") === true || pi.getFlag("web-lan") === true || pi.getFlag("web-relay") === true || resumeAfterReload) {
      await startServer(pi, ctx, resumeAfterReload && connection
        ? { open: "false", port: String(connection.port), mode: connection.mode }
        : pi.getFlag("web-relay") === true ? { mode: "relay" }
        : pi.getFlag("web-lan") === true ? { mode: "lan" } : {});
    }
  });

  pi.on("session_shutdown", async (event) => {
    if (!serverPromise) return;
    const mod = await serverPromise;
    if (event.reason === "reload" && mod.getWebUrl()) {
      reloadState.resumeWebAfterReload = true;
      reloadState.connection = mod.getWebConnectionOptions();
    }
    await mod.stopWebServer();
    serverPromise = undefined;
  });

  pi.registerCommand("web", {
    description: "Open the pi agent web UI (DSH-style multi-workspace browser surface)",
    handler: async (args, ctx) => {
      const options = parseArgs(args);
      if (options.stop) {
        if (!serverPromise) {
          ctx.ui.notify("pi-web: not running", "info");
          return;
        }
        const mod = await serverPromise;
        await mod.stopWebServer();
        serverPromise = undefined;
        ctx.ui.notify("pi-web: stopped", "info");
        return;
      }

      await startServer(pi, ctx, options);
    },
  });
}
