/**
 * 套壳（Capacitor）里的「连接到电脑」配置。
 *
 * 浏览器 / 桌面壳都不需要它（同源或回环地址）；只有 App 里页面是 `https://localhost`，
 * 数据却在 PC 的 `https://<IP>:8789` 上，所以要把地址 + 令牌存下来，请求时带上。
 *
 * 存 localStorage：WebView 的存储跟着 App 走，卸载才没；换电脑就重新扫/填一次。
 */
export interface ShellConnection {
  base: string;
  token: string;
}

const KEY = "astrbot-chat.shell-connection";

/** 当前是不是 Capacitor 原生壳（浏览器里没有 window.Capacitor） */
export function isNativeShell(): boolean {
  const cap = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return Boolean(cap?.isNativePlatform?.());
}

export function readConnection(): ShellConnection | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { base?: unknown; token?: unknown };
    const base = typeof parsed?.base === "string" ? parsed.base.replace(/\/+$/, "") : "";
    if (!/^https?:\/\//.test(base)) return null;
    return { base, token: String(parsed.token ?? "") };
  } catch {
    return null;
  }
}

export function saveConnection(connection: ShellConnection) {
  localStorage.setItem(KEY, JSON.stringify(connection));
}

export function clearConnection() {
  localStorage.removeItem(KEY);
}

/**
 * 把用户输入变成连接配置。接受：
 *   https://192.168.1.5:8789/?t=<令牌>   （从桌面端复制/扫码来的完整链接）
 *   192.168.1.5:8789                     （手填，令牌另填）
 *   192.168.1.5                          （默认 https + 8789）
 */
export function parseConnectionInput(
  input: string,
  tokenInput = "",
): ShellConnection | null {
  let text = input.trim();
  if (!text) return null;
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!url.port) url.port = "8789";

  const token = (url.searchParams.get("t") || "").trim() || tokenInput.trim();
  url.search = "";
  url.hash = "";
  if (!token) return null;

  return { base: `${url.protocol}//${url.host}`, token };
}
