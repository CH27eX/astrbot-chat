import type { MediaPart } from "../core/types";

export interface UiStats {
  tokens?: number;
  firstTokenMs?: number;
}

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  media?: MediaPart[];
  createdAt: number;
  streaming?: boolean;
  error?: boolean;
  stats?: UiStats | null;
}

/** 待发送的附件：先在本地预览，发送时才上传。 */
export interface PendingAttachment {
  id: string;
  /** image / record（语音）/ video / file */
  kind: "image" | "record" | "video" | "file";
  file: File | Blob;
  name: string;
  previewUrl: string;
  /** 从表情面板选的：发送时文件名带 `[sticker]` 前缀，渲染时收小 */
  sticker?: boolean;
}

/** 聊天区右上「聊天设置」里的开关（本地偏好） */
export interface ChatSettings {
  /** 允许发送图片（关掉后隐藏图片按钮、忽略粘贴/拖拽） */
  images: boolean;
  /** 允许发语音（录音按钮） */
  voice: boolean;
  /** 显示表情包入口 */
  stickers: boolean;
  /** 收到回复后朗读（本地 TTS） */
  speak: boolean;
}