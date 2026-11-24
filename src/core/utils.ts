export function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function normalizeBaseUrl(raw: string): string {
  let value = raw.trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) {
    value = `http://${value}`;
  }
  return value.replace(/\/+$/, "");
}

export function truncate(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

export function formatDay(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (sameDay(date, today)) return "今天";
  if (sameDay(date, yesterday)) return "昨天";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
  }).format(date);
}

export function formatRelative(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
  }).format(timestamp);
}

/**
 * 侧栏用的紧凑时间：今天只给时刻（14:20），昨天写"昨天"，更早给日期。
 * 比"5 小时前"更好扫：一眼能看出哪天聊的，也不占宽度。
 */
export function formatSessionTime(
  value: string | number | null | undefined,
): string {
  const timestamp =
    typeof value === "number" ? value : Date.parse(value ?? "");
  if (!timestamp || Number.isNaN(timestamp)) return "";

  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (sameDay(date, today)) return formatTime(timestamp);
  if (sameDay(date, yesterday)) return "昨天";
  if (date.getFullYear() === today.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 会话最后活动时间（毫秒）；拿不到就 0，用来排序和判断未读 */
export function sessionActivity(session: {
  last_message_at?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
}): number {
  const raw =
    session.last_message_at || session.updated_at || session.created_at || "";
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * 会话显示名，侧栏和标题栏共用一套规则：
 * 本地备注 > AstrBot 的 display_name > 最后一条消息摘要 > ID。
 * `named` 表示"这个名字是人为起的"（有名字时侧栏才把摘要放第二行）。
 */
export function sessionTitle(
  session: {
    session_id: string;
    display_name?: string | null;
    last_message?: string | null;
  },
  alias?: string,
): { title: string; named: boolean } {
  const local = alias?.trim();
  if (local) return { title: local, named: true };
  const named = session.display_name?.trim();
  if (named) return { title: named, named: true };
  const snippet = session.last_message?.replace(/\s+/g, " ").trim();
  if (snippet) return { title: truncate(snippet, 26), named: false };
  return { title: `对话 ${session.session_id.slice(0, 8)}`, named: false };
}

export function formatDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return "";
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "未知错误";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
/**
 * 文件名里带 `[sticker]` 前缀 = 表情包（发送时由表情面板写入）。
 * 历史消息没有额外的元数据，只能靠文件名认；普通照片不会带这个前缀。
 */
export function isStickerName(filename?: string | null): boolean {
  return typeof filename === "string" && /^\[sticker\]/i.test(filename.trim());
}

/** 去掉展示用的 `[sticker]` 前缀 */
export function stickerLabel(filename?: string | null): string {
  return (filename ?? "").replace(/^\[sticker\]/i, "");
}
