import { open } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stripAnsi, type RenderedMessage } from "./transcript.ts";

export interface BackgroundJob {
  id: string;
  jobId: string;
  name?: string;
  command: string;
  logPath: string;
}

export function collectBackgroundJobs(messages: RenderedMessage[]): BackgroundJob[] {
  const jobs = new Map<string, BackgroundJob>();
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (block.type !== "toolCall" || block.name !== "pwsh" || !block.id || block.result?.isError) continue;
      const text = block.result?.content ?? "";
      const started = /^Started background job (bg-\d+)\b/.exec(text);
      const logPath = /Full log: ([^\r\n]+)$/.exec(text)?.[1].trim();
      if (!started || !logPath || basename(logPath) !== `${started[1]}.log` || !basename(dirname(logPath)).startsWith("pi-pwsh-notify-")) continue;
      const args = block.arguments && typeof block.arguments === "object" ? block.arguments as Record<string, unknown> : {};
      // Job numbers restart with each extension instance; tool call IDs remain session-scoped.
      jobs.set(block.id, {
        id: block.id,
        jobId: started[1],
        name: typeof args.name === "string" ? args.name : undefined,
        command: typeof args.command === "string" ? args.command : block.argumentsText ?? "",
        logPath,
      });
    }
  }
  return [...jobs.values()].reverse();
}

export async function readBackgroundJobLog(logPath: string): Promise<{ output: string; truncated: boolean }> {
  const file = await open(logPath, "r");
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - 128 * 1024);
    const buffer = Buffer.alloc(Math.min(size, 128 * 1024));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    let offset = 0;
    if (start > 0) while (offset < bytesRead && (buffer[offset] & 0xc0) === 0x80) offset++;
    const text = new StringDecoder("utf8").write(buffer.subarray(offset, bytesRead));
    const lines = text.split("\n");
    return { output: stripAnsi(lines.slice(-1000).join("\n")), truncated: start > 0 || lines.length > 1000 };
  } finally {
    await file.close();
  }
}
