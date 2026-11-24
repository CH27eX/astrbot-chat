// BFF sidecar：让壳自己把 BFF 拉起来，不依赖 PowerShell 启动器。
//
// 结构：
//   * `BffManager` 放在 Tauri state 里（`Arc<BffManager>`），后台线程负责监控；
//   * 启动时先探测 `http://127.0.0.1:8788/astrbot/api/health`：
//       能连上 → 认为外部（比如启动器）已经在跑，直接复用，不管它；
//       连不上 → 用便携 Node 起 `server/index.mjs`（dev）或 `resources/bff.mjs`（打包后）；
//   * 子进程带 `BFF_PARENT_PID`，BFF 自己会在父进程消失后退出，避免孤儿进程；
//   * 崩溃自动重启，最多 3 次，退避 2/4/8 秒；
//   * 退出时 kill 掉子进程。

use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

use crate::{
    API_KEY_STORE_KEY, ASTRBOT_DATA_DIR_KEY, ASTRBOT_URL_KEY, AUTO_LAUNCH_ASTRBOT_KEY,
    LAN_ACCESS_KEY, LAN_TOKEN_KEY, SETTINGS_FILE,
};

/// BFF 端口，和 `server/index.mjs` 的默认值、前端 CSP 保持一致
pub const BFF_PORT: u16 = 8788;
/// 局域网自签 HTTPS 的端口（只在 `scripts/lan-tls.ps1` 生成过证书时启用）。
/// HTTP 那条继续只听回环：桌面壳和健康检查都走它，一点没变。
pub const BFF_HTTPS_PORT: u16 = 8789;
/// 本机反代（Tailscale Serve / cloudflared）专用端口：只绑回环、永远要令牌。
/// 8788 的令牌门对回环放行，所以反代必须打这条，否则链接里的 `?t=` 形同虚设。
pub const BFF_PROXY_PORT: u16 = 8790;
const HEALTH_PATH: &str = "/astrbot/api/health";
const MAX_RESTARTS: u32 = 3;

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    /// 复用了外部已经跑着的 BFF（例如启动器脚本起的），此时不托管它的生命周期
    external: bool,
    restarts: u32,
    stopping: bool,
    healthy: bool,
    script: Option<PathBuf>,
    error: Option<String>,
}

