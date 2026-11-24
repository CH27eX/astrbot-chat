import { isNativeShell } from "./connection";

/**
 * Android 系统返回键。
 *
 * `@capacitor/app` 在 `load()` 里就注册了 OnBackPressedCallback：只要 App 里有 JS 监听器，
 * 它就停下来发 `backButton` 事件（没有监听器时才会自己走 WebView 历史）。
 * 所以套壳里必须**常驻**一个监听器，把「先关浮层 → 再回会话列表 → 最后退出」走完；
 * 否则返回键要么什么都不做，要么直接从聊天页退出。
 *
 * 浏览器 / 桌面壳里是空实现（`isNativeShell()` 为 false）。
 */
export function registerBackHandler(handler: () => void): () => void {
  if (!isNativeShell()) return () => {};
  let cancelled = false;
  let remove: (() => void) | undefined;

  void (async () => {
    try {
      const { App } = await import("@capacitor/app");
      const listener = await App.addListener("backButton", () => handler());
      if (cancelled) await listener.remove();
      else remove = () => void listener.remove();
    } catch {
      // 插件不在（例如 PWA / 桌面壳）就静默降级：系统自己处理返回
    }
  })();

  return () => {
    cancelled = true;
    remove?.();
  };
}

/** 真正退出 App（返回键走到最后一层时才调） */
export async function exitApp(): Promise<void> {
  try {
    const { App } = await import("@capacitor/app");
    await App.exitApp();
  } catch {
    window.close();
  }
}

/**
 * 页面里分发一次「返回」：监听器调 `preventDefault()` 表示自己吃掉了这次返回。
 * 聊天页的菜单 / 记忆抽屉靠它先关，关完才轮到 App 换屏。
 */
export function dispatchBackEvent(): boolean {
  const event = new Event("astrbot:back", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
