// 一键诊断包（0.2.14）。
//
// 目的：测试者反馈「黑屏 / 连不上 / 更新失败」时，别让他自己去三个目录里翻日志、
// 再问一遍「你什么系统、什么版本」。点一下，得到一个 zip：
//
//   * `environment.txt` —— 版本、系统、路径、BFF 状态、关键设置（不含量）；
//   * `settings-redacted.json` —— 真的 settings.json，但 Key / 局域网令牌已打码；
//   * `logs/` —— 应用日志 + BFF 的 out / err 日志。
//
// 刻意**不上传**：这里只负责在本地打包，用户自己决定发给谁（和「不做云端」的定位一致）。

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

use crate::bff::BffStatus;

/// settings.json 里必须打码的键（Key / 局域网配对令牌）
const SECRET_KEYS: [&str; 2] = ["astrbotApiKey", "lanToken"];

/// 诊断包里的环境说明
pub fn environment_report(app: &AppHandle, status: &BffStatus) -> String {
    let version = app.package_info().version.to_string();
    let paths = [
        ("应用数据", app.path().app_data_dir().ok()),
        ("设置", app.path().app_config_dir().ok()),
        ("日志", app.path().app_log_dir().ok()),
        ("资源", app.path().resource_dir().ok()),
    ];

    let mut text = String::new();
    text.push_str("AstrBot Chat 诊断包\n");
    text.push_str("==================\n\n");
    text.push_str(&format!("版本      : {version}\n"));
    text.push_str(&format!("系统      : {} {}\n", std::env::consts::OS, std::env::consts::ARCH));
    text.push_str(&format!("生成时间  : {}\n", iso_utc(SystemTime::now())));
    text.push_str(&format!("进程 pid  : {}\n", std::process::id()));
    if let Ok(exe) = std::env::current_exe() {
        text.push_str(&format!("程序路径  : {}\n", exe.display()));
    }
    for (label, path) in paths {
        if let Some(path) = path {
            text.push_str(&format!("{label}  : {}\n", path.display()));
        }
    }
    if let Ok(lang) = std::env::var("LANG") {
        text.push_str(&format!("LANG      : {lang}\n"));
    }

    text.push_str("\n--- BFF ---\n");
    match serde_json::to_string_pretty(status) {
        Ok(json) => text.push_str(&json),
        Err(error) => text.push_str(&format!("（BFF 状态序列化失败：{error}）")),
    }
    text.push_str("\n\n--- 设置（已去掉 Key / 令牌）---\n");
    text.push_str(&format!("{}\n", settings_summary(app)));
    text
}

/// 设置文件里「能公开」的几项：打包给测试者看问题时足够定位，且不泄露凭据
fn settings_summary(app: &AppHandle) -> String {
    let Some(settings) = read_settings(app) else {
        return "（读不到 settings.json）".to_string();
    };
    let pick = |key: &str| settings.get(key).cloned().unwrap_or(Value::Null);
    let summary = serde_json::json!({
        "closeBehavior": pick("closeBehavior"),
        "autoLaunchAstrBot": pick("autoLaunchAstrBot"),
        "lanAccess": pick("lanAccess"),
        "astrbotUrl": pick("astrbotUrl"),
        "astrbotDataDir": pick("astrbotDataDir"),
        "updateEndpoint": pick("updateEndpoint"),
        "updateCheckOnStart": pick("updateCheckOnStart"),
        "hasApiKey": settings
            .get("astrbotApiKey")
            .and_then(Value::as_str)
            .map(|key| !key.trim().is_empty())
            .unwrap_or(false),
        "hasLanToken": settings
            .get("lanToken")
            .and_then(Value::as_str)
            .map(|token| !token.is_empty())
            .unwrap_or(false),
    });
    serde_json::to_string_pretty(&summary).unwrap_or_else(|_| "（整理失败）".to_string())
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("settings.json"))
}

