/**
 * MB（astrbot_plugin_memory_beyond，打了 mb-priority.patch）的 adapter。
 *
 * 和其它三家的差别：MB 的条目是**文件**，⭐ 落在 frontmatter 的
 * `metadata.priority: high`；写入必须走 `mode=raw` 整篇回写（`mode=fields`
 * 会重建文件、丢自定义字段），并且要带 `baseMtime` 乐观锁。
 *
 * 具体 HTTP 细节仍留在 `../memory.ts`（已有真机验证），这里只做形状转换。
 */

import {
  isHighPriority,
  listMemoryFiles,
  readMemoryFile,
  saveMemoryRaw,
  withPriority,
  type MemoryEntry,
  type MemoryScope,
} from "../memory";
import type { MemoryItem, MemoryListOptions, MemoryProvider } from "./types";

function scopeOf(options: MemoryListOptions | undefined): { scope: MemoryScope; key: string } {
  const scope = options?.scope ?? "global";
  const key = options?.scopeKey ?? options?.sessionId ?? "";
  return { scope, key };
}

function toItem(entry: MemoryEntry, scope: MemoryScope, scopeKey: string): MemoryItem {
  return {
    provider: "mb",
    id: entry.file,
    title: entry.description || entry.name,
    preview: entry.name && entry.name !== entry.description ? entry.name : undefined,
    type: entry.type,
    updatedAt: (entry.updated || 0) * 1000,
    pinned: entry.priority === "high",
    scope,
    scopeKey,
  };
}

function itemScope(item: MemoryItem): { scope: MemoryScope; key: string } {
  return {
    scope: (item.scope as MemoryScope | undefined) ?? "global",
    key: item.scopeKey ?? "",
  };
}

export const mbProvider: MemoryProvider = {
  id: "mb",
  name: "Memory Beyond",
  pluginName: "astrbot_plugin_memory_beyond",
  semantics: "hard",
  capabilities: { list: true, read: true, flag: true },

  async health() {
    try {
      await listMemoryFiles("global", "");
      return true;
    } catch {
      return false;
    }
  },

  async list(options) {
    const { scope, key } = scopeOf(options);
    const data = await listMemoryFiles(scope, key);
    return (data.files ?? []).map((entry) => toItem(entry, scope, key));
  },

  async read(item) {
    const { scope, key } = itemScope(item);
    const file = await readMemoryFile(scope, key, item.id);
    return file.content;
  },

  async setPinned(item, pinned) {
    const { scope, key } = itemScope(item);
    const file = await readMemoryFile(scope, key, item.id);
    if (isHighPriority(file.content) === pinned) return;
    const next = withPriority(file.content, pinned);
    await saveMemoryRaw({ scope, key, file: item.id, content: next, baseMtime: file.mtime });
  },
};
