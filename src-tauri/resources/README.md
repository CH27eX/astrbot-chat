# 打包用资源（生成物目录）

这个目录在仓库里是空的，打包时才会填：

| 子目录 | 内容 | 谁生成 |
|---|---|---|
| `bff/` | 本地后台服务（`server/*.mjs` 的副本，入口改名 `bff.mjs`） | `node scripts/sync-sidecar.mjs`（`tauri build` 会自动跑） |
| `node/` | 便携 Node 运行时 | Windows：手动放 `node.exe`（Node 24 x64）；Linux / macOS：`sync-sidecar.mjs` 从当前 node 复制 |

两者都被 `.gitignore` 忽略，**不要提交**。

没有便携 Node 也能构建，但装出来的应用会依赖用户机器上的系统 Node 20+，
所以正式发版请把对应平台的 Node 二进制放好：

- Windows：Node 24 的 `node.exe` → `src-tauri/resources/node/node.exe`
- Linux：在 Linux 上跑一次 `node scripts/sync-sidecar.mjs`（或 `cargo tauri build`，会自动复制）

注意 `bundle.resources` 里是 `resources/node/*` 通配：**同一个目录里不能同时放
`node` 和 `node.exe`**，否则另一个平台的二进制会被一起打进包（deb 会多半 89 MB）。
`sync-sidecar.mjs` 会自动清掉另一个平台的文件。
