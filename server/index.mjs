#!/usr/bin/env node
/**
 * AstrBot Chat BFF
 * - 端口自动发现：AstrBot Launcher 每次启动会换端口，不能写死
 * - API Key 只留在服务端，浏览器永远看不到
 * - /astrbot/api/* 原样代理到 AstrBot，SSE 流式透传
 */
import http from "node:http";
import https from "node:https";
import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { pruneStaleWebAssets } from "./web-assets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function loadEnv(file) {
  try {
    const out = {};
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#") || !s.includes("=")) continue;
      const i = s.indexOf("=");
      out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    }
    return out;
  } catch {
    return {};
  }
}

const env = { ...loadEnv(path.join(ROOT, ".env.local")), ...process.env };
const API_KEY = env.ASTRBOT_API_KEY || "";
const PORT = Number(env.BFF_PORT || 8788);

/**
 * 监听地址。默认只听回环（桌面壳 / 本机浏览器）。
 * 手机要连时由壳传 `BFF_BIND=0.0.0.0` + `BFF_LAN_TOKEN=<一次性令牌>`，
 * 非回环请求必须带令牌（`?t=` 或 cookie），否则连静态页都拿不到。
 */
const BIND = String(env.BFF_BIND || "127.0.0.1").trim() || "127.0.0.1";
const LAN_TOKEN = String(env.BFF_LAN_TOKEN || "").trim();
const TOKEN_COOKIE = "astrbot_bff_token";

/**
 * 局域网自签 HTTPS（可选，证书由 `scripts/lan-tls.ps1` 生成）。
 *
 * 为什么非要 HTTPS：`http://<IP>:8788` **不是安全上下文**，于是
 * `crypto.randomUUID` / `navigator.mediaDevices` / `navigator.serviceWorker`
 * 全都不存在 —— 手机上录不了音、装不了 PWA、发消息还会踩渲染异常（2026-11-18 黑屏）。
 *
 * 布局：HTTP 仍然只听回环（桌面壳和它的健康检查走这条，一个字都没改），
 * HTTPS 走另一个端口对局域网提供同一套 handler。这样壳里的 `probe_health`
 * 不用改成 TLS 客户端，桌面包零风险。
 */
const HTTPS_PORT = Number(env.BFF_HTTPS_PORT || 8789);
const TLS_PFX = String(env.BFF_TLS_PFX || "").trim();
const TLS_PASSPHRASE = String(env.BFF_TLS_PASSPHRASE || "").trim();
const TLS_CA = String(env.BFF_TLS_CA || "").trim();
const TLS_READY = Boolean(TLS_PFX) && existsSync(TLS_PFX);

/**
 * 反代专用端口（只监听回环）：给 Tailscale Serve / cloudflared 这类「本机反代」当源站。
 *
 * 为什么不能直接反代 8788：8788/8789 的令牌门对**回环请求**是放行的（桌面壳自己不带
 * 令牌），而本机反代连 `127.0.0.1:8788` 时源地址也是回环 —— 于是链接里的 `?t=` 形同
 * 虚设，URL 一泄露就等于把整个 BFF 交出去。这条端口用同一套 handler，但**永远要求令牌**
 * （请求上打 `FORCE_TOKEN` 标记，见下面的监听处），并且只绑 `127.0.0.1`，公网/局域网都碰不到它。
 *
 * 默认 0 = 不监听；桌面壳在打开「手机访问」（有令牌）时传 `BFF_PROXY_PORT=8790`。
 */
const PROXY_PORT = Number(env.BFF_PROXY_PORT || 0);
const PROXY_BIND = "127.0.0.1";

/**
 * 所有响应都带的「链接防火」头：
 * - no-referrer：页面里点外链时，不把带令牌的地址（或任何路径）带给第三方；
 * - noindex/nofollow + frame-ancestors 'none'：域名/链接外泄也不会被搜索引擎收录、
 *   不会被别人嵌进 iframe 当跳板；
 * - nosniff / DENY：防类型嗅探与点击劫持；
 * - permissions-policy：只留本页录音，摄像头/定位一律关掉。
 */
const SECURITY_HEADERS = {
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "permissions-policy": "microphone=(self), camera=(), geolocation=()",
};

/**
 * 静态页根目录：手机打开 `http://<PC-IP>:8788` 时要能拿到前端。
 * 壳在打包版传 `resource_dir/sidecar/web`，dev 下不传就退回 `dist`。
 */
const WEB_ROOT = env.BFF_WEB_ROOT
  ? path.resolve(env.BFF_WEB_ROOT)
  : path.resolve(ROOT, "dist");

// 由桌面壳托管时（BFF_PARENT_PID 有值），父进程一没就自己退出，
// 免得应用被强杀后留下一个孤儿 BFF 一直占着 8788。
const PARENT_PID = Number(env.BFF_PARENT_PID || 0);
if (PARENT_PID > 0) {
  const timer = setInterval(() => {
    try {
      process.kill(PARENT_PID, 0);
    } catch (error) {
      if (error && error.code === "ESRCH") process.exit(0);
    }
  }, 3000);
  timer.unref();
}

let cachedBase = String(env.ASTRBOT_BASE_URL || "").replace(/\/+$/, "");
let cachedAt = 0;
let discovering = null;
/** 发现失败后 8 秒内不再重扫（前端离线时每 3 秒探一次健康，不能每次都扫 50 个端口） */
let failedAt = 0;
let failureMessage = "";
/** 从监听端口的进程命令行推出来的 AstrBot 数据目录（历史库用） */
let cachedDbFile = "";

/**
 * 上次成功连上的 AstrBot 地址（跨 BFF 进程持久化）。
 *
 * 为什么需要：BFF 跟着桌面壳一起起，每次冷启动都是新进程，`cachedBase` 是空的，
 * 于是走「PowerShell 列本机 50 个监听端口 → 并行探」那条慢路 —— 实测冷启动首屏会话要 ~6s。
 * AstrBot 的 dashboard 端口是随机的，但只要它没重启，端口就不变；
 * 把上次成功的地址存下来先快探，命中就完全不用扫端口（冷启动首屏从 6s 降到 ~1s）。
 */
function stateDir() {
  if (process.env.APPDATA) return path.join(process.env.APPDATA, "com.astrbot.chat");
  return path.join(os.homedir(), ".config", "com.astrbot.chat");
}
const LAST_BASE_FILE = path.join(stateDir(), "bff-last-base.json");

