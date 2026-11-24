#Requires -Version 5.1
<#
.SYNOPSIS
  生成「手机通过 HTTPS 访问本机 BFF」用的自签证书（本机 CA + 服务器证书）。

.DESCRIPTION
  为什么要这一步：`http://<PC-IP>:8788` **不是安全上下文**，于是
  `crypto.randomUUID` / `navigator.mediaDevices` / `navigator.serviceWorker`
  全都不存在 —— 手机上录不了音、装不了 PWA（详见 docs/交接-2026-11-18-手机端.md）。

  这套证书的组成：
    * 本机 CA（10 年）—— 手机装的就是它，装一次就行；
    * 服务器证书（800 天，<825 天满足 iOS 限制）—— SAN 里带上本机当前所有 IPv4，
      CN 是 `AstrBot Chat LAN`，由上面那张 CA 签出来。

  输出（默认 `%APPDATA%\com.astrbot.chat\tls`）：
    AstrBotChat-CA.cer        手机要装的 CA（DER，安卓/iOS 都能直接选）
    AstrBotChat-CA.pfx        带私钥的 CA：换 IP 时重跑本脚本会复用它，手机不用重装
    lan-server.pfx            服务器证书 + 私钥（BFF 用 pfx + 口令加载）
    lan-server.pfx.pass       pfx 口令（明文，仅本机 %APPDATA%）
    README.txt                给手机端看的安装步骤

  桌面壳会自己读这个目录：拿到 `lan-server.pfx` 就额外监听 8789（HTTPS），
  并把「设置 → 手机访问」里的链接换成 https。没有证书就还是纯 HTTP，行为不变。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\lan-tls.ps1

.EXAMPLE
  # 换了 Wi-Fi / IP 变了：只用重发服务器证书（CA 复用，手机不用重装）
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\lan-tls.ps1

.EXAMPLE
  # CA 也要重建（手机得重新装一次）
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\lan-tls.ps1 -Force
#>
[CmdletBinding()]
param(
  [string]$OutDir = (Join-Path $env:APPDATA "com.astrbot.chat\tls"),
  [switch]$Force,
  [switch]$NoTrust
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Core

$OutDir = [IO.Path]::GetFullPath($OutDir)
[void][IO.Directory]::CreateDirectory($OutDir)

$caPfxPath = Join-Path $OutDir "AstrBotChat-CA.pfx"
$caPassPath = Join-Path $OutDir "AstrBotChat-CA.pass"
$caCerPath = Join-Path $OutDir "AstrBotChat-CA.cer"
$leafPfxPath = Join-Path $OutDir "lan-server.pfx"
$leafPassPath = Join-Path $OutDir "lan-server.pfx.pass"

$Hash = [System.Security.Cryptography.HashAlgorithmName]::SHA256
$Pad = [System.Security.Cryptography.RSASignaturePadding]::Pkcs1

function New-Password([int]$length = 28) {
  $chars = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  $bytes = New-Object byte[] $length
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}

function New-CertificateAuthority {
  $key = [System.Security.Cryptography.RSA]::Create(3072)
  $req = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    "CN=AstrBot Chat Local CA, O=AstrBot Chat",
    $key,
    $Hash,
    $Pad
  )
  # CA=true，pathlength=0：只能签终端证书，不能再签中间 CA
  $req.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true)
  ) | Out-Null
  $req.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
      [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor
      [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign -bor
      [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature,
      $true
    )
  ) | Out-Null
  $req.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($req.PublicKey, $false)
  ) | Out-Null
  return $req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddYears(10))
}

