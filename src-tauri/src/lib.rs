// AstrBot Chat —— Tauri 壳
//
// 这里负责桌面端才需要的原生能力：
//   * 无边框窗口：拖拽区由前端 `data-tauri-drag-region` 触发，缩放由前端手柄调用
//     `startResizeDragging`，都是 Tauri 内置行为，后端不用额外代码。
//   * 关闭询问 / 最小化到托盘 / 直接退出：拦截 CloseRequested，按 settings.json 里的
//     `closeBehavior` 决定；"ask" 时把决定权交给前端弹窗（事件 `astrbot://close-requested`）。
//   * 托盘：显示主界面 / 隐藏到托盘 / 退出。
//   * 单实例：第二次启动只把已有窗口抬到前台。
//   * 开机自启：tauri-plugin-autostart，设置页的开关直接调到这个插件。
//   * 记住窗口位置和大小：tauri-plugin-window-state。
//   * 系统通知：tauri-plugin-notification（前端 src/desktop/notify.ts 调用）。
//   * 自动更新：tauri-plugin-updater。更新源（latest.json 地址）存在 settings.json 里，
//     不写死在编译产物里；没填就等于关闭。见下面的 `check_update` / `install_update`。
//   * BFF sidecar：见 bff.rs，应用自己用便携 Node 起 BFF。

mod bff;
mod diagnostics;

use std::{
    collections::hash_map::RandomState,
    hash::{BuildHasher, Hasher},
    net::UdpSocket,
    sync::Arc,
};

use tauri::{
  menu::{Menu, MenuItem, PredefinedMenuItem},
  tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
  AppHandle, Emitter, Manager, Runtime, WindowEvent,
};
use tauri_plugin_store::StoreExt;
use tauri_plugin_updater::UpdaterExt;

use bff::BffManager;

/// 设置文件（`%APPDATA%\com.astrbot.chat\settings.json`）。
/// 前端通过下面的 `read/write_desktop_settings` 命令读写，不直接用 JS 的 store 插件，
/// 保证后端读到的和用户看到的是同一份。
const SETTINGS_FILE: &str = "settings.json";
/// 关闭行为：`ask`（每次询问）/ `tray`（最小化到托盘）/ `exit`（直接退出）
const CLOSE_BEHAVIOR_KEY: &str = "closeBehavior";
const AUTO_LAUNCH_ASTRBOT_KEY: &str = "autoLaunchAstrBot";
/// AstrBot 的 API Key，P2 起由应用自己存（用户要求存 JSON，方便迁移）
const API_KEY_STORE_KEY: &str = "astrbotApiKey";
/// 首次启动引导是否已经完成/跳过
const FIRST_RUN_DONE_KEY: &str = "firstRunDone";
/// 「缩到托盘后怎么唤回窗口」这条提示是否已经弹过（Win11 溢出区点不出来，见 hide_to_tray）
const TRAY_HINT_KEY: &str = "trayHintShown";
const TRAY_ID: &str = "astrbot-chat-tray";
/// 需要前端弹「关闭询问」时发给 WebView 的事件名
const CLOSE_REQUESTED_EVENT: &str = "astrbot://close-requested";
/// 更新源：指向一个 `latest.json` 的地址。**空字符串 = 关闭自动更新**。
/// 故意不写进 tauri.conf.json —— 用户以后把 AstrBot 搬到云上时，改设置就行，不用重新打包。
const UPDATE_ENDPOINT_KEY: &str = "updateEndpoint";
/// 启动时自动检查一次更新（默认开；更新源为空时什么也不做）
const UPDATE_CHECK_ON_START_KEY: &str = "updateCheckOnStart";
/// 允许手机 / 局域网访问（默认关；开了以后 BFF 绑 0.0.0.0 并要求令牌）
const LAN_ACCESS_KEY: &str = "lanAccess";
/// 局域网访问令牌（32 位十六进制，存在 settings.json；手机上用 `?t=` 交换 cookie）
const LAN_TOKEN_KEY: &str = "lanToken";
/// 远程访问基址（Tailscale Serve / 反向代理，形如 `https://host.tailnet.ts.net:8443`）。
/// 非空时「手机访问」的二维码 / 复制链接都拿它拼，不再用局域网 IP。
/// 空 = 只用局域网地址（老行为）。
const LAN_REMOTE_BASE_KEY: &str = "lanRemoteBase";
/// AstrBot 地址（空 = 让 BFF 自动发现本机实例；填了就连这个地址，远端/云主机用）
const ASTRBOT_URL_KEY: &str = "astrbotUrl";
/// AstrBot 数据目录（`data_v4.db` 所在处；空 = BFF 自己按平台猜。远端/容器/非标准安装时填）
const ASTRBOT_DATA_DIR_KEY: &str = "astrbotDataDir";

fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::WebviewWindow<R>> {
  app.get_webview_window("main")
}

fn show_main<R: Runtime>(app: &AppHandle<R>) {
  if let Some(window) = main_window(app) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
  }
}

fn hide_main<R: Runtime>(app: &AppHandle<R>) {
  if let Some(window) = main_window(app) {
    let _ = window.hide();
  }
}

/// 缩到托盘，并在第一次缩的时候提示一句「怎么把窗口叫回来」。
///
/// 为什么需要这句：Win11 把托盘图标折进「^」溢出区时，点图标收不到事件
/// （原因见 `build_tray` 里的注释），用户会以为程序被关掉了。
/// 提示只出一次（`trayHintShown` 记账），之后不再打扰。
fn hide_to_tray<R: Runtime>(app: &AppHandle<R>) {
  hide_main(app);

  let Ok(store) = app.store(SETTINGS_FILE) else {
    return;
  };
  if store
    .get(TRAY_HINT_KEY)
    .and_then(|value| value.as_bool())
    .unwrap_or(false)
  {
    return;
  }

  use tauri_plugin_notification::NotificationExt;
  if app
    .notification()
    .builder()
    .title("AstrBot Chat 还在后台运行")
    .body("托盘图标折进「^」里点不开时，再启动一次应用就能把窗口唤回来。")
    .show()
    .is_ok()
  {
    store.set(TRAY_HINT_KEY, true);
    let _ = store.save();
  }
}