#[derive(Clone)]
pub struct BffManager {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BffStatus {
    /// 是否是壳自己起的进程
    managed: bool,
    running: bool,
    pid: Option<u32>,
    /// `/astrbot/api/health` 能连上（不要求 AstrBot 已就绪）
    healthy: bool,
    restarts: u32,
    script: Option<String>,
    error: Option<String>,
}

impl BffManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
        }
    }

    pub fn status(&self) -> BffStatus {
        let inner = self.inner.lock().unwrap();
        let pid = inner.child.as_ref().map(Child::id);
        BffStatus {
            managed: !inner.external && pid.is_some(),
            running: inner.external || pid.is_some(),
            pid,
            healthy: inner.healthy,
            restarts: inner.restarts,
            script: inner
                .script
                .as_ref()
                .map(|path| path.display().to_string()),
            error: inner.error.clone(),
        }
    }

    pub fn shutdown(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.stopping = true;
        inner.healthy = false;
        if let Some(mut child) = inner.child.take() {
            log::info!("停止 BFF（pid {}）", child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// 杀掉当前子进程后重新拉起（改完 API Key / 开关局域网 / 重置配对用）
    ///
    /// 这里必须先 `stopping = true` 再动手：从「旧子进程收掉」到「新子进程登记进
    /// inner.child」之间有一个几毫秒的窗口，2 秒一圈的看门狗正好会把它当成「进程
    /// 退了」→ 自己再拉一个。两个 BFF 抢 8788/8789，抢输的那个马上退出，看门狗
    /// 又把它算成一次崩溃，连记 3 次就「已停止自动重启」了（2026-11-19 真机踩到）。
    pub fn restart(&self, app: &AppHandle) -> Result<(), String> {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.stopping = true;
            if let Some(mut child) = inner.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            inner.external = false;
            inner.restarts = 0;
            inner.healthy = false;
            inner.error = None;
        }
        // spawn_managed 会一直等到 health 通（最多 8 秒），这期间由 stopping 挡住看门狗
        let result = spawn_managed(app, self);
        // 显式重启失败也要把监督交还给看门狗，否则之后它再也不会接手
        self.inner.lock().unwrap().stopping = false;
        result
    }
}

/// 应用启动后调用：连不上就拉起来，然后开始盯着
pub fn bootstrap(app: &AppHandle, manager: Arc<BffManager>) {
    if probe_health().is_some() {
        let mut inner = manager.inner.lock().unwrap();
        inner.external = true;
        inner.healthy = true;
        inner.script = None;
        drop(inner);
        log::info!("端口 {BFF_PORT} 上已有 BFF，直接复用");
    } else if let Err(error) = spawn_managed(app, &manager) {
        log::warn!("{error}");
        manager.inner.lock().unwrap().error = Some(error);
    }

    maybe_launch_astrbot(app);

    let app = app.clone();
    thread::spawn(move || watchdog(app, manager));
}

fn watchdog(app: AppHandle, manager: Arc<BffManager>) {
    loop {
        thread::sleep(Duration::from_secs(2));

        let should_stop = manager.inner.lock().unwrap().stopping;
        if should_stop {
            // 暂停监督（安装更新时要先把子进程收掉，否则 sidecar\node.exe 被占用）。
            // 这里不 return：更新装失败时 restart() 会把标记清掉，线程继续干活；
            // 真退出时进程结束，线程自然消失。
            continue;
        }

        let external = manager.inner.lock().unwrap().external;
        if external {
            let healthy = probe_health().is_some();
            manager.inner.lock().unwrap().healthy = healthy;
            continue;
        }

        let exited = {
            let mut inner = manager.inner.lock().unwrap();
            match inner.child.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        log::warn!("BFF 退出（{status}）");
                        true
                    }
                    Ok(None) => false,
                    Err(error) => {
                        log::warn!("BFF 状态未知：{error}");
                        true
                    }
                },
                None => true,
            }
        };

        if !exited {
            let healthy = probe_health().is_some();
            manager.inner.lock().unwrap().healthy = healthy;
            continue;
        }

        // 检测到「退出」的同一瞬间，可能正好有人在显式 restart（它已经把 stopping 置上）。
        // 再确认一次：是的话这一步不算崩溃、也不许再拉第二个 BFF。
        if manager.inner.lock().unwrap().stopping {
            continue;
        }

        let next_restart = {
            let mut inner = manager.inner.lock().unwrap();
            inner.child = None;
            inner.healthy = false;
            inner.restarts += 1;
            inner.restarts
        };

        if next_restart > MAX_RESTARTS {
            manager.inner.lock().unwrap().error =
                Some(format!("BFF 连续退出 {MAX_RESTARTS} 次，已停止自动重启"));
            continue;
        }

        let backoff = Duration::from_secs(1 << next_restart);
        log::info!("{} 秒后重启 BFF（第 {next_restart} 次）", backoff.as_secs());
        thread::sleep(backoff);

        if manager.inner.lock().unwrap().stopping {
            continue;
        }

        if let Err(error) = spawn_managed(&app, &manager) {
            log::warn!("{error}");
            manager.inner.lock().unwrap().error = Some(error);
        }
    }
}

/// 给子进程补一份完整的 PATH：把 `System32` / `WindowsPowerShell`（以及 Windows 根目录）
/// 加进去，已经有了就不重复加。原因见 `spawn_managed` 里的注释。
fn patched_path() -> Option<String> {
    let mut path = std::env::var("PATH").unwrap_or_default();
    let root = std::env::var("SystemRoot").ok()?;
    let seen = path.to_lowercase();
    for dir in [
        format!("{root}\\System32"),
        format!("{root}\\System32\\WindowsPowerShell\\v1.0"),
        root,
    ] {
        if !seen.contains(&dir.to_lowercase()) {
            if !path.is_empty() {
                path.push(';');
            }
            path.push_str(&dir);
        }
    }
    Some(path)
}

