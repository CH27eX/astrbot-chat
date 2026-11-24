/**
 * 桌面端（Tauri）能力桥。
 *
 * 同一份前端既跑在浏览器 PWA 里，也跑在 Tauri 壳里。所有 Tauri 相关的模块都用
 * 动态 import 加载，浏览器里既不会执行也不会因为缺少 `__TAURI_INTERNALS__` 报错。
 */

export type ResizeDirection =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

/** 关闭窗口时的行为 */
export type CloseBehavior = "ask" | "tray" | "exit";

/** 交给 Rust 去执行的动作 */
export type CloseAction = "exit" | "tray";

export interface DesktopSettings {
  closeBehavior: CloseBehavior;
  autoLaunchAstrbot: boolean;
  /** 应用的设置里有没有存 Key */
  hasApiKey: boolean;
  /** Key 从哪来：settings（应用设置）/ env（环境变量兜底）/ none */
  apiKeySource: "settings" | "env" | "none";
  firstRunDone: boolean;
  /** 更新源（一个 latest.json 的地址）；空字符串 = 关闭自动更新 */
  updateEndpoint: string;
  /** 启动时自动检查一次更新 */
  updateCheckOnStart: boolean;
  /** AstrBot 地址；空 = 自动发现本机实例（远端/云主机时填） */
  astrbotUrl: string;
  /** AstrBot 数据目录（`data_v4.db` 所在处）；空 = 让 BFF 按平台猜 */
  astrbotDataDir: string;
  /** 当前运行的版本 */
  appVersion: string;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  closeBehavior: "ask",
  autoLaunchAstrbot: true,
  hasApiKey: false,
  apiKeySource: "none",
  firstRunDone: false,
  updateEndpoint: "",
  updateCheckOnStart: true,
  astrbotUrl: "",
  astrbotDataDir: "",
  appVersion: "",
};

/** 检查更新的结果（和 Rust 的 UpdateCheckResult 一一对应） */
export interface UpdateCheck {
  /** not-configured：没填更新源；up-to-date：已是最新；available：有新版本 */
  status: "not-configured" | "up-to-date" | "available";
  currentVersion: string;
  version: string | null;
  notes: string | null;
  date: string | null;
}

/** 关窗询问事件名，和 src-tauri/src/lib.rs 里的 CLOSE_REQUESTED_EVENT 保持一致 */
const CLOSE_REQUESTED_EVENT = "astrbot://close-requested";

export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function normalizeCloseBehavior(value: unknown): CloseBehavior {
  return value === "tray" || value === "exit" ? value : "ask";
}

async function currentWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export async function minimizeWindow(): Promise<void> {
  await (await currentWindow()).minimize();
}

export async function toggleMaximizeWindow(): Promise<void> {
  await (await currentWindow()).toggleMaximize();
}

export async function isWindowMaximized(): Promise<boolean> {
  return (await currentWindow()).isMaximized();
}

export async function closeWindow(): Promise<void> {
  await (await currentWindow()).close();
}

export async function startResizeDragging(
  direction: ResizeDirection,
): Promise<void> {
  await (await currentWindow()).startResizeDragging(direction);
}

/** 窗口尺寸变化（含最大化 / 还原），返回取消订阅函数 */
export async function onWindowResized(handler: () => void): Promise<() => void> {
  return (await currentWindow()).onResized(() => handler());
}

/** 后端拦截到关闭请求，需要前端弹「关闭询问」，返回取消订阅函数 */
export async function onCloseRequested(
  handler: () => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen(CLOSE_REQUESTED_EVENT, () => handler());
}

/** 执行用户在询问弹窗里的选择 */
export async function applyCloseAction(action: CloseAction): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("apply_close_action", { action });
}