fn close_behavior<R: Runtime>(app: &AppHandle<R>) -> String {
  app
    .store(SETTINGS_FILE)
    .ok()
    .and_then(|store| store.get(CLOSE_BEHAVIOR_KEY))
    .and_then(|value| value.as_str().map(ToOwned::to_owned))
    .unwrap_or_else(|| "ask".to_string())
}

/// 首次启动补齐默认值，前端/托盘读到的东西始终是完整的。
fn ensure_defaults<R: Runtime>(app: &AppHandle<R>) {
  let Ok(store) = app.store(SETTINGS_FILE) else {
    return;
  };
  let mut dirty = false;
  if store.get(CLOSE_BEHAVIOR_KEY).is_none() {
    store.set(CLOSE_BEHAVIOR_KEY, "ask");
    dirty = true;
  }
  if store.get(AUTO_LAUNCH_ASTRBOT_KEY).is_none() {
    store.set(AUTO_LAUNCH_ASTRBOT_KEY, true);
    dirty = true;
  }
  if store.get(FIRST_RUN_DONE_KEY).is_none() {
    store.set(FIRST_RUN_DONE_KEY, false);
    dirty = true;
  }
  if store.get(UPDATE_ENDPOINT_KEY).is_none() {
    store.set(UPDATE_ENDPOINT_KEY, "");
    dirty = true;
  }
  if store.get(UPDATE_CHECK_ON_START_KEY).is_none() {
    store.set(UPDATE_CHECK_ON_START_KEY, true);
    dirty = true;
  }
  if store.get(LAN_ACCESS_KEY).is_none() {
    store.set(LAN_ACCESS_KEY, false);
    dirty = true;
  }
  if store.get(ASTRBOT_URL_KEY).is_none() {
    store.set(ASTRBOT_URL_KEY, "");
    dirty = true;
  }
  if dirty {
    let _ = store.save();
  }
}

/// 前端「关闭询问」弹窗选完之后调用。
/// `action` 只会是 `exit` 或 `tray`（取消的话前端什么都不做）。
#[tauri::command]
fn apply_close_action(app: AppHandle, action: String) -> Result<(), String> {
  match action.as_str() {
    "exit" => {
      app.exit(0);
      Ok(())
    }
    "tray" => {
      hide_to_tray(&app);
      Ok(())
    }
    other => Err(format!("未知的关闭动作：{other}")),
  }
}

/// 桌面端设置，和前端共享一份（后端是唯一权威，避免两份状态漂移）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettings {
  close_behavior: String,
  auto_launch_astrbot: bool,
  has_api_key: bool,
  /// `settings`：存在应用自己的设置里；`env`：只有环境变量兜底；`none`：都没有
  api_key_source: String,
  first_run_done: bool,
  /// 更新源地址（`latest.json`）；空 = 没配置，不检查更新
  update_endpoint: String,
  update_check_on_start: bool,
  /// AstrBot 地址（空 = 自动发现本机）
  astrbot_url: String,
  /// AstrBot 数据目录（空 = 让 BFF 按平台猜；远端/容器/非标准安装时填）
  astrbot_data_dir: String,
  /// 当前运行的版本号，设置页直接显示
  app_version: String,
}

#[tauri::command]
fn read_desktop_settings(app: AppHandle) -> DesktopSettings {
  let store = app.store(SETTINGS_FILE).ok();
  let close_behavior = store
    .as_ref()
    .and_then(|store| store.get(CLOSE_BEHAVIOR_KEY))
    .and_then(|value| value.as_str().map(ToOwned::to_owned))
    .unwrap_or_else(|| "ask".to_string());
  let auto_launch_astrbot = store
    .as_ref()
    .and_then(|store| store.get(AUTO_LAUNCH_ASTRBOT_KEY))
    .and_then(|value| value.as_bool())
    .unwrap_or(true);
  let first_run_done = store
    .as_ref()
    .and_then(|store| store.get(FIRST_RUN_DONE_KEY))
    .and_then(|value| value.as_bool())
    .unwrap_or(false);
  let stored_key = store
    .as_ref()
    .and_then(|store| store.get(API_KEY_STORE_KEY))
    .and_then(|value| value.as_str().map(|key| !key.trim().is_empty()))
    .unwrap_or(false);
  let env_key = std::env::var("ASTRBOT_API_KEY")
    .map(|key| !key.trim().is_empty())
    .unwrap_or(false);
  let api_key_source = if stored_key {
    "settings"
  } else if env_key {
    "env"
  } else {
    "none"
  };

  DesktopSettings {
    close_behavior,
    auto_launch_astrbot,
    has_api_key: stored_key,
    api_key_source: api_key_source.to_string(),
    first_run_done,
    update_endpoint: read_update_endpoint(&app),
    update_check_on_start: read_update_check_on_start(&app),
    astrbot_url: read_astrbot_url(&app),
    astrbot_data_dir: read_astrbot_data_dir(&app),
    app_version: app.package_info().version.to_string(),
  }
}

