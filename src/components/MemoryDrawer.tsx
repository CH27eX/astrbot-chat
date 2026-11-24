import { ChevronDown, RefreshCw, Star, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  cx,
  errorMessage as describeError,
  formatRelative,
} from "../core/utils";
import {
  getOverview,
  isHighPriority,
  listMemoryFiles,
  type MemoryEntry,
  type MemoryOverview,
  type MemoryScope,
  type MemoryScopeList,
  readMemoryFile,
  saveMemoryRaw,
  withPriority,
} from "../core/memory";
import {
  detectProviders,
  flagHint,
  memoryProviders,
  semanticsLabel,
  type DetectedProvider,
  type MemoryItem,
  type ProviderId,
} from "../core/memory-providers";
import { useEscape } from "../core/useEscape";

interface MemoryDrawerProps {
  open: boolean;
  onClose: () => void;
  /** 当前 WebChat 会话 id（uuid）；用来在 overview 里认出"当前会话"那个作用域 */
  activeSessionId: string | null;
}

interface ScopeTab {
  id: string;
  label: string;
  scope: MemoryScope;
  key: string;
  /** 这个作用域里有几条记忆；0 = 拉出来会是空的 */
  count: number;
}

const TYPE_LABEL: Record<string, string> = {
  user: "人物",
  feedback: "反馈",
  project: "项目",
  reference: "资料",
};

function typeLabel(type: string): string {
  return TYPE_LABEL[type] ?? (type || "未标注");
}

/**
 * 记忆抽屉：浏览 / 标记记忆。
 *
 * 来源不再是写死的 MB：打开时先 `detectProviders()`（`GET /api/v1/plugins`
 * + 各家 health），多于一家时给一个下拉。⭐ 的语义随来源变化：
 * - MB（补丁后）：每轮必带 + 整理时保留原文；
 * - LivingMemory：importance=1.0，衰减/清理/整合都豁免；
 * - Memory Companion：durability=pinned，不归档；但写接口需要面板管理员会话；
 * - Angel Memory：pinned 只保衰减，不保合并。
 *
 * 只做标记，**不做删除**：删记忆是破坏性操作，留给 AstrBot 面板里的插件页面。
 */