function readLastBase() {
  try {
    const text = readFileSync(LAST_BASE_FILE, "utf8");
    const base = String(JSON.parse(text)?.base || "").replace(/\/+$/, "");
    return /^https?:\/\//.test(base) ? base : "";
  } catch {
    return "";
  }
}

function rememberBase(base) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(LAST_BASE_FILE, JSON.stringify({ base, at: Date.now() }, null, 2));
  } catch {
    // 记不住就记不住，只是下次又走慢路，不能因此影响连接
  }
}

// 有持久化地址就先拿来当候选（env 里的 ASTRBOT_BASE_URL 优先级更高）
if (!cachedBase) cachedBase = readLastBase();

async function probe(base, timeoutMs = 1000) {
  try {
    const res = await fetch(`${base}/api/v1/auth/setup-status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const json = await res.json();
    return json?.status === "ok" && json?.data && "setup_required" in json.data;
  } catch {
    return false;
  }
}

/**
 * 找 powershell.exe：**不要只靠 PATH**。
 * 壳有时会被精简的环境拉起（安装程序、计划任务、某些启动器），PATH 里没有 System32，
 * 这时 `execFile("powershell.exe")` 直接 ENOENT，端口发现就永远失败（表现为"AstrBot 未找到"）。
 */
function powershellCandidates() {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const absolute = path.join(
    root,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const list = [];
  if (existsSync(absolute)) list.push(absolute);
  list.push("powershell.exe");
  return list;
}

/** 跑一段 PowerShell，返回 stdout；跑不了 / 报错返回 null */
function runPowerShell(script, timeout = 8000) {
  const runOnce = (shell) =>
    new Promise((resolve) => {
      execFile(
        shell,
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { timeout, windowsHide: true },
        (err, stdout) => resolve(err ? null : String(stdout || "")),
      );
    });
  return (async () => {
    for (const shell of powershellCandidates()) {
      const out = await runOnce(shell);
      if (out !== null) return out;
    }
    return null;
  })();
}

/**
 * 本机所有 TCP 监听端口 + 所属进程。
 *
 * 为什么不用「筛 python.exe 的 main.py」：那只对官方 Launcher 的实例有效。
 * 用户可能用 Docker、手动 `python main.py`、官方 AstrBot Desktop、解压版——
 * 这些进程名/路径各不相同，唯一共同点是「在本机某个端口上回答 setup-status」。
 * 所以这里退回到最通用的做法：把本机监听端口全捞出来，再逐个探。
 * （本机实测 49 个监听端口，非 HTTP 端口会立刻 ECONNREFUSED 或超时 800ms，并行探测 ~1s。）
 */
async function listListeners() {
  // Linux 上没有 PowerShell：改读 /proc，否则永远只探默认 6185
  if (process.platform !== "win32") return listListenersLinux();
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Get-NetTCPConnection -State Listen | Where-Object { $_.LocalAddress -in @('127.0.0.1','0.0.0.0','::','::1') } | Select-Object -Unique LocalPort, OwningProcess | ForEach-Object { \"$($_.LocalPort) $($_.OwningProcess)\" }",
  ].join("; ");
  const out = await runPowerShell(script);
  if (!out) return [];
  const seen = new Set();
  const list = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d{1,5})\s+(\d+)$/);
    if (!m) continue;
    const port = Number(m[1]);
    const pid = Number(m[2]);
    if (port <= 0 || port > 65535 || seen.has(port)) continue;
    // 自己的端口不探（会打到自己身上）
    if (port === PORT) continue;
    seen.add(port);
    list.push({ port, pid });
  }
  return list.sort((a, b) => a.port - b.port);
}

/**
 * Linux：解析 /proc/net/tcp{,6} 拿 LISTEN 的 socket inode，再扫 /proc/<pid>/fd
 * 把 inode 映射回 pid。进程数不多，扫一遍够快；结果缓存 5 秒。
 */
let linuxListenerCache = { at: 0, list: [] };

function listListenersLinux() {
  if (Date.now() - linuxListenerCache.at < 5_000) return linuxListenerCache.list;

  const inodePort = new Map();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10) continue;
      if (parts[3] !== "0A") continue; // 0A = LISTEN
      const port = Number.parseInt((parts[1] || "").split(":")[1] || "", 16);
      const inode = parts[9];
      if (port > 0 && port <= 65535 && inode && inode !== "0") {
        inodePort.set(inode, port);
      }
    }
  }
  if (inodePort.size === 0) {
    linuxListenerCache = { at: Date.now(), list: [] };
    return [];
  }

  const byPort = new Map();
  let pids = [];
  try {
    pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    pids = [];
  }
  for (const pid of pids) {
    let fds = [];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target = "";
      try {
        target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const m = /^socket:\[(\d+)\]$/.exec(target);
      if (!m) continue;
      const port = inodePort.get(m[1]);
      if (!port || port === PORT || byPort.has(port)) continue;
      byPort.set(port, Number(pid));
    }
  }

  const list = [...byPort.entries()]
    .map(([port, pid]) => ({ port, pid }))
    .sort((a, b) => a.port - b.port);
  linuxListenerCache = { at: Date.now(), list };
  return list;
}

/** Linux：读 /proc/<pid>/cwd + cmdline，推出数据目录（和 Windows 分支对称）。 */
function dbFileFromPidLinux(pid) {
  const tryRoot = (root) => {
    if (!root || !path.isAbsolute(root)) return "";
    for (const candidate of [
      path.join(root, "data", "data_v4.db"),
      path.join(root, "core", "data", "data_v4.db"),
      path.join(root, "astrbot", "data", "data_v4.db"),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
    return "";
  };

  let cwd = "";
  try {
    cwd = readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    // 读不到 cwd（权限 / 已退出）就只靠 cmdline 里的绝对路径
  }
  // `cd /opt/astrbot && python main.py`：cwd 本身就是实例目录，最常见
  const cwdHit = tryRoot(cwd);
  if (cwdHit) return cwdHit;

  let args = [];
  try {
    args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return "";
  }
  const index = args.findIndex((arg) => /(?:^|[\\/])main\.py$/.test(arg));
  if (index < 0) return "";
  // 相对路径（`python astrbot/main.py`）按进程 cwd 展开，再用绝对路径那套规则找
  const script = path.isAbsolute(args[index])
    ? args[index]
    : cwd
      ? path.join(cwd, args[index])
      : "";
  if (!path.isAbsolute(script)) return "";
  const dir = path.dirname(script);
  return tryRoot(dir) || tryRoot(path.dirname(dir));
}

/** 从进程命令行里认出 AstrBot 的 core 目录，推出 `core\data\data_v4.db` */
async function dbFileFromPid(pid) {
  if (!pid) return "";
  // Linux：读 /proc/<pid>，和下面的 Windows 分支对称
  if (process.platform !== "win32") return dbFileFromPidLinux(pid);

  const out = await runPowerShell(
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CommandLine }`,
    6000,
  );
  if (!out) return "";

  // 命令行形如 `"C:\...\python.exe" C:\...\core\main.py`：
  // 找最后一个 `core\main.py`（或 `core/main.py`），它前面那段才是实例目录。
  const re = /core[\\/]main\.py/gi;
  let last = -1;
  let match;
  while ((match = re.exec(out)) !== null) last = match.index;
  if (last < 0) return "";

  let root = out.slice(0, last).trim();
  // 去掉解释器路径：引号包着的话取最后一个引号之后；没有引号就取最后一个空格之后
  const quote = root.lastIndexOf('"');
  if (quote >= 0) {
    root = root.slice(quote + 1).trim();
  } else {
    const space = root.lastIndexOf(" ");
    if (space >= 0) root = root.slice(space + 1);
  }
  if (!root) return "";

  const candidate = path.join(root, "core", "data", "data_v4.db");
  return existsSync(candidate) ? candidate : "";
}

/** 从发现的地址里取端口（`http://127.0.0.1:6185` → 6185）；取不到返回 0 */
function portOfBase(base) {
  try {
    const url = new URL(base);
    if (url.port) return Number(url.port);
    return url.protocol === "https:" ? 443 : 80;
  } catch {
    return 0;
  }
}

/**
 * 「在这个端口上应答的那个实例，用的是哪个库」。
 *
 * 为什么需要这条：Windows 的 Launcher 用 `cwd=<实例>/core` + `python main.py` 启动，
 * 命令行里既没有 `core\main.py` 也没有绝对路径，而读别的进程的 cwd 需要调 PEB，
 * 所以 `dbFileFromPid()` 在 Windows 上推不出来。改读每个候选库旁边的
 * `data/cmd_config.json`：`dashboard.port` 对上了，就是这个实例的库。
 * 多实例（Launcher 留了多个 core）时，这也比按 mtime 猜更准。
 */
/**
 * 读一个 JSON 文件，顺手吃掉 UTF-8 BOM。
 *
 * AstrBot 的 `cmd_config.json` 就带 BOM（Python 那边用 utf-8-sig 写的），
 * 直接 `JSON.parse` 会抛 `Unexpected token '﻿'` —— 而这里所有读配置的地方
 * 都是「读不到就换下一个候选」，报错会被静默吞掉，表现为「明明配了却没命中」。
 */
function readJsonFile(file) {
  let text = readFileSync(file, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

function dbFileForPort(port) {
  if (!port) return "";
  for (const item of candidateDbFiles()) {
    let config;
    try {
      config = readJsonFile(path.join(path.dirname(item.file), "cmd_config.json"));
    } catch {
      continue;
    }
    if (Number(config?.dashboard?.port) === port) return item.file;
  }
  return "";
}

/** 认下一个可用的 AstrBot 地址：写缓存、记持久化、顺手把历史库对上 */
async function adoptBase(base, pid) {
  cachedBase = base;
  cachedAt = Date.now();
  failedAt = 0;
  failureMessage = "";
  rememberBase(base);
  if (!pidDbFile) {
    pidDbFile = await dbFileFromPid(pid);
    pidDbSource = pidDbFile ? "pid" : "";
    if (!pidDbFile) {
      // Windows 的 Launcher 是「cwd=core + python main.py」：命令行里没有 `core\main.py`，
      // 也没有绝对路径，读不到别的进程的 cwd 就推不出来。这时换个问法：
      // 「在这里应答的那个实例，它 cmd_config.json 里 dashboard.port 是多少？」
      // 对上了，就是它在用这个库（多实例时也比按 mtime 猜准）。
      const byPort = dbFileForPort(portOfBase(base));
      if (byPort) {
        pidDbFile = byPort;
        pidDbSource = "port";
      }
    }
  }
  return base;
}

async function resolveBase(force = false) {
  if (!force && cachedBase && Date.now() - cachedAt < 60_000) {
    if (await probe(cachedBase)) return cachedBase;
  }
  if (!force && failedAt && Date.now() - failedAt < 8_000) {
    throw new Error(failureMessage || "AstrBot 未找到");
  }
  if (discovering) return discovering;
  discovering = (async () => {
    // 0) 快路：上次成功的地址，600ms 探一下。命中就不跑 PowerShell 扫端口 ——
    //    冷启动首屏会话从 ~6s 降到 ~1s 就是靠这一步。没有缓存（首次运行）就跳过，
    //    免得在「注定要扫」的情况下白等 600ms。
    if (cachedBase && !force) {
      if (await probe(cachedBase, 600)) return adoptBase(cachedBase, 0);
    }

    const candidates = [];
    const push = (base, pid) => {
      const clean = String(base || "").replace(/\/+$/, "");
      if (clean && !candidates.some((item) => item.base === clean)) {
        candidates.push({ base: clean, pid });
      }
    };

    // 1) 环境变量 / 上次发现的结果优先
    push(cachedBase);
    // 2) AstrBot 的默认端口（没被 Launcher 改过时就是它）
    push("http://127.0.0.1:6185");
    // 3) 本机所有监听端口
    const listeners = await listListeners();
    for (const { port, pid } of listeners) push(`http://127.0.0.1:${port}`, pid);

    const results = await Promise.all(
      candidates.map(async (item) => ({ ...item, ok: await probe(item.base) })),
    );

    for (const item of results) {
      if (!item.ok) continue;
      return adoptBase(item.base, item.pid);
    }

    if (cachedBase && (await probe(cachedBase))) return adoptBase(cachedBase, 0);

    const configured = String(env.ASTRBOT_BASE_URL || "").trim();
    failureMessage = configured
      ? `连不上配置的 AstrBot 地址 ${configured}（本机也没扫到可用的 AstrBot）`
      : "AstrBot 未找到：可能没启动，或它没有开放 HTTP 面板（dashboard.enable）";
    failedAt = Date.now();
    throw new Error(failureMessage);
  })();
  try {
    return await discovering;
  } finally {
    discovering = null;
  }
}

function forwardHeaders(req, length) {
  const h = { ...req.headers };
  delete h.host;
  delete h.connection;
  delete h["content-length"];
  delete h["transfer-encoding"];
  delete h.authorization;
  delete h.cookie;
  delete h.origin;
  delete h.referer;
  if (typeof length === "number") {
    h["content-length"] = String(length);
  }
  h.authorization = `Bearer ${API_KEY}`;
  return h;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function proxy(req, res, url) {
  const targetPath = url.pathname.replace(/^\/astrbot/, "") + url.search;
  const hasBody = !["GET", "HEAD"].includes(req.method || "GET");
  const body = hasBody ? await readBody(req) : null;

  const attempt = (base) => {
    const headers = forwardHeaders(req, body?.length);
    const init = {
      method: req.method,
      headers,
      signal: AbortSignal.timeout(180_000),
    };
    if (body) init.body = body;
    return fetch(base + targetPath, init);
  };

  let base = await resolveBase();
  let upstream;
  try {
    upstream = await attempt(base);
  } catch {
    base = await resolveBase(true);
    upstream = await attempt(base);
  }

  const headers = { "cache-control": "no-store", "x-astrbot-base": base };
  const ct = upstream.headers.get("content-type");
  if (ct) headers["content-type"] = ct;
  res.writeHead(upstream.status, headers);

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
}

/**
 * 找历史库 `data_v4.db`。
 *
 * 优先级（前一项命中就不再往后看）：
 * 1. 设置里显式填的「AstrBot 数据目录」（`ASTRBOT_DATA_DIR`）——用户意图优先，
 *    远端 / 容器 / 非标准安装全靠它；`~` 和 `$VAR` 会先展开；
 * 2. 发现端口时从监听进程里推出来的路径（Windows 读命令行，Linux 读 `/proc`）；
 * 3. 常见安装布局：Windows Launcher、Linux 的 uv 安装 / 解压版 / `~/astrbot` /
 *    `$XDG_DATA_HOME/astrbot` / `/opt/astrbot`（有多个就取 mtime 最新的）。
 *
 * 都不行就抛错 —— 调用方会把它变成「远端模式：没有本地历史」，而不是一条红色错误。
 */
let dbSource = "";
/** 从监听进程推出来的库；和 cachedDbFile 分开存，才不会盖掉用户在设置里填的目录 */
let pidDbFile = "";
/** pidDbFile 是怎么来的：`pid`（命令行 / cwd 推出来）、`port`（按 dashboard 端口对上的） */
let pidDbSource = "";

/** 展开用户填的路径：`~`、`~/xxx`、`$HOME`、`${XDG_DATA_HOME}`。 */
function expandPath(raw) {
  let text = String(raw || "").trim();
  if (!text) return "";
  if (text === "~") {
    text = os.homedir();
  } else if (text.startsWith("~/") || text.startsWith("~\\")) {
    text = path.join(os.homedir(), text.slice(2));
  }
  return text.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (whole, braced, plain) => env[braced || plain] ?? whole,
  );
}

/**
 * 设置里填的目录 / `.db` 文件（已展开 `~`、已确认存在）。
 * 没填、或者那儿没有库就返回 []，由 resolveDb 决定是报错还是继续猜。
 */
function explicitDbFiles() {
  const expanded = expandPath(env.ASTRBOT_DATA_DIR);
  if (!expanded) return [];
  // 允许三种填法：目录、`…/data`、直接指到 .db 文件
  const files = expanded.endsWith(".db")
    ? [expanded]
    : [path.join(expanded, "data_v4.db"), path.join(expanded, "data", "data_v4.db")];
  return files
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    })
    .map((file) => ({ file, source: "settings:ASTRBOT_DATA_DIR" }));
}

/** 按平台猜的常见布局（不判断是否存在，留给 resolveDb 过滤 / db-status 展示）。 */
function layoutDbFiles() {
  const home = os.homedir();
  const dataHome =
    expandPath(process.env.XDG_DATA_HOME) || path.join(home, ".local", "share");
  const files = [];

  // Windows Launcher：每个实例一个 core/data
  const launcher = path.join(home, ".astrbot_launcher", "instances");
  if (existsSync(launcher)) {
    let names = [];
    try {
      names = readdirSync(launcher);
    } catch {
      names = [];
    }
    for (const name of names) {
      files.push({
        file: path.join(launcher, name, "core", "data", "data_v4.db"),
        source: "windows-launcher",
      });
    }
  }

  // Linux：uv 工具安装 / 手动解压 / 白板（`$XDG_DATA_HOME` 默认 ~/.local/share）
  for (const file of [
    path.join(dataHome, "astrbot", "data", "data_v4.db"),
    path.join(dataHome, "astrbot", "data_v4.db"),
    path.join(home, "astrbot", "data", "data_v4.db"),
    path.join(home, "astrbot", "data_v4.db"),
    "/opt/astrbot/data/data_v4.db",
    "/opt/astrbot/astrbot/data/data_v4.db",
  ]) {
    files.push({ file, source: "linux-layout" });
  }

  return files.filter((item) => item.file);
}

/** 自动布局里真实存在的库（供 resolveDb 比较 mtime）。 */
function candidateDbFiles() {
  return layoutDbFiles().filter((item) => {
    try {
      return statSync(item.file).isFile();
    } catch {
      return false;
    }
  });
}

function resolveDb() {
  // 1) 用户明确填的目录：命中就直接用它，不再和别的布局比 mtime
  //    （否则本机另一个实例的库更新一点就会被"抢"走，用户填了也白填）
  const explicit = explicitDbFiles();
  if (explicit.length > 0) return rememberDb(explicit[0].file, explicit[0].source);

  const configured = String(env.ASTRBOT_DATA_DIR || "").trim();
  if (configured) {
    // 填了但那儿没有库：说清楚是哪个路径，别默默退回去猜（改起来才有依据）
    const expanded = expandPath(configured) || configured;
    const what = expanded.endsWith(".db")
      ? "这个库文件不存在"
      : "这个目录里没有 data_v4.db";
    throw new Error(`设置里的 AstrBot 数据目录不对：${what} —— ${expanded}`);
  }

  // 2) 发现端口时从监听进程推出来的路径
  //    必须排在缓存前面：服务刚起来时前端可能先要过一次历史，那时还没发现 AstrBot，
  //    按布局猜出来的路径进了缓存，之后发现到的 pid 路径就再也用不上了。
  if (pidDbFile && existsSync(pidDbFile)) return rememberDb(pidDbFile, pidDbSource || "pid");

  if (cachedDbFile && existsSync(cachedDbFile)) return cachedDbFile;

  // 3) 常见布局：有多个就取 mtime 最新的那个
  let best = null;
  for (const item of candidateDbFiles()) {
    let mtime = 0;
    try {
      mtime = statSync(item.file).mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtime > best.mtime) best = { ...item, mtime };
  }
  if (!best) throw new Error("找不到 AstrBot 的数据目录（data_v4.db）");

  return rememberDb(best.file, best.source);
}

/** 记下这次用的库（db-status 要能看到来源），顺便返回，省得每处重复赋值 */
function rememberDb(file, source) {
  cachedDbFile = file;
  dbSource = source;
  return file;
}

/** 诊断用：当前用的是哪个库、从哪推出来的。 */
function dbStatus() {
  const configured = String(env.ASTRBOT_DATA_DIR || "").trim();
  const meta = {
    platform: process.platform,
    // BFF 实际拿到的设置值（设置页保存后会自动重启 BFF，这里能直接看出有没有生效）
    configured: configured ? expandPath(configured) : "",
  };
  try {
    const file = resolveDb();
    const status = {
      ok: true,
      ...meta,
      path: file,
      source: dbSource || "unknown",
      candidates: candidateDbFiles().map((item) => item.file),
    };
    if (!meta.configured && !pidDbFile) {
      // 说白了就是：这个路径是"按安装布局猜的"，AstrBot 连上之后可能换成从进程推出来的
      status.note =
        "还没发现运行中的 AstrBot：这是按安装布局猜的库，连上后会改成从监听进程推出来的那个";
    }
    return status;
  } catch (error) {
    return {
      ok: false,
      ...meta,
      reason: String(error?.message || error),
      candidates: [
        ...(meta.configured ? [meta.configured] : []),
        ...layoutDbFiles().map((item) => item.file),
      ],
      hint: "远端 / 容器 / 非标准安装时，在设置里填「AstrBot 数据目录」（data_v4.db 所在目录）；Linux 上也可以直接写 ~/astrbot/data",
    };
  }
}

function parseHistoryRow(row) {
  let parsed;
  try {
    parsed = JSON.parse(row.content);
  } catch {
    return null;
  }
  const role = parsed.type === "user" ? "user" : "assistant";
  const segments = Array.isArray(parsed.message) ? parsed.message : [];
  const texts = [];
  const media = [];
  for (const seg of segments) {
    if (seg?.type === "plain") {
      texts.push(seg.text ?? "");
    } else if (seg?.type === "image") {
      media.push({
        type: "image",
        attachmentId: seg.attachment_id,
        filename: seg.filename,
      });
    } else if (seg?.type === "record") {
      media.push({
        type: "record",
        attachmentId: seg.attachment_id,
        url: seg.data?.url,
        filename: seg.filename,
        text: seg.data?.text,
      });
    } else if (seg?.type === "file" || seg?.type === "video") {
      media.push({
        type: seg.type,
        attachmentId: seg.attachment_id,
        filename: seg.filename,
      });
    }
  }
  return {
    id: `m${row.id}`,
    role,
    text: texts.join("\n"),
    media,
    sender: row.sender_name || "",
    createdAt: `${String(row.created_at || "").replace(" ", "T")}Z`,
    stats: parsed.agent_stats ?? null,
  };
}

let dbCache = { file: "", at: 0 };

function openDb() {
  if (!dbCache.file || Date.now() - dbCache.at > 60_000) {
    dbCache = { file: resolveDb(), at: Date.now() };
  }
  const db = new DatabaseSync(dbCache.file, { readOnly: true });
  db.exec("PRAGMA busy_timeout=3000");
  return db;
}

/**
 * 读一个会话的历史消息。
 *
 * 默认给**最近** limit 条（倒序取再翻回来）；带 `beforeId` 时给更早的一批，
 * 供前端「加载更早」用。这样做的好处：长会话打开时看到的是最新内容，
 * 而不是最早那 200 条。
 */
function readHistory(sessionId, limit, beforeId) {
  if (!sessionId) throw new Error("缺少 session_id");
  const db = openDb();
  try {
    const before = Number(beforeId || 0);
    const rows = before
      ? db
          .prepare(
            "select id, created_at, sender_id, sender_name, content " +
              "from platform_message_history where user_id = ? and id < ? " +
              "order by id desc limit ?",
          )
          .all(sessionId, before, limit)
      : db
          .prepare(
            "select id, created_at, sender_id, sender_name, content " +
              "from platform_message_history where user_id = ? " +
              "order by id desc limit ?",
          )
          .all(sessionId, limit);

    const messages = rows
      .slice()
      .reverse()
      .map(parseHistoryRow)
      .filter(Boolean);

    // 还有没有更早的？用本批最早那条 id 再探一条
    let hasMore = false;
    if (messages.length > 0) {
      const oldest = Number(String(messages[0].id).replace(/^m/, ""));
      if (Number.isFinite(oldest)) {
        const probe = db
          .prepare(
            "select 1 as hit from platform_message_history where user_id = ? and id < ? limit 1",
          )
          .get(sessionId, oldest);
        hasMore = Boolean(probe);
      }
    }
    return { messages, hasMore };
  } finally {
    db.close();
  }
}

/**
 * 消息全文搜索：只在本地 SQLite 上有；远端连接会返回 available:false
 *
 * 中文要搜两遍：AstrBot 落库时用的 `json.dumps(ensure_ascii=True)`，
 * 中文在 content 里是 `\u5531\u7247\u5e97` 这种转义形式，直接 LIKE 中文永远 0 条。
 * 所以同时用「原文」和「\uXXXX 转义形」两个 pattern 去匹配。
 */
function searchMessages(rawQuery, limit) {
  const query = String(rawQuery || "").trim();
  if (!query) return { results: [], available: true };
  const db = openDb();
  try {
    // LIKE 的通配符要转义，否则用户输个 % 就把全库捞出来了。
    // 注意 ESCAPE 不能选反斜杠：`\u5531` 这种 JSON 转义里反斜杠必须原样保留。
    const escaped = query.replace(/[!%_]/g, (ch) => `!${ch}`);
    const unicodeEscaped = escaped.replace(/[^\x00-\x7f]/g, (ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (code > 0xffff) {
        const high = 0xd800 + ((code - 0x10000) >> 10);
        const low = 0xdc00 + ((code - 0x10000) & 0x3ff);
        return `\\u${high.toString(16).padStart(4, "0")}\\u${low
          .toString(16)
          .padStart(4, "0")}`;
      }
      return `\\u${code.toString(16).padStart(4, "0")}`;
    });

    const rows = db
      .prepare(
        "select id, created_at, sender_name, content, user_id " +
          "from platform_message_history " +
          "where content like ? escape '!' or content like ? escape '!' " +
          "order by id desc limit ?",
      )
      .all(`%${escaped}%`, `%${unicodeEscaped}%`, limit);

    const results = [];
    for (const row of rows) {
      const parsed = parseHistoryRow(row);
      if (!parsed || !parsed.text.trim()) continue;
      results.push({
        messageId: parsed.id,
        sessionId: row.user_id,
        role: parsed.role,
        text: parsed.text.slice(0, 400),
        createdAt: parsed.createdAt,
      });
    }
    return { results, available: true };
  } finally {
    db.close();
  }
}

const MEDIA_LABEL = { image: "图片", record: "语音", video: "视频", file: "文件" };

/**
 * 每个会话「最后一条消息」，用来在侧栏显示摘要、判断未读。
 *
 * AstrBot 的会话列表只给 created_at / updated_at（后者实际等于创建时间），
 * 光看这两个字段认不出是哪个会话，所以这里直读 SQLite 补摘要。
 * 本地库、十几到几十个会话，逐条取也就几毫秒；读失败返回空 Map，不影响列表本身。
 */
function readLastMessages(sessionIds) {
  const result = new Map();
  if (sessionIds.length === 0) return result;
  if (!dbCache.file || Date.now() - dbCache.at > 60_000) {
    dbCache = { file: resolveDb(), at: Date.now() };
  }
  const db = new DatabaseSync(dbCache.file, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=3000");
    const stmt = db.prepare(
      "select id, created_at, sender_id, sender_name, content " +
        "from platform_message_history where user_id = ? order by id desc limit 1",
    );
    for (const sessionId of sessionIds) {
      const row = stmt.get(sessionId);
      if (!row) continue;
      const parsed = parseHistoryRow(row);
      if (!parsed) continue;
      const mediaLabel = parsed.media.length
        ? `[${MEDIA_LABEL[parsed.media[0].type] ?? "消息"}]`
        : "";
      const text = parsed.text.trim() || mediaLabel;
      result.set(sessionId, {
        text: text.slice(0, 120),
        role: parsed.role,
        at: parsed.createdAt,
      });
    }
  } finally {
    db.close();
  }
  return result;
}

/**
 * 会话列表：先拿 AstrBot 的原始 JSON，再补 `last_message` / `last_role` / `last_message_at`。
 * 补不上就原样返回，这个接口不能因为摘要失败而挂掉。
 */
async function handleSessionList(req, res, url) {
  const headers = {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  };

  let base;
  try {
    base = await resolveBase();
  } catch (error) {
    res.writeHead(503, headers);
    res.end(
      JSON.stringify({
        status: "error",
        message: String(error?.message || error),
        data: { sessions: [] },
      }),
    );
    return;
  }

  let payload;
  try {
    const upstream = await fetch(`${base}/api/v1/chat/sessions${url.search}`, {
      headers: forwardHeaders(req),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      res.writeHead(upstream.status, headers);
      res.end(text);
      return;
    }
    payload = JSON.parse(text);
  } catch (error) {
    res.writeHead(502, headers);
    res.end(JSON.stringify({ error: String(error?.message || error) }));
    return;
  }

  const sessions = payload?.data?.sessions;
  if (Array.isArray(sessions) && sessions.length > 0) {
    try {
      const last = readLastMessages(sessions.map((session) => session.session_id));
      for (const session of sessions) {
        const hit = last.get(session.session_id);
        if (!hit) continue;
        session.last_message = hit.text;
        session.last_role = hit.role;
        session.last_message_at = hit.at;
      }
    } catch (error) {
      console.warn(`[bff] 会话摘要失败：${error.message}`);
    }
  }

  res.writeHead(200, headers);
  res.end(JSON.stringify(payload));
}

// ---------------- 手机 / 局域网访问 ----------------

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
/** 桌面壳 / dev 工具固定允许的跨域来源（手机从 BFF 自己打开属于同源，不算跨域） */
const STATIC_ORIGINS = new Set([
  "http://tauri.localhost",
  "https://tauri.localhost",
  // Capacitor 套壳（Android 默认 https://localhost，iOS capacitor://localhost）
  "https://localhost",
  "capacitor://localhost",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
]);

function isLoopback(req) {
  return LOOPBACK.has(String(req.socket?.remoteAddress || ""));
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // 编码坏掉的 cookie 直接忽略
    }
  }
  return out;
}

