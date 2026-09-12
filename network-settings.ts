import { randomBytes } from "node:crypto";
import { access, chmod, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { loadJsonWithLegacyMigration, writeJsonAtomically } from "./state-store.ts";
import type { WebProxyConfig } from "./network-access.ts";

export type NetworkMode = "local" | "lan" | "relay";

export interface RelaySettings {
  serverAddr: string;
  serverPort: number;
  token: string;
  proxyName: string;
  secretKey: string;
  origin: string;
  proxySecret: string;
  frpcPath: string;
  visitorPort: number;
}

export interface NetworkSettings {
  mode: NetworkMode;
  relay?: RelaySettings;
}

function text(value: unknown, label: string, max = 1024): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label}不能为空，且不能包含换行或控制字符`);
  }
  return value;
}

function port(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${label}必须是 1–65535 之间的整数`);
  return value;
}

function validateRelay(value: RelaySettings): RelaySettings {
  text(value.serverAddr, "服务器地址", 253);
  if (!/^[a-zA-Z0-9.-]+$/.test(value.serverAddr)) throw new Error("服务器地址应填写域名或 IPv4，不包含协议和端口");
  port(value.serverPort, "frps 端口");
  port(value.visitorPort, "服务器内部端口");
  text(value.token, "frps 认证密钥");
  text(value.frpcPath, "frpc 路径");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value.proxyName)) throw new Error("隧道名称只能包含英文字母、数字、下划线和短横线");
  for (const key of [value.secretKey, value.proxySecret]) {
    if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{32,256}$/.test(key)) throw new Error("中转密钥必须包含 32–256 个字母、数字、下划线或短横线");
  }
  let url: URL;
  try { url = new URL(value.origin); } catch { throw new Error("手机访问地址应填写 HTTPS 域名，例如 https://web.example.com"); }
  if (url.protocol !== "https:" || url.origin !== value.origin || !/^[a-zA-Z0-9.-]+$/.test(url.hostname)) {
    throw new Error("手机访问地址必须是 HTTPS 根地址，不包含路径、查询参数或用户名");
  }
  return value;
}

export function updateNetworkSettings(input: unknown, current: NetworkSettings = { mode: "local" }): NetworkSettings {
  if (!input || typeof input !== "object") throw new Error("网络配置格式不正确");
  const data = input as Record<string, unknown>;
  if (!["local", "lan", "relay"].includes(data.mode as string)) throw new Error("请选择仅本机、局域网或服务器中转");
  const mode = data.mode as NetworkMode;
  if (data.relay === undefined) {
    if (mode === "relay" && !current.relay) throw new Error("请先在设置中填写服务器中转配置");
    return { mode, ...(current.relay ? { relay: current.relay } : {}) };
  }
  if (!data.relay || typeof data.relay !== "object") throw new Error("服务器中转配置格式不正确");
  const incoming = data.relay as Record<string, unknown>;
  const previous = current.relay;
  const relay = validateRelay({
    serverAddr: incoming.serverAddr as string,
    serverPort: incoming.serverPort as number,
    token: (incoming.token || previous?.token) as string,
    proxyName: (incoming.proxyName ?? previous?.proxyName ?? `pi-web-${randomBytes(4).toString("hex")}`) as string,
    secretKey: (incoming.secretKey ?? previous?.secretKey ?? randomBytes(32).toString("hex")) as string,
    origin: incoming.origin as string,
    proxySecret: (incoming.proxySecret ?? previous?.proxySecret ?? randomBytes(32).toString("hex")) as string,
    frpcPath: (incoming.frpcPath || "frpc") as string,
    visitorPort: (incoming.visitorPort ?? 13000) as number,
  });
  return { mode, relay };
}

export async function loadNetworkSettings(path: string): Promise<NetworkSettings> {
  return await loadJsonWithLegacyMigration({ stateFile: path, validate: (value): value is NetworkSettings => {
    try {
      const data = value as NetworkSettings;
      if (!data || !["local", "lan", "relay"].includes(data.mode)) return false;
      if (data.relay) validateRelay(data.relay);
      return data.mode !== "relay" || Boolean(data.relay);
    } catch { return false; }
  } }) ?? { mode: "local" };
}

export async function saveNetworkSettings(path: string, settings: NetworkSettings): Promise<void> {
  await writeJsonAtomically(path, settings);
  await chmod(path, 0o600);
}

