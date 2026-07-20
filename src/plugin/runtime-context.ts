import path from "node:path";

export interface RuntimeContext {
  pluginRoot: string;
  databasePath: string;
  stInternalBaseUrl: string;
  stHostHeader: string | null;
  /** 普通 ST API（列表/读聊天/保存）超时。 */
  stTimeoutMs: number;
  /** 生成接口硬上限（绝对超时）。流式/非流式都会用。 */
  stGenerateTimeoutMs: number;
  /** 流式生成 idle 超时：连续无新 token 超过该值才中断；有增量则续命。 */
  stGenerateIdleTimeoutMs: number;
  pageSize: number;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function strEnv(name: string): string | null {
  const raw = process.env[name];
  return raw && raw.trim() ? raw.trim() : null;
}

export function loadRuntimeContext(): RuntimeContext {
  const pluginRoot = path.resolve(__dirname, "..");
  const databasePath = path.join(pluginRoot, "data", "app.db");
  const explicitBase = strEnv("SILLYTAVERN_INTERNAL_BASE_URL");
  const port = strEnv("SILLYTAVERN_LISTEN_PORT") ?? "8000";
  return {
    pluginRoot,
    databasePath,
    stInternalBaseUrl: explicitBase ?? `http://127.0.0.1:${port}`,
    stHostHeader: strEnv("SILLYTAVERN_HOST_HEADER"),
    stTimeoutMs: intEnv("ST_TIMEOUT_MS", 15000),
    // 长文叙事角色（如叙事 GM）经常超过 2 分钟；默认 15 分钟硬上限。
    stGenerateTimeoutMs: intEnv("ST_GENERATE_TIMEOUT_MS", 900_000),
    // 有 token 就续命；只有上游卡住才断。默认 90 秒 idle。
    stGenerateIdleTimeoutMs: intEnv("ST_GENERATE_IDLE_TIMEOUT_MS", 90_000),
    pageSize: intEnv("PAGE_SIZE", 8),
    rateLimitWindowMs: intEnv("RATE_LIMIT_WINDOW_MS", 60000),
    rateLimitMaxRequests: intEnv("RATE_LIMIT_MAX_REQUESTS", 60),
  };
}