export async function readDesktopSettings(): Promise<DesktopSettings> {
  const { invoke } = await import("@tauri-apps/api/core");
  const raw = await invoke<{
    closeBehavior?: string;
    autoLaunchAstrbot?: boolean;
    hasApiKey?: boolean;
    apiKeySource?: string;
    firstRunDone?: boolean;
    updateEndpoint?: string;
    updateCheckOnStart?: boolean;
    astrbotUrl?: string;
    astrbotDataDir?: string;
    appVersion?: string;
  }>("read_desktop_settings");
  const source = raw?.apiKeySource;
  return {
    closeBehavior: normalizeCloseBehavior(raw?.closeBehavior),
    autoLaunchAstrbot: raw?.autoLaunchAstrbot !== false,
    hasApiKey: raw?.hasApiKey === true,
    apiKeySource:
      source === "settings" || source === "env" || source === "none"
        ? source
        : "none",
    firstRunDone: raw?.firstRunDone === true,
    updateEndpoint: typeof raw?.updateEndpoint === "string" ? raw.updateEndpoint : "",
    updateCheckOnStart: raw?.updateCheckOnStart !== false,
    astrbotUrl: typeof raw?.astrbotUrl === "string" ? raw.astrbotUrl : "",
    astrbotDataDir:
      typeof raw?.astrbotDataDir === "string" ? raw.astrbotDataDir : "",
    appVersion: typeof raw?.appVersion === "string" ? raw.appVersion : "",
  };
}

/** 只写传进来的字段，其余保持原值 */
export async function writeDesktopSettings(
  patch: Partial<DesktopSettings>,
): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("write_desktop_settings", {
    closeBehavior: patch.closeBehavior ?? null,
    autoLaunchAstrbot:
      typeof patch.autoLaunchAstrbot === "boolean"
        ? patch.autoLaunchAstrbot
        : null,
    firstRunDone:
      typeof patch.firstRunDone === "boolean" ? patch.firstRunDone : null,
    updateEndpoint:
      typeof patch.updateEndpoint === "string" ? patch.updateEndpoint : null,
    updateCheckOnStart:
      typeof patch.updateCheckOnStart === "boolean"
        ? patch.updateCheckOnStart
        : null,
    astrbotUrl: typeof patch.astrbotUrl === "string" ? patch.astrbotUrl : null,
    astrbotDataDir:
      typeof patch.astrbotDataDir === "string" ? patch.astrbotDataDir : null,
  });
}

/** 检查更新；没配置更新源时 status 是 `not-configured`（不算错） */
export async function checkForUpdate(): Promise<UpdateCheck> {
  const { invoke } = await import("@tauri-apps/api/core");
  const raw = await invoke<{
    status?: string;
    currentVersion?: string;
    version?: string | null;
    notes?: string | null;
    date?: string | null;
  }>("check_update");
  const status =
    raw?.status === "available"
      ? "available"
      : raw?.status === "up-to-date"
        ? "up-to-date"
        : "not-configured";
  return {
    status,
    currentVersion: typeof raw?.currentVersion === "string" ? raw.currentVersion : "",
    version: raw?.version ?? null,
    notes: raw?.notes ?? null,
    date: raw?.date ?? null,
  };
}

/**
 * 下载 + 验签 + 安装更新。
 *
 * Windows 上安装程序起来后当前进程会直接退出，安装完由安装程序重新拉起，
 * 所以这个 Promise 正常情况下不会再 resolve —— UI 按钮保持「正在安装」的样子就行。
 */
export async function installUpdate(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("install_update");
}

/** 一键导出诊断包（日志 + 环境信息，Key / 局域网令牌已打码）；返回文件（或目录）路径 */
export async function exportDiagnostics(): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("export_diagnostics");
}

export async function isAutostartEnabled(): Promise<boolean> {
  const { isEnabled } = await import("@tauri-apps/plugin-autostart");
  return isEnabled();
}

export async function setAutostart(enabled: boolean): Promise<void> {
  const { enable, disable } = await import("@tauri-apps/plugin-autostart");
  await (enabled ? enable() : disable());
}
