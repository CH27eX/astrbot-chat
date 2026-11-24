# AstrBot Chat

<p align="center">
  <img src="public/icons/icon-512.png" width="120" alt="AstrBot Chat">
</p>

<p align="center">
  <b>把 AstrBot 变成桌面上真正好用的聊天客户端。</b><br>
  Windows / Linux 桌面应用 · Android / iOS 客户端 · 手机浏览器也能用
</p>

<p align="center">
  <a href="../../releases/latest">下载最新版</a> ·
  <a href="docs/安装配置指南-0.2.26.md">安装与配置指南</a> ·
  <a href="docs/从源码构建.md">从源码构建</a> ·
  <a href="docs/功能清单.md">功能清单</a>
</p>

---

AstrBot Chat 是一个**本地优先、可迁移到云端**的 AstrBot WebChat 客户端。
PC 与手机共用一套代码，通过本机 BFF（Backend-for-Frontend）访问 AstrBot，
**API Key 不会进入浏览器**。

聊的还是你自己的 AstrBot —— 消息、记忆、和 QQ 里那套完全同一份，不改变你现有 AstrBot 的任何配置。

## 为什么需要它

AstrBot 自带的面板是**管理后台**：配模型、装插件、看日志很顺手，但拿它当聊天工具用有三个绕不过去的问题：

1. **翻历史很痛苦** —— 长对话要一屏一屏往上滚，不能搜索，退出就回到最上面；
2. **没有会话管理** —— 不能置顶、归档、备注，几十个会话只能按时间排；
3. **手机上基本没法用** —— 面板布局不是为窄屏做的，输入框、键盘、刘海全都不对付。

AstrBot Chat 就是补上这三块：**一套按聊天软件做的界面**，直接读 AstrBot 的会话与本地历史库。

## 功能

| 模块 | 说明 |
|---|---|
| 流式回复 | 逐字输出、可中途停止；长回复不掉帧（每帧最多刷一次，只重绘最后一条） |
| Markdown | 代码块 / 列表 / 表格 / 链接按聊天软件的样子渲染，附 token 数与耗时 |
| 富媒体 | 图片、文件、视频、语音的发送与预览；表情包收藏与一键发送 |
| 会话管理 | 摘要、置顶、归档、备注、行内改名；本地 SQLite 关键词搜索 |
| 历史与记忆 | 直读 AstrBot 的 `data_v4.db`；记忆抽屉支持 Memory Beyond / LivingMemory / Memory Companion / Angel Memory |
| 连接 | 端口自动发现（Launcher 换端口也不影响）；API Key 体检（无效 / 缺 `chat` / 缺 `plugin` scope） |
| 桌面体验 | 无边框窗口、单实例、开机自启、托盘常驻、窗口状态记忆、深浅色与强调色 |
| 手机 | 同一 Wi-Fi 扫二维码配对；自适应窄屏布局；PWA 可添加到主屏幕 |
| 多端 | Windows（NSIS）、Linux（deb）、Android（签名 APK）、iOS（Xcode 工程 + 构建脚本） |

## 下载与安装

安装包在 [Releases](../../releases) 里，按平台取对应的文件：

| 平台 | 文件 |
|---|---|
| Windows 10 / 11 x64 | `AstrBot-Chat_0.2.26_x64-setup.exe` |
| Ubuntu 24.04+ / Debian 12+ (amd64) | `AstrBot-Chat_0.2.26_amd64.deb` |
| Android | `AstrBot-Chat-0.2.26-universal.apk` |
| iOS | 暂不提供预打包：用仓库里的 `ios/` 工程或 `.github/workflows/ios.yml` 在 macOS 上编译 |

校验和见 [`docs/SHA256SUMS-0.2.26.txt`](docs/SHA256SUMS-0.2.26.txt)：

```bash
sha256sum -c SHA256SUMS.txt
```

> GitHub 会把附件名里的空格规范成连字符，所以这里比安装包内文件名少一个空格（`AstrBot-Chat_...`）。

### Windows

```powershell
.\"AstrBot-Chat_0.2.26_x64-setup.exe" /S
```