#[tauri::command]
fn write_desktop_settings(
  app: AppHandle,
  close_behavior: Option<String>,
  auto_launch_astrbot: Option<bool>,
  first_run_done: Option<bool>,
  update_endpoint: Option<String>,
  update_check_on_start: Option<bool>,
  astrbot_url: Option<String>,
  astrbot_data_dir: Option<String>,
) -> Result<(), String> {
  let store = app
    .store(SETTINGS_FILE)
    .map_err(|error| error.to_string())?;
  if let Some(behavior) = close_behavior {
    if !matches!(behavior.as_str(), "ask" | "tray" | "exit") {
      return Err(format!("未知的关闭行为：{behavior}"));
    }
    store.set(CLOSE_BEHAVIOR_KEY, behavior.as_str());
  }
  if let Some(auto) = auto_launch_astrbot {
    store.set(AUTO_LAUNCH_ASTRBOT_KEY, auto);
  }
  if let Some(done) = first_run_done {
    store.set(FIRST_RUN_DONE_KEY, done);
  }
  if let Some(endpoint) = update_endpoint {
    let trimmed = endpoint.trim();
    // 空字符串是允许的（= 关闭自动更新）；非空时先校验，别把打错的地址存进去
    if !trimmed.is_empty() {
      parse_update_endpoint(trimmed)?;
    }
    store.set(UPDATE_ENDPOINT_KEY, trimmed);
  }
  if let Some(check) = update_check_on_start {
    store.set(UPDATE_CHECK_ON_START_KEY, check);
  }
  if let Some(url) = astrbot_url {
    let normalized = normalize_astrbot_url(&url)?;
    store.set(ASTRBOT_URL_KEY, normalized);
  }
  if let Some(dir) = astrbot_data_dir {
    // 空字符串是允许的（= 让 BFF 自己猜）；非空只做 trim，不校验存在性
    // （用户可能在另一台机器/容器上填路径，本机打不开很正常）
    store.set(ASTRBOT_DATA_DIR_KEY, dir.trim().to_string());
  }
  store.save().map_err(|error| error.to_string())
}

/// 读 API Key（设置页要能显示/修改）
#[tauri::command]
fn read_api_key(app: AppHandle) -> String {
  app
    .store(SETTINGS_FILE)
    .ok()
    .and_then(|store| store.get(API_KEY_STORE_KEY))
    .and_then(|value| value.as_str().map(ToOwned::to_owned))
    .unwrap_or_default()
}

/// 写 API Key；写完由前端调 `restart_bff` 让它生效
#[tauri::command]
fn write_api_key(app: AppHandle, key: String) -> Result<(), String> {
  let trimmed = key.trim().to_string();
  let store = app
    .store(SETTINGS_FILE)
    .map_err(|error| error.to_string())?;
  if trimmed.is_empty() {
    store.delete(API_KEY_STORE_KEY);
  } else {
    store.set(API_KEY_STORE_KEY, trimmed);
  }
  store.save().map_err(|error| error.to_string())
}

// ---------------- 手机 / 局域网访问 ----------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LanInfo {
  enabled: bool,
  token: String,
  port: u16,
  /// 手机上直接能打开的链接（带令牌）；没开或取不到局域网 IP 时是空串
  url: String,
  lan_ip: String,
  /// 有没有可用的自签证书（有 = BFF 额外监听 https_port，url 也是 https）
  https: bool,
  https_port: u16,
  /// 手机装 CA 用的下载地址（走 http，因为装证书之前 https 还不可信）
  ca_url: String,
  /// 远程访问基址（Tailscale Serve 等）；空 = 只用局域网 IP
  remote_base: String,
  /// `url` 是怎么拼出来的：`remote` / `lan-https` / `lan-http`；空 = 没链接
  url_source: String,
}

/// 局域网自签 HTTPS 的证书目录，由 `scripts/lan-tls.ps1` 生成。
/// 拿到 pfx + 口令才算「有证书」—— 缺一个就退回纯 HTTP，行为跟以前完全一致。
pub fn lan_tls_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
  let dir = app.path().app_data_dir().ok()?.join("tls");
  let pfx = dir.join("lan-server.pfx");
  let pass = dir.join("lan-server.pfx.pass");
  if pfx.is_file() && pass.is_file() {
    Some(dir)
  } else {
    None
  }
}

/// 挑一个能上互联网的网卡地址。UDP connect 只是选路由，不会真的发包。
/// 关掉 Wi-Fi / 只有回环时返回 None。
fn local_ipv4() -> Option<String> {
  let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
  socket.connect("8.8.8.8:80").ok()?;
  let ip = socket.local_addr().ok()?.ip();
  if ip.is_loopback() || ip.is_unspecified() {
    None
  } else {
    Some(ip.to_string())
  }
}

/// 32 位十六进制令牌。用 `RandomState`（OS 随机种子）派生，不引入新依赖。
fn random_token(len: usize) -> String {
  let mut out = String::with_capacity(len + 16);
  let mut counter = 0u64;
  while out.len() < len {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(counter);
    hasher.write_u64(std::process::id() as u64);
    let nanos = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .map(|d| d.as_nanos() as u64)
      .unwrap_or(0);
    hasher.write_u64(nanos);
    out.push_str(&format!("{:016x}", hasher.finish()));
    counter += 1;
  }
  out.truncate(len);
  out
}

fn lan_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
  app
    .store(SETTINGS_FILE)
    .ok()
    .and_then(|store| store.get(LAN_ACCESS_KEY))
    .and_then(|value| value.as_bool())
    .unwrap_or(false)
}

fn stored_lan_token<R: Runtime>(app: &AppHandle<R>) -> String {
  app
    .store(SETTINGS_FILE)
    .ok()
    .and_then(|store| store.get(LAN_TOKEN_KEY))
    .and_then(|value| value.as_str().map(ToOwned::to_owned))
    .unwrap_or_default()
}