export function publicNetworkSettings(settings: NetworkSettings) {
  const relay = settings.relay;
  return {
    mode: settings.mode,
    ...(relay ? { relay: {
      serverAddr: relay.serverAddr, serverPort: relay.serverPort, proxyName: relay.proxyName,
      origin: relay.origin, frpcPath: relay.frpcPath, visitorPort: relay.visitorPort, tokenConfigured: Boolean(relay.token),
    } } : {}),
  };
}

export function proxyForNetwork(settings: NetworkSettings): WebProxyConfig | undefined {
  return settings.mode === "relay" && settings.relay ? { origin: settings.relay.origin, secret: settings.relay.proxySecret } : undefined;
}

export async function resolveFrpc(executable: string, configDir: string): Promise<string> {
  const candidates = isAbsolute(executable) || /[\\/]/.test(executable)
    ? [resolve(configDir, executable)]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory.replace(/^"|"$/g, ""), process.platform === "win32" && !executable.toLowerCase().endsWith(".exe") ? `${executable}.exe` : executable));
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* Try the next PATH directory. */ }
  }
  throw new Error("未找到 frpc。请下载原生 frpc，并在服务器中转设置中填写 frpc.exe 路径，或将其加入 PATH。");
}

function frpCommon(relay: RelaySettings, serverAddr: string): string {
  return `serverAddr = ${JSON.stringify(serverAddr)}\nserverPort = ${relay.serverPort}\nauth.method = "token"\nauth.token = ${JSON.stringify(relay.token)}\ntransport.tls.enable = true\nloginFailExit = false\nlog.to = "console"\nlog.disablePrintColor = true\n`;
}

export function frpcConfig(relay: RelaySettings, localPort: number): string {
  return `${frpCommon(relay, relay.serverAddr)}\n[[proxies]]\nname = ${JSON.stringify(relay.proxyName)}\ntype = "stcp"\nsecretKey = ${JSON.stringify(relay.secretKey)}\nlocalIP = "127.0.0.1"\nlocalPort = ${port(localPort, "本机端口")}\n`;
}

export function relayServerFiles(relay: RelaySettings): Record<string, string> {
  const url = new URL(relay.origin);
  const zone = `pi_web_${relay.proxyName.replaceAll("-", "_")}`;
  const proxyHeaders = `    proxy_http_version 1.1;\n    proxy_set_header Host ${url.host};\n    proxy_set_header X-Pi-Web-Proxy-Secret "${relay.proxySecret}";\n    proxy_set_header X-Forwarded-Proto https;\n    proxy_set_header Connection "";\n    proxy_buffering off;\n    proxy_request_buffering off;\n    proxy_read_timeout 3600s;\n    proxy_send_timeout 3600s;`;
  return {
    "frps.toml": `bindPort = ${relay.serverPort}\nauth.method = "token"\nauth.token = ${JSON.stringify(relay.token)}\ntransport.tls.force = true\n`,
    "visitor.toml": `${frpCommon(relay, "127.0.0.1")}\n[[visitors]]\nname = ${JSON.stringify(`${relay.proxyName}-visitor`)}\ntype = "stcp"\nserverName = ${JSON.stringify(relay.proxyName)}\nsecretKey = ${JSON.stringify(relay.secretKey)}\nbindAddr = "127.0.0.1"\nbindPort = ${relay.visitorPort}\n`,
    "nginx.conf": `limit_req_zone $binary_remote_addr zone=${zone}:10m rate=10r/m;\n\nserver {\n    listen 80;\n    server_name ${url.hostname};\n    return 301 ${relay.origin}$request_uri;\n}\n\nserver {\n    listen ${url.port || 443} ssl;\n    server_name ${url.hostname};\n    ssl_certificate /etc/nginx/ssl/pi-web.pem;\n    ssl_certificate_key /etc/nginx/ssl/pi-web.key;\n    client_max_body_size 21m;\n${proxyHeaders}\n\n    location = /api/auth {\n        limit_req zone=${zone} burst=10 nodelay;\n        limit_req_status 429;\n        proxy_pass http://127.0.0.1:${relay.visitorPort};\n    }\n    location / {\n        proxy_pass http://127.0.0.1:${relay.visitorPort};\n    }\n}\n`,
  };
}