function New-ServerCertificate($ca, [string[]]$ips) {
  $key = [System.Security.Cryptography.RSA]::Create(2048)
  $req = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    "CN=AstrBot Chat LAN, O=AstrBot Chat",
    $key,
    $Hash,
    $Pad
  )
  $req.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true)
  ) | Out-Null
  $req.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
      [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor
      [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment,
      $true
    )
  ) | Out-Null
  $oids = [System.Security.Cryptography.OidCollection]::new()
  $oids.Add([System.Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.1")) | Out-Null # serverAuth
  $req.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids, $false)
  ) | Out-Null

  $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
  $san.AddDnsName("localhost")
  if ($env:COMPUTERNAME) { $san.AddDnsName($env:COMPUTERNAME.ToLower()) }
  $san.AddIpAddress([System.Net.IPAddress]::Loopback)
  foreach ($ip in $ips) {
    try { $san.AddIpAddress([System.Net.IPAddress]::Parse($ip)) } catch { }
  }
  $req.CertificateExtensions.Add($san.Build()) | Out-Null

  $serial = New-Object byte[] 16
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($serial) } finally { $rng.Dispose() }
  $serial[0] = 0x01 # 别让序列号最高位是 1（会被当成负数）

  # 800 天：iOS 13+ 拒绝有效期超过 825 天的服务器证书
  $cert = $req.Create($ca, [DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddDays(800), $serial)
  # CopyWithPrivateKey 是扩展方法，PowerShell 里要显式走扩展类
  return [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($cert, $key)
}

function Add-ToRootStore([string]$cerPath) {
  $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($cerPath)
  $store = [System.Security.Cryptography.X509Certificates.X509Store]::new("Root", "CurrentUser")
  $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
  try {
    $found = $store.Certificates | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
    if (-not $found) { $store.Add($cert) }
  } finally {
    $store.Close()
  }
}

# ---------------- 1. CA：有就复用，没有（或 -Force）就新建 ----------------
$ca = $null
if (-not $Force -and (Test-Path $caPfxPath) -and (Test-Path $caPassPath) -and (Test-Path $caCerPath)) {
  $caPassword = (Get-Content -Raw $caPassPath).Trim()
  try {
    $ca = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
      $caPfxPath,
      $caPassword,
      [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable
    )
    Write-Host "复用已有 CA：$($ca.Thumbprint)" -ForegroundColor DarkGray
  } catch {
    Write-Warning "已有 CA 读不出来（$($_.Exception.Message)），改成新建一张"
    $ca = $null
  }
}

$caCreated = $false
if (-not $ca) {
  $caPassword = New-Password
  $ca = New-CertificateAuthority

  $caPfxBytes = $ca.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $caPassword)
  [IO.File]::WriteAllBytes($caPfxPath, $caPfxBytes)
  Set-Content -Path $caPassPath -Value $caPassword -NoNewline -Encoding ascii
  # 只导公钥部分（手机装的就是这个）
  [IO.File]::WriteAllBytes(
    $caCerPath,
    $ca.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
  )
  $caCreated = $true
  Write-Host "已新建 CA：$($ca.Thumbprint)" -ForegroundColor Green
}

# ---------------- 2. 本机 IPv4（手机要访问的那个） ----------------
$ips = @(
  Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
    Select-Object -ExpandProperty IPAddress -Unique
)
if (-not $ips) { $ips = @() }
Write-Host ("SAN 里的 IP：" + (($ips -join ", "))) -ForegroundColor DarkGray

# ---------------- 3. 服务器证书 ----------------
$leafPassword = New-Password
$leaf = New-ServerCertificate $ca $ips
$leafPfxBytes = $leaf.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $leafPassword)
[IO.File]::WriteAllBytes($leafPfxPath, $leafPfxBytes)
Set-Content -Path $leafPassPath -Value $leafPassword -NoNewline -Encoding ascii
Write-Host "已签发服务器证书：$($leaf.Thumbprint)（有效期到 $($leaf.NotAfter.ToString('yyyy-MM-dd'))）" -ForegroundColor Green

# ---------------- 4. 本机信任 CA（Edge / Chrome 上也能直接验） ----------------
if ($NoTrust) {
  Write-Host "跳过本机信任 CA（-NoTrust）" -ForegroundColor DarkGray
} else {
  try {
    Add-ToRootStore $caCerPath
    Write-Host "已把 CA 装进「当前用户 → 受信任的根证书颁发机构」" -ForegroundColor Green
  } catch {
    Write-Warning "装进本机根存储失败：$($_.Exception.Message)（手机端的步骤不受影响）"
  }
}

# ---------------- 5. 给手机看的说明 ----------------
$bffPort = 8788
$httpsPort = 8789
$lines = @(
  "AstrBot Chat 局域网 HTTPS",
  "",
  "1) 手机装 CA（只装一次）",
  "   手机浏览器打开： http://<电脑局域网IP>:$bffPort/ca.cer",
  "   （桌面端「设置 → 手机访问」里也有这个下载地址）",
  "   Android：设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书",
  "   iOS    ：设置 → 已下载描述文件 → 安装 → 通用 → 关于本机 → 证书信任设置 → 打开完全信任",
  "",
  "2) 之后用 https 打开应用",
  "   https://<电脑局域网IP>:$httpsPort/?t=<令牌>",
  "   令牌在桌面端「设置 → 手机访问」里（这里只放端口，不写令牌）。",
  "",
  "3) 换了 Wi-Fi / IP 变了？",
  "   重跑一次 scripts\lan-tls.ps1（CA 复用，手机不用重装）。",
  "",
  "证书目录：$OutDir",
  "CA 指纹：$($ca.Thumbprint)",
  "服务器证书到期：$($leaf.NotAfter.ToString('yyyy-MM-dd'))"
)
[IO.File]::WriteAllLines((Join-Path $OutDir "README.txt"), $lines, (New-Object System.Text.UTF8Encoding $false))

Write-Host ""
Write-Host "== 完成 ==" -ForegroundColor Cyan
Write-Host "目录：$OutDir"
Write-Host "手机装 CA：http://<电脑局域网IP>:$bffPort/ca.cer"
Write-Host "装完用 https://<电脑局域网IP>:$httpsPort/?t=<令牌> 打开（令牌见设置页）"
if ($caCreated) {
  Write-Host "注意：这是新 CA，手机上要重新装一次（旧的可以删掉）。" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "让桌面壳生效：设置 → 手机访问 关掉再打开（会重启 BFF）。"
