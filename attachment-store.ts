import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "./attachment-parser.ts";

export interface AttachmentMeta {
  id: string;
  kind: "image" | "document";
  name: string;
  textLength?: number;
  mimeType: string;
  size: number;
  createdAt: number;
  expiresAt: number;
}

interface StoredAttachment extends AttachmentMeta {
  path: string;
  text?: string;
  timer: ReturnType<typeof setTimeout>;
}

type PublicMimeDetector = (filePath: string) => Promise<string | null>;

let publicMimeDetector: Promise<PublicMimeDetector | null> | undefined;

async function resolvePublicMimeDetector(): Promise<PublicMimeDetector | null> {
  publicMimeDetector ??= import("@earendil-works/pi-coding-agent").then((module) => {
    const detector = (module as unknown as { detectSupportedImageMimeTypeFromFile?: unknown })
      .detectSupportedImageMimeTypeFromFile;
    return typeof detector === "function" ? detector as PublicMimeDetector : null;
  });
  return publicMimeDetector;
}

function fallbackImageMimeType(bytes: Uint8Array): string | null {
  const ascii = (start: number, value: string) => value.split("").every(
    (char, index) => bytes[start + index] === char.charCodeAt(0),
  );
  if (bytes.length >= 16
    && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)
    && ascii(12, "IHDR")) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && (ascii(0, "GIF87a") || ascii(0, "GIF89a"))) return "image/gif";
  if (bytes.length >= 12 && ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (bytes.length >= 26 && ascii(0, "BM")) return "image/bmp";
  return null;
}

export async function detectImageMimeType(path: string, bytes: Uint8Array): Promise<string | null> {
  const detector = await resolvePublicMimeDetector();
  return detector ? detector(path) : fallbackImageMimeType(bytes);
}

export interface AttachmentStoreOptions {
  directory?: string;
  ttlMs?: number;
  maxBytes?: number;
  maxPromptImages?: number;
  maxPromptAttachments?: number;
}

export class AttachmentStore {
  readonly maxPromptImages: number;
  readonly maxPromptAttachments: number;
  private readonly directory: string;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly entries = new Map<string, StoredAttachment>();

  constructor(options: AttachmentStoreOptions = {}) {
    this.directory = options.directory ?? tmpdir();
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxBytes = options.maxBytes ?? 15 * 1024 * 1024;
    this.maxPromptImages = options.maxPromptImages ?? 4;
    this.maxPromptAttachments = options.maxPromptAttachments ?? 8;
  }

  async create(bytes: Uint8Array, filename?: string): Promise<AttachmentMeta> {
    if (bytes.byteLength === 0) throw new Error("文件内容为空");
    if (bytes.byteLength > this.maxBytes) {
      throw new Error(`文件不能超过 ${Math.floor(this.maxBytes / 1024 / 1024)} MB`);
    }

    const id = randomUUID();
    const path = join(this.directory, `pi-web-attachment-${id}.upload`);
    const name = filename?.split(/[\\/]/).pop()?.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 255) || "";
    await writeFile(path, bytes);
    try {
      const imageMimeType = await detectImageMimeType(path, bytes);
      if (!imageMimeType && !name) throw new Error("不支持的图片格式");
      const document = imageMimeType ? undefined : await parseDocument(bytes, name);
      const mimeType = imageMimeType || document!.mimeType;
      const createdAt = Date.now();
      const expiresAt = createdAt + this.ttlMs;
      const timer = setTimeout(() => {
        void this.remove(id);
      }, this.ttlMs);
      timer.unref();
      const stored: StoredAttachment = {
        id,
        path,
        kind: imageMimeType ? "image" : "document",
        name: name || `图片.${mimeType.split("/")[1]}`,
        ...(document ? { text: document.text, textLength: document.text.length } : {}),
        mimeType,
        size: bytes.byteLength,
        createdAt,
        expiresAt,
        timer,
      };
      this.entries.set(id, stored);
      return this.meta(stored);
    } catch (error) {
      await unlink(path).catch(() => {});
      throw error;
    }
  }

  get(id: string): AttachmentMeta | undefined {
    const stored = this.entries.get(id);
    if (!stored) return undefined;
    if (stored.expiresAt <= Date.now()) {
      void this.remove(id);
      return undefined;
    }
    return this.meta(stored);
  }

  async read(id: string): Promise<{ meta: AttachmentMeta; bytes: Buffer }> {
    const stored = this.entries.get(id);
    if (!stored || stored.expiresAt <= Date.now()) {
      if (stored) await this.remove(id);
      throw new Error("附件不存在或已过期");
    }
    return { meta: this.meta(stored), bytes: await readFile(stored.path) };
  }

  async promptForRpc(ids: string[], message: string): Promise<{
    message: string;
    images: Array<{ type: "image"; data: string; mimeType: string }>;
  }> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length > this.maxPromptAttachments) {
      throw new Error(`每条消息最多附加 ${this.maxPromptAttachments} 个文件`);
    }
    const attachments = uniqueIds.map((id) => {
      const stored = this.entries.get(id);
      if (!stored || !this.get(id)) throw new Error("附件不存在或已过期，请重新上传");
      return stored;
    });
    if (attachments.filter((entry) => entry.kind === "image").length > this.maxPromptImages) {
      throw new Error(`每条消息最多附加 ${this.maxPromptImages} 张图片`);
    }
    if (attachments.reduce((length, entry) => length + (entry.textLength || 0), 0) > 200_000) {
      throw new Error("附件文本总量不能超过 200000 字符，请拆分发送");
    }
    const images = [];
    const documents = [];
    for (const attachment of attachments) {
      if (attachment.kind === "image") {
        const { meta, bytes } = await this.read(attachment.id);
        images.push({ type: "image" as const, data: bytes.toString("base64"), mimeType: meta.mimeType });
      } else {
        const text = attachment.text!;
        let fenceLength = 3;
        for (const match of text.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
        const fence = "`".repeat(fenceLength);
        documents.push(`附件：${JSON.stringify(attachment.name)}\n${fence}text\n${text}\n${fence}`);
      }
    }
    return {
      message: [message.trim() || (documents.length ? "请分析附加文件。" : "请分析附加图片。"), ...documents].join("\n\n"),
      images,
    };
  }

  async remove(id: string): Promise<boolean> {
    const stored = this.entries.get(id);
    if (!stored) return false;
    this.entries.delete(id);
    clearTimeout(stored.timer);
    await unlink(stored.path).catch(() => {});
    return true;
  }

  async close(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.remove(id)));
  }

  private meta(stored: StoredAttachment): AttachmentMeta {
    return {
      id: stored.id,
      kind: stored.kind,
      name: stored.name,
      ...(stored.textLength !== undefined ? { textLength: stored.textLength } : {}),
      mimeType: stored.mimeType,
      size: stored.size,
      createdAt: stored.createdAt,
      expiresAt: stored.expiresAt,
    };
  }
}
