import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const POWERSHELL_TIMEOUT_MS = 8_000;

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function runPowerShell(script: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const command = process.env.PI_WEB_POWERSHELL || "powershell.exe";
    const child = spawn(command, ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command", script], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    const timer = setTimeout(() => child.kill(), POWERSHELL_TIMEOUT_MS);
    timer.unref();
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 16_384) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Unable to start Windows PowerShell for clipboard access: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new Error("Windows clipboard access timed out"));
      if (code === 0 || code === 3) return resolve(code);
      reject(new Error(stderr.trim() || `Windows clipboard access failed with exit code ${code}`));
    });
  });
}

async function readClipboardFile(scriptBody: (path: string) => string): Promise<Uint8Array | null> {
  if (process.platform !== "win32") throw new Error("pi-web clipboard paste currently supports Windows only");
  const path = join(tmpdir(), `pi-web-clipboard-read-${randomUUID()}`);
  try {
    const code = await runPowerShell(scriptBody(path));
    if (code === 3) return null;
    const bytes = await readFile(path);
    return bytes.length > 0 ? new Uint8Array(bytes) : null;
  } finally {
    await unlink(path).catch(() => {});
  }
}

export function extensionForImageMimeType(mimeType: string): string | null {
  switch (mimeType.split(";", 1)[0].trim().toLowerCase()) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    default: return null;
  }
}

export async function readClipboardImage(): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  const bytes = await readClipboardFile((path) => [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$image = [System.Windows.Forms.Clipboard]::GetImage()",
    "if ($null -eq $image) { exit 3 }",
    `try { $image.Save(${quotePowerShell(path)}, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $image.Dispose() }`,
  ].join("; "));
  return bytes ? { bytes, mimeType: "image/png" } : null;
}

export async function readClipboardText(): Promise<string | null> {
  const bytes = await readClipboardFile((path) => [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$text = [System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::UnicodeText)",
    "if ([string]::IsNullOrEmpty($text)) { exit 3 }",
    `[System.IO.File]::WriteAllText(${quotePowerShell(path)}, $text, [System.Text.UTF8Encoding]::new($false))`,
  ].join("; "));
  return bytes ? Buffer.from(bytes).toString("utf8") : null;
}