/// 没令牌就生成一个并落盘；已有的原样返回（手机不必每次重新扫）
fn ensure_lan_token(app: &AppHandle) -> Result<String, String> {
  let existing = stored_lan_token(app);
  if existing.len() >= 16 {
    return Ok(existing);
  }
  let token = random_token(32);
  let store = app
    .store(SETTINGS_FILE)
    .map_err(|error| error.to_string())?;
  store.set(LAN_TOKEN_KEY, token.as_str());
  store.save().map_err(|error| error.to_string())?;
  Ok(token)
}

/// 远程基址规范化：接受 `host.tailnet.ts.net:8443` / `https://host.tailnet.ts.net:8443/` 这类写法，
/// 统一成 `scheme://host[:port]`；空串 = 清除（返回空串）。
///
/// 只留 origin：路径 / 查询串 / 锚点一律丢掉（拼链接时我们自己接 `/?t=`）。
/// `https://host`（不写端口）是允许的，但手机 APK 会把无端口的 https 补成 :8789，
/// 所以前端会另给一句提示 —— 这里不做拦截，浏览器 / PWA 用 443 是合法的。
fn normalize_remote_base(raw: &str) -> Result<String, String> {
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return Ok(String::new());
  }
  let with_scheme = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
    trimmed.to_string()
  } else if trimmed.contains("://") {
    return Err(format!("远程地址只支持 http / https：{trimmed}"));
  } else {
    format!("https://{trimmed}")
  };
  let url = tauri::Url::parse(&with_scheme).map_err(|error| format!("远程地址不合法：{error}"))?;
  match url.scheme() {
    "http" | "https" => {}
    other => return Err(format!("远程地址只支持 http / https，当前是 {other}")),
  }
  let host = url.host_str().unwrap_or_default();
  if host.is_empty() {
    return Err("远程地址缺主机名（例：https://host.tailnet.ts.net:8443）".to_string());
  }
  // 注意：`https://host:443` 里的 443 会被 URL 规范化吃掉（port() 返回 None），
  // 拼出来就是 `https://host` —— 浏览器没事，APK 会补成 8789。这是已知坑，
  // 所以 B 方案统一用 :8443，别用 443。
  let port = url.port().map(|port| format!(":{port}")).unwrap_or_default();
  Ok(format!("{}://{host}{port}", url.scheme()))
}

fn read_remote_base<R: Runtime>(app: &AppHandle<R>) -> String {
  app
    .store(SETTINGS_FILE)
    .ok()
    .and_then(|store| store.get(LAN_REMOTE_BASE_KEY))
    .and_then(|value| value.as_str().map(ToOwned::to_owned))
    .unwrap_or_default()
}

/// 拼「手机打开的那条链接」。抽成纯函数才好单测（`lan_info_for` 要 AppHandle）。
/// 返回 `(url, url_source)`。
fn build_lan_url(
  enabled: bool,
  token: &str,
  remote_base: &str,
  lan_ip: &str,
  https: bool,
) -> (String, &'static str) {
  if !enabled || token.is_empty() {
    return (String::new(), "");
  }
  // 配了远程基址就一律用它：Tailscale 地址跟局域网 IP 无关，换 Wi-Fi / 拔网线
  // 都不该让二维码失效。
  if !remote_base.trim().is_empty() {
    return (
      format!(
        "{}/?t={token}",
        remote_base.trim().trim_end_matches('/')
      ),
      "remote",
    );
  }
  if lan_ip.is_empty() {
    return (String::new(), "");
  }
  // 局域网：拿得到自签证书就走 HTTPS 8789，这才是安全上下文
  // （PWA / 录音 / crypto.randomUUID 都要它）；没有证书退回 HTTP 8788。
  if https {
    (
      format!("https://{lan_ip}:{}/?t={token}", bff::BFF_HTTPS_PORT),
      "lan-https",
    )
  } else {
    (
      format!("http://{lan_ip}:{}/?t={token}", bff::BFF_PORT),
      "lan-http",
    )
  }
}

fn lan_info_for(app: &AppHandle) -> LanInfo {
  let enabled = lan_enabled(app);
  let token = stored_lan_token(app);
  let lan_ip = local_ipv4().unwrap_or_default();
  let tls = lan_tls_dir(app);
  let https = tls.is_some();
  let https_port = bff::BFF_HTTPS_PORT;
  let ca_url = match (&tls, lan_ip.is_empty()) {
    (Some(dir), false) if dir.join("AstrBotChat-CA.cer").is_file() => {
      format!("http://{lan_ip}:{}/ca.cer", bff::BFF_PORT)
    }
    _ => String::new(),
  };
  let remote_base = read_remote_base(app);
  let (url, url_source) = build_lan_url(enabled, &token, &remote_base, &lan_ip, https);
  LanInfo {
    enabled,
    token,
    port: bff::BFF_PORT,
    url,
    lan_ip,
    https,
    https_port,
    ca_url,
    remote_base,
    url_source: url_source.to_string(),
  }
}

#[tauri::command]
fn lan_info(app: AppHandle) -> LanInfo {
  lan_info_for(&app)
}

/// 保存 / 清除「远程访问地址」（Tailscale Serve 之类）。
///
/// 只改链接怎么拼（二维码 / 复制链接 / `lan_info` 的 url），**不重启 BFF** ——
/// 反代源站那条链路（8790）跟这个值无关。空串 = 清掉，退回局域网地址。
#[tauri::command]
fn set_lan_remote_base(app: AppHandle, base: String) -> Result<LanInfo, String> {
  let normalized = normalize_remote_base(&base)?;
  {
    let store = app
      .store(SETTINGS_FILE)
      .map_err(|error| error.to_string())?;
    if normalized.is_empty() {
      store.delete(LAN_REMOTE_BASE_KEY);
    } else {
      store.set(LAN_REMOTE_BASE_KEY, normalized.as_str());
    }
    store.save().map_err(|error| error.to_string())?;
  }
  Ok(lan_info_for(&app))
}

