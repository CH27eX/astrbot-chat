# 打「带签名更新包」的 release 构建。
#
# 和普通 `tauri build` 的区别只有两点：
#   1. 用 src-tauri/tauri.release.conf.json 打开 createUpdaterArtifacts，
#      产物里多出 `AstrBot Chat_<版本>_x64-setup.nsis.zip` 和 `.sig`；
#   2. 从环境变量读签名私钥（私钥在仓库外，`~/.astrbot-updater/`）。
#
# 版本号在 src-tauri/tauri.conf.json 的 `version` 里改，改完再跑这个。
#
# 用法（在 astrbot-chat 下）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -KeyDir D:\keys

param(
  [string]$KeyDir = (Join-Path $env:USERPROFILE ".astrbot-updater"),
  [string]$ReleaseConfig = "src-tauri\tauri.release.conf.json",
  [switch]$SkipFrontend
)

$ErrorActionPreference = "Stop"

$privateKey = Join-Path $KeyDir "astrbot-chat.key"
$passwordFile = Join-Path $KeyDir "password.txt"
if (-not (Test-Path $privateKey)) {
  throw "找不到签名私钥：$privateKey`n（第一次请用 tauri signer generate 生成，见 docs/p4-自动更新.md）"
}
if (-not (Test-Path $passwordFile)) {
  throw "找不到私钥密码文件：$passwordFile`n（生成私钥时用的密码要留一份，否则没法签名）"
}

# Cargo 装在自定义目录时用它；没这个目录就走系统默认（别人机器上通常就是默认）
if (Test-Path "D:\Dev\rustup") { $env:RUSTUP_HOME = "D:\Dev\rustup" }
if (Test-Path "D:\Dev\cargo") { $env:CARGO_HOME = "D:\Dev\cargo" }
if (Test-Path "D:\Dev\cargo-target") { $env:CARGO_TARGET_DIR = "D:\Dev\cargo-target" }
if ((Test-Path "D:\Dev\cargo\bin") -and -not ($env:Path -split ';' | Where-Object { $_ -like '*cargo\bin*' })) {
  $env:Path = "D:\Dev\cargo\bin;$env:Path"
}
# 没有系统 Node 时用 DSH 运行时里那个
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  $fallbackNode = Join-Path $env:USERPROFILE ".dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin"
  if (Test-Path $fallbackNode) { $env:Path = "$fallbackNode;$env:Path" }
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "找不到 node：请安装 Node 20+ 并加入 PATH"
}

$env:TAURI_SIGNING_PRIVATE_KEY = $privateKey
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content $passwordFile -Raw).Trim()

$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
  $version = (Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json).version
  Write-Host "[release] 版本 $version，签名私钥 $privateKey" -ForegroundColor Cyan
  node node_modules\@tauri-apps\cli\tauri.js build --config $ReleaseConfig
  if ($LASTEXITCODE -ne 0) { throw "tauri build 失败（exit $LASTEXITCODE）" }

  $targetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } elseif (Test-Path "D:\Dev\cargo-target") { "D:\Dev\cargo-target" } else { Join-Path $root "src-tauri\target" }
  $bundle = Join-Path $targetDir "release\bundle\nsis"
  # Tauri 2.12 起 NSIS 更新包就是 `*_x64-setup.exe` + `.exe.sig`，
  # 不再有 `.nsis.zip`；两种都认，避免老脚本在这里误报失败。
  $exe = Join-Path $bundle "AstrBot Chat_${version}_x64-setup.exe"
  $sig = "$exe.sig"
  $zip = Join-Path $bundle "AstrBot Chat_${version}_x64-setup.nsis.zip"
  if ((Test-Path $exe) -and (Test-Path $sig)) {
    Write-Host "[release] 更新包：$exe（+ .sig）" -ForegroundColor Green
  } elseif (Test-Path $zip) {
    Write-Host "[release] 更新包：$zip" -ForegroundColor Green
  } else {
    throw "没有生成更新包（既没有 $exe(+.sig)，也没有 $zip）"
  }
  Write-Host "[release] 下一步：node scripts/update-feed.mjs --bundle `"$bundle`" --notes `"本次更新说明`"" -ForegroundColor Green
} finally {
  Pop-Location
}
