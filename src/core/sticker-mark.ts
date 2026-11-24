/**
 * 表情包标记（本地）。
 *
 * 为什么需要它：从表情面板发出的图，经 AstrBot 存库后文件名会被改写成
 * `20261122213102152_1627_好耶.png` —— `[sticker]` 前缀没了。
 * 只靠文件名识别的话，**刷新/重载历史后表情又变回大图**。
 *
 * 所以发送时把「附件 id（服务端回填）+ 文件名」都记在 localStorage，
 * 历史消息按这两个线索还原 `sticker: true`；文件名前缀作为第三重兜底。
 */
const KEY = "astrbot-chat.sticker-refs";
const MAX = 500;

type Refs = { ids: string[]; names: string[] };

function read(): Refs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ids: [], names: [] };
    const parsed = JSON.parse(raw) as Partial<Refs>;
    return {
      ids: Array.isArray(parsed.ids) ? parsed.ids.filter((x) => typeof x === "string") : [],
      names: Array.isArray(parsed.names) ? parsed.names.filter((x) => typeof x === "string") : [],
    };
  } catch {
    return { ids: [], names: [] };
  }
}

function write(refs: Refs): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        ids: refs.ids.slice(-MAX),
        names: refs.names.slice(-MAX),
      }),
    );
  } catch {
    // 存储满了就算了，退回文件名前缀识别
  }
}

/** 记住一次表情发送：attachmentId 和原始文件名都记 */
export function rememberSticker(attachmentId?: string | null, filename?: string | null): void {
  const refs = read();
  const id = typeof attachmentId === "string" ? attachmentId.trim() : "";
  const name = typeof filename === "string" ? filename.trim() : "";
  if (id && !refs.ids.includes(id)) refs.ids.push(id);
  if (name && !refs.names.includes(name)) refs.names.push(name);
  write(refs);
}

/** 这条媒体是不是表情包（attachmentId / 文件名任一命中） */
export function isKnownSticker(attachmentId?: string | null, filename?: string | null): boolean {
  const refs = read();
  const id = typeof attachmentId === "string" ? attachmentId.trim() : "";
  const name = typeof filename === "string" ? filename.trim() : "";
  return Boolean((id && refs.ids.includes(id)) || (name && refs.names.includes(name)));
}
