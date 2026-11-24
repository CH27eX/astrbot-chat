# AstrBot Chat 0.2.24 · Linux 内测须知（.deb）

> 版本：**0.2.24**（2026-11-20 构建）
> 包名：`AstrBot Chat_0.2.24_amd64.deb`（51.35 MB）
> SHA256：`FDE7E2041EDA66EE4795C3F26AAC95301B861FEB4EABC7CC9E8E281148AFFAA9`
> 实测环境：Ubuntu 24.04.5 LTS（WSL2），amd64

本版相对 0.2.23 是**界面改动（手机端 QQ 风格收尾）+ 签名 Android APK**，桌面 / Linux 的用法不变：

- 聊天页头部改成「返回 + 标题/在线 + ⋯」：记忆、聊天设置、换头像都收进 `⋯`；
- 设置改成手机端的全屏分组页（手机上打开设置不再是桌面弹层）；
- 手机端左缘抽屉宽度改成屏宽 84%（最多 320px），拖动跟手、遮罩淡入；
- Android 系统返回键：先关浮层 → 回会话列表 → 再退出（不再一按就退）；
- 另外发了签名 release APK（`AstrBot-Chat-0.2.24-universal.apk`，3.3 MB，各架构通装），在手机上装它就行。

0.2.23 的变化（从 0.2.22 及更早升上来的用户看这里）：

- **为手机套壳（Android APK）放行跨域访问**：BFF 现在接受 `x-astrbot-token` 请求头、
  CORS 预检在令牌校验之前处理、`https://localhost` 进白名单；图片/语音这类带不了自定义头的资源
  改用 `?t=` 令牌直取（不再 302 跳转）。PWA 与桌面端的用法完全不变。

0.2.22 的变化（从 0.2.21 及更早升上来的用户看这里）：

- **加了延时打点**：一次发送现在会记录「点发送 → 收到首包 → 上屏」三个时间点，存在
  `window.__astrbotPerf` 里（只在开发者用 CDP 看，正常使用无感）。实测客户端渲染只占
  24ms（桌面）/ 98ms（手机），手机和桌面之间的延时差异不在客户端。

0.2.21 的变化（从 0.2.20 及更早升上来的用户看这里）：

- **前端分包，手机首屏进 1 秒**：Markdown 渲染器（react-markdown + remark-gfm）和设置 / 首次运行弹层都改成按需加载，
  首屏只下载「壳 + 会话列表」。主 bundle 529 KB → 316 KB（gzip 165 → 101 KB），
  手机「打开 → 能看到会话」从 1.8–2.0s 降到 **0.88–1.09s**，桌面 ~0.9s。
  聊天页的 Markdown 会晚一步到，期间先显示纯文本，不会白屏。

0.2.20 的变化（从 0.2.19 及更早升上来的用户看这里）：

- **会话列表先渲染**：上次成功拉到的列表会存在本机（`astrbot-chat.sessions-cache`，按用户名分、7 天过期），
  打开应用先用它把侧栏画出来，网络结果一到就替换。桌面「首屏能看到会话」从 ~2.5s 降到 **~0.8s**；
  手机从 ~2s 降到 1.8–2.0s（手机现在主要花在前端资源加载上）。

0.2.19 的变化（从 0.2.18 及更早升上来的用户看这里）：

- **冷启动不再「扫端口」**：BFF 以前每次冷启动都要用 PowerShell 列本机 50 个监听端口、再逐个探 AstrBot
  （实测 ~4s，首屏会话要 ~6s）。现在把上次连上的地址记在
  `%APPDATA%\com.astrbot.chat\bff-last-base.json`（Linux 是 `~/.config/com.astrbot.chat/`），
  下次先 600ms 快探，命中就直接用 —— 首屏会话降到 ~2s。AstrBot 换了端口/没启动时会自动回到全量扫描。

0.2.18 的变化（从 0.2.17 及更早升上来的用户看这里）：

