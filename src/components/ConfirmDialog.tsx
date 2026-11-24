import { useEffect } from "react";
import { useEscape } from "../core/useEscape";

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** 危险操作（删除这类）按钮变红 */
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 通用二次确认弹窗（删除会话这类不可恢复的操作走这里，不用 window.confirm） */
export default function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = "取消",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEscape(onCancel, !busy);

  // 弹窗打开时锁一下滚动，免得背后的列表跟着滚
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div className="overlay" onClick={() => !busy && onCancel()}>
      <div
        className="dialog confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <h2>{title}</h2>
        </header>
        <p className="note close-note">{message}</p>
        <footer className="dialog-foot">
          <button className="ghost-btn" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            className={`primary-btn ${danger ? "danger" : ""}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "处理中…" : confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
