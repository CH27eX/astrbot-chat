/**
 * 记忆来源（provider）的公共契约。
 *
 * 设计目标：把"⭐"从 MB 专用字段升级成"保留级别"，但**不**写成某家插件的
 * 私有实现——每家插件用自己的写接口，能力/语义由 adapter 声明，UI 只读这些声明。
 *
 * 语义三档（对应交接文档 §2 的结论）：
 * - `hard`：整理/合并/清理时保留原文或整条豁免衰减（MB 补丁后、LivingMemory）
 * - `weighted`：只延后清理，不保证不被合并（Angel Memory）
 * - `none`：没有条目级保护
 */

export type ProviderId = "mb" | "livingmemory" | "memory_companion" | "angel_memory";

export type RetentionSemantics = "hard" | "weighted" | "none";

export interface ProviderCapabilities {
  /** 能列条目 */
  list: boolean;
  /** 能读单条全文 */
  read: boolean;
  /** 能写 ⭐ */
  flag: boolean;
  /**
   * 写 ⭐ 需要 AstrBot 面板管理员会话（Memory Companion 2.6.6 就是这样）。
   * 只有 API Key 的客户端点了会收到 admin_required，UI 要提前说明。
   */
  flagRequiresAdmin?: boolean;
}

export interface ProviderMeta {
  id: ProviderId;
  /** 展示名，如 "LivingMemory" */
  name: string;
  /** AstrBot 插件名（用于探测与代理路径） */
  pluginName: string;
  semantics: RetentionSemantics;
  capabilities: ProviderCapabilities;
  version?: string;
}

/** 抽屉里的一行（跨 provider 的统一形状）。 */
export interface MemoryItem {
  provider: ProviderId;
  /** provider 内部 id（MB 是文件名，其它是数字串） */
  id: string;
  title: string;
  preview?: string;
  type?: string;
  updatedAt?: number;
  pinned: boolean;
  sessionId?: string;
  /** provider 私有定位：MB 的 scope / scopeKey（其它 provider 为空） */
  scope?: string;
  scopeKey?: string;
}

export interface MemoryListOptions {
  /** 会话 id：LM/MC 按它过滤；MB 用 scope+key */
  sessionId?: string;
  /** MB 专用：作用域与 key */
  scope?: "global" | "session" | "people";
  scopeKey?: string;
  keyword?: string;
  limit?: number;
}

export interface MemoryProvider extends ProviderMeta {
  /** 插件装了且接口通 */
  health(): Promise<boolean>;
  list(options?: MemoryListOptions): Promise<MemoryItem[]>;
  read(item: MemoryItem): Promise<string>;
  /** 写/取消 ⭐；`pinned=false` 表示取消 */
  setPinned(item: MemoryItem, pinned: boolean): Promise<void>;
  /**
   * 比 `capabilities` 更细的 ⭐ 提示：能力可能随服务端配置变化
   * （例如 MC 打开 `api_key_write.enable` 之后就不再需要面板管理员）。
   * 返回空串 = 现在可以直接写。
   */
  flagHint?(): string;
}

/** 记忆接口的错误：带 HTTP 状态与 provider，便于 UI 区分"没权限"和"真出错"。 */
export class MemoryProviderError extends Error {
  status: number;
  provider: ProviderId | "unknown";
  code?: string;

  constructor(
    message: string,
    options: { status?: number; provider?: ProviderId | "unknown"; code?: string } = {},
  ) {
    super(message);
    this.name = "MemoryProviderError";
    this.status = options.status ?? 0;
    this.provider = options.provider ?? "unknown";
    this.code = options.code;
  }
}
