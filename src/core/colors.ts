/** 一点点颜色算术：把用户选的一个色值变成整套主题色。
 *
 *  预设色在 styles.css 里写死（每色一套：主色 / RGB 三元组 / 渐变 / 用户气泡）。
 *  自定义色没法预先写，只能在运行时算出来，再挂成同样的 CSS 变量盖上去
 *  （行内样式的优先级高于样式表，所以不用给「自定义」再写一套选择器）。
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

export function parseHex(value: string): Rgb | null {
  const hex = value.trim().replace(/^#/, "").toLowerCase();
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(hex)) return null;
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

export function hexOf(rgb: Rgb): string {
  const part = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`;
}

/** 从 from 往 to 混 t（0–1） */
export function mix(from: Rgb, to: Rgb, t: number): Rgb {
  return {
    r: from.r + (to.r - from.r) * t,
    g: from.g + (to.g - from.g) * t,
    b: from.b + (to.b - from.b) * t,
  };
}

/** 自定义强调色对应的那组 CSS 变量（键名和 styles.css 里的预设一致） */
export function accentVariables(hex: string, theme: "dark" | "light"): Record<string, string> {
  const rgb = parseHex(hex) ?? { r: 110, g: 168, b: 254 };
  // 浅色主题下 --accent 直接当文字色用，白底上得压深一点才够对比度
  const text = theme === "light" ? mix(rgb, BLACK, 0.28) : rgb;
  return {
    "--accent": hexOf(text),
    "--accent-rgb": `${rgb.r} ${rgb.g} ${rgb.b}`,
    // 强调色的「伴色」也用同一色：自定义色没有配对的第二种色，单色渐变更稳
    "--accent-2-rgb": `${rgb.r} ${rgb.g} ${rgb.b}`,
    // 头像 / 主按钮 / 发送键的浅色渐变：往白里混，好压深色字
    "--accent-grad-from": hexOf(mix(rgb, WHITE, 0.45)),
    "--accent-grad-to": hexOf(mix(rgb, WHITE, 0.72)),
    "--on-accent": "#0b0d12",
    // 用户气泡：往黑里混，保证白字够亮
    "--bubble-user-from": hexOf(mix(rgb, BLACK, 0.62)),
    "--bubble-user-to": hexOf(mix(rgb, BLACK, 0.42)),
  };
}

/** 这些变量在自定义色 / 恢复预设之间要整组清掉，别留一半 */
export const ACCENT_VARS = Object.keys(accentVariables("#6ea8fe", "dark"));
