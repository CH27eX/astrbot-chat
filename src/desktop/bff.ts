/**
 * BFF sidecar 的桌面端控制（启动状态 / 重启 / API Key）。
 *
 * 只有 Tauri 壳里有这些命令；浏览器 PWA 走的是启动器脚本管着的 BFF。
 */
import { isDesktop } from "./bridge";

export interface BffStatus {
  /** 是不是壳自己起的进程（false 表示复用外部已经跑着的 BFF） */
  managed: boolean;
  running: boolean;
  pid: number | null;
  healthy: boolean;
  restarts: number;
  script: string | null;
  error: string | null;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) {
    throw new Error("BFF 控制只在桌面版可用");
  }
  const { invoke: run } = await import("@tauri-apps/api/core");
  return run<T>(command, args);
}

export async function readBffStatus(): Promise<BffStatus> {
  return invoke<BffStatus>("bff_status");
}

export async function restartBff(): Promise<BffStatus> {
  return invoke<BffStatus>("restart_bff");
}

export async function readApiKey(): Promise<string> {
  return invoke<string>("read_api_key");
}

export async function writeApiKey(key: string): Promise<void> {
  await invoke<void>("write_api_key", { key });
}
