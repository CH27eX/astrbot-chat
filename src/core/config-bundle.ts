/**
 * 设置导入 / 导出（0.2.14）。
 *
 * 什么时候需要它：
 *   * 换电脑——偏好全在 localStorage 和 `%APPDATA%\com.astrbot.chat\settings.json` 里；
 *   * 同一个浏览器换源——`http://IP:8788` 和 `https://IP:8789` 是**两个源**，
 *     localStorage 各一份（`docs/开发进度总结-2026-11-19.md` §4.2 第 3 条）。
 *
 * 导出的是一份 JSON：界面偏好（外观 / 机器人 / 背景图库）+ 桌面端连接设置。
 * **刻意不含 API Key**：配置文件的用途是「换台机器接着用」，很容易被转手 / 放进网盘，
 * Key 单独提示用户自己填，不跟着文件走。
 *
 * 导入时所有字段都当不可信输入处理（`prefsFromRaw` + 白名单），坏文件最多是「没导进去」，
 * 不会把界面搞崩。
 */

import type { Prefs } from "./prefs";
import { prefsFromRaw } from "./prefs";
import type { CloseBehavior, DesktopSettings } from "../desktop/bridge";
import { DEFAULT_DESKTOP_SETTINGS } from "../desktop/bridge";

/** 文件里的类型标记：不是这个值的 JSON 一律拒收（防止用户拖错文件） */
export const BUNDLE_KIND = "astrbot-chat-config";
/** 结构版本：以后字段变了靠它决定怎么兼容 */
export const BUNDLE_VERSION = 1;

/** 导出文件里带哪些桌面设置（不含 Key / 不含窗口状态） */
export type ExportedDesktopSettings = Pick<
  DesktopSettings,
  | "closeBehavior"
  | "autoLaunchAstrbot"
  | "updateCheckOnStart"
  | "updateEndpoint"
  | "astrbotUrl"
  | "astrbotDataDir"
>;

export interface ConfigBundle {
  kind: typeof BUNDLE_KIND;
  version: number;
  /** 导出时间（ISO 8601），出问题时能对上「哪天导的」 */
  exportedAt: string;
  /** 导出它的前端版本（浏览器里没有版本号时是 `web`） */
  app: string;
  prefs: Prefs;
  /** 浏览器（PWA / 手机）里没有桌面设置，这里是 null */
  desktop: ExportedDesktopSettings | null;
}

/** 导入结果：成功了给「恢复了什么」，失败了给一句人话 */
export type ImportResult =
  | { ok: true; prefs: Prefs; desktop: ExportedDesktopSettings | null; notes: string[] }
  | { ok: false; error: string };

const CLOSE_BEHAVIORS: readonly CloseBehavior[] = ["ask", "tray", "exit"];

function exportingDesktop(desktop: DesktopSettings | null): ExportedDesktopSettings | null {
  if (!desktop) return null;
  return {
    closeBehavior: desktop.closeBehavior,
    autoLaunchAstrbot: desktop.autoLaunchAstrbot,
    updateCheckOnStart: desktop.updateCheckOnStart,
    updateEndpoint: desktop.updateEndpoint,
    astrbotUrl: desktop.astrbotUrl,
    astrbotDataDir: desktop.astrbotDataDir,
  };
}

/** 拼出要写进文件的 JSON（调用方负责下载 / 复制） */
export function buildConfigBundle(
  prefs: Prefs,
  desktop: DesktopSettings | null,
  options: { appVersion?: string; now?: Date } = {},
): ConfigBundle {
  return {
    kind: BUNDLE_KIND,
    version: BUNDLE_VERSION,
    exportedAt: (options.now ?? new Date()).toISOString(),
    app: options.appVersion?.trim() || desktop?.appVersion?.trim() || "web",
    prefs,
    desktop: exportingDesktop(desktop),
  };
}

export function serializeConfigBundle(bundle: ConfigBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/** 文件名：`astrbot-chat-config-20261119-2130.json`（本地时间，方便排序） */
export function configBundleFileName(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `astrbot-chat-config-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}.json`
  );
}

/** 把一条字符串当 JSON 解析；失败给一句能看懂的话 */
export function parseConfigBundle(text: string): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "不是合法的 JSON 文件" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "文件内容不是一个配置对象" };
  }

  const record = raw as Record<string, unknown>;
  if (record.kind !== BUNDLE_KIND) {
    return { ok: false, error: "这不是 AstrBot Chat 的配置文件" };
  }
  const version = typeof record.version === "number" ? record.version : 0;
  if (version < 1) {
    return { ok: false, error: "配置文件版本不对（缺少 version）" };
  }
  if (version > BUNDLE_VERSION) {
    return {
      ok: false,
      error: `这份配置来自更新的版本（v${version}），请先升级 AstrBot Chat`,
    };
  }

  const prefsRaw = record.prefs && typeof record.prefs === "object" ? (record.prefs as Record<string, unknown>) : {};
  const prefs = prefsFromRaw(prefsRaw);

  const notes: string[] = [];
  if (Object.keys(prefsRaw).length === 0) notes.push("文件里没有界面偏好，用的是默认值");

  const desktop = parseDesktop(record.desktop, notes);
  return { ok: true, prefs, desktop, notes };
}

/** 桌面设置同样是白名单：不认识的关闭行为退回默认，字符串只 trim */
function parseDesktop(raw: unknown, notes: string[]): ExportedDesktopSettings | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const str = (key: string) => (typeof record[key] === "string" ? (record[key] as string).trim() : "");
  const bool = (key: string, fallback: boolean) =>
    typeof record[key] === "boolean" ? (record[key] as boolean) : fallback;
  const behavior = str("closeBehavior") as CloseBehavior;

  if (behavior && !CLOSE_BEHAVIORS.includes(behavior)) {
    notes.push(`关闭行为「${behavior}」不认识，已忽略`);
  }

  const desktop: ExportedDesktopSettings = {
    closeBehavior: CLOSE_BEHAVIORS.includes(behavior) ? behavior : DEFAULT_DESKTOP_SETTINGS.closeBehavior,
    autoLaunchAstrbot: bool("autoLaunchAstrbot", DEFAULT_DESKTOP_SETTINGS.autoLaunchAstrbot),
    updateCheckOnStart: bool("updateCheckOnStart", DEFAULT_DESKTOP_SETTINGS.updateCheckOnStart),
    updateEndpoint: str("updateEndpoint"),
    astrbotUrl: str("astrbotUrl"),
    astrbotDataDir: str("astrbotDataDir"),
  };
  // 一个字段都没有 = 不是桌面导出的配置，别拿默认值去覆盖现有桌面设置
  const touched = Object.keys(record).some((key) => key in desktop);
  return touched ? desktop : null;
}

/**
 * 触发一次文件下载。
 *
 * 桌面壳（WebView2）和手机浏览器都能下；不用 Tauri 的对话框插件是为了让 PWA 里
 * 走同一条路（少一个只在桌面能用的分支）。
 */
export function downloadConfigFile(text: string, fileName: string): void {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 别立刻 revoke：WebView2 的下载是异步拿 Blob 的
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
