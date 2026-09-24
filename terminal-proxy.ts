import { loadJsonWithLegacyMigration, writeJsonAtomically } from "./state-store.ts";

export interface TerminalProxySettings {
  mode: "inherit" | "manual" | "direct";
  url: string;
}

export function validateTerminalProxy(input: unknown): TerminalProxySettings {
  if (!input || typeof input !== "object") throw new Error("终端代理配置格式不正确");
  const data = input as Record<string, unknown>;
  if (data.mode !== "inherit" && data.mode !== "manual" && data.mode !== "direct") throw new Error("请选择跟随启动环境、手动代理或直连");
  if (typeof data.url !== "string" || data.url.length > 2048 || /[\s\x00-\x1f\x7f]/.test(data.url)) throw new Error("代理地址格式不正确");
  const url = data.url;
  if (url || data.mode === "manual") {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error("请填写完整代理地址，例如 http://127.0.0.1:7987"); }
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Pi 支持 HTTP/HTTPS 代理，请使用 VPN 的 HTTP 或混合端口");
    if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.port === "0") {
      throw new Error("代理地址只需协议、主机和端口，不包含用户名、密码或路径");
    }
  }
  return { mode: data.mode, url };
}

export async function loadTerminalProxy(path: string): Promise<TerminalProxySettings> {
  return await loadJsonWithLegacyMigration({ stateFile: path, validate: (value): value is TerminalProxySettings => {
    try { validateTerminalProxy(value); return true; } catch { return false; }
  } }) ?? { mode: "inherit", url: "http://127.0.0.1:7987" };
}

export async function saveTerminalProxy(path: string, settings: TerminalProxySettings): Promise<void> {
  await writeJsonAtomically(path, settings);
}

export function terminalProxyEnv(settings: TerminalProxySettings, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  if (settings.mode === "inherit") return env;
  for (const key of Object.keys(env)) {
    if (/^(http_proxy|https_proxy|all_proxy|no_proxy)$/i.test(key)) delete env[key];
  }
  if (settings.mode === "manual") {
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) env[key] = settings.url;
    env.NO_PROXY = env.no_proxy = "localhost,127.0.0.1,::1";
    env.NODE_USE_ENV_PROXY = "1";
  } else {
    env.NO_PROXY = env.no_proxy = "*";
    env.NODE_USE_ENV_PROXY = "0";
  }
  return env;
}