fn spawn_managed(app: &AppHandle, manager: &BffManager) -> Result<(), String> {    let (node, script) = resolve_sidecar(app)?;
    let key = stored_api_key(app);

    let mut command = Command::new(&node);
    command
        .arg(&script)
        .env("BFF_PORT", BFF_PORT.to_string())
        .env("BFF_PARENT_PID", std::process::id().to_string());
    // 没有存 Key 时不要覆盖空值，留给 BFF 自己去读 .env.local（开发时方便）
    if !key.trim().is_empty() {
        command.env("ASTRBOT_API_KEY", key.trim());
    }

    // 用户显式配了 AstrBot 地址（云端 / 另一台机器）就直接用它，优先于本机端口发现
    let base_url = stored_astrbot_url(app);
    if !base_url.trim().is_empty() {
        command.env("ASTRBOT_BASE_URL", base_url.trim());
    }

    // 数据目录：用户填了就优先用它找 data_v4.db（Linux / 容器 / 非标准安装时最稳）
    let data_dir = stored_astrbot_data_dir(app);
    if !data_dir.trim().is_empty() {
        command.env("ASTRBOT_DATA_DIR", data_dir.trim());
    }

    // 手机 / 局域网访问：只在用户打开开关时绑 0.0.0.0，并且非回环请求必须带令牌。
    if lan_access_enabled(app) {
        command.env("BFF_BIND", "0.0.0.0");
        let token = lan_token(app);
        if !token.is_empty() {
            command.env("BFF_LAN_TOKEN", token);
            // 反代源站：Tailscale Serve 打 127.0.0.1:8790，令牌在这里是**强制**的
            // （8788 对回环放行，直接反代它等于没有令牌）。
            command.env("BFF_PROXY_PORT", BFF_PROXY_PORT.to_string());
        }
        // 有自签证书就顺带开 HTTPS（同一个 handler，另一个端口）：
        // 手机的 PWA / 录音 / crypto.randomUUID 都要求安全上下文。
        if let Some(dir) = crate::lan_tls_dir(app) {
            command.env("BFF_HTTPS_PORT", BFF_HTTPS_PORT.to_string());
            let pfx = dir.join("lan-server.pfx");
            command.env("BFF_TLS_PFX", &pfx);
            if let Ok(pass) = std::fs::read_to_string(dir.join("lan-server.pfx.pass")) {
                command.env("BFF_TLS_PASSPHRASE", pass.trim());
            }
            let ca = dir.join("AstrBotChat-CA.cer");
            if ca.is_file() {
                command.env("BFF_TLS_CA", &ca);
            }
        }
    }

    // 打包版把前端静态页放在 resources/sidecar/web，BFF 需要它才能让手机打开
    // `http://<PC-IP>:8788/`；dev 下没有这个目录，BFF 自己退回项目的 dist。
    if let Ok(resource_dir) = app.path().resource_dir() {
        let web = resource_dir.join("sidecar").join("web");
        if web.is_dir() {
            command.env("BFF_WEB_ROOT", web);
        }
    }
    if let Some(parent) = script.parent() {
        command.current_dir(parent);
    }

    // 壳有可能被"精简环境"拉起（安装程序的非交互启动、计划任务等），PATH 里没有
    // System32 → BFF 里调 powershell.exe 会 ENOENT，端口发现永远失败。
    // 这里把系统目录补回去，BFF 自己的 powershell 绝对路径兜底是第二道保险。
    if let Some(path) = patched_path() {
        command.env("PATH", path);
    }

    // 日志放在应用日志目录，出问题能翻
    if let Ok(dir) = app.path().app_log_dir() {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(file) = std::fs::File::create(dir.join("bff.out.log")) {
            command.stdout(Stdio::from(file));
        }
        if let Ok(file) = std::fs::File::create(dir.join("bff.err.log")) {
            command.stderr(Stdio::from(file));
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let child = command
        .spawn()
        .map_err(|error| format!("启动 BFF 失败：{error}"))?;
    let pid = child.id();

    {
        let mut inner = manager.inner.lock().unwrap();
        inner.child = Some(child);
        inner.external = false;
        inner.script = Some(script.clone());
        inner.healthy = false;
        inner.error = None;
    }

    log::info!("BFF 已启动（pid {pid}，{}）", script.display());

    // 等它把端口监听起来（最多 8 秒）
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        thread::sleep(Duration::from_millis(250));
        if probe_health().is_some() {
            manager.inner.lock().unwrap().healthy = true;
            return Ok(());
        }
    }

    let error = "BFF 启动后 8 秒内没有响应 health".to_string();
    manager.inner.lock().unwrap().error = Some(error);
    Ok(())
}

fn resolve_sidecar(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };

    // 开发时优先用项目里的东西，省得每次改 BFF 都要同步一遍
    if cfg!(debug_assertions) {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let resources = manifest.join("resources");
        let node = resources.join("node").join(node_name);
        let dev_script = manifest
            .join("..")
            .join("server")
            .join("index.mjs");
        if node.exists() && dev_script.exists() {
            return Ok((node, dev_script));
        }
    }

    let dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("拿不到 resources 目录：{error}"))?
        .join("sidecar");
    let node = dir.join(node_name);
    let script = dir.join("bff.mjs");

    if !script.exists() {
        return Err(format!(
            "找不到 BFF 资源：{}（先跑 pnpm sidecar:sync，打包前确认 bundle.resources 已配置）",
            script.display()
        ));
    }
    if node.exists() {
        Ok((node, script))
    } else {
        // 兜底：系统 PATH 里的 node
        log::warn!("没有便携 Node，退回系统 node");
        Ok((PathBuf::from("node"), script))
    }
}