/// 开关局域网访问：写设置 → 重启 BFF（监听地址和令牌是启动时传进去的）。
#[tauri::command]
async fn set_lan_access(
  app: AppHandle,
  manager: tauri::State<'_, Arc<BffManager>>,
  enabled: bool,
) -> Result<LanInfo, String> {
  if enabled {
    ensure_lan_token(&app)?;
  }
  {
    let store = app
      .store(SETTINGS_FILE)
      .map_err(|error| error.to_string())?;
    store.set(LAN_ACCESS_KEY, enabled);
    store.save().map_err(|error| error.to_string())?;
  }

  let worker = manager.inner().clone();
  let handle = app.clone();
  tauri::async_runtime::spawn_blocking(move || worker.restart(&handle))
    .await
    .map_err(|error| error.to_string())??;

  Ok(lan_info_for(&app))
}

/// 重置配对：换一把新令牌并重启 BFF。
///
/// 令牌是永久有效的（存在 settings.json 的 `lanToken` 里），手机丢了、二维码被
/// 截图转发了都没法收场 —— 所以给一个明确的重置入口。重置后：
/// 老二维码、老链接、手机里已经写进去的 cookie **全部失效**，每台手机都要重扫。
/// 局域网没开时只清令牌（下次开会新生成一把），不白重启一次 BFF。
#[tauri::command]
async fn reset_lan_pairing(
  app: AppHandle,
  manager: tauri::State<'_, Arc<BffManager>>,
) -> Result<LanInfo, String> {
  {
    let store = app
      .store(SETTINGS_FILE)
      .map_err(|error| error.to_string())?;
    store.delete(LAN_TOKEN_KEY);
    store.save().map_err(|error| error.to_string())?;
  }

  if lan_enabled(&app) {
    ensure_lan_token(&app)?;
    // BFF 的令牌是启动时用 env 传进去的，不重启还是认老的
    let worker = manager.inner().clone();
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || worker.restart(&handle))
      .await
      .map_err(|error| error.to_string())??;
  }

  Ok(lan_info_for(&app))
}

#[tauri::command]
fn bff_status(manager: tauri::State<'_, Arc<BffManager>>) -> bff::BffStatus {
  manager.status()
}

/// 一键导出诊断包（日志 + 环境信息 + 打码后的设置），返回文件（或目录）路径。
///
/// 测试者反馈问题时不用再问「你什么系统 / 日志在哪」：点一下得到 zip，
/// 自己决定发不发。打包要在后台线程做（复制日志 + 起 tar 都能慢到卡 UI）。
#[tauri::command]
async fn export_diagnostics(
  app: AppHandle,
  manager: tauri::State<'_, Arc<BffManager>>,
) -> Result<String, String> {
  let status = manager.inner().status();
  let handle = app.clone();
  let path = tauri::async_runtime::spawn_blocking(move || diagnostics::export(&handle, &status))
    .await
    .map_err(|error| error.to_string())??;
  diagnostics::reveal(std::path::Path::new(&path));
  Ok(path)
}

/// 重启 BFF（改完 Key 用）。起进程要等健康检查，别阻塞主线程。
#[tauri::command]
async fn restart_bff(
  app: AppHandle,
  manager: tauri::State<'_, Arc<BffManager>>,
) -> Result<bff::BffStatus, String> {
  let manager = manager.inner().clone();
  let worker = manager.clone();
  let handle = app.clone();
  tauri::async_runtime::spawn_blocking(move || worker.restart(&handle))
    .await
    .map_err(|error| error.to_string())??;
  Ok(manager.status())
}

// ---------------- 自动更新（P4） ----------------
//
// 更新链路：设置页填一个「更新源」地址 → 它是静态服务器上的 latest.json
// （version / pub_date / platforms.windows-x86_64.url + signature）→ 插件下载
// `.nsis.zip` → 用编译进二进制的公钥验签 → 校验通过才调 NSIS 安装包覆盖安装并重启。
//
// 几个刻意的取舍：
//   * 地址存在 settings.json，不写进 tauri.conf.json —— 换更新源不用重新打包；
//   * 没有默认地址：**空 = 关闭**，避免用户没配源时每次启动都去连一个不存在的域名；
//   * 公钥在 tauri.conf.json（可以公开），私钥在仓库外（`~/.astrbot-updater`）。

fn read_update_endpoint(app: &AppHandle) -> String {
  app
    .store(SETTINGS_FILE)
    .ok()
    .and_then(|store| store.get(UPDATE_ENDPOINT_KEY))
    .and_then(|value| value.as_str().map(|text| text.trim().to_string()))
    .unwrap_or_default()
}

fn read_astrbot_url(app: &AppHandle) -> String {
  app
    .store(SETTINGS_FILE)
    .ok()
    .and_then(|store| store.get(ASTRBOT_URL_KEY))
    .and_then(|value| value.as_str().map(|text| text.trim().to_string()))
    .unwrap_or_default()
}

/// AstrBot 数据目录：空 = 不指定，BFF 自己按平台找；非空就原样存（BFF 负责展开判断）。
fn read_astrbot_data_dir(app: &AppHandle) -> String {
  app
    .store(SETTINGS_FILE)
    .ok()
    .and_then(|store| store.get(ASTRBOT_DATA_DIR_KEY))
    .and_then(|value| value.as_str().map(|text| text.trim().to_string()))
    .unwrap_or_default()
}

