#Requires -Version 5.1
<#
.SYNOPSIS
  用 Tailscale Serve 把本机 BFF 发布到 tailnet（默认 HTTPS 8443），并做「链接防火」自检。

.DESCRIPTION
  为什么是 8443：手机 APK 的「连接电脑」页会把**没有端口**的 https 链接补成 :8789
  （src/core/connection.ts），而 URL 规范会把显式 :443 吃掉 —— 所以 443 的公网地址
  APK 连不上。Tailscale Serve 的 HTTPS 端口只有 443 / 8443 / 10000 三个，选 8443
  正好绕开这个坑，APK 现有版本不用改。

  为什么要「链接防火」：8788 的令牌门对回环请求是放行的（桌面壳自己不带令牌），
  本机反代（tailscaled）连 127.0.0.1 时源地址也是回环 —— 如果直接反代 8788，
  链接里的 ?t= 就形同虚设，URL 一泄露等于把整个 BFF 交出去。所以：
    * 新版本 BFF 会另开 127.0.0.1:8790（BFF_PROXY_PORT），**永远要求令牌**；
      本脚本优先反代它；
    * 还没重装桌面端时，退而反代 http://<局域网IP>:8788 —— BFF 看到的是非回环
      地址，同样会校验令牌；
    * 外加 Referrer-Policy / frame-ancestors / noindex 等安全头（BFF 已内置）。

  这个脚本只做「tailnet 内可见」的 Serve，不会开 Funnel（公网）。检测到 Funnel
  会明确警告：那等于把入口挂到公网，只靠链接本身的令牌。

.PARAMETER Port
  Tailscale Serve 的 HTTPS 端口，默认 8443（只能是 443 / 8443 / 10000）。

.PARAMETER Off
  关掉这个端口的 Serve 配置（不动其它端口 / 不动令牌）。

.PARAMETER NoVerify
  跳过最后的「从 tailnet 域名回连」自检（MagicDNS 在本机解析不了时用）。

.PARAMETER ProxyPort
  BFF 反代专用端口，默认 8790（和 src-tauri/src/bff.rs 的 BFF_PROXY_PORT 一致）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tailscale-serve.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tailscale-serve.ps1 -Off
#>
[CmdletBinding()]
param(
  [int]$Port = 8443,
  [int]$ProxyPort = 8790,
  [switch]$Off,
  [switch]$NoVerify
)

$ErrorActionPreference = "Stop"

function Write-Ok($message) { Write-Host "  [OK] $message" -ForegroundColor Green }
function Write-Warn2($message) { Write-Host "  [!]  $message" -ForegroundColor Yellow }
function Write-Fail($message) { Write-Host "  [x]  $message" -ForegroundColor Red }
function Write-Info($message) { Write-Host "       $message" -ForegroundColor DarkGray }

function Exit-Fail($message) {
  Write-Fail $message
  exit 1
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

function Get-OutboundIPv4 {
  # 和 BFF / 桌面壳的 local_ipv4() 同思路：UDP connect 只选路由，不发包
  $udp = New-Object System.Net.Sockets.UdpClient
  try {
    $udp.Connect("8.8.8.8", 80)
    return $udp.Client.LocalEndPoint.Address.ToString()
  } finally {
    $udp.Close()
  }
}

function Get-HttpCode {
  param([string]$Url, [string]$Token)
  if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
    Exit-Fail "系统里没有 curl.exe（Windows 10 1803+ 自带），没法做自检"
  }
  $curlArgs = @("-s", "-k", "-o", "NUL", "-w", "%{http_code}", "--max-time", "10")
  if ($Token) { $curlArgs += @("-H", "x-astrbot-token: $Token") }
  $curlArgs += $Url
  $code = $null
  try { $code = & curl.exe @curlArgs 2>$null } catch { $code = $null }
  if ($null -eq $code -or "$code".Trim() -eq "") { return 0 }
  try { return [int]("$code".Trim()) } catch { return 0 }
}

# ---------------- 0. 参数检查 ----------------
if (@(443, 8443, 10000) -notcontains $Port) {
  Exit-Fail "Tailscale Serve 的 HTTPS 端口只能是 443 / 8443 / 10000，收到 $Port"
}
if ($Port -eq 443) {
  Write-Warn2 "443 只能用手机浏览器 / PWA；APK 会把无端口的 https 链接补成 :8789，连不上"
}

$tsExe = Find-Tailscale
if (-not $tsExe) {
  Write-Fail "没找到 tailscale.exe"
  Write-Info "安装：winget install --id Tailscale.Tailscale -e   然后登录一次（需要 UAC / 浏览器）"
  Write-Info "装完先执行 tailscale up，手机上也装 Tailscale 并登录同一个 tailnet"
  exit 1
}
Write-Ok "tailscale = $tsExe"

# ---------------- 1. 登录状态 / 机器名 ----------------
$statusJson = & $tsExe status --json 2>$null
if ($LASTEXITCODE -ne 0 -or -not $statusJson) {
  Exit-Fail "tailscale 没登录或 tailscaled 没在跑：先执行 tailscale up"
}
try { $status = $statusJson | ConvertFrom-Json } catch { Exit-Fail "tailscale status --json 解析失败" }

