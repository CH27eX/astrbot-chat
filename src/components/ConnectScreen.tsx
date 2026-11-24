import { useState } from "react";
import { parseConnectionInput, saveConnection } from "../core/connection";

/**
 * 套壳（Capacitor）第一次打开、或用户主动「换一台电脑」时显示的连接页。
 *
 * 输入来源：桌面端「设置 → 桌面 → 手机访问」里那条 https 链接（带 ?t=令牌）。
 * 也可以只填 IP:8789，令牌单独填。
 */
export default function ConnectScreen({ onConnected }: { onConnected: () => void }) {
  const [input, setInput] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setError(null);
    const connection = parseConnectionInput(input, token);
    if (!connection) {
      setError("链接不完整：需要 https://<电脑IP>:8789/?t=<令牌>，或 IP:端口 + 令牌");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${connection.base}/astrbot/api/health`, {
        headers: { "x-astrbot-token": connection.token },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 401) throw new Error("令牌不对：回电脑上重新生成配对二维码");
      const text = await response.text();
      let payload: { ok?: boolean; error?: string } = {};
      try {
        payload = JSON.parse(text) as { ok?: boolean; error?: string };
      } catch {
        throw new Error("连上电脑了，但返回的不是 AstrBot Chat 的接口（地址填错了？）");
      }
      if (!payload.ok) {
        throw new Error(payload.error || "电脑上的 BFF 连不到 AstrBot（先启动 AstrBot 再试）");
      }
      saveConnection(connection);
      onConnected();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(
        /timeout|abort/i.test(message)
          ? "连不上：检查手机和电脑是否同一个网络、电脑防火墙是否放行 8789"
          : message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connect-screen">
      <div className="connect-inner">
        <div className="connect-logo">A</div>
        <h1>连接你的 AstrBot</h1>
        <p className="connect-sub">
          在电脑上打开「设置 → 桌面 → 手机访问」，把那条 https 链接复制过来（或用二维码）。
        </p>

        <label className="connect-label" htmlFor="connect-url">
          电脑地址
        </label>
        <input
          id="connect-url"
          className="connect-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="https://192.168.1.5:8789/?t=…"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
        />

        <label className="connect-label" htmlFor="connect-token">
          访问令牌（链接里带 ?t= 就不用填）
        </label>
        <input
          id="connect-token"
          className="connect-input"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="32 位十六进制"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />

        {error ? <p className="connect-error">{error}</p> : null}

        <button className="connect-btn" onClick={() => void connect()} disabled={busy}>
          {busy ? "连接中…" : "连接"}
        </button>

        <p className="connect-hint">
          手机和电脑要连同一个 Wi-Fi；电脑上「手机访问」开关要打开。
          <br />
          连上之后可以随时在设置里换一台电脑。
        </p>
      </div>
    </div>
  );
}
