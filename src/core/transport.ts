import { authHeaders, BFF_BASE } from "./endpoint";
import type {
  ChatStreamEvent,
  HistoryMessage,
  MessageHit,
  ServerSession,
  UploadResult,
} from "./types";

const BFF = BFF_BASE;
const API = `${BFF}/v1`;

export class ApiError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string) {
    super(status === 401 ? "未授权：检查 API Key" : `请求失败（${status}）`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

interface RequestOptions {
  method?: string;
  body?: BodyInit | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body = null, signal, timeoutMs = 20_000, headers } = options;
  const controller = new AbortController();

  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = timeoutMs > 0 ? window.setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetch(`${BFF}${path}`, {
      method,
      body,
      headers: authHeaders(headers),
      signal: controller.signal,
      credentials: "same-origin",
    });
    if (!response.ok) {
      throw new ApiError(response.status, await response.text().catch(() => ""));
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      // 壳里 /astrbot/api 没打到 BFF 时会拿到 index.html（SPA 兜底），
      // 直接 response.json() 会抛 `Unexpected token '<'`，对用户毫无意义。
      throw new Error("BFF 还没就绪（收到的不是 JSON），稍后自动重试");
    }
  } finally {
    if (timer !== null) window.clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** BFF 健康检查：确认 AstrBot 在线，并拿到自动发现到的 baseUrl。 */
export async function health(): Promise<{ ok: boolean; baseUrl?: string; error?: string }> {
  const response = await fetch(`${BFF}/health`, { headers: authHeaders(), credentials: "same-origin" });
  const text = await response.text();
  try {
    return JSON.parse(text) as { ok: boolean; baseUrl?: string; error?: string };
  } catch {
    // BFF 还没起来时，壳的 asset 兜底会把这个路径返回成 index.html
    return { ok: false, error: "BFF 还没就绪（收到的不是 JSON），稍后自动重试" };
  }
}

interface Envelope<T> {
  status: "ok" | "error";
  message?: string | null;
  data: T;
}

function unwrap<T>(envelope: Envelope<T>): T {
  if (envelope.status === "error") {
    throw new Error(envelope.message || "AstrBot 返回错误");
  }
  return envelope.data;
}

export async function listSessions(username: string): Promise<ServerSession[]> {
  const envelope = await request<Envelope<{ sessions?: ServerSession[] }>>(
    `/v1/chat/sessions?username=${encodeURIComponent(username)}`,
  );
  return unwrap(envelope).sessions ?? [];
}

export async function getSessionMessages(sessionId: string): Promise<unknown> {
  const envelope = await request<Envelope<unknown>>(`/v1/chat/sessions/${encodeURIComponent(sessionId)}`);
  return unwrap(envelope);
}

/**
 * 删除一个会话（真的从 AstrBot 删掉，不可恢复）。
 *
 * AstrBot 的写接口在权限不足时也返回 200 + `{status:"error"}`，
 * 所以这里必须走 `unwrap`，不能只看 HTTP 状态码。
 */
export async function deleteSession(sessionId: string): Promise<void> {
  const envelope = await request<Envelope<unknown>>(
    `/v1/chat/sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
  );
  unwrap(envelope);
}

/**
 * 从 BFF 读取历史消息。
 * AstrBot 的 API Key 无法直接读管理员会话详情，所以 BFF 只读打开 SQLite，
 * 按 session_id 查 platform_message_history。
 *
 * `available=false` 表示这个连接没有本地历史（远端 AstrBot、Docker、或者库路径没认出来），
 * 此时上层显示一句提示，而不是当成错误。
 */
export interface HistoryResult {
  messages: HistoryMessage[];
  available: boolean;
  /** 还有更早的消息（前端显示「加载更早」） */
  hasMore: boolean;
  reason?: string;
}

export async function getHistory(
  sessionId: string,
  limit = 200,
  beforeId?: string,
): Promise<HistoryResult> {
  const before = beforeId ? `&before=${encodeURIComponent(beforeId)}` : "";
  const response = await fetch(
    `${BFF}/history?session_id=${encodeURIComponent(sessionId)}&limit=${limit}${before}`,
    { headers: authHeaders(), credentials: "same-origin" },
  );
  if (!response.ok) {
    throw new ApiError(response.status, await response.text().catch(() => ""));
  }
  const json = (await response.json()) as {
    messages?: HistoryMessage[];
    available?: boolean;
    hasMore?: boolean;
    reason?: string;
    error?: string;
  };
  if (json.error) throw new Error(json.error);
  return {
    messages: json.messages ?? [],
    available: json.available !== false,
    hasMore: json.hasMore === true,
    reason: json.reason,
  };
}

/** 消息全文搜索（只覆盖本地 SQLite；远端连接返回 available:false） */
export interface SearchResult {
  available: boolean;
  results: MessageHit[];
  reason?: string;
}

export async function searchMessages(query: string, limit = 30): Promise<SearchResult> {
  const response = await fetch(
    `${BFF}/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    { headers: authHeaders(), credentials: "same-origin" },
  );
  if (!response.ok) {
    throw new ApiError(response.status, await response.text().catch(() => ""));
  }
  const json = (await response.json()) as SearchResult;
  return {
    available: json.available !== false,
    results: json.results ?? [],
    reason: json.reason,
  };
}

/** Key 体检结果：`ok` / `bad-key`（401）/ `missing-scope`（403）/ 其它 HTTP 码 */
export interface KeyProbe {
  ok: boolean;
  baseUrl?: string;
  error?: string;
  checks?: {
    chat?: string;
    plugin?: string;
    file?: string;
  };
}

/** 让 BFF 分别打一次 chat / plugin / file 接口，判断 Key 与 scope 是否够用 */
export async function probeKey(): Promise<KeyProbe> {
  const response = await fetch(`${BFF}/probe`, { headers: authHeaders(), credentials: "same-origin" });
  if (!response.ok) {
    return { ok: false, error: `BFF 返回 ${response.status}` };
  }
  return (await response.json()) as KeyProbe;
}

/** 新建一条 ChatUI 会话，返回 session_id（由 AstrBot 生成）。 */
export async function createSession(username: string): Promise<string> {
  const envelope = await request<Envelope<{ session_id?: string } | string>>(
    `/v1/chat/sessions/new?username=${encodeURIComponent(username)}`,
  );
  const data = unwrap(envelope);
  if (typeof data === "string") return data;
  return data.session_id ?? "";
}

export interface ChatRequest {
  username: string;
  message: string | unknown[];
  sessionId?: string;
  signal?: AbortSignal;
}

/**
 * 发起一次对话，逐条回调 AstrBot 的 SSE 事件。
 *
 * 事件类型（v4.29 实测）：
 *   session_id / user_message_saved / run_started / plain / complete /
 *   message_saved / agent_stats / end；注释行 `: heartbeat` 会被忽略。
 */
export async function chatStream(
  req: ChatRequest,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<void> {
  const body: Record<string, unknown> = {
    username: req.username,
    message: req.message,
    enable_streaming: true,
  };
  if (req.sessionId) body.session_id = req.sessionId;

  const response = await fetch(`${BFF}/v1/chat`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json", Accept: "text/event-stream" }),
    body: JSON.stringify(body),
    signal: req.signal,
    credentials: "same-origin",
  });

  if (!response.ok) {
    throw new ApiError(response.status, await response.text().catch(() => ""));
  }
  if (!response.body) {
    throw new Error("浏览器不支持流式响应");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");

        if (!line.startsWith("data:")) continue; // 跳过 `: heartbeat`
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          onEvent(JSON.parse(payload) as ChatStreamEvent);
        } catch {
          // 忽略无法解析的帧，保持流不中断
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** 上传附件，返回 attachment_id；用于图片 / 语音 / 文件。 */
export async function uploadFile(file: File): Promise<UploadResult> {
  const form = new FormData();
  form.append("file", file, file.name || "upload.bin");
  const envelope = await request<Envelope<UploadResult>>("/v1/file", {
    method: "POST",
    body: form,
    timeoutMs: 120_000,
  });
  return unwrap(envelope);
}

/** 主动发一条 IM 消息（用于测试主动消息投递）。 */
export async function sendProactive(umo: string, text: string): Promise<void> {
  const envelope = await request<Envelope<unknown>>("/v1/im/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ umo, message: [{ type: "plain", text }] }),
  });
  unwrap(envelope);
}