function sameToken(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * CORS：只反射白名单里的来源，以及「和 Host 同源」的来源（手机从 8788 打开就是这种）。
 * 之前是 `req.headers.origin || "*"`，等于任何网页都能借用 BFF 里注入的 API Key。
 */
function allowedOrigin(req) {
  const origin = String(req.headers.origin || "");
  if (!origin) return "";
  if (STATIC_ORIGINS.has(origin)) return origin;
  try {
    if (new URL(origin).host === String(req.headers.host || "")) return origin;
  } catch {
    // origin 不是合法 URL，按不允许处理
  }
  return "";
}

/**
 * 浏览器会「不带 cookie」去取的公开文件：web app manifest、图标、favicon。
 *
 * Chrome 取 manifest 用的是 `credentials: 'omit'`，所以这些路径要令牌就永远 401
 * —— 手机上会表现为「HTTPS 也装不上 PWA」（2026-11-18 加 HTTPS 时实测踩到）。
 * 它们都是纯静态资源，放行不会泄露任何东西（真正敏感的是 /astrbot/api/*）。
 */
const TOKEN_FREE_PATHS = [
  "/manifest.webmanifest",
  "/favicon.png",
  "/apple-touch-icon.png",
  "/icons/",
  "/ca.cer",
];

function tokenFree(pathname) {
  return TOKEN_FREE_PATHS.some((prefix) =>
    prefix.endsWith("/") ? pathname.startsWith(prefix) : pathname === prefix,
  );
}

/** 非回环请求（手机 / 局域网）必须带令牌，否则连静态页都看不到。
 *
 * `forceToken`：反代专用端口（BFF_PROXY_PORT）传 true —— 即使请求来自回环，
 * 也必须带令牌。否则本机反代（tailscaled / cloudflared / frpc 连 127.0.0.1）
 * 会被当成「桌面壳自己」，链接里的 `?t=` 就白搭了。
 */
function tokenGate(req, res, url, forceToken = false) {
  if (!forceToken && isLoopback(req)) return true;
  if (tokenFree(url.pathname)) return true;

  const queryToken = url.searchParams.get("t") || "";
  const cookieToken = parseCookies(req.headers.cookie)[TOKEN_COOKIE] || "";
  // 套壳 App 用自定义 header 带令牌：`?t=` 会被下面重定向成 cookie，
  // 而跨域 fetch 的 302 不会把 Set-Cookie 带回来，API 调用会 401。
  const headerToken = String(req.headers["x-astrbot-token"] || "");
  const provided = queryToken || cookieToken || headerToken;

  if (!LAN_TOKEN || !provided || !sameToken(provided, LAN_TOKEN)) {
    res.writeHead(401, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(
      "需要访问令牌：请用桌面端「设置 → 手机访问」里显示的链接打开（带 ?t=…）",
    );
    return false;
  }

  if (queryToken) {
    // 只对「浏览器地址栏打开页面」做 302 换 cookie；图片/语音这种资源请求不能跳，
    // 跨域 <img> 跟不了 302 又拿不到 Set-Cookie，会直接裂图（APK 套壳里实测）。
    const accept = String(req.headers.accept || "");
    if (accept.includes("text/html")) {
      // 令牌进 cookie 后从地址栏消失，刷新页面也不用重新贴
      url.searchParams.delete("t");
      const location = url.pathname + (url.search || "");
      // 反代端口只走 HTTPS（Tailscale Serve 在 8443 终止 TLS），cookie 标 Secure；
      // 8788/8789 保持原样，免得把纯 HTTP 局域网的老路弄坏。
      const secure = forceToken ? "; Secure" : "";
      res.writeHead(302, {
        location,
        "set-cookie": `${TOKEN_COOKIE}=${encodeURIComponent(queryToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`,
        "cache-control": "no-store",
      });
      res.end();
      return false;
    }
  }

  return true;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8",
};

/** 手机打开 `http://<PC-IP>:8788/` 时，用 BFF 自己把前端静态页发出去 */
async function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }

  const relative = decoded.replace(/^\/+/, "") || "index.html";
  let file = path.resolve(WEB_ROOT, relative);
  if (!file.startsWith(WEB_ROOT)) return false; // 目录穿越

  if (!existsSync(file) || !statSync(file).isFile()) {
    // 打包时 `dist/assets/*` 会被拍平到 `sidecar/web/*`，而 index.html 里引用的是
    // `/assets/xxx.js`。所以按原路径找不到时，再按文件名在 web 根下试一次——
    // 手机 / 局域网打开就是靠这一步才不至于白屏（图标 `/icons/*` 同理）。
    const flat = path.join(WEB_ROOT, path.basename(relative));
    if (flat.startsWith(WEB_ROOT) && existsSync(flat) && statSync(flat).isFile()) {
      file = flat;
    } else if (/\.[a-z0-9]{1,8}$/i.test(decoded)) {
      return false; // 有扩展名却找不到 = 真 404
    } else {
      // 没有扩展名 = SPA 路由，回 index.html
      file = path.join(WEB_ROOT, "index.html");
      if (!existsSync(file)) return false;
    }
  }

  const headers = {
    "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
    "cache-control": decoded.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "no-store",
  };
  if (req.method === "HEAD") {
    res.writeHead(200, headers);
    res.end();
    return true;
  }
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
  return true;
}

