#Requires -Version 5.1
<#
.SYNOPSIS
    编码 / 行尾 / 语法 静态校验，确保 .bat / .ps1 / config.json / publish-release.py 符合 create-bat 技能规范。
.DESCRIPTION
    通过条件：
      .bat        : 纯 ASCII + 无 BOM + CRLF（孤立 LF = 0）+ 以换行结尾
      .ps1        : UTF-8 BOM（恰好 1 个）+ CRLF（孤立 LF = 0）+ [Parser]::ParseFile 无错误
      config.json : 合法 JSON（非 ASCII 值仅告警，已知例外为构建脚本中文文件名）
      publish-release.py : py_compile 通过
      构建链源文件      : 不得出现写死的盘符绝对路径（X:\ 或 X:/），确需保留的行以
                          verify:allow-abs 标记豁免（守卫只盯构建/发布链，不管一次性取证脚本）
#>
[CmdletBinding()]
param()

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir '..')).Path

$batFiles   = @('一键发布.bat')
$ps1Files   = @('publish.ps1', 'verify.ps1')
$configFile = 'publish.config.json'
$pyFile     = 'publish-release.py'

$fails = 0
$warns = 0

function Check-Ascii($path) {
    $bytes = [System.IO.File]::ReadAllBytes($path)
    for ($i = 0; $i -lt $bytes.Length; $i++) {
        if ($bytes[$i] -gt 127) { return $i }
    }
    return -1
}

function Check-BOM($path) {
    $b = [System.IO.File]::ReadAllBytes($path)
    if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { return $true }
    return $false
}

function Count-BareLF($path) {
    $text = [System.IO.File]::ReadAllText($path)
    $n = 0; $i = 0
    while ($i -lt $text.Length) {
        if ($text[$i] -eq "`n") {
            if ($i -eq 0 -or $text[$i-1] -ne "`r") { $n++ }
        }
        $i++
    }
    return $n
}

function Report($ok, $msg) {
    if ($ok) { Write-Host ("  [PASS] " + $msg) -ForegroundColor Green }
    else { Write-Host ("  [FAIL] " + $msg) -ForegroundColor Red; $script:fails++ }
}

Write-Host "========================================"
Write-Host "  verify.ps1 - 一键发布脚本静态校验"
Write-Host "========================================"

# ---- .bat ----
Write-Host "--- .bat (纯 ASCII + 无 BOM + CRLF) ---"
foreach ($f in $batFiles) {
    $p = Join-Path $ScriptDir $f
    if (-not (Test-Path $p)) { Report $false ("缺少文件: " + $f); continue }
    $hasBom = Check-BOM $p
    $nonAscii = Check-Ascii $p
    $bareLf = Count-BareLF $p
    Report (-not $hasBom) ($f + " 无 BOM")
    if ($nonAscii -ge 0) {
        Report $false ($f + " 含非 ASCII 字节 (偏移 " + $nonAscii + ")")
    } else {
        Report $true ($f + " 纯 ASCII")
    }
    Report ($bareLf -eq 0) ($f + " CRLF (孤立 LF=" + $bareLf + ")")
}

# ---- .ps1 ----
Write-Host "--- .ps1 (UTF-8 BOM + CRLF + 语法) ---"
foreach ($f in $ps1Files) {
    $p = Join-Path $ScriptDir $f
    if (-not (Test-Path $p)) { Report $false ("缺少文件: " + $f); continue }
    $hasBom = Check-BOM $p
    $bareLf = Count-BareLF $p
    Report $hasBom ($f + " 有 UTF-8 BOM")
    Report ($bareLf -eq 0) ($f + " CRLF (孤立 LF=" + $bareLf + ")")
    $tokens = $null; $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) {
        Report $false ($f + " 语法有 " + $errors.Count + " 处错误 -> " + $errors[0].Message)
    } else {
        Report $true ($f + " 语法 OK")
    }
}

