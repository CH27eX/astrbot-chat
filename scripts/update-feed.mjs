#!/usr/bin/env node
/**
 * 更新源（latest.json）生成 + 本地静态服务。
 *
 * 为什么需要这个：自动更新要让「安装版」去一个静态服务器上拿 `latest.json`，
 * 里面写着新版本号、更新包地址和签名。正式环境就是把 `--out` 目录原样丢到
 * 自己的服务器（或对象存储）上；本地联调时用 `--serve` 直接启一个 http 服务。
 *
 * 用法（在 astrbot-chat 下）：
 *   node scripts/update-feed.mjs                       # 生成 + 本地服务 127.0.0.1:8789
 *   node scripts/update-feed.mjs --no-serve            # 只生成，不起服务
 *   node scripts/update-feed.mjs --bundle D:\\...\\bundle\\nsis --notes "修复了 xxx"
 *
 * 产物（默认 logs/update-feed/）：
 *   latest.json                 —— 更新清单
 *   AstrBot Chat_0.1.1_x64-setup.nsis.zip  —— 更新包（从 bundle 目录拷过来）
 *   ...nsis.zip.sig             —— 签名
 *
 * 安全提醒：更新包只用 `~/.astrbot-updater/astrbot-chat.key` 这把私钥签，
 * 公钥已经编译进应用（tauri.conf.json 的 plugins.updater.pubkey）。
 * 换私钥 = 所有老版本都再也更新不上去（验签失败），别乱换。
 */

import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const DEFAULTS = {
  bundle: "cargo-target\\release\\bundle\\nsis",
  out: "logs/update-feed",
  baseUrl: "http://127.0.0.1:8789",
  port: 8789,
  notes: "",
  serve: true,
};

const MIME = {
  ".json": "application/json; charset=utf-8",
  ".zip": "application/zip",
  ".sig": "text/plain; charset=utf-8",
  ".exe": "application/octet-stream",
};

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--bundle":
        args.bundle = argv[++index];
        break;
      case "--out":
        args.out = argv[++index];
        break;
      case "--base-url":
        args.baseUrl = argv[++index];
        break;
      case "--port":
        args.port = Number(argv[++index]);
        break;
      case "--notes":
        args.notes = argv[++index];
        break;
      case "--no-serve":
        args.serve = false;
        break;
      case "--serve":
        args.serve = true;
        break;
      case "-h":
      case "--help":
        console.log(
          [
            "用法: node scripts/update-feed.mjs [选项]",
            "  --bundle <dir>     tauri build 的 bundle\\nsis 目录",
            "  --out <dir>        生成的更新源目录（默认 logs/update-feed）",
            "  --base-url <url>   更新包对外的地址前缀（默认 http://127.0.0.1:8789）",
            "  --port <n>         本地服务端口（默认 8789）",
            "  --notes <text>     更新说明（写进 latest.json）",
            "  --no-serve         只生成文件，不起 http 服务",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        throw new Error(`不认识的参数：${token}`);
    }
  }
  return args;
}

/** 只比较数字段：0.1.10 > 0.1.9（字符串比较会错） */
function compareVersions(left, right) {
  const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** `AstrBot Chat_0.1.1_x64-setup.exe` / `..._x64-setup.nsis.zip` → `0.1.1` */
function versionFromArtifact(name) {
  const match =
    /_(\d+\.\d+\.\d+(?:[-+][\w.]+)?)_x64-setup\.(?:nsis\.zip|exe)$/i.exec(name);
  return match ? match[1] : null;
}

/**
 * 两种更新包格式都认：
 *   * `*.nsis.zip`（旧式打包，Tauri 2.12 之前）
 *   * `*_x64-setup.exe` + `.exe.sig`（Tauri 2.12 起 NSIS 直接签 exe）
 * 同一个版本两种都在时优先 zip。
 */
async function findArtifacts(bundleDir, entries) {
  const found = [];
  for (const name of entries) {
    const version = versionFromArtifact(name);
    if (!version) continue;
    const isZip = name.toLowerCase().endsWith(".nsis.zip");
    const sig = `${name}.sig`;
    if (!existsSync(join(bundleDir, sig))) continue;
    found.push({ name, version, zip: isZip, sig, priority: isZip ? 1 : 0 });
  }
  found.sort(
    (left, right) =>
      compareVersions(left.version, right.version) || left.priority - right.priority,
  );
  return found;
}

async function buildFeed(args) {
  const bundleDir = resolve(args.bundle);
  const outDir = resolve(args.out);
  if (!existsSync(bundleDir)) {
    throw new Error(`找不到 bundle 目录：${bundleDir}（先跑 tauri build）`);
  }

  const entries = await readdir(bundleDir);
  const candidates = await findArtifacts(bundleDir, entries);

  if (candidates.length === 0) {
    throw new Error(
      `bundle 目录里没有带签名的更新包：${bundleDir}\n` +
        "自动更新产物要用 createUpdaterArtifacts 构建（scripts/release.ps1 或 --config src-tauri/tauri.release.conf.json）",
    );
  }

  const latest = candidates[candidates.length - 1];
  const artifactName = latest.name;
  const sigName = latest.sig;
  await mkdir(outDir, { recursive: true });
  await copyFile(join(bundleDir, artifactName), join(outDir, artifactName));
  await copyFile(join(bundleDir, sigName), join(outDir, sigName));

  const signature = (await readFile(join(bundleDir, sigName), "utf8")).trim();
  const base = args.baseUrl.replace(/\/+$/, "");
  const url = `${base}/${encodeURIComponent(artifactName)}`;
  const platform = { signature, url };
  const manifest = {
    version: latest.version,
    notes: args.notes || `AstrBot Chat ${latest.version}`,
    pub_date: new Date().toISOString(),
    platforms: {
      // 插件会先找 `windows-x86_64-nsis`，再退回 `windows-x86_64`；两个都写上更保险
      "windows-x86_64-nsis": platform,
      "windows-x86_64": platform,
    },
  };
  await writeFile(join(outDir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(`[feed] 更新包：${join(outDir, artifactName)}`);
  console.log(`[feed] 清单：${join(outDir, "latest.json")}（version=${latest.version}）`);
  console.log(`[feed] 下载地址：${url}`);
  return { outDir, manifest };
}

function serve(outDir, port) {
  const server = createServer(async (request, response) => {
    const pathname = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const relative = pathname === "/" ? "latest.json" : pathname.replace(/^\/+/, "");
    // 只允许读 outDir 里的文件
    const target = resolve(join(outDir, relative));
    if (!target.startsWith(outDir)) {
      response.writeHead(403).end("forbidden");
      return;
    }
    try {
      const info = await stat(target);
      if (!info.isFile()) throw new Error("not a file");
      response.writeHead(200, {
        "content-type": MIME[extname(target)] ?? "application/octet-stream",
        "content-length": info.size,
        "cache-control": "no-store",
      });
      createReadStream(target).pipe(response);
      console.log(`[serve] ${request.method} ${pathname} → 200 (${info.size} B)`);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
      console.log(`[serve] ${request.method} ${pathname} → 404`);
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`[serve] http://127.0.0.1:${port}/latest.json（Ctrl+C 停止）`);
  });
  return server;
}

const args = parseArgs(process.argv.slice(2));
const { outDir, manifest } = await buildFeed(args);
if (args.serve) {
  serve(outDir, args.port);
  console.log(
    `[serve] 把桌面版设置页的「更新源地址」填成 http://127.0.0.1:${args.port}/latest.json 就能测`,
  );
}
