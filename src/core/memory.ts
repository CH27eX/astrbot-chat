import { BFF_BASE } from "./endpoint";

/**
 * MB（astrbot_plugin_memory_beyond）记忆接口封装。
 *
 * 全部走 BFF 的 `/v1/plugins/extensions/...`，需要 API Key 带 `plugin` scope，
 * 否则上游回 403 `Insufficient API key scope`。
 *
 * AstrBot 的写接口出错也可能返 HTTP 200 + `{"status":"error"}`，
 * 所以一律看 `status` 字段（和 transport.ts 的 unwrap 同一套语义）。
 */
const MB = `${BFF_BASE}/v1/plugins/extensions/astrbot_plugin_memory_beyond`;

export type MemoryScope = "global" | "session" | "people";

/** 一条记忆的列表项（对应插件 `_header_dict`）。 */
export interface MemoryEntry {
  file: string;
  name: string;
  description: string;
  type: string;
  mtime: number;
  updated: number;
  created: number;
  size: number;
  uses: number;
  lastUsed: number;
  forgottenAt?: number;
  /**
   * 手动标注的召回优先级：`"high"` = 已标 ⭐。
   * 语义有两层：每轮必带（补丁 v1 的召回）+ 整理/合并/遗忘时保留原文细节
   * （补丁 v2）。**字段不存在**说明 MB 补丁没打/没重载（旧版 web_api 不返回它）。
   */
  priority?: string;
}

/** overview 里的一个会话作用域。 */
export interface MemorySession {
  key: string;
  umo: string;
  platform: string;
  kind: string;
  target: string;
  name: string;
  remark: string;
  fileCount: number;
  updatedAt: number;
  lastActive: number;
}

export interface MemoryOverview {
  memoryEnabled: boolean;
  global: { fileCount: number; updatedAt: number; enabled: boolean };
  people: { enabled: boolean; platforms: Array<{ key: string; fileCount?: number }> };
  sessions: MemorySession[];
}

export interface MemoryScopeList {
  files: MemoryEntry[];
  forgotten: MemoryEntry[];
  index: { exists: boolean; content: string; lines?: number; size?: number };
}

export interface MemoryFile {
  content: string;
  mtime: number;
  [key: string]: unknown;
}

interface Envelope<T> {
  status: "ok" | "error";
  message?: string | null;
  data: T;
}

/** 记忆接口的错误：带上 HTTP 状态，方便 UI 区分"没权限"和"真出错"。 */
export class MemoryError extends Error {
  status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "MemoryError";
    this.status = status;
  }
}

