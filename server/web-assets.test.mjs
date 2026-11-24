// 旧资源清理的单元测试（node --test server/）。
// 跑法：pnpm run test:unit（Node 22+ 自带 node:test，不引额外依赖）
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { pruneStaleWebAssets, referencedAssetNames } from "./web-assets.mjs";

function sandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), "astrbot-web-"));
  return {
    root,
    write(name, content = "/* stub */") {
      const file = path.join(root, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
      return file;
    },
    names() {
      return readdirSync(root).sort();
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("index.html 引用的入口包保留，上一版的删掉，懒加载 chunk / 静态资源不碰", () => {
  const box = sandbox();
  try {
    box.write(
      "index.html",
      `<!doctype html><html><head>
        <link rel="stylesheet" href="/index-CURRENT.css">
        <script type="module" src="/index-CURRENT.js"></script>
      </head></html>`,
    );
    box.write("index-CURRENT.js");
    box.write("index-CURRENT.css");
    box.write("index-OLD1.js");
    box.write("index-OLD2.css");
    box.write("index-1-DV6JLs.js");
    // 拍平后同层的懒加载 chunk：名字里没有 `index-`，却是运行时动态 import 的
    box.write("window-GcYX3aSY.js");
    box.write("qrcode-GFUlLbvm.js");
    box.write("dist-js-brkLvQ6m.js");
    box.write("sw.js");
    box.write("favicon.png");

    const result = pruneStaleWebAssets(box.root);

    assert.deepEqual(result.removed.sort(), ["index-1-DV6JLs.js", "index-OLD1.js", "index-OLD2.css"]);
    assert.deepEqual(result.kept.sort(), ["index-CURRENT.css", "index-CURRENT.js"]);
    assert.deepEqual(box.names(), [
      "dist-js-brkLvQ6m.js",
      "favicon.png",
      "index-CURRENT.css",
      "index-CURRENT.js",
      "index.html",
      "qrcode-GFUlLbvm.js",
      "sw.js",
      "window-GcYX3aSY.js",
    ]);
  } finally {
    box.cleanup();
  }
});

test("index.html 里没有可识别的入口包时，一个文件都不删", () => {
  const box = sandbox();
  try {
    box.write("index.html", "<!doctype html><div id=root></div>");
    box.write("index-OLD.js");
    const result = pruneStaleWebAssets(box.root);
    assert.deepEqual(result.removed, []);
    assert.equal(result.reason, "no-entry-asset");
    assert.deepEqual(box.names(), ["index-OLD.js", "index.html"]);
  } finally {
    box.cleanup();
  }
});

test("没有 index.html（前端还没 build）时不动手", () => {
  const box = sandbox();
  try {
    box.write("index-OLD.js");
    const result = pruneStaleWebAssets(box.root);
    assert.equal(result.reason, "no-index-html");
    assert.deepEqual(box.names(), ["index-OLD.js"]);
  } finally {
    box.cleanup();
  }
});

test("web 根目录不存在也不报错（dev 下 dist 还没 build）", () => {
  const result = pruneStaleWebAssets(path.join(os.tmpdir(), "astrbot-web-not-here"));
  assert.deepEqual(result, { removed: [], kept: [], reason: "no-web-root" });
});

test("子目录 / 同名目录不会被当成文件删掉", () => {
  const box = sandbox();
  try {
    box.write("index.html", '<script src="/index-CURRENT.js"></script>');
    box.write("index-CURRENT.js");
    mkdirSync(path.join(box.root, "index-DIR.js"));
    const result = pruneStaleWebAssets(box.root);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(box.names(), ["index-CURRENT.js", "index-DIR.js", "index.html"]);
  } finally {
    box.cleanup();
  }
});

test("引用里带子目录 / 查询串 / 转义也能认出当前入口", () => {
  const names = referencedAssetNames(
    `<link href="/assets/index-ABC.css?v=2">
     <script src="./index-DEF.js#app"></script>
     <link rel="icon" href="favicon.png">
     <img src="data:image/png;base64,xxxx">`,
  );
  assert.deepEqual([...names].sort(), ["favicon.png", "index-ABC.css", "index-DEF.js"]);
});

test("当前入口看起来在引用里，同名旧包不会被误删", () => {
  const box = sandbox();
  try {
    box.write("index.html", '<script src="index-KEEP.js"></script>');
    box.write("index-KEEP.js");
    box.write("index-KEEP.css");
    const result = pruneStaleWebAssets(box.root);
    assert.deepEqual(result.removed, ["index-KEEP.css"]);
    assert.deepEqual(result.kept, ["index-KEEP.js"]);
  } finally {
    box.cleanup();
  }
});