$dnsName = ""
if ($status.Self -and $status.Self.DNSName) {
  $dnsName = ([string]$status.Self.DNSName).TrimEnd(".")
}
if (-not $dnsName) {
  Exit-Fail "拿不到本机 tailnet DNS 名：确认已登录、MagicDNS 已开启"
}
Write-Ok "tailnet 机器名 = $dnsName"

$hasCertDomains = @($status.PSObject.Properties.Name) -contains "CertDomains"
if ($hasCertDomains) {
  $certDomains = @($status.CertDomains)
  if ($certDomains.Count -eq 0) {
    Write-Warn2 "tailnet 还没开 HTTPS 证书：去 admin 控制台 → DNS → 打开 HTTPS Certificates"
  }
} else {
  Write-Info "（这个 tailscale 版本没有 CertDomains 字段，跳过 HTTPS 证书开关检查）"
}

# ---------------- 2. -Off：只关这个端口 ----------------
if ($Off) {
  & $tsExe serve "--https=$Port" off 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    & $tsExe serve "https:$Port" off 2>&1 | Out-Null
  }
  if ($LASTEXITCODE -ne 0) {
    Write-Fail "没关掉端口 $Port 的 Serve（当前版本语法可能不同）"
    Write-Info "看 tailscale serve status，或手动 tailscale serve off（会关掉所有 serve 规则）"
    exit 1
  }
  Write-Ok "已关闭 https:$Port 的 Serve（令牌 / 设置都没动）"
  Write-Info "手机上的旧链接会 404/连不上；重新开就是再跑一次本脚本"
  exit 0
}

# ---------------- 3. 读桌面端设置（令牌 / 开关） ----------------
$settingsPath = Join-Path $env:APPDATA "com.astrbot.chat\settings.json"
if (-not (Test-Path $settingsPath)) {
  Exit-Fail "没找到 $settingsPath —— 先启动一次 AstrBot Chat"
}
$settings = Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $settings.lanAccess) {
  Exit-Fail "桌面端「设置 → 桌面端 → 手机访问」还没打开（令牌没生成，Serve 没有可校验的东西）"
}
$token = [string]$settings.lanToken
if ($token.Length -lt 16) {
  Exit-Fail "lanToken 是空的：桌面端里点一次「重置配对」或关/开一次「手机访问」"
}
Write-Ok "已读到配对令牌（长度 $($token.Length)，不打印）"

# ---------------- 4. 选源站：优先 8790（强制令牌），否则退回局域网 IP ----------------
$lanIp = Get-OutboundIPv4
Write-Info "本机出口 IPv4 = $lanIp"

$proxyHealth = Get-HttpCode "http://127.0.0.1:$ProxyPort/astrbot/api/health" $token
$useProxy = $false
$target = ""
$lanHealth = 0
if (@(200, 503) -contains $proxyHealth) {
  $useProxy = $true
  $target = "http://127.0.0.1:$ProxyPort"
  Write-Ok "反代专用端口 127.0.0.1:$ProxyPort 在跑（强制令牌）"
} elseif ($proxyHealth -eq 401) {
  Exit-Fail "8790 返回 401：设置里的令牌和 BFF 当前用的令牌不一致 —— 重启一次 AstrBot Chat（或重置配对后再试）"
} else {
  Write-Warn2 "8790 没在监听（桌面端还是旧版本）→ 退回 http://${lanIp}:8788"
  Write-Info "想立刻用强制令牌（不等新版桌面端）：setx BFF_PROXY_PORT 8790 → 完全退出并重启 AstrBot Chat → 再跑本脚本"
  $lanHealth = Get-HttpCode "http://${lanIp}:8788/astrbot/api/health" $token
  if (@(200, 503) -contains $lanHealth) {
    $target = "http://${lanIp}:8788"
    Write-Ok "局域网入口 http://${lanIp}:8788 可用（同样会校验令牌）"
  } else {
    Exit-Fail "BFF 没起来（8790 与 http://${lanIp}:8788 都不通）。先启动 AstrBot Chat，并确认「手机访问」开着"
  }
}
if ($proxyHealth -eq 503 -or $lanHealth -eq 503) {
  Write-Warn2 "BFF 在，但连不上 AstrBot（health 503）：页面能开，聊天会报错，先把 AstrBot 拉起来"
}

# ---------------- 5. 起 Serve（兼容新旧语法） ----------------
Write-Info "tailscale serve --bg --https=$Port $target"
& $tsExe serve --bg "--https=$Port" $target 2>&1 | ForEach-Object { Write-Host "       $_" -ForegroundColor DarkGray }
if ($LASTEXITCODE -ne 0) {
  Write-Warn2 "新语法失败，试旧语法 https:$Port / $target"
  & $tsExe serve --bg "https:$Port" "/" $target 2>&1 | ForEach-Object { Write-Host "       $_" -ForegroundColor DarkGray }
}
if ($LASTEXITCODE -ne 0) {
  Exit-Fail "tailscale serve 没成功：看 tailscale serve --help（版本差异）、确认 HTTPS 证书已开启，或换管理员 PowerShell 重跑"
}
Write-Ok "Serve 已配置（后台常驻，tailscaled 重启也保留）"