fn stored_api_key(app: &AppHandle) -> String {
    app
        .store(SETTINGS_FILE)
        .ok()
        .and_then(|store| store.get(API_KEY_STORE_KEY))
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_default()
}

fn auto_launch_astrbot(app: &AppHandle) -> bool {
    app
        .store(SETTINGS_FILE)
        .ok()
        .and_then(|store| store.get(AUTO_LAUNCH_ASTRBOT_KEY))
        .and_then(|value| value.as_bool())
        .unwrap_or(true)
}

fn lan_access_enabled(app: &AppHandle) -> bool {
    app.store(SETTINGS_FILE)
        .ok()
        .and_then(|store| store.get(LAN_ACCESS_KEY))
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn stored_astrbot_url(app: &AppHandle) -> String {
    app.store(SETTINGS_FILE)
        .ok()
        .and_then(|store| store.get(ASTRBOT_URL_KEY))
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_default()
}

fn stored_astrbot_data_dir(app: &AppHandle) -> String {
    app.store(SETTINGS_FILE)
        .ok()
        .and_then(|store| store.get(ASTRBOT_DATA_DIR_KEY))
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_default()
}

fn lan_token(app: &AppHandle) -> String {
    app.store(SETTINGS_FILE)
        .ok()
        .and_then(|store| store.get(LAN_TOKEN_KEY))
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_default()
}

/// AstrBot 没找到、且用户开着「启动时自动拉起」时，把启动器打开。
/// 只负责打开启动器：真正启动实例还是要在启动器里点一下。
///
/// 这里不是「找到 exe 就 spawn」那么简单：Windows 上 Launcher 有固定安装位置，
/// Linux / macOS 上根本没有统一位置（0.2.13 之前直接 return，Linux 的开关是摆设）。
/// 所以按「显式环境变量 → 常见安装位置 → PATH → 桌面入口」找，找到第一个能用，
/// 一个都找不到就只留一条日志，别让用户以为开关坏了。
fn maybe_launch_astrbot(app: &AppHandle) {
    if !auto_launch_astrbot(app) {
        return;
    }
    match probe_health() {
        Some(200) => return, // AstrBot 已经就绪
        Some(_) => {}
        None => return, // BFF 都不通，先把 BFF 修好再说
    }

    let platform = current_launch_platform();
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let explicit = std::env::var("ASTRBOT_LAUNCHER").ok();
    let path_dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();

    let candidates = launcher_candidates(
        platform,
        local_app_data.as_deref(),
        home.as_deref(),
        explicit.as_deref().map(str::trim).filter(|value| !value.is_empty()),
        &path_dirs,
    );

    let Some(found) = candidates.iter().find(|candidate| usable(&candidate.probe, platform)) else {
        log::info!(
            "{} 上没找到 AstrBot 启动器（{} 个候选都不在），请自己启动 AstrBot；\
             有启动器的话用环境变量 ASTRBOT_LAUNCHER 指向它",
            platform.name(),
            candidates.len()
        );
        return;
    };

    log::info!(
        "AstrBot 未就绪，尝试打开启动器：{}（{}）",
        found.program.display(),
        found.probe.display()
    );
    let mut command = Command::new(&found.program);
    command.args(&found.args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        if found.args.is_empty() {
            command.creation_flags(CREATE_NO_WINDOW);
        }
    }
    match command.spawn() {
        Ok(_) => log::info!("已打开 AstrBot 启动器"),
        Err(error) => log::warn!("打开 AstrBot 启动器失败：{error}"),
    }
}

/// 桌面启动器所在的平台。抽成参数是为了让「Linux 候选列表」能在 Windows 上写单测。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LaunchPlatform {
    Windows,
    MacOs,
    Linux,
}

