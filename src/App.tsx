import { X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChatPanel from "./components/ChatPanel";
import CloseConfirmDialog from "./components/CloseConfirmDialog";
import ConfirmDialog from "./components/ConfirmDialog";
import EdgeDrawer from "./components/EdgeDrawer";
import { InsecureHint } from "./components/InsecureHint";
import ResizeHandles from "./components/ResizeHandles";
import Sidebar from "./components/Sidebar";
import { dispatchBackEvent, exitApp, registerBackHandler } from "./core/back";
import { useIsCompact } from "./core/viewport";
import {
  applyCloseAction,
  checkForUpdate,
  installUpdate,
  isDesktop,
  isWindowMaximized,
  onCloseRequested,
  onWindowResized,
  readDesktopSettings,
  writeDesktopSettings,
  type CloseAction,
} from "./desktop/bridge";
import {
  requestNotificationPermission,
  showNotification,
} from "./desktop/notify";
import {
  chatStream,
  deleteSession,
  getHistory,
  health,
  listSessions,
  searchMessages,
  sendProactive,
  uploadFile,
} from "./core/transport";
import {
  deleteRemote,
  probeAdmin,
  remoteHistory,
  renameRemote,
  type AdminStatus,
} from "./core/admin";
import type {
  ChatStreamEvent,
  HistoryMessage,
  MediaPart,
  MessageHit,
  ServerSession,
} from "./core/types";
import type { InstallPromptEvent } from "./core/pwa";
import {
  applyPrefs,
  botDisplayName,
  MAX_CHAT_BG,
  readPrefs,
  savePrefs,
  type Prefs,
} from "./core/prefs";
import { isKnownSticker, rememberSticker } from "./core/sticker-mark";
import { isStickerName, sessionActivity, sessionTitle, uid } from "./core/utils";
import { beginSend, markChunk, markFirstPaint, markServerTtft } from "./core/perf";
import { clearConnection, isNativeShell } from "./core/connection";
import type { ChatSettings, PendingAttachment, UiMessage, UiStats } from "./types/ui";

/**
 * 设置弹层 / 首次运行引导都按需加载：首屏（会话列表）用不到它们，
 * 拆出去能少下几十 KB；点开之前不请求。
 */
const SettingsDialog = lazy(() => import("./components/SettingsDialog"));
const MobileSettings = lazy(() => import("./components/MobileSettings"));
const FirstRunDialog = lazy(() => import("./components/FirstRunDialog"));

const USERNAME_KEY = "astrbot-chat.username";
const SESSION_KEY = "astrbot-chat.session";
const NOTIFY_KEY = "astrbot-chat.notifications";
/** 每个会话「已读到的最后一条消息时间」，用来算未读小点 */
const SEEN_KEY = "astrbot-chat.seen";
/** 是否折叠侧栏（桌面宽窗下也能手动收起） */
const SIDEBAR_HIDDEN_KEY = "astrbot-chat.sidebar-hidden";
/** 本地置顶的会话 id */
const PINNED_KEY = "astrbot-chat.pinned";
/** 本地备注名（服务端没有改名接口） */
const ALIAS_KEY = "astrbot-chat.aliases";
/** 本地归档（收起但保留） */
const ARCHIVED_KEY = "astrbot-chat.archived";
/** 聊天区右上角「聊天设置」里的开关 */
const CHAT_SETTINGS_KEY = "astrbot-chat.chat-settings";
/**
 * 上次成功拉到的会话列表。只为了「打开就能先看到列表」，网络结果一到就替换。
 * 冷启动这几年最慢的一段就是等 BFF 发现 AstrBot + AstrBot 列会话（~2s），
 * 列表先画出来，体感就从「空白 2 秒」变成「立刻有东西」。
 */
const SESSIONS_CACHE_KEY = "astrbot-chat.sessions-cache";
const SESSIONS_CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

function readSessionsCache(username: string): ServerSession[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSIONS_CACHE_KEY) ?? "null");
    if (!parsed || parsed.username !== username || !Array.isArray(parsed.items)) return [];
    if (Date.now() - Number(parsed.at || 0) > SESSIONS_CACHE_MAX_AGE) return [];
    return parsed.items.filter(
      (item: ServerSession) => item && typeof item.session_id === "string",
    );
  } catch {
    return [];
  }
}

function writeSessionsCache(username: string, items: ServerSession[]) {
  try {
    localStorage.setItem(
      SESSIONS_CACHE_KEY,
      JSON.stringify({ username, at: Date.now(), items: items.slice(0, 60) }),
    );
  } catch {
    // 配额满了就不缓存，不影响连接
  }
}


export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  images: true,
  voice: true,
  stickers: true,
  speak: false,
};

function loadChatSettings(): ChatSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHAT_SETTINGS_KEY) ?? "{}");
    return {
      images: parsed.images !== false,
      voice: parsed.voice !== false,
      stickers: parsed.stickers !== false,
      speak: parsed.speak === true,
    };
  } catch {
    return { ...DEFAULT_CHAT_SETTINGS };
  }
}

function loadSeen(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const next: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value)) next[key] = value;
    }
    return next;
  } catch {
    return {};
  }
}

function loadPinned(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PINNED_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function loadAliases(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(ALIAS_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim()) next[key] = value;
    }
    return next;
  } catch {
    return {};
  }
}

