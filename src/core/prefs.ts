/** 纯本地的界面偏好：主题 / 信息密度 / 强调色 / 字号档 / 圆角档，
 *  加上「机器人是谁」（名字 + 头像）和聊天背景图库。
 *
 *  全部存 localStorage，应用方式是给 `<html>` 打 `data-*` 属性 + 几个 CSS 变量，
 *  自定义强调色在运行时算成同一组变量（见 core/colors.ts）。
 *  CSS 侧用 `:root[data-theme="light"]` 这类选择器接（见 styles.css 顶部）。
 *  `main.tsx` 在挂载前先调一次 `applyPrefs()`：`:root` 默认是深色，
 *  晚一步就会给浅色用户闪一帧深色、给换了背景的人闪一帧纯色。
 */

import { ACCENT_VARS, accentVariables, parseHex } from "./colors";

export type Theme = "dark" | "light";
export type Density = "comfortable" | "compact";
/** 强调色预设（另可用 accentHex 自定义一个色值） */
export type Accent = "blue" | "violet" | "green" | "cyan" | "orange" | "rose";
export type FontScale = "s" | "m" | "l";
export type RadiusStyle = "sharp" | "default" | "round";
/** 背景图上的遮罩浓度：越深文字越好认 */
export type ChatBgDim = "light" | "mid" | "strong";
/** 背景图虚化档 */
export type ChatBgBlur = "off" | "soft" | "strong";

/** 背景图库里的一张：原图 + 两档虚化 + 平均色，都在选图时算好 */
export interface ChatBgItem {
  id: string;
  /** 最多 1600×1000 的 JPEG data URL */
  image: string;
  soft: string;
  strong: string;
  /** 平均色 "r g b"，用来给侧栏 / 聊天头染色 */
  tint: string;
}

export interface Prefs {
  theme: Theme;
  density: Density;
  accent: Accent;
  fontScale: FontScale;
  radius: RadiusStyle;
  /** 机器人名字：侧栏品牌 / 空状态文案 / 通知标题都用它（空 = 默认 AstrBot） */
  botName: string;
  /** 机器人头像（128px 方图 data URL）；空 = 用名字首字 */
  botAvatar: string;
  /** 自定义强调色（"#rrggbb"）；空 = 用上面的预设 */
  accentHex: string;
  /** 背景图库（可一次传多张，设置里点缩略图切换） */
  chatBgItems: ChatBgItem[];
  /** 当前用的那张图的 id；"" = 不铺背景图（图库还在） */
  chatBgActive: string;
  chatBgDim: ChatBgDim;
  chatBgBlur: ChatBgBlur;
  /** 侧栏（会话列表）单独挑一张背景图；"" = 不铺 */
  sidebarBgActive: string;
}

/** 背景图库最多放几张：每张（含两档虚化）大概 100 KB，localStorage 只有 5 MB 左右 */
export const MAX_CHAT_BG = 12;

/** localStorage 键：沿用 `astrbot-chat.` 前缀，和别的偏好一致 */
const KEYS: Record<keyof Prefs, string> = {
  theme: "astrbot-chat.theme",
  density: "astrbot-chat.density",
  accent: "astrbot-chat.accent",
  fontScale: "astrbot-chat.font-scale",
  radius: "astrbot-chat.radius",
  botName: "astrbot-chat.bot-name",
  botAvatar: "astrbot-chat.avatar",
  accentHex: "astrbot-chat.accent-hex",
  chatBgItems: "astrbot-chat.chat-bg-list",
  chatBgActive: "astrbot-chat.chat-bg-active",
  chatBgDim: "astrbot-chat.chat-bg-dim",
  sidebarBgActive: "astrbot-chat.sidebar-bg-active",
  chatBgBlur: "astrbot-chat.chat-bg-blur",
};

/** 0.2.8 之前的写法：一张背景图拆成四个键。读到就迁进图库，迁完删掉 */
const LEGACY_CHAT_BG = {
  image: "astrbot-chat.chat-bg",
  soft: "astrbot-chat.chat-bg-soft",
  strong: "astrbot-chat.chat-bg-strong",
  tint: "astrbot-chat.chat-bg-tint",
} as const;

export const DEFAULT_BOT_NAME = "AstrBot";

export const DEFAULT_PREFS: Prefs = {
  theme: "dark",
  density: "comfortable",
  accent: "blue",
  fontScale: "m",
  radius: "default",
  botName: DEFAULT_BOT_NAME,
  botAvatar: "",
  accentHex: "",
  chatBgItems: [],
  chatBgActive: "",
  chatBgDim: "mid",
  chatBgBlur: "off",
  sidebarBgActive: "",
};

