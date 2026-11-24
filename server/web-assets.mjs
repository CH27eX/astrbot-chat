/**
 * 安装目录旧资源清理（0.2.14）。
 *
 * NSIS 是**覆盖安装**，不删上一版留下的文件：`%LOCALAPPDATA%\AstrBot Chat\sidecar\web`
 * 每装一版就多留一对 `index-<hash>.js` / `index-<hash>.css`。0.2.13 装机目录里已经有
 * 43 个文件、其中 24 个是历史入口包（每个 0.5 MB，占 10 MB+），越装越多。
 *
 * 规则（刻意保守）：
 *   * 只认 `index-<hash>.js` / `index-<hash>.css`——这是 Vite 每次构建都会换名字的
 *     入口包，也是唯一「上一版一定作废」的东西；
 *   * 只删**当前 `index.html` 没有引用**的那些；
 *   * `index.html` 读不到、或者里面一个 `index-*` 都没引用（说明还没 build 好 / 打包
 *     拍平方式变了）时，整轮跳过——宁可留着旧文件，也不能删掉新版本要用的那个。
 *
 * 为什么不能把「没有被 index.html 引用」当唯一条件：打包时 `dist/` 被拍平到同一层，
 * Vite 按需切出来的 `window-*.js` / `qrcode-*.js` / `core-*.js` / `dist-js-*.js` 是入口
 * JS 里动态 `import()` 的，`index.html` 当然不引用；按那个条件删会让页面白屏。
 */

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

/** Vite 的入口包名：`index-B6tROh7s.js` / `index-Bagw-64G.css`（hash 里可能有 `-` `_`） */
const ENTRY_ASSET = /^index-[A-Za-z0-9_-]+\.(?:js|css)$/;

/** 从 index.html 里掏出所有 `src=` / `href=` 的文件名（只看 basename，拍平后就按名字对） */
export function referencedAssetNames(html) {
  const names = new Set();
  const attribute = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = attribute.exec(html)) !== null) {
    const raw = match[1].trim();
    if (!raw || raw.startsWith("data:") || raw.startsWith("#")) continue;
    let pathname = raw;
    const cut = pathname.search(/[?#]/);
    if (cut >= 0) pathname = pathname.slice(0, cut);
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      /* 坏转义就按原样取名字 */
    }
    const base = pathname.split("/").pop();
    if (base) names.add(base);
  }
  return names;
}

/**
 * 删掉上一版留下的入口包。
 *
 * @param {string} webRoot 静态页根目录（`sidecar/web` 或 dev 的 `dist`）
 * @param {{ log?: (message: string) => void }} [options]
 * @returns {{ removed: string[], kept: string[], reason?: string }}
 */
export function pruneStaleWebAssets(webRoot, options = {}) {
  const log = options.log ?? (() => {});
  const empty = { removed: [], kept: [] };

  if (!webRoot || !existsSync(webRoot) || !statSync(webRoot).isDirectory()) {
    return { ...empty, reason: "no-web-root" };
  }

  const indexFile = path.join(webRoot, "index.html");
  if (!existsSync(indexFile)) {
    log("[bff] 没有 index.html，跳过旧资源清理");
    return { ...empty, reason: "no-index-html" };
  }

  let html;
  try {
    html = readFileSync(indexFile, "utf8");
  } catch (error) {
    log(`[bff] 读 index.html 失败，跳过旧资源清理：${error?.message || error}`);
    return { ...empty, reason: "unreadable-index-html" };
  }

  const referenced = referencedAssetNames(html);
  // 一个入口包都没认出来 → 名字规则可能变了，什么都不删（安全第一）
  if (![...referenced].some((name) => ENTRY_ASSET.test(name))) {
    log("[bff] index.html 里没有可识别的入口包，跳过旧资源清理");
    return { ...empty, reason: "no-entry-asset" };
  }

  const removed = [];
  const kept = [];
  for (const name of readdirSync(webRoot)) {
    if (!ENTRY_ASSET.test(name)) continue;
    if (referenced.has(name)) {
      kept.push(name);
      continue;
    }
    const file = path.join(webRoot, name);
    try {
      if (!statSync(file).isFile()) continue;
      unlinkSync(file);
      removed.push(name);
    } catch (error) {
      // Windows 上文件被占（另一个进程正在读它）就留到下次启动再删
      log(`[bff] 删不掉旧资源 ${name}：${error?.message || error}`);
    }
  }

  if (removed.length > 0) {
    log(`[bff] 清掉 ${removed.length} 个上一版残留：${removed.join("、")}`);
  }
  return { removed, kept };
}
