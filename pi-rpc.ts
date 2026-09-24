import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { terminalProxyEnv, type TerminalProxySettings } from "./terminal-proxy.ts";

export type Json = Record<string, any>;

export interface PiRpc {
  send<T = unknown>(command: Json, timeoutMs?: number): Promise<T>;
  write(message: Json): void;
  close(timeoutMs?: number): Promise<void>;
  onEvent(handler: (event: Json) => void): () => void;
}

const REQUEST_TIMEOUT = 120_000;
const activeRpcs = new Set<PiRpc>();

export async function closeAllPiRpcs(): Promise<void> {
  await Promise.all([...activeRpcs].map((rpc) => rpc.close()));
}

function safeJsonParse(line: string): Json | undefined {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? (value as Json) : undefined;
  } catch {
    return undefined;
  }
}

interface PiRpcLaunch {
  entry: string;
  argsPrefix: string[];
}

function exportedRpcEntry(packageDir: string): string {
  const manifestPath = join(packageDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    exports?: Record<string, string | { import?: string; default?: string }>;
  };
  const rpcExport = manifest.exports?.["./rpc-entry"];
  const target = typeof rpcExport === "string" ? rpcExport : rpcExport?.import ?? rpcExport?.default;
  if (!target) throw new Error("@earendil-works/pi-coding-agent does not export ./rpc-entry");
  const entry = resolve(packageDir, target);
  if (!existsSync(entry)) throw new Error(`pi rpc entry does not exist: ${entry}`);
  return entry;
}

export function resolvePiRpcLaunch(): PiRpcLaunch {
  const explicitRpcEntry = process.env.PI_WEB_RPC_ENTRY;
  if (explicitRpcEntry) {
    const entry = resolve(explicitRpcEntry);
    if (!existsSync(entry)) throw new Error(`PI_WEB_RPC_ENTRY does not exist: ${entry}`);
    return { entry, argsPrefix: [] };
  }

  const legacyCli = process.env.PI_WEB_PI_CLI;
  if (legacyCli) {
    const entry = resolve(legacyCli);
    if (!existsSync(entry)) throw new Error(`PI_WEB_PI_CLI does not exist: ${entry}`);
    return { entry, argsPrefix: ["--mode", "rpc"] };
  }

  return { entry: exportedRpcEntry(getPackageDir()), argsPrefix: [] };
}

export interface PiRpcSpawnOptions {
  cwd: string;
  sessionId?: string;
  sessionFile?: string;
  name?: string;
  noSession?: boolean;
  proxy?: TerminalProxySettings;
}

