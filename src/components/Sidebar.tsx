import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Download,
  MessageSquare,
  PanelLeftClose,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { MessageHit, ServerSession } from "../core/types";
import { formatSessionTime, sessionActivity, sessionTitle } from "../core/utils";

interface SidebarProps {
  sessions: ServerSession[];
  activeId: string | null;
  status: "checking" | "online" | "offline";
  username: string;
  /** 机器人名字（侧栏左上角原来写死的 AstrBot） */
  botName: string;
  /** 有新消息、但当前没打开的会话 */
  unreadIds: Set<string>;
  /** 本地置顶的会话 */
  pinnedIds: Set<string>;
  /** 本地备注名（服务端没有改名接口） */
  aliases: Record<string, string>;
  /** 已归档的会话（本地标记，收在列表底部一组里） */
  archivedIds: Set<string>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRefresh: () => void;
  onOpenSettings: () => void;
  onTogglePin: (id: string) => void;
  onRename: (id: string, alias: string) => void;
  onToggleArchive: (id: string) => void;
  onDelete: (id: string) => void;
  /** 收起侧栏（宽窗下也能手动收） */
  onCollapse: () => void;
  canInstall: boolean;
  onInstall: () => void;
  /** 消息全文搜索结果（本地库） */
  messageHits: MessageHit[];
  /** 这个连接读不到本地库（远端 / Docker） */
  searchUnavailable: boolean;
  onSearchMessages: (query: string) => void;
  onOpenHit: (hit: MessageHit) => void;
}

