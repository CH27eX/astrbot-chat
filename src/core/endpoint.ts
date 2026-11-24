/**
 * BFF 地址与鉴权头。
 *
 * 三种运行形态：
 *   浏览器（vite dev / PWA）  → 相对地址 `/astrbot/api`（同源，cookie 鉴权）
 *   桌面壳（Tauri）           → `http://127.0.0.1:8788/astrbot/api`
 *   手机套壳（Capacitor）     → 用户在「连接电脑」里填的 `https://<IP>:8789/astrbot/api`
 *                              跨域请求，令牌走 `x-astrbot-token` 头（不走 `?t=`，那个会 302）
 */
import { readConnection } from "./connection";

export const IN_TAURI = "__TAURI_INTERNALS__" in window;

const BFF_ORIGIN = "http://127.0.0.1:8788";

const connection = readConnection();

export const BFF_BASE = connection
  ? `${connection.base}/astrbot/api`
  : IN_TAURI
    ? `${BFF_ORIGIN}/astrbot/api`
    : "/astrbot/api";

/** 套壳里给每个请求带上的令牌；浏览器/桌面壳为空 */
export const AUTH_TOKEN = connection?.token ?? "";

/** 把令牌头合并进已有 headers（浏览器里是空操作） */
export function authHeaders(extra?: Record<string, string>): Record<string, string> | undefined {
  if (!AUTH_TOKEN) return extra;
  return { ...(extra ?? {}), "x-astrbot-token": AUTH_TOKEN };
}

/**
 * `<img>` / `<audio>` / `<video>` 的 src 带不了自定义头，只能把令牌放 query。
 * BFF 对资源请求不会 302（只对 text/html 导航才换 cookie），所以这样能直接取到文件。
 */
export function withTokenParam(url: string): string {
  if (!AUTH_TOKEN) return url;
  return `${url}${url.includes("?") ? "&" : "?"}t=${encodeURIComponent(AUTH_TOKEN)}`;
}
