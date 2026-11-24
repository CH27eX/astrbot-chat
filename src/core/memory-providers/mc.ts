/**
 * Memory Companion（astrbot_plugin_memory_companion）adapter。
 *
 * ⭐ = `durability = "pinned"`。
 *
 * 授权：MC 2.6.6 的写接口走「面板管理员 + 一次性确认串」，只有 API Key 的客户端会收到
 * `admin_required`。为了让桌面客户端也能点 ⭐，仓库里带了一个补丁
 * `docs/mc-api-key-write.patch`：给 MC 加一个**默认关闭**的开关 `api_key_write.enable`，
 * 打开后只放行 `/memory/update` 且 payload 仅含 `{id, durability}` 的请求
 * （删除、导入、改分量仍然只允许面板管理员）。
 *
 * 打开抽屉时会读一次 `/ui/capabilities`，据此决定还要不要提示「需要管理员」。
 *
 * 接口（`/api/v1/plugins/extensions/astrbot_plugin_memory_companion/page`）：
 * - `GET  memories?scope=private&limit=&session_id=`
 * - `GET  memory?id=`
 * - `POST memory/update {id, durability}`
 * - `GET  ui/capabilities`（看 `api_key_write.enabled`）
 */

import { requestJson, unwrapSuccess } from "./http";
import type { MemoryItem, MemoryListOptions, MemoryProvider } from "./types";

const BASE = "/v1/plugins/extensions/astrbot_plugin_memory_companion/page";

/** MC 有没有打开「API Key 直写 ⭐」（`/ui/capabilities` → `api_key_write.enabled`） */
let apiKeyWriteEnabled = false;

/** 给别处/调试用：当前连接上 MC 是否已经允许 API Key 直写 */
export function mcApiKeyWriteEnabled(): boolean {
  return apiKeyWriteEnabled;
}

/** 每次探测健康时顺手刷新一次写能力（配置改了不用重开应用） */
async function refreshCapabilities(): Promise<void> {
  try {
    // 注意：MC 的 `_ok()` 把字段铺在顶层（不是 `{data: ...}`），
    // 这里两种形状都认，免得插件小版本调整包装就失效
    const body = await requestJson<{
      success?: boolean;
      api_key_write?: { enabled?: boolean };
      data?: { api_key_write?: { enabled?: boolean } };
    }>(`${BASE}/ui/capabilities`, { provider: "memory_companion", timeoutMs: 15_000 });
    apiKeyWriteEnabled = Boolean(
      body?.api_key_write?.enabled ?? body?.data?.api_key_write?.enabled,
    );
  } catch {
    apiKeyWriteEnabled = false;
  }
}

interface McMemory {
  id: string;
  content?: string;
  memory_type?: string;
  lifecycle?: string;
  validity_status?: string;
  durability?: string;
  salience?: number;
  importance?: number;
  session_id?: string;
  updated_at?: string;
  created_at?: string;
}

interface McListBody {
  success?: boolean;
  memories?: McMemory[];
  error?: string;
}

function toItem(raw: McMemory): MemoryItem {
  const updated = Date.parse(String(raw.updated_at || raw.created_at || ""));
  return {
    provider: "memory_companion",
    id: String(raw.id),
    title: String(raw.content ?? "").slice(0, 120),
    preview: String(raw.content ?? "").slice(120, 400) || undefined,
    type: raw.memory_type,
    updatedAt: Number.isFinite(updated) ? updated : undefined,
    pinned: String(raw.durability) === "pinned",
    sessionId: raw.session_id,
  };
}

export const memoryCompanionProvider: MemoryProvider = {
  id: "memory_companion",
  name: "Memory Companion",
  pluginName: "astrbot_plugin_memory_companion",
  semantics: "hard",
  capabilities: { list: true, read: true, flag: true, flagRequiresAdmin: true },

  async health() {
    try {
      const body = await requestJson<McListBody & { stats?: unknown }>(`${BASE}/stats`, {
        provider: "memory_companion",
      });
      await refreshCapabilities();
      return body.success !== false;
    } catch {
      return false;
    }
  },

  async list(options?: MemoryListOptions) {
    const params = new URLSearchParams({ scope: "private", limit: String(options?.limit ?? 50) });
    if (options?.sessionId) params.set("session_id", options.sessionId);
    const body = await requestJson<McListBody>(`${BASE}/memories?${params.toString()}`, {
      provider: "memory_companion",
    });
    unwrapSuccess(body, "memory_companion");
    return (body.memories ?? []).map(toItem);
  },

  async read(item) {
    const body = await requestJson<{ success?: boolean; memory?: McMemory }>(
      `${BASE}/memory?id=${encodeURIComponent(item.id)}`,
      { provider: "memory_companion", timeoutMs: 30_000 },
    );
    unwrapSuccess(body, "memory_companion");
    const memory = body.memory;
    if (!memory) return "";
    return String(memory.content ?? "");
  },

  async setPinned(item, pinned) {
    const body = await requestJson<{ success?: boolean; error?: string }>(`${BASE}/memory/update`, {
      method: "POST",
      provider: "memory_companion",
      body: { id: item.id, durability: pinned ? "pinned" : "normal" },
    });
    unwrapSuccess(body, "memory_companion");
  },

  /** 打开 `api_key_write.enable` 之后就不需要面板管理员了，提示语跟着变 */
  flagHint() {
    return apiKeyWriteEnabled
      ? ""
      : "写 ⭐ 需要面板管理员；也可以给 MC 打开「API Key 直写 ⭐」开关（api_key_write.enable，" +
          "补丁见 docs/mc-api-key-write.patch）";
  },
};