/// AstrBot 地址：空字符串 = 自动发现；非空必须是 http(s) 且没有空格。
/// 末尾的 `/` 会去掉，省得 BFF 拼出 `//api/v1`。
fn normalize_astrbot_url(raw: &str) -> Result<String, String> {
  let trimmed = raw.trim().trim_end_matches('/').to_string();
  if trimmed.is_empty() {
    return Ok(String::new());
  }
  if trimmed.contains(char::is_whitespace) {
    return Err("地址里不能有空格".to_string());
  }
  if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
    return Err("地址要以 http:// 或 https:// 开头".to_string());
  }
  if trimmed.len() <= "https://".len() {
    return Err("地址不完整".to_string());
  }
  Ok(trimmed)
}

fn read_update_check_on_start(app: &AppHandle) -> bool {
  app
    .store(SETTINGS_FILE)
    .ok()
    .and_then(|store| store.get(UPDATE_CHECK_ON_START_KEY))
    .and_then(|value| value.as_bool())
    .unwrap_or(true)
}

/// 更新源必须能解析成 http(s) URL。http 到底能不能用由插件配置决定：
/// 正式版 `dangerousInsecureTransportProtocol` 是 false（只允许 https），
/// 本地联调时用带这个开关的构建。
fn parse_update_endpoint(raw: &str) -> Result<tauri::Url, String> {
  let url = tauri::Url::parse(raw).map_err(|error| format!("更新源地址不合法：{error}"))?;
  match url.scheme() {
    "http" | "https" => Ok(url),
    other => Err(format!("更新源只支持 http/https，当前是 {other}")),
  }
}

