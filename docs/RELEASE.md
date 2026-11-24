# AstrBot Chat 0.2.26 · 发布包

> 构建时间：2026-11-24
> 源码版本：`package.json` / `src-tauri/tauri.conf.json` / `Cargo.toml` / Android `versionName` 均为 **0.2.26**
> Android `versionCode` = 26，iOS `CURRENT_PROJECT_VERSION` = 26

本轮变化（0.2.25 → 0.2.26）：手机端强调色生效修复、Service Worker 缓存升 v2、表情包缩小到 1/4。

## 1. 产物

| 平台 | 文件 | 大小 | 状态 |
|---|---|---|---|
| Android | `AstrBot-Chat-0.2.26-universal.apk` | 3.35 MB | ✅ 签名 release，全架构通装 |
| Windows | `AstrBot-Chat_0.2.26_x64-setup.exe` | 26.22 MB | ✅ NSIS 安装包（x64） |
| Linux | `AstrBot-Chat_0.2.26_amd64.deb` | 51.12 MB | ✅ Ubuntu 24.04 / Debian 12（amd64） |

iOS 这一版**不提供预打包 zip**：仓库里已有可直接编译的 Xcode 工程（`ios/`），
在 macOS 上 `pnpm install && bash scripts/build-ios.sh`，或用 `.github/workflows/ios.yml`
（macos-15 runner）从 Artifacts 取 ipa。

校验：

```bash
sha256sum -c SHA256SUMS.txt
```

## 2. 安装

### Windows

```powershell
# 双击，或静默装
.\"AstrBot-Chat_0.2.26_x64-setup.exe" /S
```

- 装到 `%LOCALAPPDATA%\AstrBot Chat\`，当前用户安装、无需管理员；
- 覆盖安装会保留 `settings.json` 与会话缓存；
- 安装包**没有代码签名**，SmartScreen 提示时点「更多信息 → 仍要运行」。

### Linux（Ubuntu 24.04 / Debian 12+，amd64）

```bash
sudo apt install "./AstrBot-Chat_0.2.26_amd64.deb"
astrbot-chat
```

- 依赖 `libwebkit2gtk-4.1-0`、`libgtk-3-0`、`libayatana-appindicator3-1`（deb 里已声明）；
- **自带 Node 24**（`/usr/lib/AstrBot Chat/sidecar/node`），不用另外装 Node；
- 卸载：`sudo apt remove astr-bot-chat`。

### Android

```bash
adb install -r AstrBot-Chat-0.2.26-universal.apk
# 或把 apk 传到手机点开安装
```

- 已用固定 keystore 签名（`CN=AstrBot Chat`），可以覆盖之前的 release 包；
- 如果手机上装的是 **debug 包**，签名不同，要先 `adb uninstall com.astrbot.chat`，
  卸载会清掉 App 里的连接配置，装完重新填一次 `https://<电脑IP>:8789/?t=<令牌>`。

### iOS（需要 macOS / Xcode）

Windows 上**没有** `xcodebuild` / iOS SDK / `codesign`，无法直出可安装的 ipa —— 这是平台限制。
仓库里的 `ios/` 是可以直接编译的 Xcode 工程（SPM）：

1. 在 Mac 上 `pnpm install && pnpm ios:sync && bash scripts/build-ios.sh` → `AstrBot-Chat_0.2.26_unsigned.ipa`；
2. 没有 Mac：推到 GitHub 跑 `.github/workflows/ios.yml`（macos-15 runner），从 Artifacts 取 ipa；
3. 未签名 ipa 用 [Sideloadly](https://sideloadly.io/) 自签安装（免费 Apple ID 7 天有效）。

详细步骤、权限说明、验收清单见 `docs/TESTER-GUIDE-IOS.md`。

## 3. 本次构建做过的验证

| 项 | 结果 |
|---|---|
| `tsc --noEmit` + `vite build` | ✅ 0 错，产物 `dist/`（主包 331.70 kB / gzip 105.22 kB） |
| 单元测试（`web-assets` / `proxy-token`） | ✅ 9/9 |
| 版本号一致性 | ✅ package.json / tauri.conf.json / Cargo.toml / Android 全部 0.2.26 |
| APK | ✅ `aapt badging`：`versionCode 26 / versionName 0.2.26 / com.astrbot.chat`；`apksigner verify` 通过（`CN=AstrBot Chat`） |
| Windows exe | ✅ NSIS 打包成功，x64，内含 `sidecar/bff.mjs` 与便携 `node.exe` |
| Linux deb | ✅ 内含 Linux `sidecar/node` 与 `/usr/bin/astrbot-chat`，WSL 构建通过 |
| iOS 编译 | ❌ 无 macOS，未跑 `xcodebuild` |

## 4. 备注

- iOS 工程里 `ios/App/CapApp-SPM/Package.swift` 的本地依赖指向 `node_modules/.pnpm/...`，
  换机器后先 `pnpm install` + `cap sync ios`（脚本已自动处理）；
- iOS 连局域网自签 CA 时，必须在「设置 → 通用 → 关于本机 → 证书信任设置」里把
  `AstrBot Chat Local CA` **完全信任**，否则白屏；
- Windows / Linux 的自动更新源仍未配置，这一版和之前一样是手动覆盖安装。