/**
 * Key 体检：分别打一次只需要 `chat` / `plugin` / `file` 的接口，
 * 把 401（Key 不对）和 403（scope 不够）区分开。前端拿它来做「测试连接」。
 */
async function probeScope(base, pathAndQuery, init = {}) {
  try {
    const response = await fetch(base + pathAndQuery, {
      method: init.method || "GET",
      body: init.body,
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 200) return "ok";
    if (response.status === 401) return "bad-key";
    if (response.status === 403) return "missing-scope";
    // 参数不合法说明鉴权已经过了（file 这条就是靠这个判断）
    if (response.status === 400 || response.status === 422) return "ok";
    return `http-${response.status}`;
  } catch {
    return "error";
  }
}

async function handleProbe(req, res) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  };
  let base;
  try {
    base = await resolveBase();
  } catch (error) {
    res.writeHead(503, headers);
    res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
    return;
  }

  const [chat, plugin, file] = await Promise.all([
    probeScope(base, "/api/v1/chat/sessions?username=astrbot"),
    probeScope(base, "/api/v1/plugins"),
    probeScope(base, "/api/v1/files/upload/status", {
      method: "POST",
      body: "{}",
    }),
  ]);

  res.writeHead(200, headers);
  res.end(JSON.stringify({ ok: true, baseUrl: base, checks: { chat, plugin, file } }));
}