const THEMES: readonly Theme[] = ["dark", "light"];
const DENSITIES: readonly Density[] = ["comfortable", "compact"];
const ACCENTS: readonly Accent[] = ["blue", "violet", "green", "cyan", "orange", "rose"];
const FONT_SCALES: readonly FontScale[] = ["s", "m", "l"];
const RADIUS_STYLES: readonly RadiusStyle[] = ["sharp", "default", "round"];
const CHAT_BG_DIMS: readonly ChatBgDim[] = ["light", "mid", "strong"];
const CHAT_BG_BLURS: readonly ChatBgBlur[] = ["off", "soft", "strong"];

/** 读到不认识的值（旧版本 / 手改 localStorage）就退回默认，别让界面挂掉 */
function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** 图库是 JSON（localStorage）或数组（导入的 JSON）；坏数据（手改 / 半截写入）就当没有 */
function normalizeChatBgItems(raw: unknown): ChatBgItem[] {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    if (!raw) return [];
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const items: ChatBgItem[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const image = typeof record.image === "string" ? record.image : "";
    if (!image) continue;
    items.push({
      id: typeof record.id === "string" && record.id ? record.id : `bg-${items.length + 1}`,
      image,
      soft: typeof record.soft === "string" ? record.soft : "",
      strong: typeof record.strong === "string" ? record.strong : "",
      tint: typeof record.tint === "string" ? record.tint : "",
    });
    if (items.length >= MAX_CHAT_BG) break;
  }
  return items;
}

/** 偏好的一段原始值：localStorage 读出来的字符串，或导入 JSON 里的一段，都当作不可信输入 */
export type RawPrefs = Partial<Record<keyof Prefs, unknown>>;

/**
 * 把「不知道从哪来」的偏好整理成合法的 Prefs：不认识的枚举、超长名字、坏图库
 * 一律按默认值 / 裁剪处理。`readPrefs`（localStorage）和「导入配置」共用这一个入口，
 * 免得两边校验规则漂移。
 */
export function prefsFromRaw(raw: RawPrefs): Prefs {
  const str = (key: keyof Prefs): string => (typeof raw[key] === "string" ? (raw[key] as string) : "");
  const chatBgItems = normalizeChatBgItems(raw.chatBgItems);
  let chatBgActive = str("chatBgActive");
  if (!chatBgItems.some((item) => item.id === chatBgActive)) chatBgActive = chatBgItems[0]?.id ?? "";
  const accentHex = parseHex(str("accentHex")) ? str("accentHex") : "";

  return {
    theme: pick(str("theme") || null, THEMES, DEFAULT_PREFS.theme),
    density: pick(str("density") || null, DENSITIES, DEFAULT_PREFS.density),
    accent: pick(str("accent") || null, ACCENTS, DEFAULT_PREFS.accent),
    fontScale: pick(str("fontScale") || null, FONT_SCALES, DEFAULT_PREFS.fontScale),
    radius: pick(str("radius") || null, RADIUS_STYLES, DEFAULT_PREFS.radius),
    botName: str("botName").slice(0, 24),
    botAvatar: str("botAvatar"),
    accentHex,
    chatBgItems,
    chatBgActive,
    chatBgDim: pick(str("chatBgDim") || null, CHAT_BG_DIMS, DEFAULT_PREFS.chatBgDim),
    chatBgBlur: pick(str("chatBgBlur") || null, CHAT_BG_BLURS, DEFAULT_PREFS.chatBgBlur),
    sidebarBgActive: chatBgItems.some((item) => item.id === str("sidebarBgActive")) ? str("sidebarBgActive") : "",
  };
}

export function readPrefs(): Prefs {
  try {
    let chatBgItems = normalizeChatBgItems(localStorage.getItem(KEYS.chatBgItems));
    let chatBgActive = localStorage.getItem(KEYS.chatBgActive) ?? "";

    // 旧版本只存一张图：迁成图库里唯一的那张，并保持它仍是当前背景
    if (chatBgItems.length === 0) {
      const legacyImage = localStorage.getItem(LEGACY_CHAT_BG.image) ?? "";
      if (legacyImage) {
        chatBgItems = [
          {
            id: "legacy",
            image: legacyImage,
            soft: localStorage.getItem(LEGACY_CHAT_BG.soft) ?? "",
            strong: localStorage.getItem(LEGACY_CHAT_BG.strong) ?? "",
            tint: localStorage.getItem(LEGACY_CHAT_BG.tint) ?? "",
          },
        ];
        chatBgActive = "legacy";
      }
    }

    return prefsFromRaw({
      theme: localStorage.getItem(KEYS.theme),
      density: localStorage.getItem(KEYS.density),
      accent: localStorage.getItem(KEYS.accent),
      fontScale: localStorage.getItem(KEYS.fontScale),
      radius: localStorage.getItem(KEYS.radius),
      botName: localStorage.getItem(KEYS.botName),
      botAvatar: localStorage.getItem(KEYS.botAvatar),
      accentHex: localStorage.getItem(KEYS.accentHex),
      chatBgItems,
      chatBgActive,
      chatBgDim: localStorage.getItem(KEYS.chatBgDim),
      chatBgBlur: localStorage.getItem(KEYS.chatBgBlur),
      sidebarBgActive: localStorage.getItem(KEYS.sidebarBgActive),
    });
  } catch {
    // 隐私模式 / 存储被禁：用默认值，别的功能照常
    return { ...DEFAULT_PREFS };
  }
}

