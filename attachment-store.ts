import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ImageAttachmentMeta {
  id: string;
  mimeType: string;
  size: number;
  createdAt: number;
  expiresAt: number;
}

interface StoredImageAttachment extends ImageAttachmentMeta {
  path: string;
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

async function detectImageMimeType(path: string, bytes: Uint8Array): Promise<string | null> {
  const detector = await resolvePublicMimeDetector();
  return detector ? detector(path) : fallbackImageMimeType(bytes);
}

export interface ImageAttachmentStoreOptions {
  directory?: string;
  ttlMs?: number;
  maxBytes?: number;
  maxPromptImages?: number;
}

export class ImageAttachmentStore {
  readonly maxPromptImages: number;
  private readonly directory: string;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly entries = new Map<string, StoredImageAttachment>();

  constructor(options: ImageAttachmentStoreOptions = {}) {
    this.directory = options.directory ?? tmpdir();
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxBytes = options.maxBytes ?? 15 * 1024 * 1024;
    this.maxPromptImages = options.maxPromptImages ?? 4;
  }

  async create(bytes: Uint8Array): Promise<ImageAttachmentMeta> {
    if (bytes.byteLength === 0) throw new Error("图片内容为空");
    if (bytes.byteLength > this.maxBytes) {
      throw new Error(`图片不能超过 ${Math.floor(this.maxBytes / 1024 / 1024)} MB`);
    }

    const id = randomUUID();
    const path = join(this.directory, `pi-web-attachment-${id}.img`);
    await writeFile(path, bytes);
    try {
      const mimeType = await detectImageMimeType(path, bytes);
      if (!mimeType) throw new Error("不支持的图片格式");
      const createdAt = Date.now();
      const expiresAt = createdAt + this.ttlMs;
      const timer = setTimeout(() => {
        void this.remove(id);
      }, this.ttlMs);
      timer.unref();
      const stored: StoredImageAttachment = {
        id,
        path,
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

  get(id: string): ImageAttachmentMeta | undefined {
    const stored = this.entries.get(id);
    if (!stored) return undefined;
    if (stored.expiresAt <= Date.now()) {
      void this.remove(id);
      return undefined;
    }
    return this.meta(stored);
  }

  async read(id: string): Promise<{ meta: ImageAttachmentMeta; bytes: Buffer }> {
    const stored = this.entries.get(id);
    if (!stored || stored.expiresAt <= Date.now()) {
      if (stored) await this.remove(id);
      throw new Error("图片附件不存在或已过期");
    }
    return { meta: this.meta(stored), bytes: await readFile(stored.path) };
  }

  async imagesForRpc(ids: string[]): Promise<Array<{ type: "image"; data: string; mimeType: string }>> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length > this.maxPromptImages) {
      throw new Error(`每条消息最多附加 ${this.maxPromptImages} 张图片`);
    }
    const images = [];
    for (const id of uniqueIds) {
      const { meta, bytes } = await this.read(id);
      images.push({ type: "image" as const, data: bytes.toString("base64"), mimeType: meta.mimeType });
    }
    return images;
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

  private meta(stored: StoredImageAttachment): ImageAttachmentMeta {
    return {
      id: stored.id,
      mimeType: stored.mimeType,
      size: stored.size,
      createdAt: stored.createdAt,
      expiresAt: stored.expiresAt,
    };
  }
}