# ---- config.json ----
Write-Host "--- config.json (合法 JSON) ---"
$p = Join-Path $ScriptDir $configFile
if (-not (Test-Path $p)) {
    Report $false ("缺少文件: " + $configFile)
} else {
    try {
        $null = Get-Content -Raw -Encoding UTF8 $p | ConvertFrom-Json
        Report $true ($configFile + " 合法 JSON")
    } catch {
        Report $false ($configFile + " JSON 解析失败: " + $_.Exception.Message)
    }
    $raw = [System.IO.File]::ReadAllText($p)
    $nonAscii = ($raw.ToCharArray() | Where-Object { [int]$_ -gt 127 }).Count
    if ($nonAscii -gt 0) {
        Write-Host ("  [WARN] " + $configFile + " 含 " + $nonAscii + " 个非 ASCII 字符（应为中文文件名，已知例外）") -ForegroundColor Yellow
        $script:warns++
    }
}

# ---- publish-release.py ----
Write-Host "--- publish-release.py (py_compile) ---"
$p = Join-Path $ScriptDir $pyFile
if (-not (Test-Path $p)) {
    Report $false ("缺少文件: " + $pyFile)
} else {
    $py = $null
    foreach ($c in @('python', 'python3', 'py')) {
        try { $cmd = Get-Command $c -ErrorAction SilentlyContinue; if ($cmd) { $py = $c; break } } catch {}
    }
    if (-not $py) { $py = 'python' }
    try {
        $out = & $py -m py_compile $p 2>&1
        if ($LASTEXITCODE -eq 0) { Report $true ($pyFile + " 编译通过") }
        else { Report $false ($pyFile + " 编译失败: " + ($out -join "`n")) }
    } catch {
        Report $false ($pyFile + " 无法运行 " + $py + ": " + $_.Exception.Message)
    }
}

# ---- 构建链绝对路径守卫 ----
Write-Host "--- 构建链绝对路径守卫（禁止写死某台机器的盘符路径） ---"
$absFiles = @(
    (Join-Path $ScriptDir 'generate_xlsx.py'),
    (Join-Path $ScriptDir 'server.py'),
    (Join-Path $ScriptDir 'replay_recognize.py'),
    (Join-Path $ScriptDir 'publish.ps1'),
    (Join-Path $ScriptDir 'publish.config.json'),
    (Join-Path $ScriptDir '构建打包.bat'),
    (Join-Path $RepoRoot '工作量评估工具.spec')
)
# 单个字母 + ":" + 斜杠；https:// 之类的前面是字母，已被后视排除
$absPattern = '(?<![A-Za-z0-9])[A-Za-z]:[\\/]'
$absHits = @()
foreach ($f in $absFiles) {
    if (-not (Test-Path $f)) { Report $false ("守卫缺少文件: " + (Split-Path -Leaf $f)); continue }
    $enc = [System.Text.Encoding]::UTF8
    if ($f -like '*.bat') { $enc = [System.Text.Encoding]::GetEncoding(936) }
    $lines = [System.IO.File]::ReadAllLines($f, $enc)
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $absPattern -and $lines[$i] -notmatch 'verify:allow-abs') {
            $absHits += ((Split-Path -Leaf $f) + ":" + ($i + 1) + " " + $lines[$i].Trim())
        }
    }
}
if ($absHits.Count -eq 0) {
    Report $true ("构建链 " + $absFiles.Count + " 个文件均为相对/环境变量解析路径")
} else {
    foreach ($h in $absHits) { Write-Host ("    " + $h) -ForegroundColor DarkRed }
    Report $false ("发现 " + $absHits.Count + " 处写死绝对路径（改相对解析，或加 verify:allow-abs 豁免并注明理由）")
}

Write-Host "========================================"
if ($fails -eq 0) {
    Write-Host ("[结果] 全部通过（告警 " + $warns + " 条）") -ForegroundColor Green
    exit 0
} else {
    Write-Host ("[结果] 存在 " + $fails + " 项失败") -ForegroundColor Red
    exit 1
}
