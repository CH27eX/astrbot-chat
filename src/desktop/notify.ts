/**
 * 系统通知。
 *
 * 浏览器里用 Web Notification；Tauri 壳里走 `@tauri-apps/plugin-notification`
 * （Windows 上 WebView2 的 Notification 需要用户手势，窗口隐藏到托盘时也不可靠）。
 */
import { isDesktop } from "./bridge";

export type NotificationPermissionState = "granted" | "denied" | "prompt";

export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (isDesktop()) {
    const { isPermissionGranted, requestPermission } = await import(
      "@tauri-apps/plugin-notification"
    );
    if (await isPermissionGranted()) return "granted";
    return (await requestPermission()) === "granted" ? "granted" : "denied";
  }

  if (!("Notification" in window)) return "denied";
  const permission =
    Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();
  return permission === "granted"
    ? "granted"
    : permission === "denied"
      ? "denied"
      : "prompt";
}

export async function showNotification(title: string, body: string): Promise<boolean> {
  if (!body) return false;

  if (isDesktop()) {
    const { isPermissionGranted, requestPermission, sendNotification } =
      await import("@tauri-apps/plugin-notification");
    const granted =
      (await isPermissionGranted()) ||
      (await requestPermission()) === "granted";
    if (!granted) return false;
    sendNotification({ title, body });
    return true;
  }

  if (!("Notification" in window) || Notification.permission !== "granted") {
    return false;
  }
  const notification = new Notification(title, {
    body,
    icon: "/icons/icon-192.png",
    tag: "astrbot-chat",
  });
  notification.onclick = () => {
    window.focus();
    notification.close();
  };
  return true;
}
