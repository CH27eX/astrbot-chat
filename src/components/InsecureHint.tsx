/**
 * 「当前是 http」提示条（0.2.16）。
 *
 * 手机用 `http://<电脑IP>:8788` 打开时**不是安全上下文**：录音（mediaDevices）、
 * 安装到桌面（serviceWorker）、`crypto.randomUUID` 全都不存在。0.2.11 之前这会直接
 * 把页面搞黑屏（已修），现在是「偷偷降级」——录音按钮点了没反应，用户完全不知道为什么。
 *
 * 所以这里给一条明确的提示 + 一句怎么换 https，关掉后按**源**记住：
 * `http://IP:8788` 和 `https://IP:8789` 是两个源，localStorage 各一份，
 * 在 http 上关掉不会影响 https 那一份（https 下本来也不显示）。
 */
import { useState } from "react";

const DISMISS_KEY = "astrbot-chat.insecure-hint-dismissed";

/** 只在「真正的 http + 非回环」时为 true（https / localhost 都是安全上下文） */
function isInsecureOrigin(): boolean {
  if (typeof window === "undefined") return false;
  if (window.isSecureContext) return false;
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return false;
  return window.location.protocol === "http:";
}

function isDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function InsecureHint() {
  const [visible, setVisible] = useState(() => isInsecureOrigin() && !isDismissed());

  if (!visible) return null;

  return (
    <div className="insecure-hint" role="status" data-testid="insecure-hint">
      <span className="insecure-hint-badge" aria-hidden="true">
        非安全
      </span>
      <p>
        当前是 <strong>http</strong>：录音、安装到桌面都用不了。电脑上「设置 → 桌面 → 手机访问」里那个{" "}
        <strong>https</strong> 链接打开才是全功能。
      </p>
      <button
        type="button"
        className="link-btn"
        onClick={() => {
          setVisible(false);
          try {
            localStorage.setItem(DISMISS_KEY, "1");
          } catch {
            /* 存储被禁就算了，下次再提示 */
          }
        }}
      >
        知道了
      </button>
    </div>
  );
}
