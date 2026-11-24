// 守一道「PowerShell 脚本必须是 UTF-8 with BOM」。
//
// 为什么：Windows PowerShell 5.1（和 `powershell.exe -File`）**没有 BOM 就按 ANSI 读**，
// 这些脚本里的中文注释 / 中文提示会变成乱码，运气不好整段字符串的引号一起被吃掉，
// 直接报 `Missing closing '}'` / `Unexpected token '}'` —— 看着像语法错，其实是编码。
// 2026-11-21 改 `tailscale-serve.ps1` 时踩过一次（编辑工具重写文件丢了 BOM）。
//
// 用法：
//   node scripts/check-ps1-encoding.mjs
// 退出码 0 = 全部带 BOM；1 = 有文件缺 BOM（该文件已列出）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const targets = ["scripts"];

const walk = (dir) => {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.toLowerCase().endsWith(".ps1")) out.push(full);
  }
  return out;
};

const missing = [];
const files = targets.flatMap((dir) => walk(join(root, dir)));
for (const file of files) {
  const head = readFileSync(file).subarray(0, 3);
  const hasBom = head.length === 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
  if (!hasBom) missing.push(file.slice(root.length));
}

if (missing.length > 0) {
  console.error("[ps1-encoding] 这些脚本缺 UTF-8 BOM，Windows PowerShell 5.1 会把中文读成乱码：");
  for (const file of missing) console.error(`  - ${file}`);
  console.error("[ps1-encoding] 修法：用「UTF-8 with BOM」另存一次（或脚本里补 EF BB BF 三个字节）");
  process.exit(1);
}

console.log(`[ps1-encoding] ${files.length} 个 .ps1 都带 BOM ✓`);