async function call<T>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const { timeoutMs = 15_000, ...rest } = init ?? {};
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${MB}${path}`, {
      credentials: "same-origin",
      signal: controller.signal,
      ...rest,
    });
  } catch (error) {
    throw new MemoryError(
      error instanceof DOMException && error.name === "AbortError"
        ? "记忆接口超时（AstrBot 没响应）"
        : "连不上 AstrBot，检查是否在运行",
    );
  } finally {
    window.clearTimeout(timer);
  }

  const text = await response.text().catch(() => "");
  if (response.status === 403) {
    throw new MemoryError(
      "API Key 缺少 plugin 权限：AstrBot 面板 → API Keys → 勾上 plugin",
      403,
    );
  }
  if (!response.ok) {
    throw new MemoryError(`记忆接口请求失败（${response.status}）`, response.status);
  }

  let envelope: Envelope<T>;
  try {
    envelope = JSON.parse(text) as Envelope<T>;
  } catch {
    throw new MemoryError("记忆接口返回的不是 JSON（BFF 没就绪？）");
  }
  if (envelope.status === "error") {
    throw new MemoryError(envelope.message || "记忆接口返回错误");
  }
  return envelope.data;
}

function scopeQuery(scope: MemoryScope, key: string): string {
  const params = new URLSearchParams({ scope });
  if (scope !== "global" && key) params.set("key", key);
  return params.toString();
}

export function getOverview(): Promise<MemoryOverview> {
  return call<MemoryOverview>("/overview");
}

export function listMemoryFiles(scope: MemoryScope, key = ""): Promise<MemoryScopeList> {
  return call<MemoryScopeList>(`/scope?${scopeQuery(scope, key)}`);
}

export function readMemoryFile(
  scope: MemoryScope,
  key: string,
  file: string,
): Promise<MemoryFile> {
  const params = new URLSearchParams(scopeQuery(scope, key));
  params.set("file", file);
  return call<MemoryFile>(`/file?${params.toString()}`);
}

/**
 * 原样写回整份记忆文本（`mode=raw`）。**标记优先级只能用这个**：
 * `mode=fields` 会走 `compose_memory()` 重建文件，把自定义字段丢掉。
 *
 * 两个坑：
 * - 保存已存在的文件必须带 `oldFile`（同名），否则插件当成新建 → "已存在同名文件"；
 * - 带了 `oldFile` 之后 `baseMtime` 的乐观锁才真正生效（文件被模型改过会拒绝写入）。
 */
export async function saveMemoryRaw(input: {
  scope: MemoryScope;
  key: string;
  file: string;
  content: string;
  baseMtime: number;
}): Promise<void> {
  await call<unknown>("/file/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scope: input.scope,
      key: input.key,
      file: input.file,
      oldFile: input.file,
      mode: "raw",
      content: input.content,
      baseMtime: input.baseMtime,
    }),
    timeoutMs: 20_000,
  });
}

// ---------------------------------------------------------------- frontmatter

const FRONTMATTER_RE = /^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/;
const HIGH = "high";

/** 读一条记忆的优先级（大小写不敏感）；没写就是空串。 */
export function readPriority(content: string): string {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return "";
  let inMetadata = false;
  let nested = "";
  let top = "";
  for (const line of match[2].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const indented = /^\s/.test(line);
    const body = line.trim();
    const colon = body.indexOf(":");
    if (colon < 0) continue;
    const key = body.slice(0, colon).trim().toLowerCase();
    const value = body
      .slice(colon + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (indented) {
      if (inMetadata && key === "priority" && !nested) nested = value;
      continue;
    }
    inMetadata = key === "metadata" && !value;
    if (key === "priority" && !top) top = value;
  }
  return (nested || top).toLowerCase();
}

export function isHighPriority(content: string): boolean {
  return readPriority(content) === HIGH;
}

/**
 * 在 `metadata:` 下写入/删除 `priority: high`，**其余内容一个字节不动**
 * （换行风格、字段顺序都保留，免得模型/插件那边看起来像整篇重写）。
 * 没有 metadata 块就补一段；连 frontmatter 都没有就补一个最小 frontmatter。
 *
 * 这个字段是"⭐"的唯一落点：MB 补丁 v1 拿它做每轮必带的召回，v2 拿它做
 * 整理 / 合并 / 遗忘的豁免——写入后那条记忆在插件压缩时保留原文细节。
 */
export function withPriority(content: string, high: boolean): string {
  const nl = content.includes("\r\n") ? "\r\n" : "\n";
  const match = content.match(FRONTMATTER_RE);

  if (!match) {
    if (!high) return content;
    return `---${nl}metadata:${nl}  priority: high${nl}---${nl}${nl}${content}`;
  }

  const head = match[1];
  const tail = match[3];
  const rest = content.slice(match[0].length);
  // 顺手把写在顶层的 priority: 去掉（统一收敛到 metadata 下），
  // 否则「取消 ⭐」对这种手写的文件不生效。
  const lines = (match[2] ? match[2].split(/\r?\n/) : []).filter(
    (line) => !/^priority[ \t]*:/.test(line),
  );
  const metaAt = lines.findIndex((line) => /^metadata:[ \t]*$/.test(line));

  if (metaAt >= 0) {
    let end = metaAt + 1;
    while (end < lines.length && (/^\s+\S/.test(lines[end]) || lines[end].trim() === "")) {
      end += 1;
    }
    const block = lines
      .slice(metaAt + 1, end)
      .filter((line) => !/^\s+priority[ \t]*:/.test(line));
    if (high) {
      const indent = block.find((line) => /^\s+\S/.test(line))?.match(/^\s+/)?.[0] ?? "  ";
      block.push(`${indent}priority: high`);
    }
    lines.splice(metaAt + 1, end - metaAt - 1, ...block);
  } else if (high) {
    lines.push("metadata:", "  priority: high");
  }

  return `${head}${lines.join(nl)}${tail}${rest}`;
}
