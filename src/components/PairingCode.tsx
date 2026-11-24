/**
 * 配对二维码：把「手机访问」那条带令牌的链接画成二维码，手机扫一下就进聊天页，
 * 不用手打 `https://192.168.x.x:8789/?t=…` 这种地址。
 *
 * 二维码的内容 = 令牌明文，投屏 / 截图就能被拿走，所以：
 *   - 显示 60 秒后自动收起（想再亮起来点「显示二维码」）；
 *   - 换 IP、重置配对导致 url 变化时，倒计时重来并重新画。
 *
 * 画布本身在 `QrCode.tsx` 里（装证书那一步也用同一块），这里只管倒计时与收起。
 */
import { useCallback, useEffect, useState } from "react";

import { QrCanvas } from "./QrCode";

/** 二维码在屏幕上亮多久。回归脚本把 window.__PAIRING_TTL_MS__ 调到 1.5s 验收「自动收起」 */
const DEFAULT_TTL_MS = 60_000;

function ttlMs(): number {
  const override = Number(
    (window as unknown as { __PAIRING_TTL_MS__?: number }).__PAIRING_TTL_MS__,
  );
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_TTL_MS;
}

export function PairingCode({ url }: { url: string }) {
  const [hidden, setHidden] = useState(false);
  const [deadline, setDeadline] = useState(() => Date.now() + ttlMs());
  const [leftMs, setLeftMs] = useState(() => ttlMs());
  const [failed, setFailed] = useState(false);

  // 换 IP / 重置配对 → url 变了：重新亮起来，倒计时从头算
  useEffect(() => {
    const ttl = ttlMs();
    setHidden(false);
    setDeadline(Date.now() + ttl);
    setLeftMs(ttl);
  }, [url]);

  // 倒计时：到点自动收起
  useEffect(() => {
    if (hidden) return;
    const tick = () => {
      const left = deadline - Date.now();
      setLeftMs(Math.max(0, left));
      if (left <= 0) setHidden(true);
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [deadline, hidden]);

  const showAgain = useCallback(() => {
    const ttl = ttlMs();
    setHidden(false);
    setDeadline(Date.now() + ttl);
    setLeftMs(ttl);
  }, []);

  if (hidden) {
    return (
      <div className="pairing pairing-hidden">
        <span>二维码已收起（防止截图把令牌带走）</span>
        <button type="button" className="link-btn" onClick={showAgain}>
          显示二维码
        </button>
      </div>
    );
  }

  return (
    <div className="pairing">
      <QrCanvas
        value={url}
        className="pairing-canvas"
        label="手机配对二维码，内容和上面的链接一样"
        onStatus={(status) => setFailed(status === "failed")}
      />
      <span className="pairing-left" data-testid="pairing-left">
        {failed
          ? "二维码没生成出来，直接复制链接吧"
          : `${Math.ceil(leftMs / 1000)} 秒后自动收起`}
      </span>
    </div>
  );
}
