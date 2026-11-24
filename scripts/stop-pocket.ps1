$ErrorActionPreference = "SilentlyContinue"

$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root "logs"
$LogFile = Join-Path $LogDir "launcher.log"

function Write-Log {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $Message
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}

Write-Log "==== 停止 AstrBot Chat 后端 ===="

$targets = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and
    $_.CommandLine -like "*astrbot-chat*" -and (
        $_.CommandLine -like "*server\index.mjs*" -or
        ($_.CommandLine -like "*vite.js*" -and $_.CommandLine -like "*preview*")
    )
}

if (-not $targets) {
    Write-Log "没有找到正在运行的后端进程"
    exit 0
}

foreach ($process in $targets) {
    Stop-Process -Id $process.ProcessId -Force
    Write-Log ("已停止 PID {0}" -f $process.ProcessId)
}

Write-Log "完成。AstrBot 本身不会被关闭。"
Start-Sleep -Seconds 1