装到 `%LOCALAPPDATA%\AstrBot Chat\`，当前用户安装、不需要管理员；覆盖安装会保留 `settings.json` 与会话缓存。
安装包**没有代码签名**，SmartScreen 提示时点「更多信息 → 仍要运行」。

### Linux

```bash
sudo apt install "./AstrBot-Chat_0.2.26_amd64.deb"
astrbot-chat
```

自带 Node 运行时（`/usr/lib/AstrBot Chat/sidecar/node`），不用另外装 Node。

### Android

```bash
adb install -r AstrBot-Chat-0.2.26-universal.apk
```

### iOS

Windows 上无法直出 ipa（平台限制）。仓库里的 `ios/` 是可编译的 Xcode 工程：在 Mac 上
`pnpm install && pnpm ios:sync && bash scripts/build-ios.sh`，或推送仓库跑 `.github/workflows/ios.yml`
（macOS runner）从 Artifacts 取 ipa。详见 [`docs/TESTER-GUIDE-IOS.md`](docs/TESTER-GUIDE-IOS.md)。

## 三步开始

1. **装**：按上表装好客户端；
2. **填 Key**：打开应用 → 左下角「设置 → 桌面」→ 粘贴 AstrBot 面板里建的 API Key
   （勾 `chat` + `file`；要用记忆抽屉再勾 `plugin`）；
3. **聊**：AstrBot 在同一台机器上时「AstrBot 地址」留空即可（自动发现）；在另一台就填 `http://那台机器:端口`。

手机端：同一 Wi-Fi 下扫设置页的二维码即可配对，首次需安装一次自签证书（安卓「安装 CA 证书」，
iOS 再开「完全信任」），之后才有 HTTPS、录音和「添加到主屏幕」。

## 从源码构建

前置：Node 20+、pnpm、Rust（桌面端）、Android SDK / Xcode（移动端）。

```bash
pnpm install
cp .env.example .env.local   # 填入 ASTRBOT_API_KEY
pnpm dev                     # http://127.0.0.1:5173
```

出包：

```bash
pnpm build                             # 前端 dist/
pnpm tauri build                       # Windows 安装包 / Linux deb
pnpm sidecar:sync                      # 同步 BFF 进安装目录
bash scripts/android-release.ps1       # Android 签名 APK（PowerShell）
```

打包细节见 [`docs/从源码构建.md`](docs/从源码构建.md) 与 [`scripts/`](scripts)。

## 项目结构

```
src/          React 前端（core / components / desktop / styles）
server/       BFF：/astrbot/api/*，鉴权注入、SSE 透传、SQLite 历史
src-tauri/    Tauri 2 桌面壳（Rust）
android/      Capacitor 8 Android 工程
ios/          Capacitor 8 iOS 工程（Xcode + SPM）
plugins/      AstrBot 侧配套插件 astrbot_plugin_webchat_admin
docs/         安装、构建、测试、接口规范
scripts/      打包、图标、证书、发布脚本
```

更细的开发笔记 —— BFF 端口自动发现、主动消息、PWA、已知边界 —— 见 [`docs/开发说明.md`](docs/开发说明.md)。

## 隐私与安全

- **Key 不进前端**：API Key 只存在本机 `settings.json`，由本地 BFF 注入请求，网页侧永远拿不到；
- **不做云端**：没有账号、没有遥测、没有中转服务器，消息直接打到你的 AstrBot；
- **局域网有门**：打开「允许局域网访问」后，非本机请求必须带令牌，令牌换 cookie 后从地址栏消失；
- **HTTPS 自签**：证书只在本机生成，私钥不出本机。

## 已知限制

1. Windows 安装包没有代码签名 → SmartScreen 会提示；
2. 自动更新尚未启用 → 新版本需手动装（升级保留设置与 Key）；
3. 客户端**不带 AstrBot**，需要你先把 AstrBot 跑起来；
4. 历史读的是**本机** `data_v4.db`：AstrBot 在 Docker / 另一台机器时，需装 `astrbot_plugin_webchat_admin`
   插件，或把库目录挂给客户端；
5. macOS 暂不支持；iOS 只交付工程与构建脚本。

## 许可

本项目以 **MIT** 许可发布，见 [`LICENSE`](LICENSE)。第三方组件与素材的归属见 [`NOTICE.md`](NOTICE.md)。

问题反馈请照 [`docs/反馈模板.md`](docs/反馈模板.md) 填写，**不要贴 API Key**（`abk_...`）。
