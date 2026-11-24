import { Minimize2, Power, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { CloseAction } from "../desktop/bridge";

interface CloseConfirmDialogProps {
  onCancel: () => void;
  onChoose: (action: CloseAction, remember: boolean) => void;
}

/** 点窗口关闭时弹出的询问：退出 / 最小化到托盘，可记住选择 */
export default function CloseConfirmDialog({
  onCancel,
  onChoose,
}: CloseConfirmDialogProps) {
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div className="overlay" onClick={onCancel}>
      <div
        className="dialog close-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="关闭 AstrBot Chat"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <h2>关闭 AstrBot Chat？</h2>
          <button className="icon-btn" onClick={onCancel} title="取消">
            <X size={18} />
          </button>
        </header>

        <p className="note close-note">
          最小化到托盘后进程会继续运行，主动消息照常接收；退出会停止整个应用。
          托盘图标可能被 Windows 折叠进 <code>^</code> 里，再启动一次应用也能唤回窗口。
        </p>

        <label className="check-row">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          <span>记住我的选择，下次不再询问</span>
        </label>

        <footer className="dialog-foot close-foot">
          <button className="ghost-btn" onClick={onCancel}>
            取消
          </button>
          <button
            className="ghost-btn danger"
            onClick={() => onChoose("exit", remember)}
          >
            <Power size={14} />
            退出
          </button>
          <button
            className="primary-btn"
            onClick={() => onChoose("tray", remember)}
          >
            <Minimize2 size={14} />
            最小化到托盘
          </button>
        </footer>
      </div>
    </div>
  );
}