- **语音气泡能播了**：以前 `.msg-audio` 写的是 `width: min(260px, 100%)`，在「宽度由内容决定」的气泡里
  百分比没有参照、循环成 **0**，发出的语音消息变成一个空蓝块、点不了；现在固定 `260px` + `max-width:100%`。
  桌面端不明显（多数气泡有文字撑着），**手机上是必现的**，所以 0.2.18 主要是给手机用的。

0.2.17 的变化（从 0.2.16 及更早升上来的用户看这里）：

- **deb 里自带 Linux 版 Node 24**（`/usr/lib/AstrBot Chat/sidecar/node`），**不用再自己装系统 Node**。
  以前 deb 里塞的是 Windows 的 `node.exe`，Linux 上靠系统 Node 20+，没装就「窗口能开、BFF 起不来」；
  现在删掉系统 Node 也能正常连 AstrBot。包因此从 41.7 MB 变成 51.1 MB。

0.2.16 的变化（从 0.2.15 及更早升上来的用户看这里）：

- **http（非 https）打开时顶部加一条提示**：明说「非安全：录音、安装到桌面都用不了，要用 https」，
  点「知道了」按**访问源**记住；https 下不显示。

0.2.15 的变化（首次从 0.2.13 及更早升上来的用户看这里）：

- **手机首次连接两步引导**：设置 → 桌面 → 手机访问 拆成「① 先装证书（单独二维码）→ ② 扫码配对」，安卓 / iOS 步骤就写在旁边，不用再翻文档；
- **冷启动骨架**：打开时先看到深色品牌页 + 进度条（不再先闪一帧白屏），12 秒还没加载出来会提示「确认 BFF 在运行」；
- **二进制改名**：`/usr/bin/app` → **`/usr/bin/astrbot-chat`**（`.desktop` 的 `Exec` / `Icon` / `StartupWMClass` 一起改了；覆盖安装会替掉旧版）；
- **安装目录旧资源清理**：BFF 启动时清掉上一版残留的 `index-<hash>.js|css`（装机目录实测 43 → 17 个文件）；
- **设置导入 / 导出**（通用页 → 备份与迁移）：不含 API Key，换电脑 / 换访问源时用；
- **一键诊断包**（桌面页 → 排障）：日志 + 环境信息压成 zip，Key 与局域网令牌已打码；
- **Linux「自动拉起 AstrBot」终于生效**：按 `ASTRBOT_LAUNCHER` → `~/.astrbot_launcher/` → `PATH` 里的 `astrbot-launcher` → 桌面入口 找启动器（以前因为没有 `LOCALAPPDATA` 直接 return，开关是摆设）。

> 更早的变化（配对二维码 / 手机布局 / 流式 / 滚动修复 / UI 自定义）见上一版须知。


---

## 1. 适用系统

- **Ubuntu 24.04 / Debian 12 或更新**（要 WebKitGTK 4.1）
- Ubuntu 22.04 **不行**：只有 `libwebkit2gtk-4.0`，依赖装不上
- 架构：amd64（x86_64）
- **不需要另外装 Node**：deb 自带 Node 24（`/usr/lib/AstrBot Chat/sidecar/node`），BFF 就是用它起的。
  想自己核对：`dpkg -L astr-bot-chat | grep sidecar/node`。

依赖（deb 里已声明，装的时候会一起检查）：

```
libayatana-appindicator3-1  libwebkit2gtk-4.1-0  libgtk-3-0
```

---

## 2. 安装

```bash
# 推荐：让 apt 顺手把依赖补齐
sudo apt install "./AstrBot Chat_0.2.22_amd64.deb"

# 或者
sudo dpkg -i "AstrBot Chat_0.2.22_amd64.deb"
sudo apt -f install          # 缺依赖时补
```

- 装到 `/usr/bin/astrbot-chat`，桌面入口在 `/usr/share/applications/AstrBot Chat.desktop`
- 包名是 `astr-bot-chat`（卸载用 `sudo apt remove astr-bot-chat`）
- 没有代码签名（Linux 上一般也不需要），装之前可以先 `sha256sum` 对一下

