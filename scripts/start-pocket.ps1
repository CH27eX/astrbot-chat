param(
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir "launcher.log"

function Write-Log {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $Message
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

function Resolve-Node {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe"),
        "C:\Program Files\nodejs\node.exe",
        (Join-Path $env:USERPROFILE ".dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return $candidate }
    }
    throw "找不到 Node.js。请安装 Node 20+，或把 node.exe 放到 PATH 里。"
}

function Get-AstrBotProcesses {
    Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -like "*astrbot_launcher*" -and
            $_.CommandLine -like "*main.py*"
        }
}

function Test-Url {
    param([string]$Url)
    try {
        $response = Invoke-WebRequest -Uri $Url -TimeoutSec 2 -UseBasicParsing
        return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400)
    } catch {
        return $false
    }
}

function Wait-AstrBot {
    param([int]$TimeoutSeconds = 180)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        foreach ($process in Get-AstrBotProcesses) {
            $ports = Get-NetTCPConnection -OwningProcess $process.ProcessId -State Listen -ErrorAction SilentlyContinue |
                Select-Object -ExpandProperty LocalPort -Unique
            foreach ($port in $ports) {
                try {
                    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/v1/auth/setup-status" -TimeoutSec 2 -UseBasicParsing
                    if ($response.StatusCode -eq 200 -and $response.Content -match "setup_required") {
                        return [int]$port
                    }
                } catch {
                    # 不是 AstrBot 的端口，继续试
                }
            }
        }
        Start-Sleep -Seconds 2
    }
    return 0
}

function Wait-Url {
    param([string]$Url, [int]$TimeoutSeconds = 40)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Url $Url) { return $true }
        Start-Sleep -Milliseconds 800
    }
    return $false
}

function Get-LatestSourceTime {
    $items = @()
    $items += Get-ChildItem (Join-Path $Root "src") -Recurse -File -ErrorAction SilentlyContinue
    $items += Get-ChildItem (Join-Path $Root "public") -Recurse -File -ErrorAction SilentlyContinue
    foreach ($name in @("index.html", "vite.config.ts")) {
        $path = Join-Path $Root $name
        if (Test-Path $path) { $items += Get-Item $path }
    }
    if ($items.Count -eq 0) { return [datetime]::MinValue }
    return ($items | Measure-Object -Property LastWriteTime -Maximum).Maximum
}

try {
    Write-Log "==== 启动 AstrBot Chat ===="

    $node = Resolve-Node
    Write-Log "Node: $node"

    # 1. AstrBot
    $astrbot = @(Get-AstrBotProcesses)
    if ($astrbot.Count -eq 0) {
        $launcher = Join-Path $env:LOCALAPPDATA "AstrBot Launcher\astrbot-launcher.exe"
        if (-not (Test-Path $launcher)) {
            throw "找不到 AstrBot Launcher：$launcher"
        }
        $launcherProcess = Get-Process -Name "astrbot-launcher" -ErrorAction SilentlyContinue
        if ($launcherProcess) {
            Write-Log "AstrBot 启动器已打开，等待实例启动…"
        } else {
            Write-Log "启动 AstrBot 启动器…"
            Start-Process -FilePath $launcher
            Start-Sleep -Seconds 3
        }
    } else {
        Write-Log ("AstrBot 已在运行（PID: {0}）" -f (($astrbot | ForEach-Object { $_.ProcessId }) -join ", "))
    }

    Write-Log "等待 AstrBot 就绪（最多 180 秒）…"
    $port = Wait-AstrBot -TimeoutSeconds 180
    if ($port -eq 0) {
        throw "AstrBot 在 180 秒内没有就绪。如果启动器已经打开，请先在窗口里点「启动实例」，再重新双击本脚本。"
    }
    Write-Log "AstrBot 就绪：http://127.0.0.1:$port"

    # 2. BFF
    $bffHealth = "http://127.0.0.1:8788/astrbot/api/health"
    if (Test-Url $bffHealth) {
        Write-Log "BFF 已在运行"
    } else {
        Write-Log "启动 BFF…"
        $bffScript = Join-Path $Root "server\index.mjs"
        $bffOut = Join-Path $LogDir "bff.out.log"
        $bffErr = Join-Path $LogDir "bff.err.log"
        Remove-Item $bffOut, $bffErr -Force -ErrorAction SilentlyContinue
        Start-Process -FilePath $node `
            -ArgumentList @($bffScript) `
            -WorkingDirectory $Root `
            -WindowStyle Hidden `
            -RedirectStandardOutput $bffOut `
            -RedirectStandardError $bffErr | Out-Null
        if (-not (Wait-Url $bffHealth 40)) {
            throw "BFF 启动失败。查看 logs\bff.err.log。"
        }
        Write-Log "BFF 就绪"
    }

    # 3. PWA 静态服务
    $pwaUrl = "http://127.0.0.1:4173"
    if (Test-Url $pwaUrl) {
        Write-Log "PWA 服务已在运行"
    } else {
        $vite = Join-Path $Root "node_modules\vite\bin\vite.js"
        if (-not (Test-Path $vite)) {
            throw "缺少前端依赖。请先在 astrbot-chat 目录执行 pnpm install。"
        }

        $distIndex = Join-Path $Root "dist\index.html"
        $needBuild = -not (Test-Path $distIndex)
        if (-not $needBuild) {
            $sourceTime = Get-LatestSourceTime
            $distTime = (Get-Item $distIndex).LastWriteTime
            if ($sourceTime -gt $distTime) { $needBuild = $true }
        }

        if ($needBuild) {
            Write-Log "构建前端…"
            $buildLog = Join-Path $LogDir "build.log"
            Push-Location $Root
            try {
                & $node $vite build *> $buildLog
                if ($LASTEXITCODE -ne 0) {
                    throw "前端构建失败。查看 logs\build.log。"
                }
            } finally {
                Pop-Location
            }
            Write-Log "构建完成"
        }

        Write-Log "启动 PWA 服务…"
        $previewOut = Join-Path $LogDir "preview.out.log"
        $previewErr = Join-Path $LogDir "preview.err.log"
        Remove-Item $previewOut, $previewErr -Force -ErrorAction SilentlyContinue
        Start-Process -FilePath $node `
            -ArgumentList @($vite, "preview") `
            -WorkingDirectory $Root `
            -WindowStyle Hidden `
            -RedirectStandardOutput $previewOut `
            -RedirectStandardError $previewErr | Out-Null
        if (-not (Wait-Url $pwaUrl 40)) {
            throw "PWA 服务启动失败。查看 logs\preview.err.log。"
        }
        Write-Log "PWA 服务就绪"
    }

    # 4. 打开窗口
    if (-not $NoBrowser) {
        $edgeCandidates = @(
            "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            "C:\Program Files\Google\Chrome\Application\chrome.exe",
            "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
        )
        $browser = $edgeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
        if ($browser) {
            Write-Log "打开应用窗口…"
            Start-Process -FilePath $browser -ArgumentList @(
                "--app=http://localhost:4173",
                "--window-size=1100,820"
            ) | Out-Null
        } else {
            Write-Log "打开默认浏览器…"
            Start-Process "http://localhost:4173" | Out-Null
        }
    }

    Write-Log "完成。可以关闭这个窗口。"
    Start-Sleep -Seconds 2
    exit 0
} catch {
    Write-Log ("错误：{0}" -f $_.Exception.Message)
    exit 1
}
