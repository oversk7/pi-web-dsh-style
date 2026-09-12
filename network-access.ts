import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";
import { loadJsonWithLegacyMigration, writeJsonAtomically } from "./state-store.ts";

const derivePassword = promisify(scrypt);
const LOGIN_SECONDS = 30 * 24 * 60 * 60;

export interface WebProxyConfig {
  origin: string;
  secret: string;
}

function equalSecret(value: unknown, expected: string): boolean {
  if (typeof value !== "string") return false;
  const candidate = Buffer.from(value);
  const secret = Buffer.from(expected);
  return candidate.length === secret.length && timingSafeEqual(candidate, secret);
}

interface WebCredentials {
  salt: string;
  passwordHash: string;
  sessionKey: string;
}

function validCredentials(value: unknown): value is WebCredentials {
  const data = value as WebCredentials | null;
  return Boolean(data && typeof data.salt === "string" && /^[a-f0-9]{32}$/.test(data.salt)
    && typeof data.passwordHash === "string" && /^[a-f0-9]{128}$/.test(data.passwordHash)
    && typeof data.sessionKey === "string" && /^[a-f0-9]{64}$/.test(data.sessionKey));
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function lanAddresses(): string[] {
  return [...new Set(Object.values(networkInterfaces()).flatMap((entries) => (
    (entries ?? []).filter((entry) => entry.family === "IPv4" && !entry.internal).map((entry) => entry.address)
  )))];
}

export function phoneLanAddress(interfaces = networkInterfaces()): string | undefined {
  const candidates = Object.entries(interfaces)
    .filter(([name]) => !/vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback/i.test(name))
    .flatMap(([name, entries]) => (entries ?? [])
      .filter((entry) => entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254."))
      .map((entry) => ({ name, address: entry.address })));
  return (candidates.find(({ name }) => /wi-?fi|wlan|无线/i.test(name)) ?? candidates[0])?.address;
}

export function requestHostname(req: IncomingMessage): string {
  try {
    const authority = req.headers.host ?? "";
    const url = new URL(`http://${authority}`);
    if (url.host.toLowerCase() !== authority.toLowerCase() && `${url.hostname}:80` !== authority.toLowerCase()) return "";
    return url.hostname;
  } catch {
    return "";
  }
}

export function isLocalRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  return (address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1")
    && LOOPBACK_HOSTS.has(requestHostname(req))
    && !req.headers["x-pi-web-proxy-secret"];
}

export class WebAccess {
  lan: boolean;
  private credentials?: WebCredentials;
  private readonly proxy?: WebProxyConfig;

  constructor(lan: boolean, credentials?: WebCredentials, proxy?: WebProxyConfig) {
    this.lan = lan;
    this.credentials = credentials;
    this.proxy = proxy;
  }

  static async load(lan: boolean, path: string, proxy?: WebProxyConfig): Promise<WebAccess> {
    const credentials = await loadJsonWithLegacyMigration({ stateFile: path, validate: validCredentials });
    return new WebAccess(lan, credentials, proxy);
  }

  get remoteEnabled(): boolean {
    return this.lan || Boolean(this.proxy);
  }

  private isProxyRequest(req: IncomingMessage): boolean {
    return Boolean(this.proxy
      && req.headers.host?.toLowerCase() === new URL(this.proxy.origin).host
      && equalSecret(req.headers["x-pi-web-proxy-secret"], this.proxy.secret));
  }

  get passwordConfigured(): boolean {
    return Boolean(this.credentials);
  }

  async setPassword(password: unknown, path: string): Promise<void> {
    if (typeof password !== "string" || !password.trim() || password.length > 256) {
      throw new Error("请输入 1–256 个字符的密码");
    }
    const salt = randomBytes(16).toString("hex");
    const passwordHash = (await derivePassword(password, salt, 64) as Buffer).toString("hex");
    const credentials = { salt, passwordHash, sessionKey: randomBytes(32).toString("hex") };
    await writeJsonAtomically(path, credentials);
    this.credentials = credentials;
  }

  trusted(req: IncomingMessage): boolean {
    const hostname = requestHostname(req);
    const proxied = this.isProxyRequest(req);
    if (req.headers["x-pi-web-proxy-secret"] && !proxied) return false;
    if (!proxied && !LOOPBACK_HOSTS.has(hostname) && !(this.lan && lanAddresses().includes(hostname))) return false;
    if (req.headers["sec-fetch-site"] === "cross-site") return false;
    if (req.headers.origin) {
      try {
        const expected = proxied ? this.proxy!.origin : new URL(`http://${req.headers.host}`).origin;
        if (new URL(req.headers.origin).origin !== expected) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  async acceptsPassword(value: unknown): Promise<boolean> {
    const credentials = this.credentials;
    if (!credentials || typeof value !== "string" || value.length > 256) return false;
    const candidate = await derivePassword(value, credentials.salt, 64) as Buffer;
    return credentials === this.credentials && timingSafeEqual(candidate, Buffer.from(credentials.passwordHash, "hex"));
  }

  private signature(expires: string): string {
    return createHmac("sha256", Buffer.from(this.credentials!.sessionKey, "hex")).update(expires).digest("hex");
  }

  private acceptsCookie(value: string): boolean {
    if (!this.credentials) return false;
    const match = /^(\d+)\.([a-f0-9]{64})$/.exec(value);
    if (!match || Number(match[1]) <= Math.floor(Date.now() / 1000)) return false;
    return timingSafeEqual(Buffer.from(match[2], "hex"), Buffer.from(this.signature(match[1]), "hex"));
  }

  cookieName(req: IncomingMessage): string {
    return `pi_web_access_${req.socket.localPort}`;
  }

  authorized(req: IncomingMessage): boolean {
    if (isLocalRequest(req)) return true;
    if (!this.remoteEnabled) return false;
    const prefix = `${this.cookieName(req)}=`;
    return (req.headers.cookie ?? "").split(";").some((part) => {
      const cookie = part.trim();
      return cookie.startsWith(prefix) && this.acceptsCookie(cookie.slice(prefix.length));
    });
  }

  cookie(req: IncomingMessage): string {
    const expires = String(Math.floor(Date.now() / 1000) + LOGIN_SECONDS);
    const secure = this.isProxyRequest(req) ? "; Secure" : "";
    return `${this.cookieName(req)}=${expires}.${this.signature(expires)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${LOGIN_SECONDS}${secure}`;
  }

  urls(port: number): string[] {
    if (this.proxy) return [`${this.proxy.origin}/`];
    const address = this.lan ? phoneLanAddress() : undefined;
    return address ? [`http://${address}:${port}/`] : [];
  }
}