/// http 源在正式版里会被插件拒绝，报错原文是一句英文，
/// 这里补一句人话，免得用户以为是网络问题。
fn updater_error_text(raw: &str) -> String {
  let lower = raw.to_lowercase();
  let insecure_transport = lower.contains("insecure")
    || lower.contains("secure protocol")
    || lower.contains("secure transport");
  if insecure_transport {
    format!(
      "{raw}（正式版只允许 https 更新源；本地联调请用带 dangerousInsecureTransportProtocol 的测试构建）"
    )
  } else {
    raw.to_string()
  }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCheckResult {
  /// `not-configured`：没填更新源；`up-to-date`：已是最新；`available`：有新版本
  status: String,
  current_version: String,
  version: Option<String>,
  notes: Option<String>,
  date: Option<String>,
}

#[tauri::command]
async fn check_update(app: AppHandle) -> Result<UpdateCheckResult, String> {
  let current_version = app.package_info().version.to_string();
  let raw = read_update_endpoint(&app);
  if raw.is_empty() {
    return Ok(UpdateCheckResult {
      status: "not-configured".to_string(),
      current_version,
      version: None,
      notes: None,
      date: None,
    });
  }

  let endpoint = parse_update_endpoint(&raw)?;
  // 每次现建 updater：用户改完更新源不用重启应用
  let updater = app
    .updater_builder()
    .endpoints(vec![endpoint])
    .map_err(|error| updater_error_text(&error.to_string()))?
    .build()
    .map_err(|error| updater_error_text(&error.to_string()))?;

  match updater
    .check()
    .await
    .map_err(|error| updater_error_text(&error.to_string()))?
  {
    Some(update) => Ok(UpdateCheckResult {
      status: "available".to_string(),
      current_version,
      version: Some(update.version.clone()),
      notes: update.body.clone(),
      date: update.date.map(|date| date.to_string()),
    }),
    None => Ok(UpdateCheckResult {
      status: "up-to-date".to_string(),
      current_version,
      version: None,
      notes: None,
      date: None,
    }),
  }
}

/// 下载 + 验签 + 交给 NSIS 安装包。Windows 上安装程序启动后进程会直接退出
/// （由安装程序的 `/R` 重新拉起新版本），所以正常情况这个命令不会返回。
///
/// ⚠️ 安装前必须先把壳托管的 BFF 子进程收掉：NSIS 要覆盖 `sidecar\node.exe`，
/// 而正在运行的 node.exe 会锁住自己的映像文件 —— 不收就会出现
/// 「无法打开要写入的文件: ...\sidecar\node.exe」的重试对话框，安装卡死。
#[tauri::command]
async fn install_update(
  app: AppHandle,
  manager: tauri::State<'_, Arc<BffManager>>,
) -> Result<(), String> {
  let raw = read_update_endpoint(&app);
  if raw.is_empty() {
    return Err("还没有配置更新源".to_string());
  }

  let endpoint = parse_update_endpoint(&raw)?;
  let updater = app
    .updater_builder()
    .endpoints(vec![endpoint])
    .map_err(|error| updater_error_text(&error.to_string()))?
    .build()
    .map_err(|error| updater_error_text(&error.to_string()))?;

  let Some(update) = updater
    .check()
    .await
    .map_err(|error| updater_error_text(&error.to_string()))?
  else {
    return Err("已经是最新版本".to_string());
  };

  log::info!(
    "开始下载更新 {} → {}（{}）",
    update.current_version,
    update.version,
    update.download_url
  );

  // 先把 BFF 收掉（shutdown 会 kill + wait，返回时文件锁已经释放）
  let manager = manager.inner().clone();
  manager.shutdown();
  std::thread::sleep(std::time::Duration::from_millis(300));

  let installed = update
    .download_and_install(|_chunk, _total| {}, || log::info!("更新包下载完成，开始安装"))
    .await;

  // 正常拿不到这里：Windows 上安装程序起来后进程就退出了。
  // 装失败就把 BFF 拉回来，别让用户看到一个连不上 AstrBot 的窗口。
  if let Err(error) = installed {
    log::warn!("更新安装失败：{error}，恢复 BFF");
    let _ = manager.restart(&app);
    return Err(updater_error_text(&error.to_string()));
  }

  log::info!("更新安装程序已启动，等待安装完成");
  Ok(())
}

/// 升级后清一次 WebView2 的缓存（每个版本只做一次，用 marker 文件记账）。
///
/// 为什么需要：P2/P3 早期版本在壳里也注册了 PWA 的 Service Worker
/// （`src/core/pwa.ts`，已修）。SW 把旧的 `index.html` 存进 WebView2 profile，
/// 升级后旧 HTML 指向的 `assets/index-<旧hash>.js` 已经不在新包里 —— 结果是**白屏**，
/// 而且新代码根本没机会跑（清缓存的 JS 自己就加载不出来）。
/// WebView2 的 profile 按 identifier 存在 `%LOCALAPPDATA%\com.astrbot.chat\EBWebView`，
/// 所以只能在这一层先删掉 `Default\Service Worker` 和 `Default\Cache`。
fn cleanup_stale_webview_cache() {
    const IDENTIFIER: &str = "com.astrbot.chat";
    let Ok(local_app_data) = std::env::var("LOCALAPPDATA") else {
        return;
    };
    let root = std::path::PathBuf::from(local_app_data).join(IDENTIFIER);
    let marker = root.join("webview-cache.ver");
    let version = env!("CARGO_PKG_VERSION");

    if std::fs::read_to_string(&marker)
        .map(|text| text.trim() == version)
        .unwrap_or(false)
    {
        return;
    }

    let profile = root.join("EBWebView").join("Default");
    for name in ["Service Worker", "Cache"] {
        let path = profile.join(name);
        if path.exists() {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
    let _ = std::fs::create_dir_all(&root);
    let _ = std::fs::write(&marker, version);
}

fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {  let show = MenuItem::with_id(app, "show", "打开主界面", true, None::<&str>)?;
  let hide = MenuItem::with_id(app, "hide", "隐藏到托盘", true, None::<&str>)?;
  let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
  let separator = PredefinedMenuItem::separator(app)?;
  let menu = Menu::with_items(app, &[&show, &hide, &separator, &quit])?;

  let mut builder = TrayIconBuilder::with_id(TRAY_ID)
    .tooltip("AstrBot Chat")
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| match event.id.as_ref() {
      "show" => show_main(app),
      "hide" => hide_to_tray(app),
      "quit" => app.exit(0),
      _ => {}
    })
    .on_tray_icon_event(|tray, event| {
      // 左键点托盘 = 把窗口叫到前台（隐藏走托盘菜单或关闭按钮，避免误触）。
      //
      // ⚠️ Win11 上图标被折进「^」溢出区时这一步收不到事件：tray-icon（0.25.x）
      // 在处理回调时先调 `Shell_NotifyIconGetRect` 取图标矩形，取不到就直接
      // `return 0`，事件根本没往上抛（溢出区 / 第三方托盘宿主都会这样）。
      // 依赖里的这个问题我们改不了，所以另给了一条用户能走通的退路：**再启动一次
      // 应用**（单实例插件会把现有窗口抬到前台），关闭到托盘时也会提示一次。
      if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
      } = event
      {
        show_main(tray.app_handle());
      }
    });

  if let Some(icon) = app.default_window_icon() {
    builder = builder.icon(icon.clone());
  }

  builder.build(app)?;
  Ok(())
}

/// 旧版本的 `app.exe` 留在安装目录里没用了（0.2.14 起可执行文件改叫 `astrbot-chat`）。
///
/// NSIS 是覆盖安装，不会删旧文件：升级后同目录会多出一个 15 MB 的 `app.exe`，
/// 用户还可能照着旧文档 / 旧快捷方式把它点起来 —— 那个是**上一次**的版本，
/// 和新的共用同一份 settings.json / WebView2 profile，最容易让人以为「升级没生效」。
/// 这里只删自己旧版本留下的这一个名字的文件，删不掉（比如还开着）就算了。
fn remove_legacy_binary() {
  let Ok(exe) = std::env::current_exe() else {
    return;
  };
  let Some(dir) = exe.parent() else {
    return;
  };
  let legacy = dir.join(if cfg!(windows) { "app.exe" } else { "app" });
  if !legacy.is_file() || legacy == exe {
    return;
  }
  match std::fs::remove_file(&legacy) {
    Ok(()) => log::info!("已清掉旧版可执行文件：{}", legacy.display()),
    Err(error) => log::warn!("旧版可执行文件暂时删不掉（{}）：{error}", legacy.display()),
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // 必须在创建窗口/WebView 之前跑，否则 WebView2 profile 被占用就删不掉了
  cleanup_stale_webview_cache();
  remove_legacy_binary();

  tauri::Builder::default()
    // 单实例必须第一个注册，否则第二个实例会先跑起来再被关掉。
    .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
      show_main(app);
    }))
    .plugin(tauri_plugin_store::Builder::new().build())
    // Windows 上 WebView2 的 Notification API 靠不住（需要用户手势，隐藏窗口时更不稳），
    // 桌面端统一走系统通知插件，见 src/desktop/notify.ts。
    .plugin(tauri_plugin_notification::init())
    // 自动更新：只注册插件，源地址在运行时从 settings.json 读（见 check_update）
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(
      tauri_plugin_autostart::Builder::new()
        // 不指定的话会用 Cargo 包名「app」写进注册表 Run 项，难看也不好排查。
        .app_name("AstrBot Chat")
        .arg("--autostart")
        .build(),
    )
    .plugin(
      tauri_plugin_window_state::Builder::new()
        .with_state_flags(
          tauri_plugin_window_state::StateFlags::SIZE
            | tauri_plugin_window_state::StateFlags::POSITION
            | tauri_plugin_window_state::StateFlags::MAXIMIZED,
        )
        .build(),
    )
    .invoke_handler(tauri::generate_handler![
      apply_close_action,
      read_desktop_settings,
      write_desktop_settings,
      read_api_key,
      write_api_key,
      lan_info,
      set_lan_remote_base,
      set_lan_access,
      reset_lan_pairing,
      bff_status,
      restart_bff,
      export_diagnostics,
      check_update,
      install_update
    ])
    .setup(|app| {
      // 打包版也要留日志：干净机器上出问题时，BFF 有 bff.out.log，壳这边得有 app.log
      // （release 的 windows_subsystem = "windows" 没有控制台，不落盘就等于什么都没了）。
      app.handle().plugin(
        tauri_plugin_log::Builder::default()
          .level(log::LevelFilter::Info)
          .max_file_size(2 * 1024 * 1024)
          .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
          .build(),
      )?;
      ensure_defaults(app.handle());
      // 版本号写进日志：升级完靠它确认到底跑的是哪个版本（安装目录里没有别的地方好查）
      log::info!(
        "AstrBot Chat {} 启动（pid {}）",
        app.package_info().version,
        std::process::id()
      );

      // BFF 在后台线程里拉起，别拖慢窗口出现
      let manager = Arc::new(BffManager::new());
      app.manage(manager.clone());
      let handle = app.handle().clone();
      std::thread::spawn(move || bff::bootstrap(&handle, manager));

      build_tray(app.handle())?;
      Ok(())
    })
    .on_window_event(|window, event| {
      if window.label() != "main" {
        return;
      }
      let WindowEvent::CloseRequested { api, .. } = event else {
        return;
      };
      let app = window.app_handle();
      match close_behavior(app).as_str() {
        "exit" => {
          api.prevent_close();
          app.exit(0);
        }
        "tray" => {
          api.prevent_close();
          hide_to_tray(app);
        }
        _ => {
          api.prevent_close();
          if let Err(error) = app.emit(CLOSE_REQUESTED_EVENT, ()) {
            log::warn!("无法发送关闭询问事件：{error}");
            // 前端没接住的话，至少别让窗口关不掉。
            hide_to_tray(app);
          }
        }
      }
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      // 真正退出前把 BFF 收掉（强杀的情况由 BFF 自己的父进程看门狗兜底）
      if let tauri::RunEvent::Exit = event {
        if let Some(manager) = app.try_state::<Arc<BffManager>>() {
          manager.shutdown();
        }
      }
    });
}

