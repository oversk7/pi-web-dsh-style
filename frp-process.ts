import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type FrpStatus = { state: "stopped" | "connecting" | "connected" | "error"; message: string };
type StartOptions = { executable: string; args: string[]; cwd: string };
type Run = { child: ChildProcess; stopped: boolean; closed: Promise<void> };

export class FrpProcess {
  status: FrpStatus = { state: "stopped", message: "隧道已停止" };
  private current?: Run;
  private pending: Promise<void> = Promise.resolve();

  private onStatus?: (status: FrpStatus) => void;

  constructor(onStatus?: (status: FrpStatus) => void) {
    this.onStatus = onStatus;
  }

  private update(state: FrpStatus["state"], message: string): void {
    if (this.status.state === state && this.status.message === message) return;
    this.status = { state, message };
    this.onStatus?.({ ...this.status });
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const result = this.pending.then(action);
    this.pending = result.catch(() => {});
    return result;
  }

  start(options: StartOptions): Promise<void> {
    const launch = { ...options, args: [...options.args] };
    return this.enqueue(async () => {
      await this.stopCurrent();
      this.update("connecting", "正在连接隧道服务器");
      const windows = process.platform === "win32";
      let child: ChildProcess;
      try {
        child = spawn(windows
          ? join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
          : launch.executable, windows
          ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("./windows-rpc-job.ps1", import.meta.url))]
          : launch.args, {
          cwd: launch.cwd,
          env: { ...process.env, NO_COLOR: "1", ...(windows ? {
            PI_WEB_RPC_JOB: JSON.stringify({ ownerPid: process.pid, ...launch }),
          } : {}) },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          shell: false,
          detached: !windows,
        });
      } catch {
        this.update("error", "隧道进程启动失败");
        throw new Error("隧道进程启动失败");
      }
      let resolveClosed!: () => void;
      const run: Run = { child, stopped: false, closed: new Promise<void>((resolve) => { resolveClosed = resolve; }) };
      this.current = run;
      const line = (text: string) => {
        if (this.current !== run || run.stopped) return;
        const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
        if (/start proxy success/i.test(clean)) {
          this.update("connected", "隧道已连接");
        } else if (/login.*failed|connection.*(?:closed|lost)|connect.*(?:fail|refused|timeout)|reconnect|retry|re-?login|连接.*(?:丢失|断开|失败)|重试/i.test(clean)) {
          this.update("connecting", "连接中断，正在重连");
        } else if (/\b(?:error|fatal|failed)\b|\[E\]|错误/i.test(clean)) {
          this.update("error", "隧道发生错误，请检查连接设置");
        }
      };
      for (const stream of [child.stdout, child.stderr]) {
        let buffer = "";
        stream?.setEncoding("utf8");
        stream?.on("data", (chunk: string) => {
          buffer += chunk;
          let end: number;
          while ((end = buffer.indexOf("\n")) >= 0) {
            line(buffer.slice(0, end));
            buffer = buffer.slice(end + 1);
          }
          // Bound unfinished log lines from a long-lived process.
          if (buffer.length > 16_384) buffer = buffer.slice(-16_384);
        });
        stream?.on("end", () => { if (buffer) line(buffer); });
      }
      child.on("error", () => {
        if (this.current === run && !run.stopped) this.update("error", "隧道进程启动失败");
      });
      child.once("exit", () => { if (!windows) this.terminate(run); });
      child.once("close", () => {
        if (this.current === run) {
          this.current = undefined;
          if (run.stopped) this.update("stopped", "隧道已停止");
          else this.update("error", "隧道进程意外退出");
        }
        resolveClosed();
      });
      // On Windows, spawn confirms the launcher; target creation failures arrive as an exit.
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", () => reject(new Error("隧道进程启动失败")));
      });
    });
  }

  private terminate(run: Run): void {
    if (process.platform !== "win32" && run.child.pid) {
      try { process.kill(-run.child.pid, "SIGKILL"); } catch { /* The process group has already exited. */ }
    }
    run.child.kill("SIGKILL");
  }

  private async stopCurrent(): Promise<void> {
    const run = this.current;
    if (run) {
      run.stopped = true;
      this.terminate(run);
      await run.closed;
    }
    this.update("stopped", "隧道已停止");
  }

  stop(): Promise<void> {
    return this.enqueue(() => this.stopCurrent());
  }

  kill(): void {
    const run = this.current;
    if (run) {
      run.stopped = true;
      this.terminate(run);
    }
  }
}
