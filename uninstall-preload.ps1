<#
  卸载「固定 4K」preload 补丁：优先用备份还原，没有备份就剥掉补丁块。
  用法： powershell -ExecutionPolicy Bypass -File .\uninstall-preload.ps1
        powershell -ExecutionPolicy Bypass -File .\uninstall-preload.ps1 -InstallRoot 'D:\软件\抖音\douyin' -Version '8.7.0'
#>
[CmdletBinding()]
param(
  [string]$InstallRoot = 'D:\软件\抖音\douyin',
  [string]$Version = '',
  [switch]$AllowRunning
)

$ErrorActionPreference = 'Stop'

if (-not $Version) {
  $cand = Get-ChildItem -LiteralPath $InstallRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
    Sort-Object { [version]$_.Name } -Descending
  if (-not $cand) { throw "在 $InstallRoot 下找不到版本目录" }
  $Version = $cand[0].Name
}

$Preload = Join-Path $InstallRoot "$Version\resources\app.asar.unpacked\preload.js"
$Backup = "$Preload.dypc4k.bak"
if (-not (Test-Path -LiteralPath $Preload)) { throw "找不到 preload.js: $Preload" }

if ((Get-Process -Name douyin, douyin_tray -ErrorAction SilentlyContinue) -and -not $AllowRunning) {
  throw '抖音正在运行，请先从托盘完全退出后再卸载（或加 -AllowRunning，重启抖音生效）'
}

if (Test-Path -LiteralPath $Backup) {
  Copy-Item -LiteralPath $Backup -Destination $Preload -Force
  Write-Host "[+] 已用备份还原 preload.js" -ForegroundColor Green
} else {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $content = [System.IO.File]::ReadAllText($Preload, [System.Text.Encoding]::UTF8)
  $stripped = [regex]::Replace($content, "(?s)\r?\n?/\* ==== dypc4k begin ==== \*/.*?/\* ==== dypc4k end ==== \*/", '')
  $stripped = [regex]::Replace($stripped, "(?s)\r?\n?/\* ==== dypc4k-probe begin ==== \*/.*?/\* ==== dypc4k-probe end ==== \*/", '')
  $stripped = [regex]::Replace($stripped, "(?s)\r?\n?/\* ==== dypc4k-probe2 begin ==== \*/.*?/\* ==== dypc4k-probe2 end ==== \*/", '')
  if ($stripped -eq $content) { Write-Host '[-] 没发现补丁块，文件未改动'; return }
  [System.IO.File]::WriteAllText($Preload, $stripped.TrimEnd() + [Environment]::NewLine, $utf8)
  Write-Host "[+] 已剥掉补丁块（无备份）" -ForegroundColor Green
}

Write-Host ("    当前 md5: " + (Get-FileHash -LiteralPath $Preload -Algorithm MD5).Hash.ToLower())
Write-Host '    8.7.0 原版应为 bfcb8e31fae5a7370c5bee258ffcdfad（可对照 md5.json）'