impl LaunchPlatform {
    fn name(self) -> &'static str {
        match self {
            LaunchPlatform::Windows => "Windows",
            LaunchPlatform::MacOs => "macOS",
            LaunchPlatform::Linux => "Linux",
        }
    }
}

fn current_launch_platform() -> LaunchPlatform {
    if cfg!(windows) {
        LaunchPlatform::Windows
    } else if cfg!(target_os = "macos") {
        LaunchPlatform::MacOs
    } else {
        LaunchPlatform::Linux
    }
}

/// 一条「打开启动器」的命令。
#[derive(Debug, Clone, PartialEq, Eq)]
struct LaunchCommand {
    /// 真正要执行的程序；走桌面入口时是 `gtk-launch` / `open` 这种中介
    program: PathBuf,
    args: Vec<String>,
    /// 判断「这套启动方式在不在」的证据路径（可执行文件 / `.desktop` / `.app` 目录）
    probe: PathBuf,
}

/// 按优先级列出「怎么打开 AstrBot 启动器」。
///
/// 返回的只是候选，能不能用由 `usable()` 判断（存在 + 可执行 / 是 .app 目录）。
/// 顺序就是优先级：`ASTRBOT_LAUNCHER` 显式指定 > 各平台默认安装位置 > PATH > 桌面入口。
fn launcher_candidates(
    platform: LaunchPlatform,
    local_app_data: Option<&Path>,
    home: Option<&Path>,
    explicit: Option<&str>,
    path_dirs: &[PathBuf],
) -> Vec<LaunchCommand> {
    let mut out: Vec<LaunchCommand> = Vec::new();
    let mut push = |program: PathBuf, args: Vec<String>, probe: PathBuf| {
        // 同一个启动器被几条路径重复命中时只留第一条
        if !out.iter().any(|existing| existing.probe == probe) {
            out.push(LaunchCommand {
                program,
                args,
                probe,
            });
        }
    };

    // 用户显式指定：`.desktop` 文件走 gtk-launch，其余当可执行文件直接跑
    if let Some(raw) = explicit {
        let path = PathBuf::from(raw);
        if raw.ends_with(".desktop") {
            if let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) {
                push(
                    PathBuf::from("gtk-launch"),
                    vec![stem.to_string()],
                    path.clone(),
                );
            }
        } else {
            push(path.clone(), Vec::new(), path);
        }
    }

    match platform {
        LaunchPlatform::Windows => {
            if let Some(base) = local_app_data {
                for relative in ["AstrBot Launcher", "Programs/AstrBot Launcher"] {
                    let dir = base.join(relative);
                    push(
                        dir.join("astrbot-launcher.exe"),
                        Vec::new(),
                        dir.join("astrbot-launcher.exe"),
                    );
                }
            }
        }
        LaunchPlatform::MacOs => {
            // 启动器是个 .app 包，跑 `open -a` 才符合 macOS 的启动方式
            for app in [
                "/Applications/AstrBot Launcher.app",
                "/Applications/AstrBot Chat Launcher.app",
            ] {
                let path = PathBuf::from(app);
                if let Some(name) = path.file_stem().and_then(|stem| stem.to_str()) {
                    push(
                        PathBuf::from("open"),
                        vec!["-a".to_string(), name.to_string()],
                        path,
                    );
                }
            }
        }
        LaunchPlatform::Linux => {
            // 自己的 Linux 启动器脚本（~/.astrbot_launcher/ 下按常见命名找）
            if let Some(home) = home {
                let dir = home.join(".astrbot_launcher");
                for name in ["astrbot-launcher", "start.sh", "run.sh", "launcher.sh"] {
                    push(dir.join(name), Vec::new(), dir.join(name));
                }
            }
            // PATH 里的 astrbot-launcher
            for dir in path_dirs {
                push(dir.join("astrbot-launcher"), Vec::new(), dir.join("astrbot-launcher"));
            }
            // 桌面入口：装过启动器的人大多是从菜单里点开的
            let mut desktop_dirs: Vec<PathBuf> = Vec::new();
            if let Some(home) = home {
                desktop_dirs.push(home.join(".local/share/applications"));
            }
            desktop_dirs.push(PathBuf::from("/usr/share/applications"));
            for dir in desktop_dirs {
                for stem in ["astrbot-launcher", "astrbot"] {
                    let desktop = dir.join(format!("{stem}.desktop"));
                    push(
                        PathBuf::from("gtk-launch"),
                        vec![stem.to_string()],
                        desktop,
                    );
                }
            }
        }
    }

    out
}

