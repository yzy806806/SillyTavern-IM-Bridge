import type { AccountProxyConfig } from "../../core/models/account";

/**
 * Per-bot proxy agent factory for grammy/node-fetch.
 *
 * grammy bundles node-fetch 2.x whose `init.agent` option accepts either an
 * http.Agent instance or a `(parsedURL) => agent` selector. We build agents
 * lazily from ST's own runtime dependencies (proxy-agent's children):
 *   - socks-proxy-agent  (socks5://, socks://)
 *   - https-proxy-agent  (https:// proxy, https targets)
 *   - http-proxy-agent   (http:// proxy, http targets)
 *
 * These are resolved via require() at call time so the bundle stays lean and
 * the runtime (SillyTavern's node_modules) provides the implementations.
 * Telegram targets are always https://api.telegram.org (or an http apiRoot
 * override), so both directions are covered.
 */

interface AgentLike {
  destroy(): void;
}

interface NodeFetchInit {
  agent?: unknown;
}

type AgentSelector = (parsedURL: URL) => AgentLike | undefined;

type ProxyAgentModule = new (uri: string | URL, opts?: Record<string, unknown>) => AgentLike;

const ALLOWED_SCHEMES = new Set(["socks5", "socks", "http", "https"]);

export class ProxyConfigError extends Error {}

export function normalizeProxyUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ProxyConfigError("代理 URL 不能为空");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ProxyConfigError("代理 URL 格式无效");
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (!ALLOWED_SCHEMES.has(scheme)) {
    throw new ProxyConfigError(`不支持的代理协议: ${scheme}（仅支持 socks5 / http / https）`);
  }
  if (!parsed.hostname) {
    throw new ProxyConfigError("代理主机不能为空");
  }
  // WHATWG URL 对默认端口（https:443 / http:80）返回空串，视为合法默认。
  let port: number;
  if (parsed.port === "") {
    if (scheme === "https") port = 443;
    else if (scheme === "http") port = 80;
    else throw new ProxyConfigError("代理端口不能为空");
  } else {
    port = Number(parsed.port);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ProxyConfigError("代理端口无效");
  }
  return trimmed;
}

/** 掩盖 URL 中的密码，用于 API 回显与日志。 */
export function maskProxyUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!parsed.hostname) return "****";
    if (parsed.password) parsed.password = "****";
    return parsed.toString();
  } catch {
    return "****";
  }
}

interface ProxyModules {
  socks: ProxyAgentModule;
  https: ProxyAgentModule;
  http: ProxyAgentModule;
}

/**
 * 静态 require：webpack externals 会原样保留 require("模块名")，运行时由
 * SillyTavern 的 node_modules（proxy-agent 的依赖树）提供实现。
 * 测试环境由本仓库 devDependencies 提供。
 */
function requireProxyModules(): ProxyModules {
  const unwrap = (mod: unknown, name: string): ProxyAgentModule => {
    if (typeof mod === "function") return mod as ProxyAgentModule;
    if (mod && typeof mod === "object") {
      const record = mod as Record<string, unknown>;
      for (const value of Object.values(record)) {
        if (typeof value === "function") return value as ProxyAgentModule;
      }
    }
    throw new Error(`unexpected export shape: ${typeof mod}`);
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const socks: unknown = require("socks-proxy-agent");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const httpsAgent: unknown = require("https-proxy-agent");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const httpAgent: unknown = require("http-proxy-agent");
    return {
      socks: unwrap(socks, "socks-proxy-agent"),
      https: unwrap(httpsAgent, "https-proxy-agent"),
      http: unwrap(httpAgent, "http-proxy-agent"),
    };
  } catch (error) {
    throw new ProxyConfigError(
      `代理模块不可用（运行环境缺少 SillyTavern 的 node_modules 依赖）: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function buildSocksAgent(url: string): AgentLike {
  const SocksProxyAgent = requireProxyModules().socks;
  return new SocksProxyAgent(url);
}

function buildHttpFamilySelector(url: string): AgentSelector {
  const mods = requireProxyModules();
  const httpsAgent = new mods.https(url);
  const httpAgent = new mods.http(url);
  return (parsedURL: URL) => (parsedURL.protocol === "https:" ? httpsAgent : httpAgent);
}

/**
 * 根据账号代理配置构造 node-fetch 使用的 agent。
 * - 未启用 → undefined（grammy 走默认 fetch，不带代理）
 * - socks5/socks → SocksProxyAgent（同时支持 http/https 目标）
 * - http/https 代理 → 按 URL 协议在 http/https proxy agent 间选择
 */
export function buildBotFetchAgent(proxy: AccountProxyConfig | null | undefined): NodeFetchInit["agent"] {
  if (!proxy?.enabled || !proxy.url) {
    return undefined;
  }
  const url = normalizeProxyUrl(proxy.url);
  const scheme = new URL(url).protocol.replace(/:$/, "").toLowerCase();
  if (scheme === "socks5" || scheme === "socks") {
    return buildSocksAgent(url);
  }
  return buildHttpFamilySelector(url);
}
