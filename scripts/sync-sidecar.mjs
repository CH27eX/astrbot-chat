#!/usr/bin/env node
/**
 * 把 BFF 同步到 Tauri 的 resources 里，供打包后的应用自带运行。
 *
 * 源文件：`server/*.mjs`（`index.mjs` 是入口，`web-assets.mjs` 等是它 import 的模块）
 * 目标：`src-tauri/resources/bff/`（gitignore，生成物）
 *
 * ⚠️ 新增模块必须同时在两处登记：下面的 `MODULES` 和 `tauri.conf.json` 的
 * `bundle.resources`——少登记一处，装完的包会因为找不到模块起不来。这里会自检，
 * 让 `pnpm build` 在打包前就失败，而不是等用户装完才发现。
 *
 * 用法：
 *   node scripts/sync-sidecar.mjs
 *   node scripts/sync-sidecar.mjs --check   # 只检查是否同步（构建前校验用）
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/**
 * 参与打包的 BFF 模块。
 * `resource` 是 `tauri.conf.json` 里的目标路径（入口改名成 `bff.mjs`，和 bff.rs 里的
 * `sidecar/bff.mjs` 对应；其余模块保持原名，靠相对 import 找到）。
 */
const MODULES = [
  { source: "index.mjs", target: "index.mjs", resource: "sidecar/bff.mjs" },
  { source: "web-assets.mjs", target: "web-assets.mjs", resource: "sidecar/web-assets.mjs" },
];

const SERVER_DIR = path.join(ROOT, "server");
const TARGET_DIR = path.join(ROOT, "src-tauri", "resources", "bff");
const NODE_DIR = path.join(ROOT, "src-tauri", "resources", "node");
const NODE_NAME = process.platform === "win32" ? "node.exe" : "node";
const NODE_BIN = path.join(NODE_DIR, NODE_NAME);
// 另一个平台的同名文件：Linux 打包时会从 Windows 侧 rsync 过来一个 node.exe，
// `resources/node/*` 是通配，两个都在就会被一起塞进 deb（多 89 MB），所以清掉。
const NODE_OTHER = path.join(NODE_DIR, process.platform === "win32" ? "node" : "node.exe");
const TAURI_CONF = path.join(ROOT, "src-tauri", "tauri.conf.json");

const checkOnly = process.argv.includes("--check");
const banner = "// 由 scripts/sync-sidecar.mjs 从 server/ 生成，不要直接改这个文件。\n";

/** shebang 必须在第一行：Node 只给「文件第一行」剥 shebang，前面加 banner 会让
 *  `#!/usr/bin/env node` 掉到第二行，ESM 直接 `SyntaxError`（2026-11-17 打包版踩过）。 */
function buildTarget(name) {
  const source = readFileSync(path.join(SERVER_DIR, name), "utf8");
  const shebangMatch = /^#![^\n]*\n/.exec(source);
  const shebang = shebangMatch ? shebangMatch[0] : "";
  const body = shebang ? source.slice(shebang.length) : source;
  return shebang + banner + body;
}

/** tauri.conf.json 里每个模块都得有一条 `resources/bff/<target>` → `<resource>` 的映射 */
function missingResourceMappings() {
  const conf = JSON.parse(readFileSync(TAURI_CONF, "utf8"));
  const resources = conf?.bundle?.resources ?? {};
  return MODULES.filter(({ target, resource }) => {
    const mapped = resources[`resources/bff/${target}`];
    return !mapped || String(mapped).replace(/\\/g, "/") !== resource;
  });
}

/** 便携 node 必须用通配映射（Windows 打 node.exe、Linux 打 node，同一条配置两边都不缺文件） */
function nodeMappingMissing() {
  const conf = JSON.parse(readFileSync(TAURI_CONF, "utf8"));
  const resources = conf?.bundle?.resources ?? {};
  return !Object.keys(resources).some((group) => group.replace(/\\/g, "/") === "resources/node/*");
}