/// 候选在不在：Windows / Linux 要求是文件（Linux 还要求可执行位），macOS 允许 `.app` 目录。
#[cfg(unix)]
fn usable(probe: &Path, platform: LaunchPlatform) -> bool {
    use std::os::unix::fs::PermissionsExt;
    if platform == LaunchPlatform::MacOs && probe.is_dir() {
        return true;
    }
    probe.is_file()
        && probe
            .metadata()
            .map(|meta| meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

#[cfg(not(unix))]
fn usable(probe: &Path, platform: LaunchPlatform) -> bool {
    if platform == LaunchPlatform::MacOs && probe.is_dir() {
        return true;
    }
    probe.is_file()
}

/// 访问 BFF 的 health，返回状态码（None = 连不上 / 不是我们的服务）
fn probe_health() -> Option<u16> {
    let addr = SocketAddr::from(([127, 0, 0, 1], BFF_PORT));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(600)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(900)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(600)));

    let request = format!("GET {HEALTH_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).ok()?;

    let mut response = Vec::new();
    loop {
        let mut buffer = [0u8; 1024];
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                response.extend_from_slice(&buffer[..read]);
                if response.len() > 8192 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    if response.is_empty() {
        return None;
    }
    let head = String::from_utf8_lossy(&response);
    if !head.starts_with("HTTP/1.") {
        return None;
    }
    // 只认我们自己 BFF 的响应，避免把别的服务误判成 BFF
    if !head.contains("\"ok\"") {
        return None;
    }
    head.split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_only_looks_in_local_app_data() {
        let base = Path::new(r"C:\Users\tester\AppData\Local");
        let found = launcher_candidates(LaunchPlatform::Windows, Some(base), None, None, &[]);
        assert_eq!(found.len(), 2);
        assert_eq!(
            found[0].probe,
            base.join("AstrBot Launcher").join("astrbot-launcher.exe")
        );
        assert_eq!(
            found[1].probe,
            base.join("Programs/AstrBot Launcher")
                .join("astrbot-launcher.exe")
        );
        assert!(found.iter().all(|candidate| candidate.args.is_empty()));
    }

    #[test]
    fn windows_without_local_app_data_has_no_candidate() {
        let found = launcher_candidates(LaunchPlatform::Windows, None, None, None, &[]);
        assert!(found.is_empty());
    }

    #[test]
    fn linux_finds_home_launcher_script_before_path_and_desktop_entries() {
        let home = Path::new("/home/tester");
        let path_dirs = vec![
            PathBuf::from("/home/tester/.local/bin"),
            PathBuf::from("/usr/local/bin"),
        ];
        let found = launcher_candidates(
            LaunchPlatform::Linux,
            None,
            Some(home),
            None,
            &path_dirs,
        );

        // ~/.astrbot_launcher 下的四种命名都在，且排在最前面
        assert_eq!(found[0].probe, home.join(".astrbot_launcher/astrbot-launcher"));
        assert_eq!(found[0].program, home.join(".astrbot_launcher/astrbot-launcher"));
        assert_eq!(found.len(), 4 + 2 + 4);

        // PATH 里每个目录都试一遍（顺序就是 PATH 顺序）
        let path_index = found
            .iter()
            .position(|candidate| candidate.probe == PathBuf::from("/home/tester/.local/bin/astrbot-launcher"))
            .expect("PATH 候选应该在列表里");
        assert_eq!(
            found[path_index + 1].probe,
            PathBuf::from("/usr/local/bin/astrbot-launcher")
        );

        // 最后是两条桌面入口，走 gtk-launch
        let desktop_entry = &found[found.len() - 1];
        assert_eq!(desktop_entry.program, PathBuf::from("gtk-launch"));
        assert_eq!(desktop_entry.args, vec!["astrbot".to_string()]);
        assert_eq!(
            desktop_entry.probe,
            PathBuf::from("/usr/share/applications/astrbot.desktop")
        );
    }

    #[test]
    fn linux_without_home_still_tries_system_desktop_entries() {
        // 以前这里因为「没有 LOCALAPPDATA 就 return」直接变成空列表，开关形同摆设
        let found = launcher_candidates(LaunchPlatform::Linux, None, None, None, &[]);
        assert!(!found.is_empty());
        assert!(found
            .iter()
            .all(|candidate| candidate.program == PathBuf::from("gtk-launch")));
        assert_eq!(
            found[0].probe,
            PathBuf::from("/usr/share/applications/astrbot-launcher.desktop")
        );
    }

    #[test]
    fn explicit_env_wins_and_supports_desktop_files() {
        let explicit = "/opt/custom/astrbot-launcher";
        let found = launcher_candidates(
            LaunchPlatform::Linux,
            None,
            Some(Path::new("/home/tester")),
            Some(explicit),
            &[],
        );
        assert_eq!(found[0].program, PathBuf::from(explicit));
        assert!(found[0].args.is_empty());

        let found = launcher_candidates(
            LaunchPlatform::Linux,
            None,
            None,
            Some("/opt/custom/Mine.desktop"),
            &[],
        );
        assert_eq!(found[0].program, PathBuf::from("gtk-launch"));
        assert_eq!(found[0].args, vec!["Mine".to_string()]);
    }

    #[test]
    fn macos_opens_the_app_bundle() {
        let found = launcher_candidates(LaunchPlatform::MacOs, None, None, None, &[]);
        assert_eq!(found[0].program, PathBuf::from("open"));
        assert_eq!(
            found[0].args,
            vec!["-a".to_string(), "AstrBot Launcher".to_string()]
        );
        assert_eq!(
            found[0].probe,
            PathBuf::from("/Applications/AstrBot Launcher.app")
        );
    }

    #[test]
    fn candidates_are_deduplicated() {
        let home = Path::new("/home/tester");
        let path_dirs = vec![home.join(".astrbot_launcher")];
        let found = launcher_candidates(
            LaunchPlatform::Linux,
            None,
            Some(home),
            None,
            &path_dirs,
        );
        // PATH 里的 ~/.astrbot_launcher/astrbot-launcher 和第一条候选同一个文件
        let duplicates = found
            .iter()
            .filter(|candidate| candidate.probe == home.join(".astrbot_launcher/astrbot-launcher"))
            .count();
        assert_eq!(duplicates, 1);
    }

    #[test]
    fn usable_requires_an_existing_file() {
        let dir = std::env::temp_dir().join("astrbot-usable-test");
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("astrbot-launcher");
        let _ = std::fs::write(&file, "#!/bin/sh\n");

        assert!(usable(&file, LaunchPlatform::Linux));
        assert!(usable(&file, LaunchPlatform::Windows));
        assert!(!usable(&dir.join("does-not-exist"), LaunchPlatform::Linux));

        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir(&dir);
    }
}
