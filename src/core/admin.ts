/**
 * 可选的 AstrBot 插件 `astrbot_plugin_webchat_admin`。
 *
 * AstrBot 的会话接口在服务层硬比较 `session.creator == username`，而 API Key 的身份是
 * `api_key:<id>`，所以用 Key 删会话 / 改名 / 读会话详情永远是 Permission denied。
 * 装了那个插件后，这三件事改走插件的 Web API（同样要 plugin scope）。
 *
 * 插件不在就返回 available:false，调用方退回原来的行为，不影响其它功能。
 */
import { authHeaders, BFF_BASE } from "./endpoint";
import type { HistoryMessage, MediaPart } from "./types";

const EXT = `${BFF_BASE}/v1/plugins/extensions/astrbot_plugin_webchat_admin`;

export interface AdminStatus {
  available: boolean;
  version?: string;
  reason?: string;
}

interface Envelope<T> {
  status: "ok" | "error";
  message?: string;
  data: T;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${EXT}${path}`, {
    credentials: "same-origin",
    ...init,
    headers: authHeaders({
      "content-type": "application/json",
      ...((init?.headers as Record<string, string> | undefined) ?? {}),
    }),
  });
  if (!response.ok) throw new Error(`插件接口返回 ${response.status}`);
  const json = (await response.json()) as Envelope<T>;
  if (json.status === "error") throw new Error(json.message || "插件返回错误");
  return json.data;
}

export async function probeAdmin(): Promise<AdminStatus> {
  try {
    const info = await call<{ plugin?: string; version?: string }>("/health");
    if (info?.plugin) return { available: true, version: info.version };
    return { available: false, reason: "插件没有返回 plugin 字段" };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function renameRemote(sessionId: string, name: string): Promise<void> {
  await call("/rename", {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId, name }),
  });
}

export async function deleteRemote(sessionId: string): Promise<{ deleted: boolean }> {
  return call<{ deleted: boolean }>("/delete", {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId }),
  });
}

export interface RemoteHistory {
  messages: HistoryMessage[];
  hasMore: boolean;
  displayName?: string | null;
}

/** 插件返回的消息和 BFF 的 HistoryMessage 形状对齐，只有 media 缺 url */
export async function remoteHistory(
  sessionId: string,
  page = 1,
  pageSize = 100,
): Promise<RemoteHistory> {
  const data = await call<{
    messages?: Array<HistoryMessage & { media?: Array<Record<string, unknown>> }>;
    hasMore?: boolean;
    displayName?: string | null;
  }>(`/history?session_id=${encodeURIComponent(sessionId)}&page=${page}&page_size=${pageSize}`);

  const messages = (data.messages ?? []).map((message) => ({
    ...message,
    media: (message.media ?? []).map((part) => {
      const type = String(part.type ?? "file");
      return {
        type: (type === "record" || type === "video" || type === "image"
          ? type
          : "file") as MediaPart["type"],
        attachmentId: (part.attachmentId as string) ?? undefined,
        filename: (part.filename as string) ?? undefined,
      } satisfies MediaPart;
    }),
  }));

  return { messages, hasMore: data.hasMore === true, displayName: data.displayName };
}
