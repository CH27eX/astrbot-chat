import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Markdown 渲染器单独一个模块，由 MessageBubble 用 `lazy()` 引。
 *
 * 为什么拆：`react-markdown` + `remark-gfm` 这一套（含 unified/micromark 全家桶）
 * 是首屏 bundle 里最大的一块，但**会话列表页根本用不到**它。
 * 拆出去之后首屏只加载「壳 + 会话列表」，聊天页第一次渲染时再按需取这块；
 * 取回来之前先用纯文本占位，不会白屏。
 */
export default function Markdown({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>;
}