# ---------------- 6. 确认没开 Funnel（公网） ----------------
$serveStatus = (& $tsExe serve status 2>&1) -join "`n"
if ($serveStatus.Trim()) {
  Write-Host ""
  Write-Host "  tailscale serve status:" -ForegroundColor DarkGray
  $serveStatus -split "`n" | ForEach-Object { Write-Host "       $_" -ForegroundColor DarkGray }
}
if ($serveStatus -match "Funnel on") {
  Write-Warn2 "检测到 Funnel 相关配置：Funnel 会把入口暴露到公网，只靠链接里的令牌，不建议"
}
$funnelStatus = (& $tsExe funnel status 2>&1) -join "`n"
# 注意：这个版本（1.104.7）的 `funnel status` 会把 **serve** 记录一起打出来，
# 每条末尾标 `(tailnet only)`。所以不能看到 https:// 就报警 —— 只有不带该标记的
# 才是真的 Funnel（公网）暴露。
$funnelPublic = @(
  ($funnelStatus -split "`n") |
    Where-Object { $_ -match "https://" -and $_ -notmatch "\(tailnet only\)" }
) -join "`n"
if ($funnelPublic.Trim()) {
  Write-Warn2 "tailscale funnel status 显示有公网暴露；确认不是你想要的（关掉：tailscale funnel reset）"
  Write-Info $funnelPublic.Trim()
} else {
  Write-Ok "没有 Funnel：入口只在 tailnet 内可见"
}

# ---------------- 7. 链接防火自检 ----------------
$base = "https://${dnsName}:$Port"
$verifyOk = $true
if ($NoVerify) {
  Write-Warn2 "跳过回连自检（-NoVerify）"
} else {
  # 第一次访问可能还在签证书：最多等 3 轮，每轮 3 秒
  $nakedPage = 0
  $nakedApi = 0
  $tokenApi = 0
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $nakedPage = Get-HttpCode "$base/" ""
    $nakedApi = Get-HttpCode "$base/astrbot/api/health" ""
    $tokenApi = Get-HttpCode "$base/astrbot/api/health" $token
    if ($nakedPage -eq 401 -and $nakedApi -eq 401 -and (@(200, 503) -contains $tokenApi)) { break }
    if ($attempt -lt 3) { Start-Sleep -Seconds 3 }
  }

  if ($nakedPage -eq 401 -and $nakedApi -eq 401) {
    Write-Ok "裸链接（不带 ?t=）被拒：401 —— 泄露的 URL 本身不是通行证"
  } else {
    $verifyOk = $false
    Write-Warn2 "裸链接没有被令牌门拦住（页面 $nakedPage / API $nakedApi）"
  }
  if (@(200, 503) -contains $tokenApi) {
    Write-Ok "带令牌访问 health = $tokenApi（200 = 全通，503 = BFF 连不上 AstrBot）"
  } else {
    $verifyOk = $false
    Write-Warn2 "带令牌访问 health = $tokenApi（预期 200/503）"
  }
}

# ---------------- 8. 输出 ----------------
Write-Host ""
Write-Host "== 完成 ==" -ForegroundColor Cyan
Write-Host ""
Write-Host "  手机 APK（连接页粘贴，必须带 :$Port）：" -ForegroundColor White
Write-Host "    $base/?t=$token" -ForegroundColor Yellow
Write-Host ""
Write-Host "  手机 / PC 浏览器 / 新装 PWA：同上（打开后 ?t= 会变成 cookie，地址栏不再带令牌）"
Write-Host ""
Write-Host "  让桌面端的二维码也显示这条链接（0.2.25+）：" -ForegroundColor White
Write-Host "    设置 → 桌面 → 手机访问 → 远程地址，填：https://${dnsName}:$Port" -ForegroundColor Yellow
Write-Host "    （填完二维码 / 复制链接都用它，换 Wi-Fi 不用重配；清空就退回局域网地址）"
Write-Host ""
Write-Host "  链接防火（已经生效的）：" -ForegroundColor White
Write-Host "    * 裸链接 401；令牌 = 密码，别截图外发"
Write-Host "    * Referrer-Policy: no-referrer / frame-ancestors 'none' / noindex"
Write-Host "    * 只在本 tailnet 可见；不要开 tailscale funnel"
Write-Host "    * 换令牌：桌面端「重置配对」→ 旧链接、旧 cookie 立即失效"
Write-Host ""
Write-Host "  常用：" -ForegroundColor White
Write-Host "    tailscale serve status"
Write-Host "    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tailscale-serve.ps1 -Off"
Write-Host ""

if (-not $verifyOk) {
  Write-Warn2 "自检有未通过项：先处理上面的 [!]，再从手机试一次"
  exit 2
}
