export interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

/** 和 App.tsx 里的 DESKTOP 判定一致：壳里存在 __TAURI_INTERNALS__ */
function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/** 与 public/sw.js 里的 CACHE 一致；换版本号时这里要跟着改 */
const SHELL_CACHE_PREFIX = "astrbot-chat-v";

/**
 * Tauri 壳里不注册 Service Worker：资源本来就在安装包/程序目录里，不需要离线缓存，
 * 而 tauri.localhost 上的 SW 会把旧 index.html 缓存下来，升级后容易一直看到旧界面。
 * 顺手把以前误注册的 SW 和它的缓存清掉（只清我们自己的缓存，不动别的）。
 */
async function unregisterShellWorker(): Promise<void> {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key.startsWith(SHELL_CACHE_PREFIX)).map((key) => caches.delete(key)),
      );
    }
  } catch (error) {
    console.warn("清理 service worker 失败", error);
  }
}

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!("serviceWorker" in navigator)) return;
  if (isTauri()) {
    void unregisterShellWorker();
    return;
  }
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("Service worker registration failed", error);
    });
  });
}

export function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}
