/** provider 共用的 HTTP 小工具：只管发请求、解 JSON、把错误翻译成 MemoryProviderError。 */

import { BFF_BASE } from "../endpoint";
import { MemoryProviderError, type ProviderId } from "./types";

export { BFF_BASE };

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
  provider?: ProviderId;
}

/**
 * 发一个请求并返回解析后的 JSON。
 *
 * AstrBot 的插件写接口出错时也可能回 HTTP 200 + `{status:"error"}` / `{success:false}`，
 * 所以这里只看 HTTP；业务层各自用 unwrapXxx 判语义。
 */
export async function requestJson<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, timeoutMs = 20_000, provider } = options;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${BFF_BASE}${path}`, {
      method,
      credentials: "same-origin",
      signal: controller.signal,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new MemoryProviderError(
      error instanceof DOMException && error.name === "AbortError"
        ? "记忆接口超时（AstrBot 没响应）"
        : "连不上 AstrBot，检查是否在运行",
      { provider },
    );
  } finally {
    window.clearTimeout(timer);
  }

  const text = await response.text().catch(() => "");
  let errorCode = "";
  let errorDetail = "";
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    errorCode = String(parsed.error || "");
    errorDetail = String(parsed.message || parsed.error || "");
  } catch {
    errorDetail = text.slice(0, 160);
  }

  if (response.status === 403) {
    // 403 有两种：Key 缺 plugin scope，和插件自己的 admin_required。
    // 先看上游怎么说，别把"需要管理员"误报成"缺权限"。
    if (errorCode === "admin_required") {
      throw new MemoryProviderError(
        "这个操作需要 AstrBot 面板管理员会话（只有 API Key 不够）；" +
          "Memory Companion 可在插件配置里打开「API Key 直写 ⭐」（api_key_write.enable）",
        { status: 403, provider, code: errorCode },
      );
    }
    throw new MemoryProviderError(
      "API Key 缺少 plugin 权限：AstrBot 面板 → API Keys → 勾上 plugin",
      { status: 403, provider, code: errorCode || undefined },
    );
  }
  if (!response.ok) {
    throw new MemoryProviderError(
      `记忆接口请求失败（${response.status}）${errorDetail ? `：${errorDetail}` : ""}`,
      { status: response.status, provider, code: errorCode || undefined },
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new MemoryProviderError("记忆接口返回的不是 JSON（BFF 没就绪？）", { provider });
  }
}

/** MB / LivingMemory 用的是 `{status:"ok", data}`。 */
export interface Envelope<T> {
  status?: "ok" | "error";
  message?: string | null;
  data?: T;
}

export function unwrap<T>(body: Envelope<T>, provider: ProviderId): T {
  if (body?.status === "error") {
    throw new MemoryProviderError(body.message || "记忆接口返回错误", { provider });
  }
  return (body?.data ?? ({} as T)) as T;
}

export interface SuccessBody {
  success?: boolean;
  error?: string;
  message?: string;
}

/** Memory Companion 用的是 `{success:true, ...}`。 */
export function unwrapSuccess<T extends SuccessBody>(body: T, provider: ProviderId): T {
  if (body && body.success === false) {
    const code = String(body.error || "");
    const message = String(body.message || body.error || "记忆接口返回错误");
    if (code === "admin_required") {
      throw new MemoryProviderError(
        "这个操作需要 AstrBot 面板管理员会话（只有 API Key 不够）",
        { provider, code },
      );
    }
    throw new MemoryProviderError(message, { provider, code });
  }
  return body;
}
