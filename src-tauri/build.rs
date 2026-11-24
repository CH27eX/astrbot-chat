fn main() {
  // 版本号有两处：`tauri.conf.json`（安装包名、包信息）和 `Cargo.toml`
  // （`CARGO_PKG_VERSION`，升级时清 WebView 缓存的版本标记也用它）。
  // 只改一个会出现「安装包叫 0.1.1、缓存标记还是 0.1.0」这种错位，所以对不上就警告。
  println!("cargo:rerun-if-changed=tauri.conf.json");
  println!("cargo:rerun-if-env-changed=TAURI_CONFIG");

  if let Some(config_version) = config_version() {
    let cargo_version = std::env::var("CARGO_PKG_VERSION").unwrap_or_default();
    if !cargo_version.is_empty() && cargo_version != config_version {
      println!(
        "cargo:warning=版本号不一致：tauri.conf.json={} / Cargo.toml={}（发版时两边都要改）",
        config_version, cargo_version
      );
    }
  }

  tauri_build::build()
}

/// 拿「真正生效」的版本号：`tauri build --config xxx.json` 会通过 `TAURI_CONFIG`
/// 传合并后的配置，这时以它为准；没有这个环境变量（普通构建）才读文件。
fn config_version() -> Option<String> {
  if let Ok(raw) = std::env::var("TAURI_CONFIG") {
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
      if let Some(version) = json.get("version").and_then(|value| value.as_str()) {
        return Some(version.to_string());
      }
    }
  }

  let text = std::fs::read_to_string("tauri.conf.json").ok()?;
  let json = serde_json::from_str::<serde_json::Value>(&text).ok()?;
  json
    .get("version")
    .and_then(|value| value.as_str())
    .map(ToOwned::to_owned)
}