/** 反代端口在请求上打的标记：同一个 handler，但要强制令牌 */
const FORCE_TOKEN = Symbol("bff.forceToken");

const handleRequest = async (req, res) => {
  // 链接防火相关的安全头，所有响应（含 302 / 401 / 静态页 / SSE）都带
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  // 手机装 CA 用的下载点：证书本身是公开信息，而且「装证书之前 https 还不可信」，
  // 所以这一个路径不要求令牌（其余非回环请求照旧 401）。
  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/ca.cer" && TLS_CA && existsSync(TLS_CA)) {
    const headers = {
      "content-type": "application/x-x509-ca-cert",
      "content-disposition": 'attachment; filename="AstrBotChat-CA.cer"',
      "cache-control": "no-store",
    };
    if (req.method === "HEAD") {
      res.writeHead(200, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    createReadStream(TLS_CA).pipe(res);
    return;
  }

  // CORS 预检必须在令牌门之前：浏览器发 OPTIONS 时不带自定义头（没有令牌），
  // 放它过去，真正的请求再按令牌校验。
  const origin = allowedOrigin(req);
  if (origin) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("vary", "origin");
    res.setHeader("access-control-allow-headers", "content-type, authorization, x-astrbot-token");
    res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  }

  if (req.method === "OPTIONS") {
    res.writeHead(req.headers.origin && !origin ? 403 : 204);
    res.end();
    return;
  }

  if (!tokenGate(req, res, url, req[FORCE_TOKEN] === true)) return;

  if (url.pathname === "/astrbot/api/db-status") {
    // 诊断用：本地历史库到底找到没有、从哪推出来的（支持/反馈时让对方直接打开）
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(dbStatus()));
    return;
  }

  if (url.pathname === "/astrbot/api/health") {
    try {
      const base = await resolveBase();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, baseUrl: base }));
    } catch (e) {
      res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
    }
    return;
  }

  if (url.pathname === "/astrbot/api/probe") {
    await handleProbe(req, res);
    return;
  }

  if (url.pathname === "/astrbot/api/search") {
    try {
      const q = url.searchParams.get("q") || "";
      const limit = Math.min(
        Math.max(Number(url.searchParams.get("limit") || 30), 1),
        100,
      );
      const { results } = searchMessages(q, limit);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ available: true, results }));
    } catch (e) {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(
        JSON.stringify({
          available: false,
          results: [],
          reason: String(e?.message || e),
        }),
      );
    }
    return;
  }

  if (url.pathname === "/astrbot/api/history") {
    // 历史是「锦上添花」：远端 AstrBot / Docker / 没有本地库时，返回空列表 + 标记，
    // 让前端显示一句「这个连接没有本地历史」，而不是把整页顶成红色错误。
    try {
      const sessionId = url.searchParams.get("session_id") || "";
      const limit = Math.min(
        Math.max(Number(url.searchParams.get("limit") || 200), 1),
        500,
      );
      const before = url.searchParams.get("before") || "";
      const { messages, hasMore } = readHistory(sessionId, limit, before);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ messages, available: true, hasMore }));
    } catch (e) {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(
        JSON.stringify({
          messages: [],
          available: false,
          hasMore: false,
          reason: String(e?.message || e),
        }),
      );
    }
    return;
  }

  if (url.pathname === "/astrbot/api/v1/chat/sessions" && req.method === "GET") {
    await handleSessionList(req, res, url);
    return;
  }

  if (!url.pathname.startsWith("/astrbot/api/")) {
    if (await serveStatic(req, res, url.pathname)) return;
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("AstrBot Chat BFF");
    return;
  }

  if (!API_KEY) {
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "ASTRBOT_API_KEY 未配置（见 .env.local）" }));
    return;
  }

  try {
    await proxy(req, res, url);
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    }
    res.end(JSON.stringify({ error: String(e?.message || e) }));
  }
};

