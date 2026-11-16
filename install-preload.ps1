<#
  安装「固定 4K」preload 补丁（改文件方案，可选）
  ------------------------------------------------------------
  作用：把 dypc4k 注入片段追加到抖音客户端的 web preload.js 末尾。
        preload 在网页脚本之前执行，所以每一帧、每次启动都会先把
        sessionStorage['MANUAL_SWITCH'] 写成目标档位。

  !! 这会修改客户端安装目录里的文件（<版本>\resources\app.asar.unpacked\preload.js）：
     - 安装目录里的 md5.json 记录了该文件原哈希，客户端更新/修复时可能覆盖回原文件；
     - 覆盖后需要重新执行本脚本。
     不想动文件就改用 CDP 方案（启动-4K抖音.cmd），效果一样。

  用法：
    powershell -ExecutionPolicy Bypass -File .\install-preload.ps1
    powershell -ExecutionPolicy Bypass -File .\install-preload.ps1 -Target 4khdr
    powershell -ExecutionPolicy Bypass -File .\install-preload.ps1 -InstallRoot 'D:\软件\抖音\douyin' -Version '8.7.0'
#>
[CmdletBinding()]
param(
  [string]$InstallRoot = 'D:\软件\抖音\douyin',
  [string]$Version = '',
  [ValidateSet('4khdr', '4k', '2k', '1080p')]
  [string]$Target = '4k',
  # 附带质量探针：把 <video> 的真实解码分辨率写进 %APPDATA%\douyin\dypc4k-quality.log
  [switch]$WithQualityProbe,
  # 附带诊断探针 v2：主世界里 MANUAL_SWITCH 的每次读写 + 分辨率 + 菜单文案 -> dypc4k-diag.log
  [switch]$WithDiag,
  # 附带码流档位探针：记录客户端自己拿到的档位表（gear_name/宽高/码率/编码）+ 请求参数 -> dypc4k-gear.log
  [switch]$WithGearProbe,
  # 客户端抽掉 4K 项后抢回 + 拦截降档调用（4K 优先，可能偶发重载）。默认不抢。
  [switch]$Fight,
  # 钉住的编码族。留空=不钉（推荐）：实测客户端自己选 h265，而 4K 档只存在于 h265，钉成 h264 会把 4K 挡掉。
  [string]$Codec = '',
  # 编码能力改判范围：none（默认，不封任何编码 —— 最终方案不需要它）
  #                   vvc-all（连 HEVC/AV1 一起封，实测会把 4K 一起封掉，只剩 1080P）
  #                   none（不改判）
  [ValidateSet('vvc', 'vvc-all', 'none')]
  [string]$Refuse = 'none',
  # 兼容旧版参数；两个 AB 实验均已关闭，原生 ABR/卡顿恢复保持原值。
  [switch]$NoAbPatch,
  # 关闭起播前的高画质 HEVC 档位组优选，便于对照或回退。
  [switch]$NoHevcPreference,
  # 允许在抖音运行时写入（改完需要重启抖音才生效；一般不建议）
  [switch]$AllowRunning
)

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$SnippetPath = Join-Path $Here 'preload-snippet.js'
if (-not (Test-Path -LiteralPath $SnippetPath)) { throw "找不到 preload-snippet.js: $SnippetPath" }

# ---- 定位 preload.js ----
if (-not $Version) {
  $cand = Get-ChildItem -LiteralPath $InstallRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
    Sort-Object { [version]$_.Name } -Descending
  if (-not $cand) { throw "在 $InstallRoot 下找不到版本目录（形如 8.7.0）" }
  $Version = $cand[0].Name
}
$Preload = Join-Path $InstallRoot "$Version\resources\app.asar.unpacked\preload.js"
if (-not (Test-Path -LiteralPath $Preload)) { throw "找不到 preload.js: $Preload" }
$Backup = "$Preload.dypc4k.bak"

# ---- 客户端必须在退出状态 ----
$running = Get-Process -Name douyin, douyin_tray -ErrorAction SilentlyContinue
if ($running -and -not $AllowRunning) {
  $running | Select-Object Id, ProcessName | Format-Table -AutoSize | Out-String | Write-Host
  throw '抖音正在运行，请先从托盘完全退出后再安装（或加 -AllowRunning，改完重启抖音生效）'
}

# ---- 备份（只备份一次，保留最原始版本）----
if (-not (Test-Path -LiteralPath $Backup)) {
  Copy-Item -LiteralPath $Preload -Destination $Backup -Force
  Write-Host "[*] 已备份原文件 -> $Backup"
} else {
  Write-Host "[*] 备份已存在，沿用: $Backup"
}
$origMd5 = (Get-FileHash -LiteralPath $Backup -Algorithm MD5).Hash.ToLower()

# ---- 读文件（保留无 BOM 的 UTF-8）----
$utf8 = New-Object System.Text.UTF8Encoding($false)
$content = [System.IO.File]::ReadAllText($Preload, [System.Text.Encoding]::UTF8)