---

## 3. 第一次启动

```bash
astrbot-chat   # 或者从应用菜单点「AstrBot Chat」
```

第一次打开要填 **AstrBot 的 API Key**（面板 → API Keys，勾 `chat` + `file`，记忆抽屉再加 `plugin`）。

### AstrBot 地址：默认自动发现，不用填

BFF 会读 `/proc/net/tcp` 扫本机监听端口，逐个探「你是不是 AstrBot」，扫到就自动连上
（AstrBot 换端口也不影响）。

只有这两种情况要手填：

```
http://192.168.x.x:6185        # AstrBot 在另一台机器 / 虚拟机里
```

或者 AstrBot 在容器里、端口没映射出来时，填它的地址。

### 历史消息（`data_v4.db`）：也默认自动找

顺序是：设置里填的「AstrBot 数据目录」→ 从运行中的 AstrBot 实例推（Linux 读
`/proc/<pid>/cwd` 和 `cmdline`；读不到时按 `cmd_config.json` 里的 `dashboard.port` 对齐）→
常见布局（`~/astrbot/data`、`~/.local/share/astrbot/data`、`/opt/astrbot/data`）。

**读不到历史时先看这个诊断地址**：

```
http://127.0.0.1:8788/astrbot/api/db-status
```

- `"ok": true` → 看 `path`（实际用的库）和 `source`：
  `pid`（从进程 cwd/命令行推的）/ `port`（按端口对上的）/ `linux-layout`（按装法猜的）/ `settings`（你填的）；
- `"ok": false` → `reason` 会说清是哪个路径不对，`candidates` 是试过的全部路径。

### Memory Companion 的 ⭐（可选）

MC 2.6.6 的写接口原本**只认面板管理员会话**，只有 API Key 的客户端点 ⭐ 会被拒
（`admin_required`）。如果让客户端也能点：

1. 在 MC 插件目录打下补丁 `mc-api-key-write.patch`（默认关闭、只放行改 ⭐）；
2. 面板 → 插件 → Memory Companion → 配置 → 打开「允许 API Key 写 ⭐」（`api_key_write.enable`）；
3. 重启 AstrBot。

客户端会自动读 `/ui/capabilities`，开关打开后不再提示「需要管理员」。
⚠️ MC 插件升级会覆盖补丁，升级后要重新打。

**设置文件**：`~/.local/share/com.astrbot.chat/settings.json`
**日志**：`~/.local/share/com.astrbot.chat/logs/`（`bff.out.log` / `bff.err.log` / 应用日志）

### 手机 / 平板（可选）

1. 设置 → 桌面 → 手机访问 → 打开「允许局域网访问」；
2. 手机同 Wi-Fi，先打开 `http://<电脑IP>:8788/ca.cer` 装一次 CA（安卓：设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书；iOS 再开「完全信任」）；
3. 回设置页**扫二维码**（内容就是 `https://<电脑IP>:8789/?t=…`）；
4. 手机丢了 / 二维码外泄 → 点「重置配对」，所有手机重新扫。

> 换了 Wi-Fi / IP 变了，https 会提示证书不对：让发你包的人重跑一次证书脚本（CA 不用重装），再把局域网开关关掉重开。

---

## 4. 可选插件：解锁「删除会话 / 改服务端名 / 读远端历史」

只填 API Key 时，这三件事一定用不了（不是 bug）：

- 删除会话 → 服务端 `Permission denied`
- 改会话名 → 只能改本地备注
- AstrBot 在另一台机器/容器 → 客户端读不到本地 SQLite，历史是空的

原因：AstrBot 会话接口在服务端硬比较 `session.creator == username`，
而 API Key 的身份是 `api_key:<id>`。

包里带了一个小插件 **`astrbot_plugin_webchat_admin` 0.1.1**（MIT）绕开这个限制：