// 覆盖安装不会删上一版的静态资源：每装一版 `sidecar/web` 就多留一对
// `index-<hash>.js|css`（0.2.13 的装机目录已经攒了 24 个历史入口包）。
// 每次启动按当前 index.html 清一遍；规则和边界见 server/web-assets.mjs。
// `BFF_SKIP_PRUNE=1` 可以关掉（回归脚本指向真实安装目录时不希望它动手）。
if (env.BFF_SKIP_PRUNE !== "1") {
  pruneStaleWebAssets(WEB_ROOT, { log: (message) => console.log(message) });
}

const server = http.createServer(handleRequest);

/**
 * 反代专用监听：只绑回环、永远要令牌。Tailscale Serve 的源站指向这里。
 * 这样「链接里没带 ?t=」或「令牌不对」都进不来 —— 泄露的裸链接/旧截图不再能用。
 */
let proxyServer = null;
if (PROXY_PORT > 0) {
  if (PROXY_PORT === PORT || (TLS_READY && PROXY_PORT === HTTPS_PORT)) {
    console.warn(`[bff] BFF_PROXY_PORT=${PROXY_PORT} 和主端口冲突，忽略`);
  } else if (!LAN_TOKEN) {
    console.warn("[bff] 配了 BFF_PROXY_PORT 但没有 BFF_LAN_TOKEN：不监听反代端口（没有可校验的令牌）");
  } else {
    proxyServer = http.createServer((req, res) => {
      req[FORCE_TOKEN] = true;
      return handleRequest(req, res);
    });
    proxyServer.on("error", (error) => {
      console.warn(`[bff] 反代端口监听失败（${PROXY_BIND}:${PROXY_PORT}）：${error?.message || error}`);
    });
    proxyServer.listen(PROXY_PORT, PROXY_BIND, () => {
      console.log(
        `[bff] proxy on http://${PROXY_BIND}:${PROXY_PORT}（强制令牌，供 Tailscale Serve / 本机反代用）`,
      );
    });
  }
}

