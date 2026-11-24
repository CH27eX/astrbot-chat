export type ProfileKind = "local" | "cloud";

export interface Profile {
  id: string;
  name: string;
  baseUrl: string;
  username: string;
  apiKey: string;
  kind: ProfileKind;
  createdAt: number;
  updatedAt: number;
}

export interface ProfileInput {
  id?: string;
  name: string;
  baseUrl: string;
  username: string;
  apiKey: string;
  kind: ProfileKind;
}

export type MessageRole = "user" | "assistant";

export type MessageStatus =
  | "sending"
  | "streaming"
  | "done"
  | "error"
  | "stopped";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  attachmentId?: string;
  localId?: string;
  filename?: string;
  mime?: string;
}

export interface AudioPart {
  type: "audio";
  attachmentId?: string;
  localId?: string;
  filename?: string;
  mime?: string;
  durationMs?: number;
}

export interface FilePart {
  type: "file";
  attachmentId?: string;
  localId?: string;
  filename?: string;
  mime?: string;
}

export type MessagePart = TextPart | ImagePart | AudioPart | FilePart;

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  parts: MessagePart[];
  reasoning?: string;
  createdAt: number;
  status: MessageStatus;
  error?: string;
  serverMessageId?: string;
}

export interface Session {
  id: string;
  profileId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

/** AstrBot 服务端返回的 ChatUI 会话（与本地 Session 分开）。 */
export interface ServerSession {
  session_id: string;
  platform_id: string;
  creator: string;
  display_name: string | null;
  is_group: number;
  created_at: string;
  updated_at: string;
  /** BFF 补的：最后一条消息摘要（AstrBot 自己不给，侧栏靠它认会话） */
  last_message?: string | null;
  last_role?: "user" | "assistant" | null;
  /** BFF 补的：最后一条消息时间（ISO） */
  last_message_at?: string | null;
}

/** 非文本消息段（图片 / 语音 / 文件 / 视频）。 */
export interface MediaPart {
  type: "image" | "record" | "file" | "video";
  attachmentId?: string;
  url?: string;
  filename?: string;
  text?: string;
  /** 本地预览地址（仅 UI 用，历史消息没有）。 */
  localUrl?: string;
  /**
   * 表情包标记：从表情面板选的图（不是普通照片）。
   * 渲染时用 .msg-sticker 收成 1/4 大小；历史消息靠文件名的 `[sticker]` 前缀识别。
   */
  sticker?: boolean;
}

/** BFF 从 AstrBot 数据库读出的历史消息。 */
export interface HistoryMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  media?: MediaPart[];
  sender?: string;
  createdAt: string;
  stats?: unknown;
}

export interface AttachmentRecord {
  id: string;
  blob: Blob;
  mime: string;
  filename: string;
  createdAt: number;
}

export interface Sticker {
  id: string;
  name: string;
  mime: string;
  createdAt: number;
}

export interface PendingAttachment {
  id: string;
  file: File;
  kind: "image" | "record" | "file";
  previewUrl?: string;
  durationMs?: number;
}

export interface UploadResult {
  attachment_id: string;
  filename: string;
  stored_filename?: string;
  type: "image" | "record" | "file" | "video";
}

export interface ChatStreamEvent {
  type: string;
  data?: unknown;
  streaming?: boolean;
  chain_type?: string;
  message_id?: string;
  reasoning?: string;
  [key: string]: unknown;
}

export type ConnectionState = "idle" | "checking" | "online" | "offline";

/** 消息全文搜索命中（来自本地 SQLite） */
export interface MessageHit {
  messageId: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}