/** 界面上该显示的名字：空名字回落到 AstrBot */
export function botDisplayName(prefs: Prefs): string {
  return prefs.botName.trim() || DEFAULT_BOT_NAME;
}

/** 当前选中的那张背景图（没选 / 被删了就是 null） */
export function activeChatBg(prefs: Prefs): ChatBgItem | null {
  return prefs.chatBgItems.find((item) => item.id === prefs.chatBgActive) ?? null;
}

/** 把偏好打到 `<html>` 上（CSS 全靠这些 data-* 和几个 CSS 变量） */
export function applyPrefs(prefs: Prefs): void {
  const root = document.documentElement;
  root.dataset.theme = prefs.theme;
  root.dataset.density = prefs.density;
  root.dataset.accent = prefs.accent;
  root.dataset.fontScale = prefs.fontScale;
  root.dataset.radius = prefs.radius;

  applyAccent(root, prefs);
  applyChatBackground(root, prefs);
}

/** 自定义强调色：算出一整套变量盖在预设色上面（行内样式优先级最高） */
function applyAccent(root: HTMLElement, prefs: Prefs): void {
  const hex = prefs.accentHex;
  if (!hex) {
    for (const name of ACCENT_VARS) root.style.removeProperty(name);
    return;
  }
  const vars = accentVariables(hex, prefs.theme);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
}

/** 背景图：按虚化档挑当前那张的一个版本，data URL 放 CSS 变量里；没选就把变量撤掉 */
function applyChatBackground(root: HTMLElement, prefs: Prefs): void {
  const item = activeChatBg(prefs);
  root.dataset.chatBg = item ? "on" : "off";
  root.dataset.chatBgDim = prefs.chatBgDim;
  if (!item) {
    root.style.removeProperty("--chat-bg-image");
    root.style.removeProperty("--chat-bg-tint");
  }
  if (item) {
    const image =
      prefs.chatBgBlur === "strong"
        ? item.strong || item.image
        : prefs.chatBgBlur === "soft"
          ? item.soft || item.image
          : item.image;
    root.style.setProperty("--chat-bg-image", `url("${image}")`);
    root.style.setProperty("--chat-bg-tint", item.tint || "110 168 254");
  }

  // 侧栏背景：和聊天区解耦，单独挑一张（没有就撤掉，退回普通面板）
  const side = prefs.chatBgItems.find((entry) => entry.id === prefs.sidebarBgActive) ?? null;
  // CSS 靠这个属性决定要不要给 .sidebar 铺图（styles.css 里有解释：别用 background 简写）
  root.dataset.sidebarBg = side ? "on" : "off";
  if (!side) {
    root.style.removeProperty("--sidebar-bg-image");
    root.style.removeProperty("--sidebar-bg-tint");
  } else {
    // 侧栏文字多、又直接坐在图上：默认用虚化版（选图时就算好的那张），
    // 只有用户把聊天背景切到「强虚化」时才跟着用更强的那档。
    // 老数据 / 迁移进来的图没有虚化版就退回原图。
    const sideImage =
      prefs.chatBgBlur === "strong" ? side.strong || side.image : side.soft || side.image;
    root.style.setProperty("--sidebar-bg-image", `url("${sideImage}")`);
    root.style.setProperty("--sidebar-bg-tint", side.tint || "110 168 254");
  }
}

export function savePrefs(prefs: Prefs): void {
  const values: [keyof Prefs, string][] = [
    ["theme", prefs.theme],
    ["density", prefs.density],
    ["accent", prefs.accent],
    ["fontScale", prefs.fontScale],
    ["radius", prefs.radius],
    ["botName", prefs.botName],
    ["botAvatar", prefs.botAvatar],
    ["accentHex", prefs.accentHex],
    ["chatBgItems", JSON.stringify(prefs.chatBgItems)],
    ["chatBgActive", prefs.chatBgActive],
    ["chatBgDim", prefs.chatBgDim],
    ["chatBgBlur", prefs.chatBgBlur],
    ["sidebarBgActive", prefs.sidebarBgActive],
  ];
  for (const [key, value] of values) {
    try {
      // 背景图库那种几百 KB 的字符串只在真变了的时候才重写
      if (localStorage.getItem(KEYS[key]) !== value) localStorage.setItem(KEYS[key], value);
    } catch {
      // 写不进去（配额满 / 存储被禁）就算了，本次会话里仍然生效
    }
  }
  // 图库写成功后旧键就没用了，留着会让「删光图库」在重启后又冒出一张
  for (const key of Object.values(LEGACY_CHAT_BG)) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}