1. AstrBot 面板 → 插件 → 上传 `plugins/astrbot_plugin_webchat_admin-0.1.1.zip`
2. 装完自动加载；客户端重开一次就会显示「会话管理增强：已启用」
3. 要求 **AstrBot ≥ 4.26**；Key 仍需带 `plugin` scope

它只操作 `platform_id == webchat` 的会话，不会碰 QQ 会话。

---

## 5. 已验证 / 未验证

| 项 | 状态 |
|---|---|
| `.deb` 安装 / 卸载 | ✅ Ubuntu 24.04 实测（0.2.13 → … → 0.2.22 → 0.2.23 逐版覆盖装，二进制改名后仍能覆盖） |
| 启动、窗口创建（1100×820） | ✅ `xwininfo` 能看到 `AstrBot Chat` 窗口 |
| BFF 托管 | ✅ 本机实测（BFF 在 `127.0.0.1:8788` 正常）；**0.2.17 起用的是包里自带的 node**：把 PATH 里的 node 拿掉后启动，`/proc/<bff>/exe` 指向 `/usr/lib/AstrBot Chat/sidecar/node`，首页 200 |
| 便携 node | ✅ 0.2.17 deb 自带 Node 24（120.7 MB，映射到 `sidecar/node`）；Windows 侧同一条通配映射打的是 `node.exe` |
| 端口自动发现（Linux） | ✅ 读 `/proc/net/tcp`；脚本化验证 18/18 |
| 历史库自动发现（Linux） | ✅ `/proc` 进程推 + `~/astrbot` / `$XDG_DATA_HOME` / `/opt` 布局；18/18 |
| 连 AstrBot 取会话 | ✅ 实测拿到真实会话；代理层未改 |
| 手机端 HTTPS / 扫码 | ✅ 与 Windows 同一份前端；`https.mjs` / `pairing.mjs` 回归通过 |
| Memory Companion 写 ⭐ | ✅ 补丁 + 开关打开后，API Key 能通过授权（负例仍 403） |
| 记忆抽屉四家 adapter | ✅ 与 Windows 版同一份前端；网络链路已验证，**UI 未逐家点选** |
| 托盘图标 | ⚠️ 需要桌面有 DBus/AppIndicator；WSLg 下只有 dbus 警告，图标不显示属正常 |
| 窗口截图 | ❌ WSLg 下 X11 抓不到 WebKit 内容，没做视觉回归 |
| 自动更新 | ❌ 未启用（和 Windows 版一样没有更新源） |

---

## 6. 已知限制

1. **Memory Companion 点 ⭐**：默认仍要面板管理员；要么打补丁+开开关（见 §3），要么用面板操作。
2. **Angel Memory** 需要 `am-pinned.patch` 才有 ⭐ 入口；且只保衰减、不保合并。
3. **Memory Beyond** 要打 `mb-priority.patch` 才有「整理时保留」。
4. **身份桥** 下 WebChat 会话没有独立记忆作用域，记忆抽屉「当前会话」可能是空的。
5. **托盘**：GNOME 需要 AppIndicator 扩展才能看到托盘图标。
6. **二进制名**：0.2.14 起是 `/usr/bin/astrbot-chat`（0.2.13 及更早是 `/usr/bin/app`）。
7. ~~要系统 Node 20+~~ **0.2.17 起不需要了**：deb 自带 Node 24。

---

## 7. 出问题给我什么

```bash
sha256sum "AstrBot Chat_0.2.22_amd64.deb"
lsb_release -a
dpkg -l | grep -E 'webkit2gtk|libgtk-3|appindicator'
cat ~/.local/share/com.astrbot.chat/logs/bff.err.log
curl -s http://127.0.0.1:8788/astrbot/api/db-status   # 历史库诊断
```

注意：**别把 API Key 贴出来**（在 `settings.json` 里，形如 `abk_...`）。

---

## 8. 回退 / 卸载

```bash
sudo apt remove astr-bot-chat          # 卸载程序
rm -rf ~/.local/share/com.astrbot.chat # 想连配置一起删再执行
```