/** 便携 Node：Windows 用仓库里预先放好的 node.exe；其它平台从「正在跑脚本的这个 node」复制。 */
function syncPortableNode() {
  if (process.platform !== "win32") {
    const source = process.execPath;
    let needsCopy = true;
    if (existsSync(NODE_BIN)) {
      try {
        needsCopy = statSync(NODE_BIN).size !== statSync(source).size;
      } catch {
        needsCopy = true;
      }
    }
    if (needsCopy) {
      mkdirSync(NODE_DIR, { recursive: true });
      copyFileSync(source, NODE_BIN);
      chmodSync(NODE_BIN, 0o755);
      console.log(`便携 Node: 从 ${source} 复制 -> ${path.relative(ROOT, NODE_BIN)}`);
    }
  }

  // 通配映射会把 resources/node 下所有文件都打进包，另一个平台的二进制必须清掉
  if (existsSync(NODE_OTHER)) {
    unlinkSync(NODE_OTHER);
    console.log(
      `清掉另一个平台的便携 Node：${path.basename(NODE_OTHER)}（resources/node/* 会把目录里所有文件都打包）`,
    );
  }

  if (existsSync(NODE_BIN)) {
    const mb = (statSync(NODE_BIN).size / 1024 / 1024).toFixed(1);
    console.log(`便携 Node: ${path.relative(ROOT, NODE_BIN)} (${mb} MB)`);
  } else if (process.platform === "win32") {
    console.warn(
      `警告：${path.relative(ROOT, NODE_BIN)} 不存在，打包出来的应用会依赖系统 Node。`,
    );
    console.warn("      把 Node 24 win-x64 的 node.exe 放到那个路径即可。");
  } else {
    console.warn(`警告：${path.relative(ROOT, NODE_BIN)} 没同步上，Linux 包会退回系统 Node。`);
  }
}

if (!existsSync(path.join(SERVER_DIR, "index.mjs"))) {
  console.error(`找不到 BFF 源文件：${path.join(SERVER_DIR, "index.mjs")}`);
  process.exit(1);
}

const missing = missingResourceMappings();
if (missing.length > 0) {
  for (const { target, resource } of missing) {
    console.error(
      `tauri.conf.json 的 bundle.resources 少了："resources/bff/${target}": "${resource}"`,
    );
  }
  process.exit(1);
}

if (nodeMappingMissing()) {
  console.error(
    'tauri.conf.json 的 bundle.resources 少了："resources/node/*": "sidecar/"（便携 node 的通配映射）',
  );
  process.exit(1);
}

mkdirSync(TARGET_DIR, { recursive: true });

const changed = [];
const unsynced = [];
for (const { source, target } of MODULES) {
  const next = buildTarget(source);
  const targetFile = path.join(TARGET_DIR, target);
  const current = existsSync(targetFile) ? readFileSync(targetFile, "utf8") : null;
  if (current === next) continue;
  if (checkOnly) {
    unsynced.push(target);
    continue;
  }
  writeFileSync(targetFile, next, "utf8");
  // 写完立刻让 node 自己解析一遍：语法错了宁可构建失败，也别等到装完才发现 BFF 起不来。
  const syntax = spawnSync(process.execPath, ["--check", targetFile], { stdio: "inherit" });
  if (syntax.status !== 0) {
    unlinkSync(targetFile);
    console.error(`${target} 语法检查没过，已删除；请检查 server/${source}`);
    process.exit(1);
  }
  changed.push(target);
}

if (checkOnly) {
  if (unsynced.length > 0) {
    console.error(
      `src-tauri/resources/bff 与 server/ 不一致（${unsynced.join("、")}），请先运行 pnpm sidecar:sync`,
    );
    process.exit(1);
  }
  console.log("sidecar 已同步");
  process.exit(0);
}

// 顺手清掉旧版本遗留的、已经不在 MODULES 里的生成物（模块合并 / 改名后的残渣）
const targets = new Set(MODULES.map(({ target }) => target));
for (const name of readdirSync(TARGET_DIR)) {
  if (name.endsWith(".mjs") && !targets.has(name)) {
    unlinkSync(path.join(TARGET_DIR, name));
    console.log(`清掉旧生成物：${name}`);
  }
}

console.log(changed.length > 0 ? `已同步 BFF -> ${changed.join("、")}` : "BFF 没有变化，跳过");

syncPortableNode();