export function spawnPiRpc(options: PiRpcSpawnOptions): PiRpc {
  const launch = resolvePiRpcLaunch();
  const args = [...launch.argsPrefix];
  if (options.noSession) {
    args.push("--no-session");
  } else if (options.sessionFile) {
    args.push("--session", options.sessionFile);
  } else if (options.sessionId) {
    args.push("--session-id", options.sessionId);
  }
  if (options.name) args.push("--name", options.name);
  const windows = process.platform === "win32";
  const executable = windows
    ? join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : process.execPath;
  const childArgs = windows
    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("./windows-rpc-job.ps1", import.meta.url))]
    : [launch.entry, ...args];
  const child = spawn(executable, childArgs, {
    cwd: options.cwd,
    env: {
      ...(options.proxy ? terminalProxyEnv(options.proxy) : process.env), NO_COLOR: "1", PI_TELEMETRY: "0",
      ...(windows ? { PI_WEB_RPC_JOB: JSON.stringify({ ownerPid: process.pid, executable: process.execPath, args: [launch.entry, ...args], cwd: options.cwd }) } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: !windows,
  });

  const handlers = new Set<(event: Json) => void>();
  const pending = new Map<string, { resolve: (v: Json) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let buffer = "";
  let closed = false;
  let closing: Promise<void> | undefined;
  let spawnError: Error | undefined;
  let resolveExit: (() => void) | undefined;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const killProcessTree = (): void => {
    if (!windows && child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* The process group may already be gone. */ }
    }
    child.kill();
  };

  const forceClose = (reason: string): void => {
    if (closed) return;
    closed = true;
    try {
      killProcessTree();
    } catch {
      // ignore
    }
    const error = new Error(reason);
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  };

  child.on("error", (error) => {
    spawnError = error;
    activeRpcs.delete(rpc);
    closed = true;
    resolveExit?.();
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
    for (const handler of handlers) handler({ type: "spawn_error", error: String(error) });
  });

  const expectedNewSessionWarning = options.sessionId
    ? `Warning: No project session found with id '${options.sessionId}'; creating a new session with that id.`
    : undefined;
  let stderrBuffer = "";
  const logStderrLine = (line: string) => {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!text || text.includes("pi@") || text === expectedNewSessionWarning) return;
    console.error(`[pi-web rpc stderr] ${text}`);
  };

  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderrBuffer += chunk;
    let idx: number;
    while ((idx = stderrBuffer.indexOf("\n")) >= 0) {
      logStderrLine(stderrBuffer.slice(0, idx));
      stderrBuffer = stderrBuffer.slice(idx + 1);
    }
  });
  child.stderr?.on("end", () => {
    if (stderrBuffer) logStderrLine(stderrBuffer);
    stderrBuffer = "";
  });

  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const event = safeJsonParse(line);
      if (!event) continue;
      if (event.type === "response" && typeof event.id === "string") {
        const p = pending.get(event.id);
        if (p) {
          pending.delete(event.id);
          clearTimeout(p.timer);
          if (event.success === false) {
            p.reject(new Error(typeof event.error === "string" ? event.error : JSON.stringify(event.error)));
          } else {
            p.resolve(event);
          }
        }
        continue;
      }
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (error) {
          console.error("[pi-web] event handler failed:", error);
        }
      }
    }
  });

  child.on("exit", (code, signal) => {
    activeRpcs.delete(rpc);
    if (!windows) killProcessTree();
    closed = true;
    resolveExit?.();
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`pi rpc exited (${code ?? signal ?? "unknown"})`));
    }
    pending.clear();
    for (const handler of handlers) handler({ type: "process_exit", code: code ?? undefined, signal: signal ?? undefined });
  });

  const rpc: PiRpc = {
    send<T = unknown>(command: Json, timeoutMs = REQUEST_TIMEOUT): Promise<T> {
      if (spawnError) return Promise.reject(spawnError);
      if (closed || closing) return Promise.reject(new Error("pi rpc process is not running"));
      const id = randomUUID();
      const payload = { ...command, id };
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`pi rpc command timed out: ${String(command.type)}`));
        }, timeoutMs);
        pending.set(id, { resolve: resolve as (v: Json) => void, reject, timer });
        child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
          if (error) {
            pending.delete(id);
            clearTimeout(timer);
            reject(error);
          }
        });
      });
    },
    write(message: Json): void {
      if (spawnError) throw spawnError;
      if (closed || closing) throw new Error("pi rpc process is not running");
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close(timeoutMs = 3000) {
      if (closing) return closing;
      if (closed) return exitPromise;
      closing = closeProcess(timeoutMs);
      return closing;
    },
  };
  activeRpcs.add(rpc);
  return rpc;

  async function closeProcess(timeoutMs: number): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let forced = false;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        forced = true;
        forceClose("pi rpc close timed out");
        resolve();
      }, timeoutMs);
    });
    try {
      child.stdin.end();
    } catch {
      // The RPC may have already closed its input.
    }
    await Promise.race([exitPromise, timeoutPromise]);
    if (timeout) clearTimeout(timeout);
    if (forced) {
      try {
        await Promise.race([
          exitPromise,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("pi rpc process tree did not exit after forced shutdown")), 1000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
  }
}
