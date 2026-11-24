import {
  Brain,
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
  Mic,
  MoreHorizontal,
  Paperclip,
  PanelLeftOpen,
  Plus,
  Send,
  Settings,
  Settings2,
  Smile,
  Square,
  X,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { initialOf, readAvatarImage } from "../core/images";
import {
  addSticker,
  deleteSticker,
  getStickerBlob,
  listStickers,
  seedStickers,
} from "../core/store";
import type { Sticker } from "../core/types";
import type { ChatSettings, PendingAttachment, UiMessage } from "../types/ui";
import { uid } from "../core/utils";
import MemoryDrawer from "./MemoryDrawer";
import MessageBubble from "./MessageBubble";
import WindowControls from "./WindowControls";

/** 时间分隔条用：本地时区的 HH:mm */
function hhmm(ts: number): string {
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

interface ChatPanelProps {
  title: string;
  messages: UiMessage[];
  sending: boolean;
  loading: boolean;
  status: "checking" | "online" | "offline";
  error: string | null;
  /** 不是错误的提示（例如远端连接没有本地历史），显示成一行灰字 */
  notice?: string | null;
  onDismissNotice?: () => void;
  /** 上面还有更早的消息 */
  hasMore?: boolean;
  onLoadMore?: () => void | Promise<void>;
  /** 机器人头像（data URL）；空 = 用名字首字 */
  avatarUrl: string;
  /** 机器人名字：空状态文案和占位字用 */
  botName: string;
  chatSettings: ChatSettings;
  onChatSettingsChange: (patch: Partial<ChatSettings>) => void;
  onAvatarChange: (url: string) => void;
  sidebarHidden: boolean;
  onToggleSidebar: () => void;
  maximized: boolean;
  /** Tauri 壳里为 true：只有壳里才画最小化 / 最大化 / 关闭（手机浏览器上点了也没反应） */
  desktop: boolean;
  /** 当前会话 id：记忆抽屉靠它在 overview 里认出"当前会话"作用域 */
  activeSessionId: string | null;
  onSend: (text: string, attachment?: PendingAttachment | null) => void;
  onStop: () => void;
  onBack: () => void;
  onOpenSettings: () => void;
  onRetry: () => void;
}

const TOGGLES: { key: keyof ChatSettings; label: string; hint: string }[] = [
  { key: "images", label: "图片识别", hint: "允许发送图片（关掉后隐藏图片按钮、忽略粘贴和拖拽）" },
  { key: "voice", label: "语音消息", hint: "允许录音并发送语音" },
  { key: "stickers", label: "表情包", hint: "显示表情包面板" },
  { key: "speak", label: "朗读回复", hint: "收到回复后用系统语音念出来（本地 TTS）" },
];

export default function ChatPanel({
  title,
  messages,
  sending,
  loading,
  status,
  error,
  notice,
  onDismissNotice,
  hasMore,
  onLoadMore,
  avatarUrl,
  botName,
  chatSettings,
  onChatSettingsChange,
  onAvatarChange,
  sidebarHidden,
  onToggleSidebar,
  maximized,
  desktop,
  activeSessionId,
  onSend,
  onStop,
  onBack,
  onOpenSettings,
  onRetry,
}: ChatPanelProps) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<PendingAttachment | null>(null);
  const [stickerOpen, setStickerOpen] = useState(false);
  /** 窄屏（手机）下把图片 / 文件 / 表情 / 语音收进「＋」里，不然输入框被挤成两行 */
  const [toolsOpen, setToolsOpen] = useState(false);
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [stickerUrls, setStickerUrls] = useState<Record<string, string>>({});
  const [recording, setRecording] = useState(false);
  /** 头部「⋯」菜单：root = 菜单项，chat = 聊天设置（开关） */
  const [menu, setMenu] = useState<"closed" | "root" | "chat">("closed");
  const [memoryOpen, setMemoryOpen] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const docRef = useRef<HTMLInputElement>(null);
  const stickerRef = useRef<HTMLInputElement>(null);
  const avatarRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const urlsRef = useRef<Record<string, string>>({});
  const spokenRef = useRef<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  /** 滚到最底：用 instant，别让 CSS 的 smooth 和「图片加载后长高」抢动画 */
  const pinToBottom = (node: HTMLElement) => {
    node.scrollTo({ top: node.scrollHeight, behavior: "instant" as ScrollBehavior });
  };

  useEffect(() => {
    const node = listRef.current;
    if (!node || !stickToBottom.current) return;
    pinToBottom(node);
  }, [messages, sending]);

  /**
   * 只靠 `[messages]` 不够：历史重灌时图片要重新加载，图片撑高的那一下 messages 没变，
   * 视口就停在半空（2026-11-19 真机：长会话发完消息看到的是「中间」，得自己拖到底）。
   * 这里盯两件事：
   *   1. 消息区里任何图片 load / error 之后重新贴底（load 不冒泡，用捕获阶段）；
   *   2. 任何一条消息自己变高变矮（ResizeObserver，覆盖流式 markdown / 代码块换行）。
   * 用户手动往上翻时 stickToBottom 是 false，这里什么都不做。
   */
  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    const pin = () => {
      if (stickToBottom.current) pinToBottom(node);
    };
    node.addEventListener("load", pin, true);
    node.addEventListener("error", pin, true);
    const resize = new ResizeObserver(pin);
    const sync = () => {
      resize.disconnect();
      for (const child of Array.from(node.children)) resize.observe(child);
    };
    sync();
    const mutations = new MutationObserver(sync);
    mutations.observe(node, { childList: true });
    return () => {
      node.removeEventListener("load", pin, true);
      node.removeEventListener("error", pin, true);
      mutations.disconnect();
      resize.disconnect();
    };
  }, []);

  // 「加载更早」：往上补历史时保持可视位置不跳。
  // 锚点存「距底部多少像素 + 当时的 scrollHeight」：只有真的补进了东西（高度变大）才还原，
  // 否则直接丢掉 —— 否则到底 / 远端返回空时锚点会一直挂着，下次发消息按旧锚点把视口拽回中间。
  const loadAnchor = useRef<{ gap: number; height: number } | null>(null);
  const loadOlder = async () => {
    const node = listRef.current;
    if (!node || !onLoadMore) return;
    loadAnchor.current = {
      gap: node.scrollHeight - node.scrollTop,
      height: node.scrollHeight,
    };
    stickToBottom.current = false;
    await onLoadMore();
  };

  useEffect(() => {
    const node = listRef.current;
    const anchor = loadAnchor.current;
    if (!node || !anchor) return;
    loadAnchor.current = null;
    // 高度没变 = 这一批没补进东西（到底了 / 远端返回空），别动视口
    if (node.scrollHeight <= anchor.height) return;
    node.scrollTop = node.scrollHeight - anchor.gap;
  }, [messages]);

  // 输入框跟着内容长高，最多约 5 行，再多就内部滚动
  useEffect(() => {
    const node = textRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 148)}px`;
  }, [text]);

  // 朗读回复：只在最后一条已完成的助手消息变化时念一次
  useEffect(() => {
    if (!chatSettings.speak) return;
    const last = [...messages]
      .reverse()
      .find((item) => item.role === "assistant" && !item.streaming && item.text.trim());
    if (!last || spokenRef.current === last.id) return;
    spokenRef.current = last.id;
    try {
      const utterance = new SpeechSynthesisUtterance(last.text.slice(0, 300));
      utterance.lang = "zh-CN";
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    } catch {
      // 没有 TTS 引擎就静默
    }
  }, [messages, chatSettings.speak]);

  // 「⋯」菜单：点空白处收起（点菜单本身不关）
  useEffect(() => {
    if (menu === "closed") return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".chat-menu") || target?.closest(".chat-more-btn")) return;
      setMenu("closed");
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [menu]);

  /**
   * 系统返回键（壳里由 App 统一分发）：先关最上面那层浮层。
   * `preventDefault` = 这次返回被聊天页吃掉了，别再回列表 / 退出。
   */
  useEffect(() => {
    const onBack = (event: Event) => {
      if (menu !== "closed") {
        // 二级菜单先回菜单首页，再按一次才全关（和 QQ 一致）
        setMenu((current) => (current === "chat" ? "root" : "closed"));
        event.preventDefault();
        return;
      }
      if (memoryOpen) {
        setMemoryOpen(false);
        event.preventDefault();
        return;
      }
      if (stickerOpen || toolsOpen) {
        setStickerOpen(false);
        setToolsOpen(false);
        event.preventDefault();
      }
    };
    window.addEventListener("astrbot:back", onBack);
    return () => window.removeEventListener("astrbot:back", onBack);
  }, [menu, memoryOpen, stickerOpen, toolsOpen]);

  const loadStickers = useCallback(async () => {
    await seedStickers();
    const list = await listStickers();
    const urls: Record<string, string> = {};
    for (const sticker of list) {
      const blob = await getStickerBlob(sticker.id);
      if (blob) urls[sticker.id] = URL.createObjectURL(blob);
    }
    // 旧的 objectURL 要收回，不然反复增删会漏内存
    for (const stale of Object.values(urlsRef.current)) {
      if (!Object.values(urls).includes(stale)) URL.revokeObjectURL(stale);
    }
    urlsRef.current = urls;
    setStickers(list);
    setStickerUrls(urls);
  }, []);

  useEffect(() => {
    void loadStickers();
  }, [loadStickers]);

  const submit = () => {
    const value = text.trim();
    if ((!value && !pending) || sending) return;
    const attachment = pending;
    setText("");
    setPending(null);
    setToolsOpen(false);
    stickToBottom.current = true;
    onSend(value, attachment);
  };

  const pickImage = useCallback(
    (file: File) => {
      if (!file.type.startsWith("image/")) return;
      if (!chatSettings.images) return;
      setPending({
        id: uid(),
        kind: "image",
        file,
        name: file.name || "image.png",
        previewUrl: URL.createObjectURL(file),
      });
      setStickerOpen(false);
      setToolsOpen(false);
    },
    [chatSettings.images],
  );

  /** 任意文件：按 MIME 归类成 视频 / 语音 / 图片 / 普通文件 */
  const pickFile = useCallback(
    (file: File) => {
      const kind: PendingAttachment["kind"] = file.type.startsWith("video/")
        ? "video"
        : file.type.startsWith("audio/")
          ? "record"
          : file.type.startsWith("image/")
            ? "image"
            : "file";
      if (kind === "image" && !chatSettings.images) return;
      if (kind === "record" && !chatSettings.voice) return;
      setPending({
        id: uid(),
        kind,
        file,
        name: file.name || `${kind}-${Date.now()}.bin`,
        previewUrl: URL.createObjectURL(file),
      });
      setStickerOpen(false);
      setToolsOpen(false);
    },
    [chatSettings.images, chatSettings.voice],
  );

  /** 加一张表情包：存 IndexedDB（图不落磁盘），然后重载列表 */
  const addStickerFromFile = async (file: File) => {
    if (!file.type.startsWith("image/")) return;
    const name = (file.name || "表情")
      .replace(/\.[^.]+$/, "")
      .slice(0, 24)
      .trim() || "表情";
    await addSticker(name, file.slice(0, file.size, file.type), file.type);
    await loadStickers();
  };

  const removeSticker = async (sticker: Sticker) => {
    await deleteSticker(sticker.id);
    const url = urlsRef.current[sticker.id];
    if (url) URL.revokeObjectURL(url);
    await loadStickers();
  };

  const chooseSticker = async (sticker: Sticker) => {
    const blob = await getStickerBlob(sticker.id);
    if (!blob) return;
    const file = new File([blob], `${sticker.name}.png`, { type: sticker.mime });
    setPending({
      id: uid(),
      kind: "image",
      file,
      // `[sticker]` 前缀会随上传文件名落到 AstrBot 库里：刷新后还能认出是表情包
      name: `[sticker]${sticker.name}.png`,
      previewUrl: stickerUrls[sticker.id] ?? URL.createObjectURL(blob),
      sticker: true,
    });
    setStickerOpen(false);
    setToolsOpen(false);
  };

  /** 换头像：裁成 128px 方图存进偏好（失败了就在聊天设置面板里说一句） */
  const pickAvatar = useCallback(
    async (file: File) => {
      try {
        setAvatarError(null);
        onAvatarChange(await readAvatarImage(file));
      } catch (error) {
        setAvatarError(error instanceof Error ? error.message : "换头像失败");
      }
    },
    [onAvatarChange],
  );

  /** 直接发一段纯文本（重新生成走这条路，不经过输入框） */
  const sendText = useCallback(
    (value: string) => {
      const value2 = value.trim();
      if (!value2 || sending) return;
      setText("");
      setPending(null);
      stickToBottom.current = true;
      onSend(value2, null);
    },
    [sending, onSend],
  );

  /**
   * 重新生成：把这条回复之前用户说的那句话再发一次。
   *
   * 用 ref 读最新的 messages，是为了让这个回调的引用保持稳定 ——
   * MessageBubble 是 memo 的，回调每帧换新引用会让所有气泡白重渲染一遍。
   */
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const regenerate = useCallback(
    (messageId: string) => {
      const list = messagesRef.current;
      const index = list.findIndex((item) => item.id === messageId);
      if (index < 0) return;
      const previous = [...list.slice(0, index)]
        .reverse()
        .find((item) => item.role === "user" && item.text.trim());
      if (previous) sendText(previous.text);
    },
    [sendText],
  );

  /** 编辑后重发：把内容放回输入框并聚焦，不自动发送 */
  const editMessage = useCallback((value: string) => {
    setText(value);
    stickToBottom.current = true;
    requestAnimationFrame(() => {
      const node = textRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(node.value.length, node.value.length);
    });
  }, []);

  // 最后一条已经结束的回复才能重新生成（正在流式输出时不给按钮）
  const lastAssistantId =
    [...messages].reverse().find((item) => item.role === "assistant" && !item.streaming)
      ?.id ?? null;

  const pickFirstFile = (files: FileList | File[] | null): boolean => {
    if (!files) return false;
    const file = Array.from(files)[0];
    if (!file) return false;
    pickFile(file);
    return true;
  };

  const toggleRecord = async () => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      alert("录音需要 HTTPS 或 localhost 环境");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        const file = new File([blob], `voice-${Date.now()}.webm`, {
          type: blob.type,
        });
        setPending({
          id: uid(),
          kind: "record",
          file,
          name: "语音",
          previewUrl: URL.createObjectURL(blob),
        });
        setRecording(false);
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      alert("无法访问麦克风，请检查权限");
    }
  };

  const statusText =
    error
      ? "报错"
      : status === "online"
        ? "在线"
        : status === "checking"
          ? "连接中…"
          : "离线";

  return (
    <main
      className={`chat ${dragging ? "dragging" : ""}`}
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.types).includes("Files")) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        pickFirstFile(event.dataTransfer.files);
      }}
    >
      <header className="chat-head" data-tauri-drag-region="deep">
        <button
          className="icon-btn back-btn"
          onClick={onBack}
          title="返回会话列表"
          aria-label="返回会话列表"
        >
          <ChevronLeft size={24} />
        </button>
        {sidebarHidden && (
          <button
            className="icon-btn"
            onClick={onToggleSidebar}
            title="展开会话列表（Ctrl+B）"
            aria-label="展开会话列表"
          >
            <PanelLeftOpen size={16} />
          </button>
        )}

        <button
          className="bot-avatar"
          onClick={() => avatarRef.current?.click()}
          title="点击换头像"
          aria-label="机器人头像"
        >
          {avatarUrl ? (
            <img src={avatarUrl} alt="" />
          ) : (
            <span className="bot-avatar-letter">{initialOf(botName)}</span>
          )}
        </button>

        <div className="chat-title">
          <strong>{title}</strong>
          <small className={error ? "err" : ""}>
            <span className={`status-dot ${error ? "offline" : status}`} />
            {statusText}
          </small>
        </div>

        <div className="chat-head-actions">
          <button
            className={`icon-btn chat-more-btn ${menu !== "closed" ? "active" : ""}`}
            onClick={() => setMenu((current) => (current === "closed" ? "root" : "closed"))}
            title="更多"
            aria-label="更多"
            aria-expanded={menu !== "closed"}
          >
            <MoreHorizontal size={20} />
          </button>
          {desktop && <WindowControls maximized={maximized} />}
        </div>

        {menu !== "closed" && (
          <div className="chat-menu" role="menu">
          {menu === "root" ? (
            <>
              <button
                className="chat-menu-row"
                role="menuitem"
                onClick={() => {
                  setMenu("closed");
                  setMemoryOpen(true);
                }}
              >
                <Brain size={16} />
                <span>记忆</span>
              </button>
              <button
                className="chat-menu-row"
                role="menuitem"
                onClick={() => setMenu("chat")}
              >
                <Settings2 size={16} />
                <span>聊天设置</span>
                <ChevronRight size={15} className="chat-menu-chev" />
              </button>
              <button
                className="chat-menu-row"
                role="menuitem"
                onClick={() => {
                  setMenu("closed");
                  avatarRef.current?.click();
                }}
              >
                <ImageIcon size={16} />
                <span>换头像</span>
              </button>
              {avatarUrl && (
                <button
                  className="chat-menu-row"
                  role="menuitem"
                  onClick={() => {
                    setMenu("closed");
                    setAvatarError(null);
                    onAvatarChange("");
                  }}
                >
                  <X size={16} />
                  <span>恢复默认头像</span>
                </button>
              )}
              <div className="chat-menu-sep" />
              <button
                className="chat-menu-row"
                role="menuitem"
                onClick={() => {
                  setMenu("closed");
                  onOpenSettings();
                }}
              >
                <Settings size={16} />
                <span>更多设置</span>
              </button>
            </>
          ) : (
            <>
              <div className="chat-menu-head">
                <button
                  className="icon-btn"
                  onClick={() => setMenu("root")}
                  title="返回"
                  aria-label="返回"
                >
                  <ChevronLeft size={18} />
                </button>
                <span>聊天设置</span>
              </div>
              {TOGGLES.map((toggle) => (
                <div className="chat-menu-toggle" key={toggle.key}>
                  <div className="switch-copy">
                    <strong>{toggle.label}</strong>
                    <small>{toggle.hint}</small>
                  </div>
                  <button
                    className={`switch ${chatSettings[toggle.key] ? "on" : ""}`}
                    onClick={() =>
                      onChatSettingsChange({ [toggle.key]: !chatSettings[toggle.key] })
                    }
                    aria-pressed={chatSettings[toggle.key]}
                    title={chatSettings[toggle.key] ? "关闭" : "开启"}
                  >
                    <span />
                  </button>
                </div>
              ))}
              {avatarError && <div className="chat-menu-err">{avatarError}</div>}
            </>
          )}
          </div>
        )}
      </header>

      <MemoryDrawer
        open={memoryOpen}
        onClose={() => setMemoryOpen(false)}
        activeSessionId={activeSessionId}
      />

      <div
        className="messages"
        ref={listRef}
        onScroll={() => {
          const node = listRef.current;
          if (!node) return;
          stickToBottom.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}
      >
        {loading && messages.length === 0 && (
          <div className="loading-state">
            <span className="spinner" />
            加载历史消息…
          </div>
        )}

        {!loading && messages.length === 0 && (
          <div className="empty-state">
            <div className="empty-orb">
              {avatarUrl ? <img src={avatarUrl} alt="" /> : initialOf(botName)}
            </div>
            <h2>和 {botName} 说点什么吧</h2>
            <p>消息会走你本机的 AstrBot，和 QQ 共用同一套记忆。</p>
          </div>
        )}

        {hasMore && (
          <button
            className="load-older"
            onClick={() => void loadOlder()}
            disabled={loading}
            title="从本地 AstrBot 库里再往前读一批"
          >
            {loading ? "正在加载…" : "加载更早的消息"}
          </button>
        )}

        {messages.map((message, index) => {
          const previous = messages[index - 1];
          // QQ 那种「隔一段时间插一条时间」：首条或跟上一隔了 10 分钟以上才显示
          const showTime = !previous || message.createdAt - previous.createdAt > 10 * 60 * 1000;
          return (
            <Fragment key={message.id}>
              {showTime && <div className="msg-time-sep">{hhmm(message.createdAt)}</div>}
              <MessageBubble
                message={message}
                botAvatarUrl={avatarUrl}
                botInitial={initialOf(botName)}
                canRegenerate={!sending && message.id === lastAssistantId}
                onRegenerate={regenerate}
                onEdit={editMessage}
              />
            </Fragment>
          );
        })}
      </div>

      {notice && (
        <div className="notice-bar">
          <span>{notice}</span>
          {onDismissNotice && (
            <button
              className="icon-btn"
              onClick={onDismissNotice}
              title="知道了"
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="error-bar">
          <span>{error}</span>
          <button className="link-btn" onClick={onRetry}>
            重试
          </button>
        </div>
      )}

      <footer className="composer">
        {pending && (
          <div className="pending">
            {pending.kind === "image" ? (
              <img src={pending.previewUrl} alt="" />
            ) : pending.kind === "record" ? (
              <audio src={pending.previewUrl} controls />
            ) : (
              <div className="pending-file">
                <Paperclip size={16} />
                <span>{pending.name}</span>
                <small>{pending.kind === "video" ? "视频" : "文件"}</small>
              </div>
            )}
            <button
              className="icon-btn"
              onClick={() => setPending(null)}
              title="移除"
            >
              <X size={16} />
            </button>
          </div>
        )}

        {stickerOpen && chatSettings.stickers && (
          <div className="sticker-panel">
            <div className="sticker-grid">
              {stickers.map((sticker) =>
                stickerUrls[sticker.id] ? (
                  <span className="sticker-item" key={sticker.id}>
                    <button
                      onClick={() => void chooseSticker(sticker)}
                      title={sticker.name}
                    >
                      <img src={stickerUrls[sticker.id]} alt={sticker.name} />
                    </button>
                    <button
                      className="sticker-del"
                      onClick={() => void removeSticker(sticker)}
                      title="删除这个表情包"
                    >
                      <X size={11} />
                    </button>
                  </span>
                ) : null,
              )}
              <button
                className="sticker-add"
                onClick={() => stickerRef.current?.click()}
                title="添加表情包（图片）"
              >
                <Plus size={18} />
              </button>
            </div>
            <p className="sticker-hint">
              点「＋」加一张图（只存在本机）；悬停可删除
            </p>
          </div>
        )}

        <div className="composer-row">
          <button
            className={`tool-btn tool-more ${toolsOpen ? "active" : ""}`}
            onClick={() => setToolsOpen((value) => !value)}
            title="图片 / 文件 / 表情 / 语音"
            aria-label="更多工具"
            aria-expanded={toolsOpen}
          >
            <Plus size={20} />
          </button>

          <div className={`composer-tools ${toolsOpen ? "open" : ""}`}>
            {chatSettings.images && (
              <button
                className="tool-btn"
                onClick={() => fileRef.current?.click()}
                title="图片"
                aria-label="图片"
              >
                <ImageIcon size={18} />
              </button>
            )}
            <button
              className="tool-btn"
              onClick={() => docRef.current?.click()}
              title="文件 / 视频"
              aria-label="文件 / 视频"
            >
              <Paperclip size={18} />
            </button>
            {chatSettings.stickers && (
              <button
                className={`tool-btn ${stickerOpen ? "active" : ""}`}
                onClick={() => setStickerOpen((value) => !value)}
                title="表情包"
                aria-label="表情包"
              >
                <Smile size={18} />
              </button>
            )}
            {chatSettings.voice && (
              <button
                className={`tool-btn ${recording ? "recording" : ""}`}
                onClick={() => void toggleRecord()}
                title={recording ? "停止录音" : "语音"}
                aria-label={recording ? "停止录音" : "语音"}
              >
                {recording ? <Square size={16} /> : <Mic size={18} />}
              </button>
            )}
          </div>

          <textarea
            ref={textRef}
            value={text}
            rows={1}
            placeholder={status === "offline" ? "AstrBot 未连接…" : "说点什么…"}
            onChange={(event) => setText(event.target.value)}
            onPaste={(event) => {
              const item = Array.from(event.clipboardData.items).find((entry) =>
                entry.type.startsWith("image/"),
              );
              const file = item?.getAsFile();
              if (file) pickImage(file);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />

          {sending ? (
            <button className="send-btn stop" onClick={onStop} title="停止">
              <Square size={18} />
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={submit}
              disabled={(!text.trim() && !pending) || status === "offline"}
              title="发送"
            >
              <Send size={18} />
            </button>
          )}
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) pickImage(file);
            event.target.value = "";
          }}
        />
        <input
          ref={docRef}
          type="file"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) pickFile(file);
            event.target.value = "";
          }}
        />
        <input
          ref={stickerRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void addStickerFromFile(file);
            event.target.value = "";
          }}
        />
        <input
          ref={avatarRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void pickAvatar(file);
            event.target.value = "";
          }}
        />
      </footer>
    </main>
  );
}