export default function MemoryDrawer({
  open,
  onClose,
  activeSessionId,
}: MemoryDrawerProps) {
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [tabId, setTabId] = useState<string>("");
  const [list, setList] = useState<MemoryScopeList | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busyFile, setBusyFile] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [indexOpen, setIndexOpen] = useState(false);
  /** null = 还不知道（没拉到过带文件的列表）；false = 补丁没打/没重载 */
  const [patchLive, setPatchLive] = useState<boolean | null>(null);
  /** 加一就重新拉 overview（错误态的重试用） */
  const [reloadKey, setReloadKey] = useState(0);

  // ---- 多来源 ----
  const [detected, setDetected] = useState<DetectedProvider[]>([]);
  const [providerId, setProviderId] = useState<ProviderId>("mb");
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [busyItem, setBusyItem] = useState<string | null>(null);

  useEscape(onClose, open);

  const activeProvider = memoryProviders[providerId];
  const isMb = providerId === "mb";
  const reachableProviders = detected.filter((entry) => entry.reachable);

  const tabs = useMemo<ScopeTab[]>(() => {
    if (!overview) return [];
    const result: ScopeTab[] = [
      {
        id: "global",
        label: "全局",
        scope: "global",
        key: "",
        count: overview.global?.fileCount ?? 0,
      },
    ];

    const current = activeSessionId
      ? overview.sessions.find((item) => item.key.includes(activeSessionId))
      : undefined;
    if (current) {
      result.push({
        id: "current",
        label: "当前会话",
        scope: "session",
        key: current.key,
        count: current.fileCount ?? 0,
      });
    } else if (activeSessionId) {
      // 认不出也留一个空标签，让用户知道"这个会话确实还没有记忆"
      result.push({ id: "current", label: "当前会话", scope: "session", key: "", count: 0 });
    }

    // 非 WebChat 的会话（QQ / 群）：有记忆的排前面，最多放 3 个，免得挤满一行
    const external = overview.sessions
      .filter((item) => !item.key.startsWith("webchat") && (item.fileCount ?? 0) > 0)
      .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))
      .slice(0, 3);
    for (const item of external) {
      const prefix = item.kind === "group" ? "群" : "QQ";
      result.push({
        id: `ext:${item.key}`,
        label: `${prefix} ${item.target || item.key}`,
        scope: "session",
        key: item.key,
        count: item.fileCount ?? 0,
      });
    }
    return result;
  }, [overview, activeSessionId]);

  const tab = useMemo(() => tabs.find((item) => item.id === tabId) ?? null, [tabs, tabId]);

  // 打开抽屉 → 探测来源
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const found = await detectProviders();
      if (cancelled) return;
      setDetected(found);
      if (found.length > 0 && !found.some((entry) => entry.provider.id === providerId)) {
        const fallback = found.find((entry) => entry.reachable) ?? found[0];
        setProviderId(fallback.provider.id);
      }
    })();
    return () => {
      cancelled = true;
    };
    // providerId 故意不进依赖：只在"当前来源消失了"时才回退
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // MB：打开抽屉 → 拉 overview
  useEffect(() => {
    if (!open || !isMb) return;
    let cancelled = false;
    setOverviewLoading(true);
    setOverviewError(null);
    (async () => {
      try {
        const data = await getOverview();
        if (cancelled) return;
        setOverview(data);
      } catch (error) {
        if (!cancelled) setOverviewError(describeError(error));
      } finally {
        if (!cancelled) setOverviewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, isMb, reloadKey]);

  // MB：选默认标签：优先"当前会话"（有记忆时），否则全局
  useEffect(() => {
    if (!open || !isMb || tabs.length === 0) return;
    if (tabs.some((item) => item.id === tabId)) return;
    const current = tabs.find((item) => item.id === "current");
    const firstWithMemory = tabs.find((item) => item.count > 0);
    setTabId(current?.count ? current.id : (firstWithMemory?.id ?? tabs[0].id));
  }, [open, isMb, tabs, tabId]);

  const loadList = useCallback(
    async (target: ScopeTab) => {
      if (!target.key && target.scope !== "global") {
        setList({ files: [], forgotten: [], index: { exists: false, content: "" } });
        setListError(null);
        return;
      }
      setListLoading(true);
      setListError(null);
      try {
        const data = await listMemoryFiles(target.scope, target.key);
        setList(data);
        // 服务端返回 priority 字段 = MB 补丁已生效；没有 = 旧版 web_api
        if (data.files.length > 0) {
          setPatchLive("priority" in data.files[0]);
        }
      } catch (error) {
        setList(null);
        setListError(describeError(error));
      } finally {
        setListLoading(false);
      }
    },
    [],
  );

  // MB：切标签 → 拉列表；顺便收起展开项
  useEffect(() => {
    if (!open || !isMb || !tab) return;
    setExpanded(null);
    setPreview(null);
    setActionError(null);
    void loadList(tab);
  }, [open, isMb, tab, loadList]);

  // 非 MB：按当前来源拉一张扁平列表（会话 id 过滤在 adapter 里）
  const loadItems = useCallback(async () => {
    if (isMb) return;
    setItemsLoading(true);
    setItemsError(null);
    try {
      const data = await activeProvider.list({
        sessionId: activeSessionId ?? undefined,
        limit: 50,
      });
      setItems(data);
    } catch (error) {
      setItems([]);
      setItemsError(describeError(error));
    } finally {
      setItemsLoading(false);
    }
  }, [activeProvider, activeSessionId, isMb]);

  useEffect(() => {
    if (!open || isMb) return;
    setExpanded(null);
    setPreview(null);
    setActionError(null);
    void loadItems();
  }, [open, isMb, providerId, loadItems]);

  const toggleExpand = async (entry: MemoryEntry) => {
    if (!tab) return;
    if (expanded === entry.file) {
      setExpanded(null);
      setPreview(null);
      return;
    }
    setExpanded(entry.file);
    setPreview(null);
    try {
      const file = await readMemoryFile(tab.scope, tab.key, entry.file);
      setPreview(file.content);
    } catch (error) {
      setPreview(`读取失败：${describeError(error)}`);
    }
  };

  /** ⭐ 开关：读全文 → 改 frontmatter → mode=raw 写回（带 baseMtime 乐观锁） */
  const toggleStar = async (entry: MemoryEntry) => {
    if (!tab || busyFile) return;
    setBusyFile(entry.file);
    setActionError(null);
    try {
      const file = await readMemoryFile(tab.scope, tab.key, entry.file);
      const high = isHighPriority(file.content);
      const next = withPriority(file.content, !high);
      await saveMemoryRaw({
        scope: tab.scope,
        key: tab.key,
        file: entry.file,
        content: next,
        baseMtime: file.mtime,
      });
      // 先本地更新（立刻有反馈），再拉一次拿插件回写的真实状态与索引
      const wanted = high ? "" : "high";
      setList((prev) =>
        prev
          ? {
              ...prev,
              files: prev.files.map((item) =>
                item.file === entry.file ? { ...item, priority: wanted } : item,
              ),
            }
          : prev,
      );
      if (expanded === entry.file) setPreview(next);
      try {
        await loadList(tab);
      } catch {
        // 列表刷新失败不影响"已经保存成功"这个事实
      }
      setPatchLive(true);
    } catch (error) {
      setActionError(describeError(error));
    } finally {
      setBusyFile(null);
    }
  };

  const toggleItemStar = async (item: MemoryItem) => {
    if (busyItem) return;
    setBusyItem(item.id);
    setActionError(null);
    try {
      await activeProvider.setPinned(item, !item.pinned);
      setItems((prev) =>
        prev.map((entry) => (entry.id === item.id ? { ...entry, pinned: !item.pinned } : entry)),
      );
      if (expanded === item.id) {
        // 让预览跟着刷新（有些插件写回后会改正文/元数据）
        void expandItem(item);
      }
    } catch (error) {
      setActionError(describeError(error));
    } finally {
      setBusyItem(null);
    }
  };

  const expandItem = async (item: MemoryItem) => {
    if (expanded === item.id) {
      setExpanded(null);
      setPreview(null);
      return;
    }
    setExpanded(item.id);
    setPreview(null);
    try {
      setPreview(await activeProvider.read(item));
    } catch (error) {
      setPreview(`读取失败：${describeError(error)}`);
    }
  };

  if (!open) return null;

  const files = list?.files ?? [];
  const highCount = isMb
    ? files.filter((item) => item.priority === "high").length
    : items.filter((item) => item.pinned).length;
  const visibleCount = isMb ? files.length : items.length;
  const loading = isMb ? overviewLoading || listLoading : itemsLoading;
  const currentError = isMb ? overviewError ?? listError : itemsError;
  const hint = flagHint(activeProvider);

  return (
    <aside className="memory-drawer" aria-label="记忆">
      <header className="memory-drawer-head">
        <div className="memory-drawer-title">
          <strong>记忆</strong>
          <small>
            {`${activeProvider.name} · ${visibleCount} 条`}
            {highCount > 0 ? ` · ⭐ ${highCount}` : ""}
          </small>
        </div>
        <button
          className="icon-btn"
          onClick={() => {
            if (isMb) {
              if (tab) void loadList(tab);
            } else {
              void loadItems();
            }
          }}
          title="刷新"
          aria-label="刷新记忆列表"
        >
          <RefreshCw size={15} />
        </button>
        <button className="icon-btn" onClick={onClose} title="关闭（Esc）" aria-label="关闭记忆面板">
          <X size={16} />
        </button>
      </header>

      {reachableProviders.length + detected.filter((entry) => !entry.reachable).length > 1 && (
        <div className="memory-providers" role="tablist" aria-label="记忆来源">
          {detected.map((entry) => (
            <button
              key={entry.provider.id}
              role="tab"
              aria-selected={entry.provider.id === providerId}
              disabled={!entry.reachable}
              className={cx(
                "memory-scope",
                entry.provider.id === providerId && "active",
                !entry.reachable && "empty",
              )}
              onClick={() => {
                if (!entry.reachable) return;
                setProviderId(entry.provider.id);
              }}
              title={`${entry.provider.name}${entry.version ? ` ${entry.version}` : ""} · ${
                entry.reachable ? semanticsLabel(entry.provider.semantics) : "插件没启用或接口不可用"
              }`}
            >
              {entry.provider.name}
              <span className="memory-scope-count">
                {entry.reachable ? semanticsLabel(entry.provider.semantics) : "不可用"}
              </span>
            </button>
          ))}
        </div>
      )}

      {isMb && (
        <div className="memory-scopes" role="tablist" aria-label="记忆作用域">
          {tabs.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={item.id === tabId}
              className={cx("memory-scope", item.id === tabId && "active", item.count === 0 && "empty")}
              onClick={() => setTabId(item.id)}
              title={item.count > 0 ? `${item.count} 条记忆` : "还没有记忆"}
            >
              {item.label}
              {item.count > 0 && <span className="memory-scope-count">{item.count}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="memory-body">
        {loading && (
          <div className="memory-state">
            <span className="spinner" />
            读取记忆…
          </div>
        )}

        {currentError && !loading && (
          <div className="memory-state err">
            <span>{currentError}</span>
            {isMb && (
              <button className="link-btn" onClick={() => setReloadKey((value) => value + 1)}>
                重试
              </button>
            )}
          </div>
        )}

        {!loading && !currentError && visibleCount === 0 && (
          <div className="memory-state">
            {isMb ? (
              tab?.id === "current" && !tab.key ? (
                <>
                  <p>这个会话还没有记忆</p>
                  <small>
                    抽屉按会话 id 找作用域。如果 AstrBot 用身份桥把 WebChat 接到了 QQ，
                    聊天里实际用的是 QQ 作用域下的记忆——切上面那个「QQ …」标签就能看到。
                  </small>
                </>
              ) : (
                <>
                  <p>这个作用域还没有记忆。</p>
                  <small>MB 只在模型调用 memory_write 之后才建文件，所以新会话通常是空的。</small>
                </>
              )
            ) : (
              <>
                <p>{activeProvider.name} 里还没有记忆。</p>
                <small>
                  {activeSessionId
                    ? "按当前会话 id 过滤了；换成 MB 视图可以看全局。"
                    : "没有活动会话时只能看默认作用域。"}
                </small>
              </>
            )}
          </div>
        )}

        {isMb && files.length > 0 && (
          <ul className="memory-list">
            {files.map((entry) => {
              const high = entry.priority === "high";
              const isOpen = expanded === entry.file;
              return (
                <li
                  key={entry.file}
                  className={cx("memory-item", high && "is-high", isOpen && "expanded")}
                >
                  <div className="memory-item-row">
                    <button
                      className="memory-item-main"
                      onClick={() => void toggleExpand(entry)}
                      aria-expanded={isOpen}
                      title={isOpen ? "收起" : "展开全文"}
                    >
                      <span className="memory-desc">{entry.description || entry.name}</span>
                      <span className="memory-meta">
                        <span className={cx("memory-type", `type-${entry.type || "none"}`)}>
                          {typeLabel(entry.type)}
                        </span>
                        {high && (
                          <span
                            className="memory-protect"
                            title="整理 / 合并 / 遗忘时保留原文细节，不参与压缩"
                          >
                            整理时保留
                          </span>
                        )}
                        {entry.updated > 0 && (
                          <span>{formatRelative(entry.updated * 1000)}</span>
                        )}
                        {entry.uses > 0 && <span>用过 {entry.uses} 次</span>}
                        <span className="memory-file">{entry.file}</span>
                      </span>
                    </button>
                    <button
                      className={cx("memory-star", high && "on")}
                      onClick={() => void toggleStar(entry)}
                      disabled={busyFile === entry.file}
                      aria-pressed={high}
                      title={
                        high
                          ? "取消高优先级（不再每轮必带，整理时也不再特别保留）"
                          : "标为高优先级（每轮都带上；整理 / 合并 / 遗忘时保留原文细节）"
                      }
                    >
                      {busyFile === entry.file ? (
                        <span className="spinner tiny" />
                      ) : (
                        <Star size={15} fill={high ? "currentColor" : "none"} />
                      )}
                    </button>
                  </div>
                  {isOpen && (
                    <pre className="memory-content">
                      {preview === null ? "读取中…" : preview}
                    </pre>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {!isMb && items.length > 0 && (
          <ul className="memory-list">
            {items.map((item) => {
              const isOpen = expanded === item.id;
              return (
                <li
                  key={`${item.provider}:${item.id}`}
                  className={cx("memory-item", item.pinned && "is-high", isOpen && "expanded")}
                >
                  <div className="memory-item-row">
                    <button
                      className="memory-item-main"
                      onClick={() => void expandItem(item)}
                      aria-expanded={isOpen}
                      title={isOpen ? "收起" : "展开全文"}
                    >
                      <span className="memory-desc">{item.title}</span>
                      <span className="memory-meta">
                        {item.type && (
                          <span className={cx("memory-type", `type-${item.type || "none"}`)}>
                            {typeLabel(item.type)}
                          </span>
                        )}
                        {item.pinned && (
                          <span
                            className="memory-protect"
                            title={semanticsLabel(activeProvider.semantics)}
                          >
                            {semanticsLabel(activeProvider.semantics)}
                          </span>
                        )}
                        {item.updatedAt ? <span>{formatRelative(item.updatedAt)}</span> : null}
                        <span className="memory-file">#{item.id}</span>
                      </span>
                    </button>
                    <button
                      className={cx("memory-star", item.pinned && "on")}
                      onClick={() => void toggleItemStar(item)}
                      disabled={busyItem === item.id || !activeProvider.capabilities.flag}
                      aria-pressed={item.pinned}
                      title={
                        !activeProvider.capabilities.flag
                          ? "这家插件不支持写 ⭐"
                          : item.pinned
                            ? "取消 ⭐"
                            : `标为 ⭐（${semanticsLabel(activeProvider.semantics)}）`
                      }
                    >
                      {busyItem === item.id ? (
                        <span className="spinner tiny" />
                      ) : (
                        <Star size={15} fill={item.pinned ? "currentColor" : "none"} />
                      )}
                    </button>
                  </div>
                  {isOpen && (
                    <pre className="memory-content">
                      {preview === null ? "读取中…" : preview}
                    </pre>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {isMb && list?.index?.exists && list.index.content.trim() && (
          <div className="memory-index">
            <button
              className="memory-index-toggle"
              onClick={() => setIndexOpen((value) => !value)}
              aria-expanded={indexOpen}
            >
              <ChevronDown size={14} className={cx("chev", indexOpen && "open")} />
              索引（每轮对话都注入这一段）
            </button>
            {indexOpen && <pre className="memory-content index">{list.index.content}</pre>}
          </div>
        )}
      </div>

      <footer className="memory-foot">
        {actionError && <div className="memory-action-err">{actionError}</div>}
        {hint && <small className="warn">{hint}</small>}
        {isMb && patchLive === false ? (
          <small className="warn">
            已标记，但当前 MB 插件还是旧版（补丁没打或没重载）；重载后召回与整理保护才生效
          </small>
        ) : (
          <small>
            {activeProvider.semantics === "hard"
              ? "⭐ = 整理 / 合并 / 清理时保留这条（MB 还会每轮必带，最多 2 条）"
              : activeProvider.semantics === "weighted"
                ? "⭐ = 只延后清理，不保证不被合并"
                : "这家插件没有条目级保护，⭐ 不可用"}
          </small>
        )}
      </footer>
    </aside>
  );
}