fn read_settings(app: &AppHandle) -> Option<Map<String, Value>> {
    let raw = fs::read_to_string(settings_path(app)?).ok()?;
    match serde_json::from_str::<Value>(&raw).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// 把 settings.json 里的凭据换成占位符，其余原样保留（结构本身就是排查线索）
pub fn redact_settings(settings: &Map<String, Value>) -> Map<String, Value> {
    let mut out = settings.clone();
    for key in SECRET_KEYS {
        if let Some(value) = out.get_mut(key) {
            let present = value.as_str().map(|text| !text.trim().is_empty()).unwrap_or(false);
            *value = Value::String(if present { "<已隐藏>".into() } else { String::new() });
        }
    }
    out
}

/// UTC 的 ISO-8601（`2026-11-19T13:30:00Z`）。不引 chrono：只需要一个时间戳。
pub fn iso_utc(time: SystemTime) -> String {
    let seconds = time
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or(0);
    let days = seconds.div_euclid(86_400);
    let rem = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// 天数（1970-01-01 起）→ 年月日。Howard Hinnant 的 `civil_from_days`，避免引日期库。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 诊断包放哪：下载目录 → 桌面 → 临时目录（总有地方落）
fn output_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .download_dir()
        .ok()
        .or_else(|| app.path().desktop_dir().ok())
        .unwrap_or_else(std::env::temp_dir)
}

/// 打包：生成目录 → 复制日志 → 压缩。返回给用户看的路径。
///
/// 压缩用系统自带的 `tar`（Win10 1803+ / macOS / Linux 都有）：失败就只留目录，
/// 宁可给一个文件夹，也别因为打包工具不在就整个功能报错。
pub fn export(app: &AppHandle, status: &BffStatus) -> Result<String, String> {
    let stamp = iso_utc(SystemTime::now())
        .replace([':', '-'], "")
        .replace('T', "-")
        .replace('Z', "");
    let base = format!("AstrBot-Chat-诊断-{stamp}");
    let parent = output_dir(app);
    fs::create_dir_all(&parent).map_err(|error| format!("建不了输出目录：{error}"))?;
    let folder = parent.join(&base);
    fs::create_dir_all(&folder).map_err(|error| format!("建不了诊断目录：{error}"))?;

    fs::write(folder.join("environment.txt"), environment_report(app, status))
        .map_err(|error| format!("写 environment.txt 失败：{error}"))?;

    if let Some(settings) = read_settings(app) {
        let redacted = Value::Object(redact_settings(&settings));
        if let Ok(text) = serde_json::to_string_pretty(&redacted) {
            let _ = fs::write(folder.join("settings-redacted.json"), format!("{text}\n"));
        }
    }

    let logs = folder.join("logs");
    let _ = fs::create_dir_all(&logs);
    if let Ok(dir) = app.path().app_log_dir() {
        copy_logs(&dir, &logs);
    }

    let archive = archive(&parent, &base);
    if archive.is_some() {
        // 压缩成功就把中间目录收掉，只留一个文件给用户拖进聊天窗
        let _ = fs::remove_dir_all(&folder);
        Ok(archive.unwrap().display().to_string())
    } else {
        Ok(folder.display().to_string())
    }
}

/// 复制日志目录里的文件（只认普通文件，跳过轮转中的 .old 之类不存在的东西）
fn copy_logs(from: &Path, to: &Path) {
    let Ok(entries) = fs::read_dir(from) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name() else {
            continue;
        };
        let _ = fs::copy(&path, to.join(name));
    }
}

fn archive(parent: &Path, name: &str) -> Option<PathBuf> {
    if cfg!(windows) {
        let target = parent.join(format!("{name}.zip"));
        let status = Command::new("tar")
            .args(["-a", "-c", "-f"])
            .arg(&target)
            .arg("-C")
            .arg(parent)
            .arg(name)
            .status()
            .ok()?;
        (status.success() && target.is_file()).then_some(target)
    } else {
        let target = parent.join(format!("{name}.tar.gz"));
        let status = Command::new("tar")
            .arg("-czf")
            .arg(&target)
            .arg("-C")
            .arg(parent)
            .arg(name)
            .status()
            .ok()?;
        (status.success() && target.is_file()).then_some(target)
    }
}

/// 在文件管理器里定位到诊断包（找不到就静默失败，路径已经显示在 UI 上）
pub fn reveal(path: &Path) {
    #[cfg(windows)]
    {
        let _ = Command::new("explorer").arg("/select,").arg(path).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg("-R").arg(path).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(dir) = path.parent() {
            let _ = Command::new("xdg-open").arg(dir).spawn();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_utc_formats_known_instants() {
        assert_eq!(iso_utc(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        // 2026-11-19T13:30:00Z
        assert_eq!(
            iso_utc(UNIX_EPOCH + std::time::Duration::from_secs(1_795_095_000)),
            "2026-11-19T13:30:00Z"
        );
        // 闰日
        assert_eq!(
            iso_utc(UNIX_EPOCH + std::time::Duration::from_secs(951_782_400)),
            "2000-02-29T00:00:00Z"
        );
    }

    #[test]
    fn redact_settings_hides_secrets_but_keeps_shape() {
        let mut settings = Map::new();
        settings.insert("astrbotApiKey".into(), Value::String("sk-live-secret".into()));
        settings.insert("lanToken".into(), Value::String("abcdef0123456789".into()));
        settings.insert("closeBehavior".into(), Value::String("tray".into()));

        let redacted = redact_settings(&settings);
        assert_eq!(redacted.get("astrbotApiKey").unwrap(), "<已隐藏>");
        assert_eq!(redacted.get("lanToken").unwrap(), "<已隐藏>");
        assert_eq!(redacted.get("closeBehavior").unwrap(), "tray");
        let text = serde_json::to_string(&redacted).unwrap();
        assert!(!text.contains("sk-live-secret"));
        assert!(!text.contains("abcdef0123456789"));
    }

    #[test]
    fn redact_settings_keeps_empty_values_empty() {
        let mut settings = Map::new();
        settings.insert("astrbotApiKey".into(), Value::String("  ".into()));
        let redacted = redact_settings(&settings);
        assert_eq!(redacted.get("astrbotApiKey").unwrap(), "");
    }
}
