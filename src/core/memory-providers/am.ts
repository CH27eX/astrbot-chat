/**
 * Angel Memory（astrbot_plugin_angel_memory）adapter。
 *
 * ⭐ = `pinned`（`state.pinned`）。语义只能算 **weighted**：
 * - ✅ 保衰减：pinned 不降 strength、不进退休候选（白板 2.0.4 + 本仓库补丁真机验证，
 *   `scripts/dev/am-live-check.py`）；
 * - ❌ 不保合并：`core/deepmind.py` 的记忆整理不看 pinned。
 *
 * 上游 2.0.4 的 WebUI 没有写 pinned 的接口，本仓库补了两个（`docs/am-pinned.patch`）：
 * - `POST /astrbot_plugin_angel_memory/memories/pin {id, pinned}`
 * - `POST /astrbot_plugin_angel_memory/maintenance/decay`
 */

import { requestJson } from "./http";
import type { MemoryItem, MemoryListOptions, MemoryProvider } from "./types";

const BASE = "/v1/plugins/extensions/astrbot_plugin_angel_memory";

interface AmItem {
  id: string | number;
  judgment?: string;
  reasoning?: string;
  memory_type?: string;
  strength?: number;
  is_active?: boolean;
  created_at?: number;
  updated_at?: number;
  tags?: string;
  memory_scope?: string;
}

interface AmListBody {
  items?: AmItem[];
  total?: number;
}

function toItem(raw: AmItem): MemoryItem {
  const updated = Number(raw.updated_at ?? raw.created_at ?? 0);
  return {
    provider: "angel_memory",
    id: String(raw.id),
    title: String(raw.judgment ?? "").trim() || `记忆 #${raw.id}`,
    preview: String(raw.reasoning ?? "").slice(0, 240) || undefined,
    type: raw.memory_type,
    updatedAt: updated > 0 ? updated * 1000 : undefined,
    pinned: Boolean(raw.is_active),
  };
}

export const angelMemoryProvider: MemoryProvider = {
  id: "angel_memory",
  name: "Angel Memory",
  pluginName: "astrbot_plugin_angel_memory",
  semantics: "weighted",
  capabilities: { list: true, read: true, flag: true },

  async health() {
    try {
      const body = await requestJson<{ memory_count?: number }>(`${BASE}/overview`, {
        provider: "angel_memory",
      });
      return typeof body.memory_count === "number";
    } catch {
      return false;
    }
  },

  async list(options?: MemoryListOptions) {
    const pageSize = Math.min(100, Math.max(1, options?.limit ?? 50));
    const body = await requestJson<AmListBody>(`${BASE}/memories?page=1&page_size=${pageSize}`, {
      provider: "angel_memory",
    });
    let items = (body.items ?? []).map(toItem);
    if (options?.keyword) {
      const needle = options.keyword.toLowerCase();
      items = items.filter((item) => `${item.title} ${item.preview ?? ""}`.toLowerCase().includes(needle));
    }
    return items;
  },

  async read(item) {
    // AM 没有"读单条"的接口：列表项里已经带 judgment + reasoning，直接拼出来。
    const body = await requestJson<AmListBody>(`${BASE}/memories?page=1&page_size=100`, {
      provider: "angel_memory",
      timeoutMs: 30_000,
    });
    const found = (body.items ?? []).find((entry) => String(entry.id) === item.id);
    if (!found) return "";
    return [found.judgment, found.reasoning].filter((part) => String(part ?? "").trim()).join("\n\n");
  },

  async setPinned(item, pinned) {
    await requestJson(`${BASE}/memories/pin`, {
      method: "POST",
      provider: "angel_memory",
      body: { id: item.id, pinned },
    });
  },
};
