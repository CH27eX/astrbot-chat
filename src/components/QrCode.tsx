/**
 * 通用二维码画布：把一段文本画成「白底黑块」的方形 canvas。
 *
 * 两处在用：
 *   * `PairingCode` —— 手机扫码配对（带 60 秒自动收起，逻辑在那边）；
 *   * 设置里的「第一步：装证书」—— 手机扫码下载自签 CA（不需要收起）。
 *
 * 为什么自己画而不是用 CSS 缩放：手机摄像头对 1px 的模块很敏感，缩放出来的
 * 非整数倍会糊；这里按「模块数 × 每模块整数像素」直接算边长。
 */
import { useEffect, useRef, useState } from "react";

/** 静区（二维码四周留白），规范要求 ≥4 个模块，少了有些扫码器不认 */
const QUIET_MODULES = 4;
/** 目标边长（CSS 像素）；实际边长 = 模块数 × 每模块像素 */
const TARGET_PX = 190;
/** 每模块最多几个像素（太大占地方，会把右边的说明挤到下一行） */
const MAX_CELL_PX = 5;
/** 每模块最少几个像素（再小手机就不好扫了） */
const MIN_CELL_PX = 3;

type QrMatrix = {
  addData: (data: string) => void;
  make: () => void;
  getModuleCount: () => number;
  isDark: (row: number, col: number) => boolean;
};
type QrFactory = (typeNumber: number, level: "M") => QrMatrix;

export type QrStatus = "ready" | "failed";

/** 白底黑块，故意不跟主题走：深色底上扫码器基本认不出来 */
function drawQr(canvas: HTMLCanvasElement, qr: QrMatrix): void {
  const count = qr.getModuleCount();
  const cells = count + QUIET_MODULES * 2;
  // floor：让边长稳定落在 ~150–190px，长一点的链接（41 模块）也不会把右边说明挤走。
  // 每模块仍是整数像素，不糊。
  const cell = Math.min(MAX_CELL_PX, Math.max(MIN_CELL_PX, Math.floor(TARGET_PX / cells)));
  const side = cells * cell;
  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));

  canvas.width = Math.round(side * dpr);
  canvas.height = Math.round(side * dpr);
  canvas.style.width = `${side}px`;
  canvas.style.height = `${side}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, side, side);
  ctx.fillStyle = "#000000";
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!qr.isDark(row, col)) continue;
      ctx.fillRect(
        (col + QUIET_MODULES) * cell,
        (row + QUIET_MODULES) * cell,
        cell,
        cell,
      );
    }
  }
}

export function QrCanvas({
  value,
  className,
  label,
  onStatus,
}: {
  value: string;
  className?: string;
  /** 给读屏软件的一句话（画布本身对读屏不可见） */
  label: string;
  onStatus?: (status: QrStatus) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !value) return;
    // 换内容后同一块画布还在：先撤掉标记，等新的画完再打上（回归脚本据此等待）
    delete canvas.dataset.ready;
    let cancelled = false;

    void (async () => {
      try {
        // 库按需加载：只有真的打开这一页才会下载它
        const imported = (await import("qrcode-generator")) as unknown as {
          default?: QrFactory;
        };
        if (cancelled) return;
        const factory =
          typeof imported.default === "function"
            ? imported.default
            : (imported as unknown as QrFactory);
        // 0 = 按内容自动选版本；M 级纠错对屏幕扫描够用，模块数也不会太大
        const qr = factory(0, "M");
        qr.addData(value);
        qr.make();
        if (cancelled) return;
        drawQr(canvas, qr);
        canvas.dataset.ready = "true";
        setFailed(false);
        onStatus?.("ready");
      } catch {
        if (!cancelled) {
          setFailed(true);
          onStatus?.("failed");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // onStatus 故意不进依赖：调用方每次渲染都可能传新函数，进来会无限重画
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      role="img"
      aria-label={label}
      data-qr-failed={failed ? "true" : undefined}
    />
  );
}
