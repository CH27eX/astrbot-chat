import { KeyRound, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useEscape } from "../core/useEscape";
import { readApiKey, restartBff, writeApiKey } from "../desktop/bff";
import { writeDesktopSettings } from "../desktop/bridge";

interface FirstRunDialogProps {
  /** 保存完（或跳过）后回调，让 App 重新检测连接 */
  onDone: () => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 首次启动引导：应用自己的设置里还没有 API Key 时出现。
 * Key 存 `%APPDATA%\com.astrbot.chat\settings.json`，由壳在启动 BFF 时通过环境变量传进去。
 */
export default function FirstRunDialog({ onDone }: FirstRunDialogProps) {
  const [key, setKey] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readApiKey()
      .then((existing) => {
        if (!cancelled) setKey(existing);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    const trimmed = key.trim();
    if (!trimmed) {
      setError("先把 Key 填上，或者点「稍后再说」");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await writeApiKey(trimmed);
      await writeDesktopSettings({ firstRunDone: true });
      await restartBff();
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const skip = async () => {
    try {
      await writeDesktopSettings({ firstRunDone: true });
    } catch {
      // 写不进去也不该挡住用户
    }
    onDone();
  };

  // Esc = 稍后再说（和点右上角那颗叉一样，会记住「不再引导」）
  useEscape(() => void skip());

  return (
    <div className="overlay">
      <div
        className="dialog firstrun"
        role="dialog"
        aria-modal="true"
        aria-label="首次使用设置"
      >
        <header className="dialog-head">
          <h2>
            <KeyRound size={16} /> 先填一下 AstrBot 的 API Key
          </h2>
          <button className="icon-btn" onClick={() => void skip()} title="稍后再说">
            <X size={18} />
          </button>
        </header>

        <p className="note">
          桌面版会自己启动 BFF，Key 只需要存在本机。它会写进
          <code>settings.json</code>，以后换电脑把这个文件一起带走就行。
        </p>

        <label className="field">
          <span>API Key</span>
          <div className="key-input">
            <input
              type={revealed ? "text" : "password"}
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="在 AstrBot 面板里创建"
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(event) => {
                if (event.key === "Enter") void save();
              }}
            />
            <button
              type="button"
              className="link-btn"
              onClick={() => setRevealed((value) => !value)}
            >
              {revealed ? "隐藏" : "显示"}
            </button>
          </div>
          <small>
            权限至少要有 <code>chat</code> 和 <code>file</code>；本机已有
            <code>.env.local</code> 的话也可以先跳过。
          </small>
        </label>

        {error && <p className="note warn">{error}</p>}

        <footer className="dialog-foot">
          <button className="ghost-btn" onClick={() => void skip()}>
            稍后再说
          </button>
          <button
            className="primary-btn"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? "正在重启 BFF…" : "保存并连接"}
          </button>
        </footer>
      </div>
    </div>
  );
}
