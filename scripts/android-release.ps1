# 出签名 release APK。
#
# 签名材料都在仓库外（默认 %USERPROFILE%\.astrbot-android\）：
#   astrbot-chat-release.jks   keystore
#   keystore.properties        storeFile / storePassword / keyAlias / keyPassword
# 第一次跑会自动生成（随机密码，只写在本机），之后就复用同一把 key ——
# 手机上的升级包必须同一个签名，换 key 只能卸载重装。
#
# 用法（在 astrbot-chat 下）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/android-release.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/android-release.ps1 -SkipFrontend

param(
  [string]$KeyDir = (Join-Path $env:USERPROFILE ".astrbot-android"),
  [string]$Jdk = $(if ($env:JAVA_HOME) { $env:JAVA_HOME } else { "D:\Dev\android\jdk21" }),
  [string]$Sdk = $(if ($env:ANDROID_HOME) { $env:ANDROID_HOME } elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { "D:\Dev\android\sdk" }),
  [string]$OutDir = $(if (Test-Path "D:\Dev\out") { "D:\Dev\out\releases" } else { Join-Path (Split-Path $PSScriptRoot -Parent) "releases" }),
  [switch]$SkipFrontend
)

$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = Join-Path $env:USERPROFILE ".dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" }
if (-not (Test-Path $node)) { throw "找不到 node：请安装 Node 20+ 并加入 PATH" }
if (-not (Test-Path $Jdk)) { throw "找不到 JDK：$Jdk（用 -Jdk 指定，或设 JAVA_HOME）" }
if (-not (Test-Path $Sdk)) { throw "找不到 Android SDK：$Sdk（用 -Sdk 指定，或设 ANDROID_HOME）" }

$keystore = Join-Path $KeyDir "astrbot-chat-release.jks"
$propsFile = Join-Path $KeyDir "keystore.properties"
$alias = "astrbot-chat"

if (-not (Test-Path $KeyDir)) { New-Item -ItemType Directory -Path $KeyDir | Out-Null }

if (-not (Test-Path $keystore) -or -not (Test-Path $propsFile)) {
  Write-Host "[android] 生成签名密钥：$keystore" -ForegroundColor Cyan
  # 32 位十六进制随机密码；只落在本机这个文件里
  $password = -join ((1..32) | ForEach-Object { "0123456789abcdef"[(Get-Random -Maximum 16)] })
  $keytool = Join-Path $Jdk "bin\keytool.exe"
  & $keytool -genkeypair -v `
    -keystore $keystore -alias $alias `
    -keyalg RSA -keysize 2048 -validity 10000 `
    -storepass $password -keypass $password `
    -dname "CN=AstrBot Chat, OU=Personal, O=AstrBot Chat, C=CN"
  if ($LASTEXITCODE -ne 0) { throw "keytool 失败（exit $LASTEXITCODE）" }
  $props = @"
storeFile=$($keystore -replace '\\', '/')
storePassword=$password
keyAlias=$alias
keyPassword=$password
"@
  # 必须无 BOM：Gradle 的 Properties.load 会把 BOM 当成第一个 key 的一部分
  [System.IO.File]::WriteAllText($propsFile, $props, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "[android] 签名配置：$propsFile（别提交进仓库）" -ForegroundColor Green
}

$version = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version

$env:JAVA_HOME = $Jdk
$env:ANDROID_HOME = $Sdk
$env:ANDROID_SDK_ROOT = $Sdk
$env:ASTRBOT_KEYSTORE_PROPS = $propsFile
$env:Path = "$Jdk\bin;$Sdk\platform-tools;$env:Path"

Push-Location $root
try {
  if (-not $SkipFrontend) {
    Write-Host "[android] 前端构建 + 同步进 Android 工程" -ForegroundColor Cyan
    & $node "node_modules\vite\bin\vite.js" build
    if ($LASTEXITCODE -ne 0) { throw "vite build 失败" }
    & $node "node_modules\@capacitor\cli\bin\capacitor" sync android
    if ($LASTEXITCODE -ne 0) { throw "capacitor sync 失败" }
  }

  Push-Location "android"
  try {
    Write-Host "[android] gradlew assembleRelease（JDK $Jdk）" -ForegroundColor Cyan
    & ".\gradlew.bat" assembleRelease
    if ($LASTEXITCODE -ne 0) { throw "assembleRelease 失败（exit $LASTEXITCODE）" }
  } finally {
    Pop-Location
  }

  $apk = "android\app\build\outputs\apk\release\app-release.apk"
  if (-not (Test-Path $apk)) { throw "没找到 release APK：$apk" }
  $target = Join-Path $OutDir $version
  if (-not (Test-Path $target)) { New-Item -ItemType Directory -Path $target | Out-Null }
  $dest = Join-Path $target "AstrBot-Chat-$version-universal.apk"
  Copy-Item $apk $dest -Force
  $hash = (Get-FileHash $dest -Algorithm SHA256).Hash
  Write-Host "[android] 产物：$dest" -ForegroundColor Green
  Write-Host "[android] SHA256：$hash" -ForegroundColor Green
  Write-Host "[android] 装：adb install -r `"$dest`"" -ForegroundColor Green
} finally {
  Pop-Location
}