# ---- 幂等：先剥掉旧补丁块（payload + 可选探针）----
$content = [regex]::Replace($content, "(?s)\r?\n?/\* ==== dypc4k begin ==== \*/.*?/\* ==== dypc4k end ==== \*/", '')
$content = [regex]::Replace($content, "(?s)\r?\n?/\* ==== dypc4k-probe begin ==== \*/.*?/\* ==== dypc4k-probe end ==== \*/", '')
$content = [regex]::Replace($content, "(?s)\r?\n?/\* ==== dypc4k-probe2 begin ==== \*/.*?/\* ==== dypc4k-probe2 end ==== \*/", '')
$content = [regex]::Replace($content, "(?s)\r?\n?/\* ==== dypc4k-gearprobe begin ==== \*/.*?/\* ==== dypc4k-gearprobe end ==== \*/", '')

# ---- 片段 + 目标档位 ----
$snippet = [System.IO.File]::ReadAllText($SnippetPath, [System.Text.Encoding]::UTF8)
$snippet = $snippet -replace "var TARGET = '[^']+';", "var TARGET = '$Target';"
$snippet = $snippet -replace "var FIGHT = (true|false);", ("var FIGHT = {0};" -f $(if ($Fight) { 'true' } else { 'false' }))
$snippet = $snippet -replace "var LOCK_CODEC = '[^']*';", ("var LOCK_CODEC = '{0}';" -f $Codec)
$snippet = $snippet -replace "var REFUSE = '[^']*';", ("var REFUSE = '{0}';" -f $Refuse)
$snippet = $snippet -replace "var AB_PATCH = (true|false);", 'var AB_PATCH = false;'
$snippet = $snippet -replace "var QUALITY_AB_PATCH = (true|false);", 'var QUALITY_AB_PATCH = false;'
$snippet = $snippet -replace "var PREFER_HIGH_HEVC = (true|false);", ("var PREFER_HIGH_HEVC = {0};" -f $(if ($NoHevcPreference) { 'false' } else { 'true' }))
$snippet = $snippet -replace "var SAFE_PLAYBACK = (true|false);", 'var SAFE_PLAYBACK = true;'

$append = $snippet
if ($WithQualityProbe) {
  $probePath = Join-Path $Here 'quality-probe.snippet.js'
  if (-not (Test-Path -LiteralPath $probePath)) { throw "找不到 quality-probe.snippet.js: $probePath" }
  $append += [Environment]::NewLine + [Environment]::NewLine +
    [System.IO.File]::ReadAllText($probePath, [System.Text.Encoding]::UTF8)
}
if ($WithDiag) {
  $diagPath = Join-Path $Here 'probe2.snippet.js'
  if (-not (Test-Path -LiteralPath $diagPath)) { throw "找不到 probe2.snippet.js: $diagPath" }
  $append += [Environment]::NewLine + [Environment]::NewLine +
    [System.IO.File]::ReadAllText($diagPath, [System.Text.Encoding]::UTF8)
}
if ($WithGearProbe) {
  $gp = Join-Path $Here 'probe-gear.snippet.js'
  if (-not (Test-Path -LiteralPath $gp)) { throw "找不到 probe-gear.snippet.js: $gp" }
  $append += [Environment]::NewLine + [Environment]::NewLine +
    [System.IO.File]::ReadAllText($gp, [System.Text.Encoding]::UTF8)
}

$newContent = $content.TrimEnd() + [Environment]::NewLine + [Environment]::NewLine + $append + [Environment]::NewLine
[System.IO.File]::WriteAllText($Preload, $newContent, $utf8)

$newMd5 = (Get-FileHash -LiteralPath $Preload -Algorithm MD5).Hash.ToLower()
Write-Host "[+] 已写入补丁: $Preload" -ForegroundColor Green
Write-Host "    目标档位 : $Target"
Write-Host "    播放策略 : 保留高画质偏好；不硬换源、不补档抢档、不重置缓冲"
Write-Host "    起播选档 : $(if ($NoHevcPreference) { '原生选择（HEVC 优选已关闭）' } else { '同视频 HEVC 档位更高且本机支持时，起播前优选；保留低码率档' })"
Write-Host "    清晰度重选: 原值（两个 AB 改写实验均关闭）"
Write-Host "    ABR/卡顿恢复: 保留原值"
Write-Host "    编码改判 : 不改判"
Write-Host "    质量探针 : $(if ($WithQualityProbe) { '已装 -> %APPDATA%\douyin\dypc4k-quality.log' } else { '未装' })"
Write-Host "    诊断探针 : $(if ($WithDiag) { '已装 -> %APPDATA%\douyin\dypc4k-diag.log' } else { '未装' })"
Write-Host "    原始 md5 : $origMd5"
Write-Host "    当前 md5 : $newMd5"
Write-Host ""
Write-Host "下一步：启动抖音，推荐页保留 4K 偏好；实际画质由视频源、客户端和网络决定。Alt+I 可查看实际分辨率。"
Write-Host "撤销  ： powershell -ExecutionPolicy Bypass -File .\uninstall-preload.ps1"
