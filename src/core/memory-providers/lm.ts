/**
 * LivingMemory（astrbot_plugin_livingmemory）adapter。
 *
 * ⭐ = `importance = 1.0`。白板 2.13.0 真机验证过三条路径都豁免
 * （衰减 / 清理 / 整合），脚本：`scripts/dev/lm-live-check.py`。
 *
 * 接口（都在 `/api/v1/plugins/extensions/astrbot_plugin_livingmemory/page`）：
 * - `GET  memories?session_id=&page_size=&status=all`
 * - `GET  memories/detail?memory_id=`
 * - `POST memories/update {memory_id, field:"importance", value, value_scale:"stored"}`
 */

import { requestJson, unwrap, type Envelope } from "./http";
import type { MemoryItem, MemoryListOptions, MemoryProvider } from "./types";

const BASE = "/v1/plugins/extensions/astrbot_plugin_livingmemory/page";

/** 取消 ⭐ 时写回的中性值：LM 的"普通记忆"大致落在这里。 */
const DEFAULT_IMPORTANCE = 0.5;

interface LmListItem {
  id: number | string;
  summary?: string;
  created_at?: string;
  updated_at?: string;
  metadata?: {
    importance?: number;
    status?: string;
    session_id?: string;
    memory_type?: string;
    create_time?: number;
  };
}

interface LmListResponse {
  items?: LmListItem[];
  total?: number;
}

interface LmDetail {
  memory_id?: number | string;
  text?: string;
  summary?: string;
  metadata?: { importance?: number };
}

function toItem(raw: LmListItem): MemoryItem {
  const importance = Number(raw.metadata?.importance ?? 0);
  const updated = Number(raw.metadata?.create_time ?? 0);
  return {
    provider: "livingmemory",
    id: String(raw.id),
    title: String(raw.summary ?? "").trim() || `记忆 #${raw.id}`,
    type: raw.metadata?.memory_type,
    updatedAt: updated > 0 ? updated * 1000 : undefined,
    pinned: importance >= 0.999,
    sessionId: raw.metadata?.session_id,
  };
}

export const livingMemoryProvider: MemoryProvider = {
  id: "livingmemory",
  name: "LivingMemory",
  pluginName: "astrbot_plugin_livingmemory",
  semantics: "hard",
  capabilities: { list: true, read: true, flag: true },

  async health() {
    try {
      const body = await requestJson<Envelope<{ ready?: boolean }>>(`${BASE}/readiness`, {
        provider: "livingmemory",
      });
      return Boolean(unwrap(body, "livingmemory").ready);
    } catch {
      return false;
    }
  },

  async list(options?: MemoryListOptions) {
    const params = new URLSearchParams({ page: "1", page_size: String(options?.limit ?? 50), status: "all" });
    if (options?.sessionId) params.set("session_id", options.sessionId);
    const body = await requestJson<Envelope<LmListResponse>>(`${BASE}/memories?${params.toString()}`, {
      provider: "livingmemory",
    });
    const data = unwrap(body, "livingmemory");
    return (data.items ?? []).map(toItem);
  },

  async read(item) {
    const params = new URLSearchParams({ memory_id: item.id });
    const body = await requestJson<Envelope<LmDetail>>(`${BASE}/memories/detail?${params.toString()}`, {
      provider: "livingmemory",
      timeoutMs: 30_000,
    });
    const detail = unwrap(body, "livingmemory");
    return detail.text || detail.summary || "";
  },

  async setPinned(item, pinned) {
    await requestJson(`${BASE}/memories/update`, {
      method: "POST",
      provider: "livingmemory",
      body: {
        memory_id: Number(item.id),
        field: "importance",
        value: pinned ? 1.0 : DEFAULT_IMPORTANCE,
        value_scale: "stored",
        reason: pinned ? "⭐ 客户端标记：整理时保留原文" : "取消 ⭐",
      },
    });
  },
};