/**
 * 同一个 handler 再挂一个 HTTPS 监听（只在拿到证书时）。证书由
 * `scripts/lan-tls.ps1` 生成：一份本机 CA + 一张带所有局域网 IP 的服务器证书。
 * 失败不影响 HTTP 那条路（手机退回用 http 链接，只是没有 PWA / 录音）。
 */
let httpsServer = null;
if (TLS_READY) {
  try {
    httpsServer = https.createServer(
      { pfx: readFileSync(TLS_PFX), passphrase: TLS_PASSPHRASE },
      handleRequest,
    );
  } catch (error) {
    console.warn(`[bff] 自签 HTTPS 未启用：${error?.message || error}`);
    httpsServer = null;
  }
  if (httpsServer) {
    httpsServer.on("error", (error) => {
      console.warn(`[bff] HTTPS 监听失败（${HTTPS_PORT}）：${error?.message || error}`);
    });
    httpsServer.listen(HTTPS_PORT, BIND, () => {
      const shown = BIND === "0.0.0.0" ? "0.0.0.0（局域网可访问）" : BIND;
      console.log(`[bff] listening on https://${shown}:${HTTPS_PORT}`);
      if (TLS_CA && existsSync(TLS_CA)) {
        console.log(`[bff] 手机装 CA：http://<PC-IP>:${PORT}/ca.cer（文件：${TLS_CA}）`);
      }
    });
  }
} else if (BIND === "0.0.0.0") {
  console.log("[bff] 没有自签证书 → 只有 HTTP（手机上无 PWA / 录音）。生成：scripts/lan-tls.ps1");
}

server.listen(PORT, BIND, () => {
  const shown = BIND === "0.0.0.0" ? "0.0.0.0（局域网可访问）" : BIND;
  console.log(`[bff] listening on http://${shown}:${PORT}`);
  if (BIND === "0.0.0.0" && !LAN_TOKEN) {
    console.warn("[bff] 绑定了 0.0.0.0 但没有令牌：非回环请求一律 401");
  }
  console.log(`[bff] web root = ${WEB_ROOT}${existsSync(WEB_ROOT) ? "" : "（不存在，手机访问会 404）"}`);
  resolveBase()
    .then((base) => console.log(`[bff] astrbot = ${base}`))
    .catch((e) => console.warn(`[bff] astrbot not found yet: ${e.message}`));
});