#[cfg(test)]
mod tests {
  use super::{build_lan_url, normalize_remote_base};

  const TOKEN: &str = "0123456789abcdef0123456789abcdef";

  #[test]
  fn remote_base_accepts_bare_host_and_port() {
    assert_eq!(
      normalize_remote_base("host.tailnet.ts.net:8443").unwrap(),
      "https://host.tailnet.ts.net:8443"
    );
  }

  #[test]
  fn remote_base_drops_path_query_and_trailing_slash() {
    assert_eq!(
      normalize_remote_base("  https://host.tailnet.ts.net:8443/some/path?x=1#y  ").unwrap(),
      "https://host.tailnet.ts.net:8443"
    );
  }

  #[test]
  fn remote_base_empty_clears() {
    assert_eq!(normalize_remote_base("   ").unwrap(), "");
  }

  #[test]
  fn remote_base_rejects_non_http_scheme() {
    assert!(normalize_remote_base("ftp://example.com").is_err());
    assert!(normalize_remote_base("ws://example.com").is_err());
  }

  #[test]
  fn remote_base_keeps_explicit_http() {
    assert_eq!(
      normalize_remote_base("http://10.0.0.5:8788").unwrap(),
      "http://10.0.0.5:8788"
    );
  }

  #[test]
  fn remote_base_443_falls_back_to_no_port() {
    // 已知坑：URL 规范把 :443 吃掉 —— 记下来，免得以后以为这里坏了
    assert_eq!(
      normalize_remote_base("https://host.tailnet.ts.net:443").unwrap(),
      "https://host.tailnet.ts.net"
    );
  }

  #[test]
  fn url_prefers_remote_base_even_without_lan_ip() {
    let (url, source) = build_lan_url(
      true,
      TOKEN,
      "https://host.tailnet.ts.net:8443",
      "",
      false,
    );
    assert_eq!(url, format!("https://host.tailnet.ts.net:8443/?t={TOKEN}"));
    assert_eq!(source, "remote");
  }

  #[test]
  fn url_falls_back_to_lan_https_then_http() {
    let (url, source) = build_lan_url(true, TOKEN, "", "192.168.1.5", true);
    assert_eq!(url, format!("https://192.168.1.5:8789/?t={TOKEN}"));
    assert_eq!(source, "lan-https");

    let (url, source) = build_lan_url(true, TOKEN, "  ", "192.168.1.5", false);
    assert_eq!(url, format!("http://192.168.1.5:8788/?t={TOKEN}"));
    assert_eq!(source, "lan-http");
  }

  #[test]
  fn url_empty_when_disabled_or_tokenless_or_ipless() {
    let remote = "https://host.tailnet.ts.net:8443";
    assert_eq!(build_lan_url(false, TOKEN, remote, "192.168.1.5", true), (String::new(), ""));
    assert_eq!(build_lan_url(true, "", remote, "192.168.1.5", true), (String::new(), ""));
    assert_eq!(build_lan_url(true, TOKEN, "", "", false), (String::new(), ""));
  }
}