function loadArchived(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(ARCHIVED_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** 只在 Tauri 壳里为 true；浏览器 PWA 下不渲染标题栏和缩放手柄 */
const DESKTOP = isDesktop();

function shortId(id: string): string {
  return id.slice(0, 8);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statsFrom(raw: unknown): UiStats | null {
  const data = raw as
    | {
        token_usage?: {
          input_other?: number;
          input_cached?: number;
          output?: number;
        };
        time_to_first_token?: number;
      }
    | null
    | undefined;
  if (!data || typeof data !== "object") return null;
  const usage = data.token_usage;
  const stats: UiStats = {
    tokens: usage
      ? (usage.input_other ?? 0) +
        (usage.input_cached ?? 0) +
        (usage.output ?? 0)
      : undefined,
    firstTokenMs: data.time_to_first_token
      ? Math.round(data.time_to_first_token * 1000)
      : undefined,
  };
  return stats.tokens || stats.firstTokenMs ? stats : null;
}

function toUiMessage(item: HistoryMessage): UiMessage {
  return {
    id: item.id,
    role: item.role,
    text: item.text,
    media: (item.media ?? []).map((part) =>
      part.type === "image" &&
      (part.sticker === true ||
        isStickerName(part.filename) ||
        isKnownSticker(part.attachmentId, part.filename))
        ? { ...part, sticker: true }
        : part,
    ),
    createdAt: Date.parse(item.createdAt) || Date.now(),
    stats: statsFrom(item.stats),
  };
}

function notifyMessage(message: UiMessage, botName: string) {
  const body =
    message.text.trim().slice(0, 140) ||
    (message.media?.length ? "收到一条媒体消息" : "");
  if (!body) return;
  void showNotification(botName, body);
}

export default function App() {
  const [username, setUsername] = useState(
    () => localStorage.getItem(USERNAME_KEY) || "astrbot",
  );
  const [sessions, setSessions] = useState<ServerSession[]>(() =>
    readSessionsCache(username),
  );
  const [activeId, setActiveId] = useState<string | null>(
    () => localStorage.getItem(SESSION_KEY),
  );
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [status, setStatus] = useState<"checking" | "online" | "offline">(
    "checking",
  );
  const [baseUrl, setBaseUrl] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 左缘设置抽屉：提到这里是为了让系统返回键能先关它 */
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** 手机布局：设置走全屏分组页，而不是桌面弹层 */
  const compact = useIsCompact();
  const [mobileView, setMobileView] = useState<"list" | "chat">(() =>
    localStorage.getItem(SESSION_KEY) ? "chat" : "list",
  );
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [notifications, setNotifications] = useState(
    () => localStorage.getItem(NOTIFY_KEY) === "1",
  );
  const [error, setError] = useState<string | null>(null);
  /** 历史读不到时的温和提示（远端 / Docker），不是错误，不挡聊天 */
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [closePrompt, setClosePrompt] = useState(false);
  const [showFirstRun, setShowFirstRun] = useState(false);
  // 启动时自动检查更新，有新版本就浮一条提示（不打断当前聊天）
  const [updateInfo, setUpdateInfo] = useState<{
    version: string | null;
  } | null>(null);
  const [updating, setUpdating] = useState(false);
  // 侧栏折叠：也是纯本地偏好
  const [sidebarHidden, setSidebarHidden] = useState(
    () => localStorage.getItem(SIDEBAR_HIDDEN_KEY) === "1",
  );
  // 外观偏好（主题 / 密度 / 强调色 / 字号档 / 圆角档）：纯本地，改完立刻落盘
  const [prefs, setPrefs] = useState<Prefs>(readPrefs);
  const updatePrefs = (patch: Partial<Prefs>) =>
    setPrefs((prev) => ({ ...prev, ...patch }));
  /** 当前会话上面还有没有更早的消息（本地库才有） */
  const [historyHasMore, setHistoryHasMore] = useState(false);
  /** 侧栏消息搜索结果 */
  const [searchHits, setSearchHits] = useState<MessageHit[]>([]);
  const [searchUnavailable, setSearchUnavailable] = useState(false);
  /** 可选的 webchat_admin 插件（装了才能删/改名/读远端历史） */
  const [admin, setAdmin] = useState<AdminStatus>({ available: false });
  const adminRef = useRef(admin);
  /** 当前会话的历史是走本地库还是插件 */
  const [historyRemote, setHistoryRemote] = useState(false);
  const remotePageRef = useRef(1);
  const [seen, setSeen] = useState<Record<string, number>>(loadSeen);
  const [pinned, setPinned] = useState<string[]>(loadPinned);
  const [aliases, setAliases] = useState<Record<string, string>>(loadAliases);
  const [archived, setArchived] = useState<string[]>(loadArchived);
  /** 等待二次确认的删除目标 */
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [chatSettings, setChatSettings] = useState<ChatSettings>(loadChatSettings);
  /** 机器人显示名：侧栏品牌 / 空状态文案 / 通知标题都用它 */
  const botName = botDisplayName(prefs);
  const botNameRef = useRef(botName);
  /** 第一次拿到会话列表时把历史会话都标成已读，否则一开就是一片红点 */
  const seenInitialized = useRef(false);

  const abortRef = useRef<AbortController | null>(null);
  const draftRef = useRef<string | null>(null);
  const newBubbleRef = useRef(true);
  const sessionRef = useRef<string | null>(activeId);
  const activeRef = useRef<string | null>(activeId);
  /**
   * 「正在写一条新对话」：点了 + 新对话之后 activeId 是 null，
   * 但会话列表每 20 秒轮询一次，refreshSessions 的兜底会把 activeId 自动
   * 设成 list[0]，于是新对话被"弹回"到最近那个会话——用户看起来就是
   * "点新对话没用 / 消息进了上一个会话"。这个标记决定兜底要不要生效。
   */
  const composingNewRef = useRef(false);
  const historySeq = useRef(0);
  const messagesRef = useRef<UiMessage[]>([]);
  const notificationsRef = useRef(notifications);

  /** 把某个会话标成已读（`at` 传它最后一条消息的时间，避免时钟误差） */
  const markSeen = useCallback((sessionId: string | null, at?: number) => {
    if (!sessionId) return;
    const stamp = at && Number.isFinite(at) ? at : Date.now();
    setSeen((current) => {
      const previous = current[sessionId] ?? 0;
      if (previous >= stamp) return current;
      return { ...current, [sessionId]: stamp };
    });
  }, []);

  /** 哪些会话有新消息（当前打开的那个不算） */
  const unreadIds = useMemo(() => {
    const result = new Set<string>();
    for (const session of sessions) {
      if (session.session_id === activeId) continue;
      const activity = sessionActivity(session);
      const seenAt = seen[session.session_id] ?? 0;
      if (activity > seenAt) result.add(session.session_id);
    }
    return result;
  }, [sessions, activeId, seen]);

  const checkConnection = useCallback(async () => {
    setStatus("checking");
    setError(null);
    // 桌面壳是先开窗、后拉 BFF 的，所以失败要短暂重试几次。
    // 壳里 BFF 的冷启动要起一个 Node 进程，8 次 × 700ms 覆盖 bff.rs 的 8 秒就绪等待。
    const attempts = DESKTOP ? 8 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const result = await health();
        if (result.ok) {
          setStatus("online");
          setBaseUrl(result.baseUrl || "");
          // 前一次尝试失败留下的「Failed to fetch」必须在这里清掉：
          // 循环开头只清过一次，成功返回时如果不清，冷启动那一下的错误会一直挂着。
          setError(null);
          return;
        }
        setStatus("offline");
        setError(result.error || "无法连接 AstrBot");
      } catch (e) {
        setStatus("offline");
        setError(errorText(e));
      }
      if (attempt < attempts) {
        await new Promise((resolve) => window.setTimeout(resolve, 700));
      }
    }
  }, []);

  const refreshSessions = useCallback(
    async (name: string) => {
      try {
        const list = await listSessions(name);
        setSessions(list);
        writeSessionsCache(name, list);
        setActiveId((current) => {
          if (current && list.some((item) => item.session_id === current)) {
            return current;
          }
          // 用户正在写一条新对话：不要自动选中 list[0]，否则 20 秒轮询
          // 会把「新对话」弹回最近的会话，发出去的消息就落到旧会话里了。
          if (composingNewRef.current) return null;
          // 刚创建、列表还没刷出来的会话：保留它，别跳走
          if (current && sessionRef.current === current) return current;
          return list[0]?.session_id ?? null;
        });
      } catch (e) {
        setError(errorText(e));
      }
    },
    [],
  );

  const reloadHistory = useCallback(async (sessionId: string) => {
    const local = await getHistory(sessionId, 200);
    let messages: HistoryMessage[] = local.messages;
    let hasMore = local.hasMore;
    let available = local.available;
    let remote = false;

    // 本地库读不到（远端 / Docker）时，如果装了 webchat_admin 插件，就改走插件
    if (!available && adminRef.current.available) {
      try {
        const data = await remoteHistory(sessionId, 1, 200);
        messages = data.messages;
        hasMore = data.hasMore;
        available = true;
        remote = true;
      } catch (error) {
        setError(errorText(error));
      }
    }

    setHistoryRemote(remote);
    remotePageRef.current = 1;
    setMessages(messages.map(toUiMessage));
    setHistoryHasMore(hasMore);
    setHistoryNotice(
      available
        ? null
        : "这个连接读不到本地历史（远端 AstrBot / Docker）：新消息照常收发，旧记录看不到",
    );
  }, []);

  /** 往上翻：本地库用 before 游标；插件模式用 page 翻页 */
  const loadMoreHistory = useCallback(async () => {
    if (!activeId) return;
    if (historyRemote) {
      const next = remotePageRef.current + 1;
      const data = await remoteHistory(activeId, next, 200);
      remotePageRef.current = next;
      setHistoryHasMore(data.hasMore);
      if (data.messages.length === 0) return;
      setMessages((prev) => {
        const seen = new Set(prev.map((message) => message.id));
        const front = data.messages
          .filter((message) => !seen.has(message.id))
          .map(toUiMessage);
        return [...front, ...prev];
      });
      return;
    }

    const first = messagesRef.current.find((message) => message.id.startsWith("m"));
    const before = first ? first.id.replace(/^m/, "") : "";
    if (!before) return;
    const older = await getHistory(activeId, 100, before);
    setHistoryHasMore(older.available && older.hasMore);
    if (older.messages.length === 0) return;
    setMessages((prev) => {
      const seen = new Set(prev.map((message) => message.id));
      const front = older.messages
        .filter((message) => !seen.has(message.id))
        .map(toUiMessage);
      return [...front, ...prev];
    });
  }, [activeId, historyRemote]);

  /** 消息全文搜索：本地库走 SQL，远端会返回「不可用」 */
  const runSearch = useCallback(async (query: string) => {
    const keyword = query.trim();
    if (keyword.length < 2) {
      setSearchHits([]);
      setSearchUnavailable(false);
      return;
    }
    try {
      const result = await searchMessages(keyword, 20);
      setSearchHits(result.results);
      setSearchUnavailable(!result.available);
    } catch {
      setSearchHits([]);
      setSearchUnavailable(false);
    }
  }, []);

  const openSearchHit = useCallback((hit: MessageHit) => {
    setActiveId(hit.sessionId);
    setMobileView("chat");
  }, []);

  useEffect(() => {
    void checkConnection();
  }, [checkConnection]);

  // 离线时每 3 秒自己再试一次（AstrBot 可能是后起来的）
  useEffect(() => {
    if (status !== "offline") return;
    const timer = window.setInterval(() => void checkConnection(), 3_000);
    return () => window.clearInterval(timer);
  }, [status, checkConnection]);

  // 连上之后再拉一次会话列表：壳里 BFF 比窗口晚起来时，首屏那次请求会失败
  useEffect(() => {
    if (status !== "online") return;
    void refreshSessions(username);
  }, [status, username, refreshSessions]);

  // 桌面端首次启动：既是第一跑、又没有任何 Key 兜底时，弹一次引导
  useEffect(() => {
    if (!DESKTOP) return;
    let cancelled = false;
    void readDesktopSettings()
      .then((settings) => {
        if (cancelled) return;
        if (!settings.firstRunDone && settings.apiKeySource === "none") {
          setShowFirstRun(true);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // 桌面端：启动时按设置检查一次更新。没配更新源 / 连不上都静默跳过。
  useEffect(() => {
    if (!DESKTOP) return;
    let cancelled = false;
    void (async () => {
      try {
        const settings = await readDesktopSettings();
        if (cancelled || !settings.updateCheckOnStart) return;
        if (!settings.updateEndpoint) return;
        const result = await checkForUpdate();
        if (cancelled || result.status !== "available") return;
        setUpdateInfo({ version: result.version });
      } catch {
        // 更新检查失败不该打扰用户：日志里有壳的 warn 就够了
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const runInstallUpdate = async () => {
    setUpdating(true);
    setError(null);
    try {
      await installUpdate();
      // 正常走不到这里：Windows 上安装程序起来后进程就退出了
      setUpdateInfo(null);
      setUpdating(false);
    } catch (e) {
      setUpdating(false);
      setError(errorText(e));
    }
  };

  // 桌面端：跟进最大化状态 + 接住「关闭询问」事件
  useEffect(() => {
    if (!DESKTOP) return;
    let cancelled = false;
    let stopResize: (() => void) | undefined;
    let stopClose: (() => void) | undefined;

    const syncMaximized = () => {
      void isWindowMaximized()
        .then((value) => {
          if (!cancelled) setMaximized(value);
        })
        .catch(() => undefined);
    };

    void (async () => {
      try {
        const unlisten = await onWindowResized(syncMaximized);
        if (cancelled) {
          unlisten();
          return;
        }
        stopResize = unlisten;
        syncMaximized();
      } catch {
        // 桌面能力不可用时静默降级
      }
    })();

    void onCloseRequested(() => setClosePrompt(true))
      .then((unlisten) => {
        if (cancelled) unlisten();
        else stopClose = unlisten;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      stopResize?.();
      stopClose?.();
    };
  }, []);

  const handleCloseChoice = (action: CloseAction, remember: boolean) => {
    setClosePrompt(false);
    void (async () => {
      try {
        if (remember) {
          await writeDesktopSettings({
            closeBehavior: action === "exit" ? "exit" : "tray",
          });
        }
        await applyCloseAction(action);
      } catch (e) {
        setError(errorText(e));
      }
    })();
  };

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => setInstallPrompt(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  useEffect(() => {
    void refreshSessions(username);
  }, [username, refreshSessions]);

  // 未读小点：第一次拿到列表时先把已有会话标成已读，之后才靠轮询发现新的
  useEffect(() => {
    if (seenInitialized.current || sessions.length === 0) return;
    seenInitialized.current = true;
    setSeen((current) => {
      const next = { ...current };
      for (const session of sessions) {
        if (next[session.session_id]) continue;
        next[session.session_id] = sessionActivity(session);
      }
      return next;
    });
  }, [sessions]);

  useEffect(() => {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  }, [seen]);

  useEffect(() => {
    localStorage.setItem(PINNED_KEY, JSON.stringify(pinned));
  }, [pinned]);

  useEffect(() => {
    localStorage.setItem(ALIAS_KEY, JSON.stringify(aliases));
  }, [aliases]);

  useEffect(() => {
    localStorage.setItem(ARCHIVED_KEY, JSON.stringify(archived));
  }, [archived]);

  const togglePin = useCallback((sessionId: string) => {
    setPinned((current) =>
      current.includes(sessionId)
        ? current.filter((id) => id !== sessionId)
        : [sessionId, ...current],
    );
  }, []);

  /** 备注名留空 = 删掉备注，恢复成服务端的名字/摘要 */
  const renameSession = useCallback((sessionId: string, alias: string) => {
    setAliases((current) => {
      const next = { ...current };
      const trimmed = alias.trim();
      if (!trimmed) delete next[sessionId];
      else next[sessionId] = trimmed;
      return next;
    });
    // 装了 webchat_admin 插件就顺带改服务端的名字（AstrBot 面板/QQ 侧也能看到）
    if (adminRef.current.available) {
      void renameRemote(sessionId, alias)
        .then(() => refreshSessions(username))
        .catch((error) => setError(errorText(error)));
    }
  }, [refreshSessions, username]);

  const pinnedIds = useMemo(() => new Set(pinned), [pinned]);
  const archivedIds = useMemo(() => new Set(archived), [archived]);

  const toggleArchive = useCallback((sessionId: string) => {
    setArchived((current) =>
      current.includes(sessionId)
        ? current.filter((id) => id !== sessionId)
        : [...current, sessionId],
    );
  }, []);

  const updateChatSettings = useCallback((patch: Partial<ChatSettings>) => {
    setChatSettings((current) => ({ ...current, ...patch }));
  }, []);

  useEffect(() => {
    localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify(chatSettings));
  }, [chatSettings]);

  useEffect(() => {
    botNameRef.current = botName;
  }, [botName]);

  // 当前打开的会话，一有新消息就标已读（含发出去的消息）
  useEffect(() => {
    if (!activeId) return;
    const session = sessions.find((item) => item.session_id === activeId);
    if (!session) return;
    markSeen(activeId, sessionActivity(session));
  }, [activeId, sessions, markSeen]);

  // 侧栏折叠偏好落盘
  useEffect(() => {
    localStorage.setItem(SIDEBAR_HIDDEN_KEY, sidebarHidden ? "1" : "0");
  }, [sidebarHidden]);

  // 外观偏好落到 <html> 的 data-* 上并持久化（main.tsx 启动时也会先应用一次）
  useEffect(() => {
    applyPrefs(prefs);
    savePrefs(prefs);
  }, [prefs]);

  useEffect(() => {
    adminRef.current = admin;
  }, [admin]);

  // 连上 AstrBot 后探一次可选的 webchat_admin 插件（没装就维持原来的行为）
  useEffect(() => {
    if (status !== "online") return;
    let cancelled = false;
    void probeAdmin().then((next) => {
      if (!cancelled) setAdmin(next);
    });
    return () => {
      cancelled = true;
    };
  }, [status]);

  // Ctrl/Cmd + B 折叠侧栏（和 IDE 的习惯一致）
  useEffect(() => {
    if (!DESKTOP) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebarHidden((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // 后台也轮询会话列表：别的会话来消息时侧栏能亮未读点（AstrBot 是本地服务，开销很小）
  useEffect(() => {
    if (status !== "online") return;
    const timer = window.setInterval(
      () => void refreshSessions(username),
      20_000,
    );
    return () => window.clearInterval(timer);
  }, [status, username, refreshSessions]);

  useEffect(() => {
    localStorage.setItem(USERNAME_KEY, username);
  }, [username]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    notificationsRef.current = notifications;
  }, [notifications]);

  useEffect(() => {
    activeRef.current = activeId;
    sessionRef.current = activeId;
    if (activeId) localStorage.setItem(SESSION_KEY, activeId);
    else localStorage.removeItem(SESSION_KEY);
  }, [activeId]);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    const seq = ++historySeq.current;
    setMessages([]);
    setLoadingHistory(true);
    reloadHistory(activeId)
      .then(() => {
        // 历史能读到说明 BFF 是通的：把启动期「Failed to fetch」这类残留错误清掉，
        // 否则冷启动那 1～2 秒的失败会一直挂在聊天区上面。
        if (seq === historySeq.current) setError(null);
      })
      .catch((e) => {
        if (seq === historySeq.current) setError(errorText(e));
      })
      .finally(() => {
        if (seq === historySeq.current) setLoadingHistory(false);
      });
  }, [activeId, reloadHistory]);

  useEffect(() => {
    if (!activeId || status !== "online") return;
    let cancelled = false;

    const tick = async () => {
      if (sending) return;
      try {
        const history = await getHistory(activeId, 50);
        if (cancelled) return;
        const known = new Set(messagesRef.current.map((message) => message.id));
        const fresh = history.messages
          .filter((message) => !known.has(message.id))
          .map(toUiMessage);
        if (fresh.length === 0) return;
        setMessages((prev) => {
          const seen = new Set(prev.map((message) => message.id));
          return [...prev, ...fresh.filter((message) => !seen.has(message.id))];
        });
        const assistant = fresh.filter((message) => message.role === "assistant");
        if (assistant.length > 0 && notificationsRef.current && document.hidden) {
          notifyMessage(assistant[assistant.length - 1], botNameRef.current);
        }
      } catch {
        // 轮询失败静默，等下一次
      }
    };

    const timer = window.setInterval(() => void tick(), 10_000);
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [activeId, status, sending]);

  /**
   * 流式渲染批处理。
   *
   * AstrBot 每个 token 推一帧 SSE，一秒钟能来几十帧；以前每帧一次 `setMessages`
   * + 整条 markdown 重解析，手机上必掉帧（这也是「手机手感」里唯一主要由前端决定的一项）。
   * 现在把增量攒进 ref，每帧（rAF）最多刷一次，并且只重建最后一条消息对象
   * ——其它气泡的对象引用不变，配合 MessageBubble 的 memo 就不会重渲染。
   */
  const pendingTextRef = useRef<{
    id: string;
    parts: { kind: "append" | "block"; text: string }[];
  } | null>(null);
  const flushFrameRef = useRef<number | null>(null);

  const flushDraftText = useCallback(() => {
    if (flushFrameRef.current !== null) {
      window.cancelAnimationFrame(flushFrameRef.current);
      flushFrameRef.current = null;
    }
    const pending = pendingTextRef.current;
    if (!pending) return;
    pendingTextRef.current = null;
    setMessages((prev) => {
      let index = -1;
      for (let i = prev.length - 1; i >= 0; i -= 1) {
        if (prev[i].id === pending.id) {
          index = i;
          break;
        }
      }
      if (index < 0) return prev;
      let text = prev[index].text;
      for (const part of pending.parts) {
        text = part.kind === "block" ? (text ? `${text}\n${part.text}` : part.text) : text + part.text;
      }
      const next = [...prev];
      next[index] = { ...next[index], text };
      return next;
    });
    // 双 rAF：第一次在提交后、第二次在下一帧，约等于「已经画上屏幕」
    if (pending.parts.some((part) => part.text)) {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => markFirstPaint());
      });
    }
  }, []);

  const queueDraftText = useCallback(
    (id: string, parts: { kind: "append" | "block"; text: string }[]) => {
      const current = pendingTextRef.current;
      pendingTextRef.current =
        current && current.id === id
          ? { id, parts: [...current.parts, ...parts] }
          : { id, parts };
      if (flushFrameRef.current !== null) return;
      flushFrameRef.current = window.requestAnimationFrame(() => {
        flushFrameRef.current = null;
        flushDraftText();
      });
    },
    [flushDraftText],
  );

  // 卸载时把攒着的字刷出去 / 清掉 rAF，别留一个悬着的回调
  useEffect(
    () => () => {
      if (flushFrameRef.current !== null) {
        window.cancelAnimationFrame(flushFrameRef.current);
        flushFrameRef.current = null;
      }
    },
    [],
  );

  const ensureDraft = (): string => {
    if (!draftRef.current) {
      const id = `a-${uid()}`;
      draftRef.current = id;
      setMessages((prev) => [
        ...prev,
        {
          id,
          role: "assistant",
          text: "",
          createdAt: Date.now(),
          streaming: true,
        },
      ]);
    }
    return draftRef.current;
  };

  const handleEvent = (event: ChatStreamEvent) => {
    switch (event.type) {
      case "session_id": {
        if (typeof event.session_id === "string") {
          sessionRef.current = event.session_id;
        }
        break;
      }
      case "plain": {
        const chunk = typeof event.data === "string" ? event.data : "";
        if (!chunk) break;
        if (!event.streaming && newBubbleRef.current) {
          draftRef.current = null;
          newBubbleRef.current = false;
        }
        const id = ensureDraft();
        markChunk();
        queueDraftText(id, [{ kind: event.streaming ? "append" : "block", text: chunk }]);
        break;
      }
      case "complete": {
        const full = typeof event.data === "string" ? event.data : "";
        // 先把攒着的增量落下来：`full` 为空时还能保住已经显示出来的字
        flushDraftText();
        const id = ensureDraft();
        setMessages((prev) =>
          prev.map((message) =>
            message.id === id
              ? { ...message, text: full || message.text, streaming: false }
              : message,
          ),
        );
        break;
      }
      case "image":
      case "record":
      case "file":
      case "video": {
        const data = event.data as
          | {
              attachment_id?: string;
              attachmentId?: string;
              url?: string;
              filename?: string;
              text?: string;
            }
          | undefined;
        // 媒体挂在气泡上，和文字有先后关系：先把攒着的字刷出来
        flushDraftText();
        const id = ensureDraft();
        const part: MediaPart = {
          type: event.type as MediaPart["type"],
          attachmentId: data?.attachment_id ?? data?.attachmentId,
          url: data?.url,
          filename: data?.filename,
          text: data?.text,
        };
        setMessages((prev) =>
          prev.map((message) =>
            message.id === id
              ? { ...message, media: [...(message.media ?? []), part] }
              : message,
          ),
        );
        break;
      }
      case "message_saved": {
        newBubbleRef.current = true;
        break;
      }
      case "agent_stats": {
        const data = event.data as
          | {
              token_usage?: {
                input_other?: number;
                input_cached?: number;
                output?: number;
              };
              time_to_first_token?: number;
            }
          | undefined;
        const usage = data?.token_usage;
        const stats: UiStats = {
          tokens: usage
            ? (usage.input_other ?? 0) +
              (usage.input_cached ?? 0) +
              (usage.output ?? 0)
            : undefined,
          firstTokenMs: data?.time_to_first_token
            ? Math.round(data.time_to_first_token * 1000)
            : undefined,
        };
        markServerTtft(
          data?.time_to_first_token ? Math.round(data.time_to_first_token * 1000) : 0,
        );
        setMessages((prev) => {
          const index = [...prev]
            .reverse()
            .findIndex((message) => message.role === "assistant");
          if (index < 0) return prev;
          const target = prev.length - 1 - index;
          const next = [...prev];
          next[target] = { ...next[target], stats };
          return next;
        });
        break;
      }
      case "error": {
        setError(typeof event.data === "string" ? event.data : "AstrBot 返回错误");
        break;
      }
      default:
        break;
    }
  };

  const send = async (text: string, attachment?: PendingAttachment | null) => {
    const content = text.trim();
    if ((!content && !attachment) || sending) return;

    const hadSession = Boolean(activeRef.current);
    const controller = new AbortController();
    abortRef.current = controller;
    draftRef.current = null;
    newBubbleRef.current = true;
    setError(null);
    setSending(true);
    beginSend();

    const media: MediaPart[] = attachment
      ? [
          {
            type: attachment.kind,
            localUrl: attachment.previewUrl,
            filename: attachment.name,
            sticker: attachment.sticker === true,
          },
        ]
      : [];

    setMessages((prev) => [
      ...prev,
      {
        id: `u-${uid()}`,
        role: "user",
        text: content,
        media,
        createdAt: Date.now(),
      },
    ]);

    try {
      let message: string | unknown[] = content;
      if (attachment) {
        const raw = attachment.file;
        const file =
          raw instanceof File
            ? raw
            : new File([raw], attachment.name, {
                type: raw.type || "application/octet-stream",
              });
        const uploaded = await uploadFile(file);
        // 表情包：把服务端附件 id 记下来，刷新/重载历史后还认得出来
        if (attachment.sticker) rememberSticker(uploaded.attachment_id, attachment.name);
        const segments: unknown[] = [];
        if (content) segments.push({ type: "plain", text: content });
        segments.push({
          type: attachment.kind,
          attachment_id: uploaded.attachment_id,
        });
        message = segments;
      }

      await chatStream(
        {
          username,
          message,
          sessionId: activeRef.current ?? undefined,
          signal: controller.signal,
        },
        handleEvent,
      );
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === "AbortError";
      // 攒在 rAF 里的增量先落地，否则最后几十个字会跟着流一起丢掉
      flushDraftText();
      if (!aborted) setError(errorText(e));
      setMessages((prev) =>
        prev.map((message) =>
          message.streaming
            ? { ...message, streaming: false, error: !aborted }
            : message,
        ),
      );
    } finally {
      flushDraftText();
      setSending(false);
      abortRef.current = null;
      setMessages((prev) =>
        prev.map((message) =>
          message.streaming ? { ...message, streaming: false } : message,
        ),
      );
      if (!hadSession && sessionRef.current) {
        // 新对话已经落地成真实会话：退出「写新对话」状态
        composingNewRef.current = false;
        setActiveId(sessionRef.current);
      } else if (sessionRef.current) {
        void reloadHistory(sessionRef.current);
      }
      void refreshSessions(username);
    }
  };

  const stop = () => {
    flushDraftText();
    abortRef.current?.abort();
  };

  const newChat = () => {
    stop();
    composingNewRef.current = true;
    activeRef.current = null;
    sessionRef.current = null;
    setActiveId(null);
    setMessages([]);
    setError(null);
    setMobileView("chat");
  };

  const selectSession = (id: string) => {
    stop();
    composingNewRef.current = false;
    setActiveId(id);
    setError(null);
    setMobileView("chat");
  };

  const saveSettings = (name: string) => {
    const next = name.trim() || "astrbot";
    setSettingsOpen(false);
    setUsername(next);
    composingNewRef.current = false;
    setActiveId(null);
    setMessages([]);
    setMobileView("list");
    void refreshSessions(next);
  };

  const install = async () => {
    const prompt = installPrompt;
    if (!prompt) return;
    await prompt.prompt();
    await prompt.userChoice;
    setInstallPrompt(null);
  };

  const toggleNotifications = async () => {
    if (notifications) {
      setNotifications(false);
      localStorage.setItem(NOTIFY_KEY, "0");
      return;
    }
    try {
      const permission = await requestNotificationPermission();
      if (permission === "granted") {
        setNotifications(true);
        localStorage.setItem(NOTIFY_KEY, "1");
        setError(null);
      } else {
        setError("通知权限被拒绝，可在系统设置里重新允许");
      }
    } catch (e) {
      setError(errorText(e));
    }
  };

  const testNotification = () => {
    void showNotification(botNameRef.current, "这是一条测试通知");
  };

  const testProactive = async () => {
    if (!activeRef.current) {
      setError("先打开一个会话，再测试主动消息");
      return;
    }
    const umo = `webchat:FriendMessage:webchat!${username}!${activeRef.current}`;
    try {
      await sendProactive(umo, "（这是一条主动消息测试）");
    } catch (e) {
      setError(errorText(e));
    }
  };

  /** 真删除：有插件走插件，没插件退回 AstrBot 的 DELETE（大概率 Permission denied） */
  const confirmDelete = async () => {
    const target = deleteTarget;
    if (!target) return;
    setDeleting(true);
    setError(null);
    try {
      if (adminRef.current.available) {
        await deleteRemote(target);
      } else {
        await deleteSession(target);
      }
      setPinned((current) => current.filter((id) => id !== target));
      setArchived((current) => current.filter((id) => id !== target));
      setAliases((current) => {
        const next = { ...current };
        delete next[target];
        return next;
      });
      if (activeId === target) {
        setActiveId(null);
        setMessages([]);
      }
      await refreshSessions(username);
    } catch (e) {
      const message = errorText(e);
      // AstrBot 有权限校验：当前 API Key 只有 chat/file 两个 scope，
      // 删除会话会回 Permission denied。这里翻成人话，并给出替代做法。
      setError(
        /permission denied/i.test(message)
          ? "AstrBot 拒绝了这次删除：API Key 的身份不是会话创建者。装一个 astrbot_plugin_webchat_admin 插件就能删（设置里能看到插件状态），或者直接在 AstrBot 面板里删。"
          : message,
      );
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  /**
   * Android 系统返回键：先关最上面那层浮层 → 再回会话列表 → 最后才退出。
   * 状态放 ref 里、监听器只注册一次：`@capacitor/app` 的回调是常驻的，
   * 每次改状态都重注册反而会漏事件。
   */
  const backRef = useRef<() => void>(() => {});
  backRef.current = () => {
    // 聊天页里的「⋯」菜单 / 记忆抽屉 / 表情面板先吃掉这次返回
    if (dispatchBackEvent()) return;
    if (drawerOpen) {
      setDrawerOpen(false);
      return;
    }
    if (settingsOpen) {
      setSettingsOpen(false);
      return;
    }
    if (mobileView === "chat") {
      setMobileView("list");
      return;
    }
    void exitApp();
  };

  useEffect(() => registerBackHandler(() => backRef.current()), []);

  const activeSession = sessions.find((item) => item.session_id === activeId);  // 和侧栏同一套取名规则：备注 > display_name > 最后一条消息 > ID
  const title = activeSession
    ? sessionTitle(activeSession, activeId ? aliases[activeId] : undefined).title
    : activeId
      ? `对话 ${shortId(activeId)}`
      : "新对话";

  return (
    <div className={`shell shell-full ${DESKTOP ? "is-desktop" : ""}`}>
      <InsecureHint />
      <EdgeDrawer
        botName={botName}
        status={status}
        theme={prefs.theme}
        notifications={notifications}
        version={__APP_VERSION__}
        native={isNativeShell()}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleTheme={() => updatePrefs({ theme: prefs.theme === "dark" ? "light" : "dark" })}
        onToggleNotifications={() => void toggleNotifications()}
        onSwitchComputer={() => {
          clearConnection();
          window.location.reload();
        }}
      />
      <div
        className={`app ${mobileView === "chat" ? "has-active" : ""} ${sidebarHidden ? "sidebar-hidden" : ""}`}
      >
        {!sidebarHidden && (
          <Sidebar
            sessions={sessions}
            activeId={activeId}
            status={status}
            username={username}
            botName={botName}
            unreadIds={unreadIds}
            pinnedIds={pinnedIds}
            aliases={aliases}
            onSelect={selectSession}
            onNew={newChat}
            onRefresh={() => {
              void checkConnection();
              void refreshSessions(username);
            }}
            onOpenSettings={() => setSettingsOpen(true)}
            onTogglePin={togglePin}
            onRename={renameSession}
            archivedIds={archivedIds}
            onToggleArchive={toggleArchive}
            onDelete={(id) => setDeleteTarget(id)}
            onCollapse={() => setSidebarHidden(true)}
            canInstall={Boolean(installPrompt)}
            onInstall={() => void install()}
            messageHits={searchHits}
            searchUnavailable={searchUnavailable}
            onSearchMessages={runSearch}
            onOpenHit={openSearchHit}
          />
        )}
        <ChatPanel
          title={title}
          messages={messages}
          sending={sending}
          loading={loadingHistory}
          status={status}
          error={error}
          notice={historyNotice}
          onDismissNotice={() => setHistoryNotice(null)}
          hasMore={historyHasMore}
          onLoadMore={loadMoreHistory}
          avatarUrl={prefs.botAvatar}
          botName={botName}
          chatSettings={chatSettings}
          onChatSettingsChange={updateChatSettings}
          onAvatarChange={(botAvatar) => updatePrefs({ botAvatar })}
          sidebarHidden={sidebarHidden}
          onToggleSidebar={() => setSidebarHidden((value) => !value)}
          maximized={maximized}
          desktop={DESKTOP}
          activeSessionId={activeId}
          onSend={send}
          onStop={stop}
          onBack={() => setMobileView("list")}
          onOpenSettings={() => setSettingsOpen(true)}
          onRetry={checkConnection}
        />
      </div>
      {DESKTOP && <ResizeHandles disabled={maximized} />}
      {DESKTOP && updateInfo && (
        <div className="update-toast">
          <span>
            有新版本{updateInfo.version ? ` v${updateInfo.version}` : ""}
          </span>
          <button
            className="link-btn"
            onClick={() => void runInstallUpdate()}
            disabled={updating}
          >
            {updating ? "正在安装…" : "立即更新"}
          </button>
          <button
            className="icon-btn"
            onClick={() => setUpdateInfo(null)}
            title="以后再说"
            disabled={updating}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {DESKTOP && closePrompt && (
        <CloseConfirmDialog
          onCancel={() => setClosePrompt(false)}
          onChoose={handleCloseChoice}
        />
      )}
      {deleteTarget && (
        <ConfirmDialog
          title="删除这个会话？"
          message={
            admin.available
              ? "会真的从 AstrBot 删掉这个会话、它的聊天记录和 LLM 上下文，不可恢复。"
              : "会真的从 AstrBot 删掉这个会话和它的聊天记录，不可恢复。当前没有装 webchat_admin 插件，AstrBot 会因为 Key 身份不匹配而拒绝（设置里能看到插件状态）。"
          }
          confirmLabel="删除"
          danger
          busy={deleting}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      {DESKTOP && showFirstRun && (
        <Suspense fallback={null}>
          <FirstRunDialog
            onDone={() => {
              setShowFirstRun(false);
              void checkConnection();
              void refreshSessions(username);
            }}
          />
        </Suspense>
      )}
      {settingsOpen && compact && (
        <Suspense fallback={null}>
          <MobileSettings
            username={username}
            status={status}
            notifications={notifications}
            onToggleNotifications={() => void toggleNotifications()}
            theme={prefs.theme}
            onThemeChange={(theme) => updatePrefs({ theme })}
            density={prefs.density}
            onDensityChange={(density) => updatePrefs({ density })}
            accent={prefs.accent}
            onAccentChange={(accent) => updatePrefs({ accent, accentHex: "" })}
            accentHex={prefs.accentHex}
            onAccentHexChange={(accentHex) => updatePrefs({ accentHex })}
            fontScale={prefs.fontScale}
            onFontScaleChange={(fontScale) => updatePrefs({ fontScale })}
            radius={prefs.radius}
            onRadiusChange={(radius) => updatePrefs({ radius })}
            botName={prefs.botName}
            onBotNameChange={(botName) => updatePrefs({ botName })}
            botAvatar={prefs.botAvatar}
            onBotAvatarChange={(botAvatar) => updatePrefs({ botAvatar })}
            chatBgItems={prefs.chatBgItems}
            chatBgActive={prefs.chatBgActive}
            chatBgDim={prefs.chatBgDim}
            chatBgBlur={prefs.chatBgBlur}
            onAddChatBg={(added) =>
              updatePrefs({
                chatBgItems: [...prefs.chatBgItems, ...added].slice(0, MAX_CHAT_BG),
                chatBgActive: added[0]?.id ?? prefs.chatBgActive,
              })
            }
            onSelectChatBg={(chatBgActive) => updatePrefs({ chatBgActive })}
            onRemoveChatBg={(id) =>
              updatePrefs({
                chatBgItems: prefs.chatBgItems.filter((item) => item.id !== id),
                chatBgActive: prefs.chatBgActive === id ? "" : prefs.chatBgActive,
                // 侧栏用的那张被删了也要跟着回到「不铺」，别留一个悬空 id
                sidebarBgActive: prefs.sidebarBgActive === id ? "" : prefs.sidebarBgActive,
              })
            }
            onChatBgDimChange={(chatBgDim) => updatePrefs({ chatBgDim })}
            onChatBgBlurChange={(chatBgBlur) => updatePrefs({ chatBgBlur })}
            sidebarBgActive={prefs.sidebarBgActive}
            onSidebarBgChange={(sidebarBgActive) => updatePrefs({ sidebarBgActive })}
            version={__APP_VERSION__}
            onSwitchComputer={() => {
              clearConnection();
              window.location.reload();
            }}
            onSave={saveSettings}
            onClose={() => setSettingsOpen(false)}
          />
        </Suspense>
      )}
      {settingsOpen && !compact && (
        <Suspense fallback={null}>
          <SettingsDialog
          username={username}
          status={status}
          baseUrl={baseUrl}
          notifications={notifications}
          density={prefs.density}
          onDensityChange={(density) => updatePrefs({ density })}
          theme={prefs.theme}
          onThemeChange={(theme) => updatePrefs({ theme })}
          accent={prefs.accent}
          onAccentChange={(accent) => updatePrefs({ accent, accentHex: "" })}
          accentHex={prefs.accentHex}
          onAccentHexChange={(accentHex) => updatePrefs({ accentHex })}
          fontScale={prefs.fontScale}
          onFontScaleChange={(fontScale) => updatePrefs({ fontScale })}
          radius={prefs.radius}
          onRadiusChange={(radius) => updatePrefs({ radius })}
          botName={prefs.botName}
          onBotNameChange={(botName) => updatePrefs({ botName })}
          botAvatar={prefs.botAvatar}
          onBotAvatarChange={(botAvatar) => updatePrefs({ botAvatar })}
          chatBgItems={prefs.chatBgItems}
          chatBgActive={prefs.chatBgActive}
          chatBgDim={prefs.chatBgDim}
          chatBgBlur={prefs.chatBgBlur}
          onAddChatBg={(added) =>
            updatePrefs({
              chatBgItems: [...prefs.chatBgItems, ...added].slice(0, MAX_CHAT_BG),
              // 新加的这张直接切过去，省得再点一下
              chatBgActive: added[0]?.id ?? prefs.chatBgActive,
            })
          }
          onSelectChatBg={(chatBgActive) => updatePrefs({ chatBgActive })}
          onRemoveChatBg={(id) =>
            updatePrefs({
              chatBgItems: prefs.chatBgItems.filter((item) => item.id !== id),
              // 删掉正用的那张 = 回到「不铺背景图」，但图库其它张不动
              chatBgActive: prefs.chatBgActive === id ? "" : prefs.chatBgActive,
              sidebarBgActive: prefs.sidebarBgActive === id ? "" : prefs.sidebarBgActive,
            })
          }
          onChatBgDimChange={(chatBgDim) => updatePrefs({ chatBgDim })}
          onChatBgBlurChange={(chatBgBlur) => updatePrefs({ chatBgBlur })}
          sidebarBgActive={prefs.sidebarBgActive}
          onSidebarBgChange={(sidebarBgActive) => updatePrefs({ sidebarBgActive })}
          adminAvailable={admin.available}
          adminVersion={admin.version}
          onReplacePrefs={setPrefs}
          onSave={saveSettings}
          onClose={() => setSettingsOpen(false)}
          onRetry={checkConnection}
          onToggleNotifications={() => void toggleNotifications()}
          onTestNotification={testNotification}
          onTestProactive={() => void testProactive()}
          />
        </Suspense>
      )}
    </div>
  );
}




