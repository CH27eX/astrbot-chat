import { Check, Copy, Pencil, RefreshCw } from "lucide-react";
import { lazy, memo, Suspense, useEffect, useRef, useState } from "react";
import { BFF_BASE, withTokenParam } from "../core/endpoint";
import type { MediaPart } from "../core/types";
import { formatTime, isStickerName, stickerLabel } from "../core/utils";
import type { UiMessage } from "../types/ui";

const Markdown = lazy(() => import("./Markdown"));

function mediaSrc(part: MediaPart): string | null {
  if (part.localUrl) return part.localUrl;
  if (part.attachmentId) {
    // 套壳里 BFF 是跨域的，<img>/<audio> 带不了自定义头 → 令牌只能放 query
    return withTokenParam(`${BFF_BASE}/v1/files/${encodeURIComponent(part.attachmentId)}/content`);
  }
  if (part.url) {
    // 同源相对路径（PWA）也统一走一下；外链 http(s) 不加令牌，避免泄露
    return part.url.startsWith("/") ? withTokenParam(part.url) : part.url;
  }
  return null;
}

/** 表情包判定：标记 / 文件名 / 本机记录都算；再补一条「小方图」兜底 */
const STICKER_MAX_SIDE = 480;

function MediaItem({ part }: { part: MediaPart }) {
  const src = mediaSrc(part);
  // 先按标记判断；拿到图片尺寸后再用「小方图」兜底（历史消息文件名会被 AstrBot 改写）
  const [looksLikeSticker, setLooksLikeSticker] = useState(false);
  const sticker =
    part.type === "image" &&
    (part.sticker === true || isStickerName(part.filename) || looksLikeSticker);

  if (part.type === "image") {
    return src ? (
      <img
        className={sticker ? "msg-image msg-sticker" : "msg-image"}
        src={src}
        alt={sticker ? stickerLabel(part.filename) || "表情" : part.filename || "图片"}
        loading="lazy"
        onLoad={(event) => {
          const img = event.currentTarget;
          const w = img.naturalWidth;
          const h = img.naturalHeight;
          if (w > 0 && h > 0 && w <= STICKER_MAX_SIDE && h <= STICKER_MAX_SIDE) {
            const ratio = Math.max(w, h) / Math.min(w, h);
            if (ratio <= 1.6) setLooksLikeSticker(true);
          }
        }}
      />
    ) : (
      <span className="media-missing">[图片]</span>
    );
  }

  if (part.type === "record") {
    return src ? (
      <audio className="msg-audio" src={src} controls preload="none" />
    ) : (
      <span className="media-missing">
        [语音]{part.text ? ` ${part.text}` : ""}
      </span>
    );
  }

  if (part.type === "video") {
    return src ? (
      <video className="msg-video" src={src} controls preload="none" />
    ) : (
      <span className="media-missing">[视频]</span>
    );
  }

  return src ? (
    <a className="msg-file" href={src} target="_blank" rel="noreferrer">
      {part.filename || "文件"}
    </a>
  ) : (
    <span className="media-missing">{part.filename || "[文件]"}</span>
  );
}

/** 复制到剪贴板：优先 Clipboard API，不行就退回 execCommand（旧 WebView 兜底） */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

interface MessageBubbleProps {
  message: UiMessage;
  /** 机器人头像（data URL）；只在非用户消息的小头像上用 */
  botAvatarUrl?: string;
  /** 没有头像时的占位字（机器人名字首字） */
  botInitial?: string;
  /** 只有最后一条回复能「重新生成」 */
  canRegenerate?: boolean;
  /** 重新生成：参数是这条消息的 id（上层按 id 找它前面那轮提问） */
  onRegenerate?: (messageId: string) => void;
  /** 把这条用户消息放回输入框，改完再发 */
  onEdit?: (text: string) => void;
}

/**
 * 单条消息。**必须 memo**：流式输出时上层每帧都会重建 messages 数组，
 * 但只有最后一条是新的对象；其余气泡靠 memo 直接跳过（markdown 重解析很贵）。
 * 所以给它的回调必须是稳定引用（ChatPanel 里用 useCallback + ref 保证）。
 */
function MessageBubble({
  message,
  botAvatarUrl = "",
  botInitial = "A",
  canRegenerate = false,
  onRegenerate,
  onEdit,
}: MessageBubbleProps) {
  const isUser = message.role === "user";
  const media = message.media ?? [];
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    if (!message.text.trim()) return;
    const ok = await copyText(message.text);
    if (!ok) return;
    setCopied(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1200);
  };

  const canEdit = isUser && Boolean(onEdit) && Boolean(message.text.trim());

  return (
    <div className={`msg ${isUser ? "msg-user" : "msg-bot"} ${message.error ? "msg-error" : ""}`}>
      {!isUser && (
        <div className="avatar">
          {botAvatarUrl ? <img src={botAvatarUrl} alt="" /> : botInitial}
        </div>
      )}
      <div className="msg-body">
        <div className="msg-actions">
          <button
            type="button"
            className="msg-action"
            onClick={() => void copy()}
            title={copied ? "已复制" : "复制"}
            aria-label="复制这条消息"
            disabled={!message.text.trim()}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
          {canEdit && (
            <button
              type="button"
              className="msg-action"
              onClick={() => onEdit?.(message.text)}
              title="编辑后重发"
              aria-label="编辑后重发"
            >
              <Pencil size={13} />
            </button>
          )}
          {!isUser && canRegenerate && onRegenerate && (
            <button
              type="button"
              className="msg-action"
              onClick={() => onRegenerate?.(message.id)}
              title="重新生成（会把上一条提问再发一次）"
              aria-label="重新生成"
            >
              <RefreshCw size={13} />
            </button>
          )}
        </div>

        <div className="bubble">
          {media.length > 0 && (
            <div className="msg-media">
              {media.map((part, index) => (
                <MediaItem key={`${part.type}-${index}`} part={part} />
              ))}
            </div>
          )}

          {isUser ? (
            message.text ? <p className="plain">{message.text}</p> : null
          ) : (
            <div className="markdown">
              {message.text ? (
                <Suspense fallback={<p className="plain">{message.text}</p>}>
                  <Markdown text={message.text} />
                </Suspense>
              ) : null}
              {message.streaming && <span className="cursor" />}
            </div>
          )}
        </div>
        <div className="msg-meta">
          <span>{formatTime(message.createdAt)}</span>
          {message.stats?.tokens ? <span>{message.stats.tokens} tokens</span> : null}
          {message.stats?.firstTokenMs ? <span>{message.stats.firstTokenMs} ms</span> : null}
        </div>
      </div>
    </div>
  );
}

export default memo(MessageBubble);

