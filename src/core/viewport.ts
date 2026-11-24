/**
 * 手机软键盘把输入条挡住的问题。
 *
 * 理想做法是 viewport 里的 `interactive-widget=resizes-content`（Chrome 108+，
 * 见 index.html）：键盘弹出时**布局视口**跟着缩小，`.app` 的 100dvh 变矮，
 * 输入条自然贴在键盘上面。
 *
 * 但国内无 GMS 的机器系统 WebView 可能落后好几年，不认识这个值 → 键盘直接
 * 盖住输入条。这条路用 `visualViewport` 自己算一遍：
 *
 *   inset = 布局视口高度 - 可视视口高度 - 可视视口顶部偏移
 *
 * 支持 `resizes-content` 时布局视口已经缩了，这个差值自然就是 0（不会叠加）；
 * 不支持时差值正好是键盘高度。算出来写到 `--kb-inset`，由 `.composer` 的
 * padding-bottom 用掉（见 styles.css 的 `@media (max-width: 680px)`）。
 *
 * 只在窄屏（≤680px，和手机布局断点一致）生效：桌面窗口没有软键盘。
 */
import { useEffect, useState } from "react";

const MOBILE_QUERY = "(max-width: 680px)";

export function installViewportFix(): void {
  const viewport = window.visualViewport;
  if (!viewport) return;

  const root = document.documentElement;
  const narrow = () => window.matchMedia(MOBILE_QUERY).matches;

  let frame = 0;
  const apply = () => {
    frame = 0;
    if (!narrow()) {
      root.style.setProperty("--kb-inset", "0px");
      return;
    }
    const layout = root.clientHeight;
    const inset = layout - viewport.height - viewport.offsetTop;
    root.style.setProperty("--kb-inset", `${Math.max(0, Math.round(inset))}px`);
  };

  const schedule = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(apply);
  };

  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);
  apply();
}

/**
 * 当前是不是手机布局（同一个 680px 断点）。
 * 设置页据此选「全屏分组页」还是「桌面弹层」，和 CSS 里 `.app.has-active` 那套保持一致。
 */
export function useIsCompact(): boolean {
  const [compact, setCompact] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(MOBILE_QUERY).matches,
  );
  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY);
    const sync = () => setCompact(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return compact;
}
