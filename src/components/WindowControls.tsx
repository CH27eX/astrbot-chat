import { Copy, Minus, Square, X } from "lucide-react";
import {
  closeWindow,
  minimizeWindow,
  toggleMaximizeWindow,
} from "../desktop/bridge";

/**
 * 无边框窗口的最小化 / 最大化 / 关闭。
 *
 * 新布局（参考线框图）没有横贯全宽的标题栏，所以这三个按钮放在聊天区右上角，
 * 和「聊天设置」挨着；拖拽区是侧栏头部和聊天头部（`data-tauri-drag-region`）。
 */
export default function WindowControls({ maximized }: { maximized: boolean }) {
  const maximizeLabel = maximized ? "还原" : "最大化";

  return (
    <div className="window-controls">
      <button
        type="button"
        className="window-btn"
        title="最小化"
        aria-label="最小化"
        onClick={() => void minimizeWindow()}
      >
        <Minus size={15} />
      </button>
      <button
        type="button"
        className="window-btn"
        title={maximizeLabel}
        aria-label={maximizeLabel}
        onClick={() => void toggleMaximizeWindow()}
      >
        {maximized ? <Copy size={12} /> : <Square size={11} />}
      </button>
      <button
        type="button"
        className="window-btn close"
        title="关闭"
        aria-label="关闭"
        onClick={() => void closeWindow()}
      >
        <X size={15} />
      </button>
    </div>
  );
}
