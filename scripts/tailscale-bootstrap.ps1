#Requires -Version 5.1
<#
.SYNOPSIS
  B 方案一键收尾：装 Tailscale（缺就装）→ 登录 → 起 Serve(8443) → 打印手机链接。

.DESCRIPTION
  跑这个脚本之前不用做任何事；它会：
    1) 检查 tailscale.exe，没有就用 winget 装（会弹一次 UAC）；
    2) 没登录就 `tailscale up`，把登录 URL 打开/打印，最多等你 10 分钟；
    3) 检查 tailnet 的 HTTPS 证书开关（没开就打开 admin 页面让你点一下）；
    4) 调 scripts\tailscale-serve.ps1 起 Serve 并自检。

  手机那边仍然要装 Tailscale App、登录同一个账号 —— 账号登录没法替你做。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tailscale-bootstrap.ps1
#>
[CmdletBinding()]
param(
  [switch]$Elevated,
  [int]$Port = 8443,
  [int]$ProxyPort = 8790
)

$ErrorActionPreference = "Stop"

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Find-Tailscale {
  $command = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $candidates = @(
    (Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Tailscale\tailscale.exe")
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  return $null
}

function Write-Step($message) { Write-Host ""; Write-Host "== $message ==" -ForegroundColor Cyan }
function Write-Ok($message) { Write-Host "  [OK] $message" -ForegroundColor Green }
function Write-Warn2($message) { Write-Host "  [!]  $message" -ForegroundColor Yellow }
function Write-Fail($message) {
  Write-Host "  [x]  $message" -ForegroundColor Red
  if ($Elevated) { Read-Host "按回车关闭这个窗口" | Out-Null }
  exit 1
}

if (-not (Test-Admin)) {
  Write-Host "需要管理员权限（装 Tailscale / 改 Serve）。正在弹 UAC，点「是」后会自动继续…" -ForegroundColor Yellow
  $argLine = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Elevated -Port $Port -ProxyPort $ProxyPort"
  Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $argLine
  exit 0
}

# 提权后的窗口里留日志，方便在别的窗口看进度 / 排错
$transcript = Join-Path $env:TEMP "astrbot-tailscale-bootstrap.log"
try { Start-Transcript -Path $transcript -Force | Out-Null } catch { }

# ---------------- 1. 装 Tailscale ----------------
Write-Step "1/4 检查 / 安装 Tailscale"
$tsExe = Find-Tailscale
if (-not $tsExe) {
  Write-Warn2 "没装 Tailscale，开始用 winget 安装（约 30–60 秒）"
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Fail "这台机器没有 winget：去 https://tailscale.com/download/windows 手动装完再跑本脚本"
  }
  & winget install --id Tailscale.Tailscale -e --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    Write-Fail "winget 安装失败（退出码 $LASTEXITCODE）：手动装 https://tailscale.com/download/windows"
  }
  for ($i = 0; $i -lt 30; $i++) {
    $tsExe = Find-Tailscale
    if ($tsExe) { break }
    Start-Sleep -Seconds 1
  }
}
if (-not $tsExe) { Write-Fail "装完了但找不到 tailscale.exe：重启一次 PowerShell 再跑" }
Write-Ok "tailscale = $tsExe"

# ---------------- 2. 登录 ----------------
Write-Step "2/4 登录 Tailscale"
$status = $null
try { $status = (& $tsExe status --json 2>$null) | ConvertFrom-Json } catch { $status = $null }
$state = ""
if ($status -and $status.BackendState) { $state = [string]$status.BackendState }

if ($state -ne "Running") {
  Write-Warn2 "当前状态：$state（需要在浏览器里用 Tailscale 账号登录）"
  $job = Start-Job -ScriptBlock { param($exe) & $exe up --accept-routes } -ArgumentList $tsExe
  $authUrl = ""
  $deadline = (Get-Date).AddMinutes(10)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    try { $status = (& $tsExe status --json 2>$null) | ConvertFrom-Json } catch { continue }
    if ($status.AuthURL -and [string]$status.AuthURL -ne $authUrl) {
      $authUrl = [string]$status.AuthURL
      Write-Host ""
      Write-Host "  登录地址（已尝试自动打开）：" -ForegroundColor White
      Write-Host "    $authUrl" -ForegroundColor Yellow
      try { Start-Process $authUrl } catch { }
    }
    if ($status.BackendState -eq "Running") { break }
  }
  if (-not $status -or $status.BackendState -ne "Running") {
    Stop-Job $job -ErrorAction SilentlyContinue
    Remove-Job $job -Force -ErrorAction SilentlyContinue
    Write-Fail "10 分钟内没等到登录完成：重新跑本脚本，或先手动 tailscale up 登录"
  }
  Stop-Job $job -ErrorAction SilentlyContinue
  Remove-Job $job -Force -ErrorAction SilentlyContinue
  Write-Ok "已登录 tailnet"
} else {
  Write-Ok "已登录 tailnet"
}

# ---------------- 3. HTTPS 证书开关 ----------------
Write-Step "3/4 检查 HTTPS 证书开关"
$hasCertDomains = @($status.PSObject.Properties.Name) -contains "CertDomains"
if ($hasCertDomains -and @($status.CertDomains).Count -eq 0) {
  Write-Warn2 "tailnet 还没开 HTTPS 证书（Serve 8443 需要）"
  Write-Host "  去 https://login.tailscale.com/admin/dns 打开 MagicDNS + HTTPS Certificates" -ForegroundColor White
  try { Start-Process "https://login.tailscale.com/admin/dns" } catch { }
  Read-Host "  开好之后按回车"
} else {
  Write-Ok "HTTPS 证书开关检查通过（或该版本没有此字段）"
}

# ---------------- 4. 起 Serve ----------------
Write-Step "4/4 起 Serve（8443）"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "tailscale-serve.ps1") -Port $Port -ProxyPort $ProxyPort
$code = $LASTEXITCODE

if ($Elevated) {
  Write-Host ""
  Write-Host "（这个窗口是提权打开的，按回车关闭）" -ForegroundColor DarkGray
  Read-Host | Out-Null
}
exit $code
