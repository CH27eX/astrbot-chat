import { useEffect } from "react";

/**
 * Esc 关闭当前弹窗。弹窗（设置 / 关闭询问 / 首次引导）都挂这个，键盘用户不用去点按钮。
 * `enabled` 传 false 时临时不响应（比如正在安装更新，不让 Esc 打断）。
 */
export function useEscape(handler: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        handler();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handler, enabled]);
}
