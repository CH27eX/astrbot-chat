// 反代端口 / 链接防火的回归（node --test server/proxy-token.test.mjs）。
//
// 命题：8788 的令牌门对回环放行（桌面壳不带令牌），而本机反代（Tailscale Serve、
// cloudflared、frpc）连 127.0.0.1 时源地址也是回环 —— 如果直接反代 8788，链接里的
// `?t=` 就形同虚设。BFF_PROXY_PORT（只绑回环）用同一套 handler 但**永远要令牌**。
//
// 这里起一个真 BFF，验证：
//   1) 8788 回环不带令牌照旧 200（桌面端不能被弄挂）；
//   2) 8790 裸链接 401、错令牌 401、对令牌 200；
//   3) 8790 上 `?t=` + text/html 仍然 302 换 cookie（HttpOnly / Secure）；
//   4) 所有响应带「链接防火」安全头。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TOKEN = "0123456789abcdef0123456789abcdef";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startBff(mainPort, proxyPort) {
  const child = spawn(process.execPath, [path.join(HERE, "index.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      BFF_PORT: String(mainPort),
      BFF_BIND: "127.0.0.1",
      BFF_LAN_TOKEN: TOKEN,
      BFF_PROXY_PORT: String(proxyPort),
      BFF_SKIP_PRUNE: "1",
      ASTRBOT_API_KEY: "test-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // 一直读走，免得管道塞满把子进程卡住
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}

async function stopBff(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitReady(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/astrbot/api/db-status`, {
        signal: AbortSignal.timeout(1000),
      });
      await response.arrayBuffer();
      if (response.status) return;
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`BFF 没在 ${timeoutMs}ms 内起来（127.0.0.1:${port}）`);
}

test("反代端口强制令牌；8788 回环行为不变；安全头齐全", async () => {
  const mainPort = await freePort();
  const proxyPort = await freePort();
  const child = startBff(mainPort, proxyPort);
  try {
    await waitReady(mainPort);

    const main = `http://127.0.0.1:${mainPort}`;
    const proxy = `http://127.0.0.1:${proxyPort}`;

    // 1) 桌面壳：回环 + 不带令牌，照旧 200（这条挂了就是桌面端全挂）
    const desktop = await fetch(`${main}/astrbot/api/db-status`);
    assert.equal(desktop.status, 200, "8788 回环不带令牌必须仍然放行");
    await desktop.arrayBuffer();

    // 2) 反代端口：裸链接 401（哪怕来自回环）
    const naked = await fetch(`${proxy}/astrbot/api/db-status`);
    assert.equal(naked.status, 401, "8790 裸链接必须 401");
    assert.match(await naked.text(), /需要访问令牌/);

    // 3) 反代端口：错令牌 401，对令牌 200
    const wrong = await fetch(`${proxy}/astrbot/api/db-status`, {
      headers: { "x-astrbot-token": "f".repeat(32) },
    });
    assert.equal(wrong.status, 401);
    await wrong.arrayBuffer();

    const good = await fetch(`${proxy}/astrbot/api/db-status`, {
      headers: { "x-astrbot-token": TOKEN },
    });
    assert.equal(good.status, 200);
    const payload = await good.json();
    assert.equal(payload.ok, true);
    assert.equal(typeof payload.platform, "string");

    // 4) `?t=` + text/html：302 换 cookie，地址栏里不再留令牌
    const redirected = await fetch(`${proxy}/?t=${TOKEN}`, {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    assert.equal(redirected.status, 302);
    assert.equal(redirected.headers.get("location"), "/");
    const cookie = redirected.headers.get("set-cookie") || "";
    assert.match(cookie, /astrbot_bff_token=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Secure/, "反代端口只走 HTTPS，cookie 必须带 Secure");

    // 5) 安全头：401 / 200 / 302 都要有
    for (const [name, value] of [
      ["referrer-policy", "no-referrer"],
      ["x-content-type-options", "nosniff"],
      ["x-frame-options", "DENY"],
      ["x-robots-tag", "noindex, nofollow, noarchive"],
    ]) {
      assert.equal(naked.headers.get(name), value, `401 缺 ${name}`);
      assert.equal(good.headers.get(name), value, `200 缺 ${name}`);
      assert.equal(redirected.headers.get(name), value, `302 缺 ${name}`);
    }
    assert.match(naked.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
    assert.match(naked.headers.get("permissions-policy") || "", /camera=\(\)/);
  } finally {
    await stopBff(child);
  }
});

test("没有令牌时不监听反代端口（避免开了个谁都能进的洞）", async () => {
  const mainPort = await freePort();
  const proxyPort = await freePort();
  const child = spawn(process.execPath, [path.join(HERE, "index.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      BFF_PORT: String(mainPort),
      BFF_BIND: "127.0.0.1",
      BFF_LAN_TOKEN: "",
      BFF_PROXY_PORT: String(proxyPort),
      BFF_SKIP_PRUNE: "1",
      ASTRBOT_API_KEY: "test-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  try {
    await waitReady(mainPort);
    let refused = false;
    try {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/astrbot/api/db-status`, {
        signal: AbortSignal.timeout(1500),
      });
      await response.arrayBuffer();
    } catch {
      refused = true;
    }
    assert.equal(refused, true, "没令牌时反代端口不应该在监听");
  } finally {
    await stopBff(child);
  }
});