export default function Sidebar({
  sessions,
  activeId,
  status,
  username,
  botName,
  unreadIds,
  pinnedIds,
  aliases,
  archivedIds,
  onSelect,
  onNew,
  onRefresh,
  onOpenSettings,
  onTogglePin,
  onRename,
  onToggleArchive,
  onDelete,
  onCollapse,
  canInstall,
  onInstall,
  messageHits,
  searchUnavailable,
  onSearchMessages,
  onOpenHit,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const keyword = query.trim().toLowerCase();

  // 关键词 >= 2 个字才搜消息，300ms 防抖；清空时把结果也清掉
  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      onSearchMessages("");
      return;
    }
    const timer = window.setTimeout(() => onSearchMessages(text), 300);
    return () => window.clearTimeout(timer);
  }, [query, onSearchMessages]);

  const ordered = [...sessions]
    .filter((session) => {
      if (!keyword) return true;
      const { title } = sessionTitle(session, aliases[session.session_id]);
      const snippet = session.last_message ?? "";
      return (
        title.toLowerCase().includes(keyword) ||
        snippet.toLowerCase().includes(keyword) ||
        session.session_id.startsWith(keyword)
      );
    })
    .sort((left, right) => {
      // 置顶的先排，其余按最后活动时间
      const leftPin = pinnedIds.has(left.session_id) ? 1 : 0;
      const rightPin = pinnedIds.has(right.session_id) ? 1 : 0;
      if (leftPin !== rightPin) return rightPin - leftPin;
      return sessionActivity(right) - sessionActivity(left);
    });

  // 归档只是"本地收起"，会话本身还在 AstrBot 里
  const visible = ordered.filter((session) => !archivedIds.has(session.session_id));
  const archivedVisible = ordered.filter((session) =>
    archivedIds.has(session.session_id),
  );

  const startRename = (session: ServerSession) => {
    setRenamingId(session.session_id);
    setRenameValue(
      aliases[session.session_id]?.trim() ||
        session.display_name?.trim() ||
        sessionTitle(session, undefined).title,
    );
  };

  const commitRename = (sessionId: string) => {
    onRename(sessionId, renameValue.trim());
    setRenamingId(null);
    setRenameValue("");
  };

  const renderRow = (session: ServerSession, archived: boolean) => {
    const alias = aliases[session.session_id];
    const { title } = sessionTitle(session, alias);
    // 手机 QQ 的「消息」列表是「名字 + 一行预览」：名字优先用备注/服务端名，
    // 没有就用「对话 xxxx」；预览永远是最后一条消息。
    const displayName = session.display_name?.trim();
    // 没有备注/服务端名字时用「对话 xxxx」，别拿最后一条消息当名字——那样名字和预览会一模一样
    const name = alias?.trim() || displayName || `对话 ${session.session_id.slice(0, 8)}`;
    // 说明：`title` 在没名字时是「最后一条消息的截断」，直接拿来当预览会和名字重复。
    const preview = session.last_message?.replace(/\s+/g, " ").trim() ?? "";
    const avatarChar =
      (name.replace(/^[^\p{L}\p{N}]+/u, "").trim().slice(0, 1) || "A").toUpperCase();
    const unread = unreadIds.has(session.session_id);
    const active = session.session_id === activeId;
    const pinned = pinnedIds.has(session.session_id);
    const renaming = renamingId === session.session_id;

    const itemClass = [
      "session-item",
      active ? "active" : "",
      unread ? "unread" : "",
      pinned ? "pinned" : "",
      archived ? "archived" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <div className="session-row" key={session.session_id}>
        {renaming ? (
          <div className="session-item renaming">
            <input
              value={renameValue}
              autoFocus
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitRename(session.session_id);
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setRenamingId(null);
                }
              }}
              onBlur={() => commitRename(session.session_id)}
              placeholder="给它起个名字（留空恢复默认）"
              aria-label="会话备注名"
            />
          </div>
        ) : (
          <button
            className={itemClass}
            onClick={() => onSelect(session.session_id)}
            onDoubleClick={() => startRename(session)}
            title={[
              session.display_name?.trim() || "未命名会话",
              session.session_id,
              "双击可重命名",
            ].join("\n")}
          >
            <span className="session-avatar">{avatarChar}</span>
            <span className="session-icon">
              {pinned ? <Pin size={15} /> : <MessageSquare size={16} />}
              {unread && <span className="session-dot" aria-label="有新消息" />}
            </span>
            <span className="session-body">
              <span className="session-title">{name}</span>
              {preview && <span className="session-snippet">{preview}</span>}
            </span>
            <span className="session-time">
              {formatSessionTime(session.last_message_at ?? session.updated_at)}
            </span>
          </button>
        )}

        {!renaming && (
          <div className="session-actions">
            <button
              className="msg-action"
              onClick={() => onTogglePin(session.session_id)}
              title={pinned ? "取消置顶" : "置顶"}
              aria-label={pinned ? "取消置顶" : "置顶"}
            >
              {pinned ? <PinOff size={13} /> : <Pin size={13} />}
            </button>
            <button
              className="msg-action"
              onClick={() => startRename(session)}
              title="重命名（本地备注）"
              aria-label="重命名"
            >
              <Pencil size={13} />
            </button>
            <button
              className="msg-action"
              onClick={() => onToggleArchive(session.session_id)}
              title={archived ? "取消归档" : "归档（只在本地收起，不删 AstrBot 数据）"}
              aria-label={archived ? "取消归档" : "归档"}
            >
              {archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
            </button>
            <button
              className="msg-action danger"
              onClick={() => onDelete(session.session_id)}
              title="删除会话（从 AstrBot 删除，不可恢复；需要更高权限的 Key）"
              aria-label="删除会话"
            >
              <Trash2 size={13} />
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="sidebar">
      <header className="sidebar-head" data-tauri-drag-region="deep">
        <div className="brand">
          <span className={`status-dot ${status}`} />
          <div className="brand-text">
            <strong>{botName}</strong>
            <small>
              {status === "online"
                ? "已连接"
                : status === "checking"
                  ? "连接中…"
                  : "未连接"}
            </small>
          </div>
        </div>
        <div className="sidebar-head-actions">
          <button className="icon-btn" onClick={onRefresh} title="刷新会话列表">
            <RefreshCw size={16} />
          </button>
          <button
            className="icon-btn"
            onClick={onCollapse}
            title="收起会话列表（Ctrl+B）"
            aria-label="收起会话列表"
          >
            <PanelLeftClose size={16} />
          </button>
        </div>
      </header>

      <button className="new-chat" onClick={onNew}>
        <Plus size={18} />
        新对话
      </button>

      <div className="session-search">
        <Search size={14} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索会话…"
          autoComplete="off"
          spellCheck={false}
          aria-label="搜索会话"
        />
        {query && (
          <button
            className="icon-btn search-clear"
            onClick={() => setQuery("")}
            title="清空搜索"
            aria-label="清空搜索"
          >
            <X size={13} />
          </button>
        )}
      </div>

      <div className="session-list">
        {query.trim().length >= 2 && (messageHits.length > 0 || searchUnavailable) && (
          <div className="hit-list">
            <div className="hit-head">
              消息
              {messageHits.length > 0 ? ` · ${messageHits.length}` : ""}
            </div>
            {searchUnavailable ? (
              <p className="empty-hint">这个连接读不到本地消息库（远端 / Docker）</p>
            ) : (
              messageHits.map((hit) => (
                <button
                  key={hit.messageId}
                  className="hit-row"
                  onClick={() => onOpenHit(hit)}
                  title={hit.text}
                >
                  <span className={`hit-badge ${hit.role}`}>
                    {hit.role === "user" ? "我" : "她"}
                  </span>
                  <span className="hit-text">
                    {hit.text.replace(/\s+/g, " ").slice(0, 80)}
                  </span>
                  <span className="hit-time">
                    {formatSessionTime(hit.createdAt)}
                  </span>
                </button>
              ))
            )}
          </div>
        )}

        {visible.map((session) => renderRow(session, false))}
        {visible.length === 0 && archivedVisible.length === 0 && (
          <p className="empty-hint">
            {keyword ? "没有匹配的会话" : "还没有会话"}
          </p>
        )}

        {archivedVisible.length > 0 && (
          <>
            <button
              className="archive-head"
              onClick={() => setShowArchived((value) => !value)}
              title="已归档的会话还在 AstrBot 里，只是不放在常用列表"
            >
              {showArchived ? (
                <ChevronDown size={13} />
              ) : (
                <ChevronRight size={13} />
              )}
              <Archive size={13} />
              已归档
              <span className="archive-count">{archivedVisible.length}</span>
            </button>
            {showArchived &&
              archivedVisible.map((session) => renderRow(session, true))}
          </>
        )}
      </div>

      <footer className="sidebar-foot">
        {canInstall ? (
          <button className="foot-row" onClick={onInstall}>
            <Download size={15} />
            安装到桌面
          </button>
        ) : null}
        <button className="foot-row" onClick={onOpenSettings}>
          <Settings size={15} />
          设置
          <span className="foot-username">{username}</span>
        </button>
      </footer>
    </aside>
  );
}
