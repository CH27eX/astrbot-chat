# NOTICE

AstrBot Chat 本身以 MIT 许可发布（见 `LICENSE`）。它依赖、引用或附带以下第三方作品，
各自的许可与归属如下。

## 运行依赖（通过包管理器安装，不随源码库分发）

| 组件 | 许可 | 用途 |
|---|---|---|
| Tauri 2 | MIT / Apache-2.0 | 桌面壳（Windows / Linux） |
| Capacitor 8 | MIT | Android / iOS 壳 |
| React 19、react-dom | MIT | 前端框架 |
| Vite | MIT | 构建工具 |
| react-markdown、remark-gfm | MIT | Markdown 渲染 |
| lucide-react | ISC | 图标 |
| qrcode-generator | MIT | 配对二维码 |
| idb | ISC | IndexedDB 封装 |
| jsqr | Apache-2.0 | 二维码识别 |

## 可选插件

- `plugins/astrbot_plugin_webchat_admin`（及打包的 zip）：MIT，作者见插件目录内说明。

## 便携运行时

- 源码库**不包含** Node.js 可执行文件。打包时由 `scripts/sync-sidecar.mjs`
  从本机复制（Windows 需手动放 `src-tauri/resources/node/node.exe`）。
  Node.js 本身为 MIT，其二进制内附带的第三方库许可见 Node.js 发行包。

## 图片素材

- 应用图标、启动图由仓库内 `src-tauri/icons/icon.png` 生成，可自由替换。

## 与 AstrBot 的关系

- AstrBot 本体（AGPL-3.0）**不在**本仓库内，客户端只通过 HTTP API 与它通信。
  分发本客户端不改变 AstrBot 的许可；若你把两者一起分发，请遵守 AGPL-3.0。
