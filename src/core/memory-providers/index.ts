/**
 * 记忆来源注册表 + 探测。
 *
 * 客户端不写死 MB：打开记忆抽屉时先问 AstrBot 装了哪些记忆插件
 * （`GET /api/v1/plugins`），再逐个 health 探测，最后按下面的顺序给用户选。
 */

import { requestJson, unwrap, type Envelope } from "./http";
import { angelMemoryProvider } from "./am";
import { livingMemoryProvider } from "./lm";
import { mbProvider } from "./mb";
import { memoryCompanionProvider } from "./mc";
import type { MemoryProvider, ProviderId, RetentionSemantics } from "./types";

export * from "./types";

export const memoryProviders: Record<ProviderId, MemoryProvider> = {
  mb: mbProvider,
  livingmemory: livingMemoryProvider,
  memory_companion: memoryCompanionProvider,
  angel_memory: angelMemoryProvider,
};

/** 优先级：在用/验证最充分的排前面（MB 有补丁，LM 已真机验证）。 */
export const PROVIDER_ORDER: ProviderId[] = ["mb", "livingmemory", "memory_companion", "angel_memory"];

export interface DetectedProvider {
  provider: MemoryProvider;
  version?: string;
  /** 插件在但接口不通（没配 provider / 初始化失败） */
  reachable: boolean;
}

interface PluginListItem {
  name?: string;
  version?: string;
  activated?: boolean;
}

/** 列出所有"装了且能用"的记忆来源。 */
export async function detectProviders(): Promise<DetectedProvider[]> {
  let installed: PluginListItem[] = [];
  try {
    const body = await requestJson<Envelope<PluginListItem[]>>("/v1/plugins");
    installed = unwrap(body, "mb") ?? [];
  } catch {
    // 插件列表都拿不到：只返回 MB（它是本客户端一直支持的）
    return [{ provider: mbProvider, reachable: true }];
  }

  const byName = new Map<string, PluginListItem>();
  for (const item of installed) {
    if (item?.name) byName.set(item.name, item);
  }

  const detected: DetectedProvider[] = [];
  for (const id of PROVIDER_ORDER) {
    const provider = memoryProviders[id];
    const plugin = byName.get(provider.pluginName);
    if (!plugin) continue;
    if (plugin.activated === false) {
      detected.push({ provider, version: plugin.version, reachable: false });
      continue;
    }
    let reachable = false;
    try {
      reachable = await provider.health();
    } catch {
      reachable = false;
    }
    detected.push({ provider, version: plugin.version, reachable });
  }
  return detected;
}

/** ⭐ 语义的中文说明（UI 直接显示）。 */
export function semanticsLabel(semantics: RetentionSemantics): string {
  switch (semantics) {
    case "hard":
      return "压缩/清理时保留";
    case "weighted":
      return "仅延后清理";
    default:
      return "不支持标记";
  }
}

/** 写 ⭐ 的提示语：管理员会话限制要提前讲清楚（具体由 adapter 决定）。 */
export function flagHint(provider: MemoryProvider): string {
  if (!provider.capabilities.flag) return "这家插件不支持写 ⭐";
  // adapter 自己知道服务端现在的配置（例如 MC 的 api_key_write 开关）
  if (provider.flagHint) return provider.flagHint();
  if (provider.capabilities.flagRequiresAdmin) {
    return "写 ⭐ 需要 AstrBot 面板管理员会话（只有 API Key 会被拒）";
  }
  return "";
}
