/**
 * 手机 / 局域网访问（桌面壳能力）。
 *
 * 打开后壳会把 BFF 绑到 `0.0.0.0` 并带一个令牌；手机在同一个 Wi-Fi 下打开
 * 设置里显示的链接（`?t=<令牌>`）即可，令牌会换成 cookie 并从地址栏消失。
 * 局域网上不填 Key —— Key 只在 BFF 里注入。
 */
import { isDesktop } from "./bridge";

export interface LanInfo {
  enabled: boolean;
  /** 32 位十六进制令牌；没开时可能是空串 */
  token: string;
  port: number;
  /** 手机能直接打开的链接；没开或取不到局域网 IP 时为空 */
  url: string;
  lanIp: string;
  /** 有没有自签证书（有 = 走 8789 的 HTTPS，url 也是 https；手机上才是安全上下文） */
  https: boolean;
  httpsPort: number;
  /** 手机装 CA 用的下载地址（http，装证书之前 https 还不被信任） */
  caUrl: string;
  /** 远程访问基址（Tailscale Serve 等，形如 `https://host.tailnet.ts.net:8443`）；空 = 只用局域网 IP */
  remoteBase: string;
  /** `url` 的来源：`remote` / `lan-https` / `lan-http`；空 = 没链接 */
  urlSource: "" | "remote" | "lan-https" | "lan-http";
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) {
    throw new Error("局域网访问只在桌面版可用");
  }
  const { invoke: run } = await import("@tauri-apps/api/core");
  return run<T>(command, args);
}

export async function readLanInfo(): Promise<LanInfo> {
  return invoke<LanInfo>("lan_info");
}

/** 开关会重启 BFF（监听地址是启动时决定的），返回新的连接信息 */
export async function setLanAccess(enabled: boolean): Promise<LanInfo> {
  return invoke<LanInfo>("set_lan_access", { enabled });
}

/**
 * 重置配对：换一把新令牌 + 重启 BFF。
 * 老二维码、老链接、手机里已写入的 cookie 全部失效，每台手机都要重新扫。
 */
export async function resetLanPairing(): Promise<LanInfo> {
  return invoke<LanInfo>("reset_lan_pairing");
}

/**
 * 保存「远程访问地址」（Tailscale Serve 之类）：二维码 / 复制链接改用它拼。
 * 传空串 = 清掉，退回局域网地址。不重启 BFF。
 */
export async function setLanRemoteBase(base: string): Promise<LanInfo> {
  return invoke<LanInfo>("set_lan_remote_base", { base });
}
