# AstrBot Chat 0.2.26 · iOS 构建与安装说明

> 版本：**0.2.26**（2026-11-23）
> Bundle ID：`com.astrbot.chat`
> 最低系统：**iOS 15.0**
> 技术栈：Capacitor 8.6（SPM 依赖，无 CocoaPods）+ React 前端（和桌面 / Android 同一份 `dist`）

## 0. 先说清楚：iOS 包为什么不是现成的

iOS 的 `.ipa` 里有**用 Xcode + iOS SDK 编译出来的 arm64 二进制**，还要 Apple 的签名 /
Provisioning Profile。Windows 和 Linux 上没有 `xcodebuild`、`codesign`、iOS SDK，
**任何工具都无法在 Windows 上直出可安装的 iOS 包**（这不是配置问题）。

所以这一版交付的是「**能直接出包的 Xcode 工程 + 一键脚本 + CI 配置**」：

| 交付物 | 位置 | 用途 |
|---|---|---|
| Xcode 工程（已同步 0.2.26 前端） | `ios/` | 在 Mac 上打开即可编译 |
| 一键打包脚本 | `scripts/build-ios.sh` | Mac 上一条命令出 ipa |
| GitHub Actions | `.github/workflows/ios.yml` | 没有 Mac 时用 GitHub 的 macOS runner 出包 |
| 图标 / 启动图生成 | `scripts/ios-icons.py` | 换图标时重跑 |

## 1. 出包（三选一）

### 1.1 有 Mac（推荐）

```bash
# 前置：Xcode 15+（App Store 装），Node 24+，pnpm
sudo xcode-select -s /Applications/Xcode.app

# 在工程根目录
bash scripts/build-ios.sh
# → build/ios/AstrBot-Chat_0.2.26_unsigned.ipa
```

有 Apple 开发者账号（付费或免费都行，签名能力不同）：

```bash
TEAM_ID=ABCDE12345 bash scripts/build-ios.sh          # development 签名
TEAM_ID=ABCDE12345 EXPORT_METHOD=ad-hoc bash scripts/build-ios.sh
```

> 免费 Apple ID 也能在 Xcode 里选个人 Team 做 development 签名（7 天有效）。

### 1.2 没有 Mac：GitHub Actions

1. 把工程推到 GitHub（任意仓库）；
2. 仓库 → **Actions** → 左侧 **iOS IPA** → **Run workflow**；
3. 需要签名的填 Team ID，不填就出未签名 ipa；
4. 跑完在本次 run 的 **Artifacts** 里下载 `AstrBot-Chat-ios-ipa`。

runner 是 `macos-15`，自带 Xcode；不需要本地任何 iOS 工具链。
（注意：签名要在仓库 Secrets 里配好证书 / App Store Connect API Key，本 workflow 只做了
未签名路径和「传入 Team ID 自动签名」的骨架。）

### 1.3 Xcode 图形界面

```bash
pnpm install && pnpm build
node node_modules/@capacitor/cli/bin/capacitor sync ios
open ios/App/App.xcodeproj
```

在 Xcode 里选 `App` scheme → Signing & Capabilities 选自己的 Team →
选真机 → Run（或 Product → Archive → Distribute）。

## 2. 安装未签名 ipa

未签名 ipa **双击装不上**，要用自签工具把它用你自己的 Apple ID 重签：

1. 电脑装 [Sideloadly](https://sideloadly.io/)（Windows / macOS 都有）；
2. 手机用数据线连电脑，Sideloadly 里选 `AstrBot-Chat_0.2.26_unsigned.ipa`；
3. Apple ID 填自己的（会走 Apple 的匿名开发者签名），Start；
4. 手机上「设置 → 通用 → VPN与设备管理 → 开发者 App」里**信任**自己的证书；
5. 免费 Apple ID 的签名 **7 天到期**，到期用同样步骤重签（App 内数据不丢）。

> AltStore / SideStore 也能做同样的事，适合长期自签（需要一台常开的电脑做 AltServer）。

## 3. 第一次连接

1. Windows / Linux 那边的 AstrBot Chat 桌面端：**设置 → 桌面 → 手机访问**，打开「允许局域网访问」；
2. 手机和电脑在同一个 Wi-Fi / Tailscale 网络；
3. **先装证书**：Safari 打开桌面端给的 `http://<电脑IP>:8788/ca.cer` → 允许下载描述文件 →
   「设置 → 已下载描述文件 → 安装」→ 然后 **设置 → 通用 → 关于本机 → 证书信任设置**，
   把 `AstrBot Chat Local CA` 打开（**这一步不做，App 里会一直白屏 / 连不上**）；
4. 回 App，输入桌面端二维码对应的地址：`https://<电脑IP>:8789/?t=<令牌>`；
5. 首次会弹「App 想要查找并连接本地网络上的设备」→ **允许**。

## 4. 和 Android / 桌面版的差异

| 项 | iOS | 说明 |
|---|---|---|
| 语音录制 | ✅ | 已声明 `NSMicrophoneUsageDescription` |
| 拍照 / 相册 | ✅ | 已声明相机、相册权限文案 |
| 本地网络 | ✅ | 已声明 `NSLocalNetworkUsageDescription`（iOS 14+ 必需） |
| 局域网自签 CA | ⚠️ 需手动「完全信任」 | 见 §3 第 3 步，系统限制 |
| 主动消息通知 | ⚠️ 仅前台 | App 在前台时轮询；切后台/杀进程收不到（没有 APNs 通道） |
| 自动更新 | ❌ | 和桌面版一样没有更新源；iOS 侧只能重签覆盖装 |
| 主题 / 表情包 / 记忆抽屉 | ✅ | 前端与桌面同源 |

## 5. 验收清单（拿到 ipa 后逐条点）

1. 装完能启动，首屏是深色品牌页，不是白屏；
2. 填 `https://<IP>:8789/?t=…` 能连上，会话列表有数据；
3. 发一条消息，流式回复正常，能点「停止」；
4. 发图片（相册 + 拍照各一次）、录一条语音并播放；
5. 左缘滑动出抽屉；聊天页 `⋯` 菜单能开「聊天设置」；
6. 切到别的 App 再回来，会话还在、能继续发；
7. 换浅色主题 / 换强调色，气泡颜色跟着变。

出问题请带上：iOS 版本、`设置 → 通用 → 关于本机` 的机型、App 内「设置 → 桌面 → 排障」导出的诊断包。

## 6. 已知坑

1. **`cap sync ios` 在 Windows 上能跑**（只复制 web 资源、生成 `Package.swift`），
   `pod install` 那一步会跳过/报错，属正常 —— 真正编译必须在 Mac 上做。
2. **SPM 依赖路径是本地的**：`ios/App/CapApp-SPM/Package.swift` 里
   `CapacitorApp` 指向 `node_modules/.pnpm/...`。换机器后先 `pnpm install`，再
   `cap sync ios` 重新生成这个文件（脚本里已经自动做了）。
3. **`xcodebuild` 报 "requires a development team"**：没传 `TEAM_ID` 时必须走
   `CODE_SIGNING_ALLOWED=NO`（脚本默认就是这样）；要真机直装则必须有 Team。
4. **App Store 上传**：`ITSAppUsesNonExemptEncryption=false` 已写进 Info.plist，
   不会卡出口合规问卷；但「本地网络 + 自签证书」这种形态不适合上架，内测自签即可。
