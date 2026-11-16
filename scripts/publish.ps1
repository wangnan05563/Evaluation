#Requires -Version 5.1
<#
.SYNOPSIS
    WorkloadEval 一键发布：构建（PyInstaller + electron-builder）→ 发布 GitHub Release。
.DESCRIPTION
    纯 logic 脚本（UTF-8 BOM），由 一键发布.bat 委派调用。
    流程：前置检查 → 调用 构建打包.bat 出包 → 免安装产物冒烟（win-unpacked，非 0 即阻断）→ 定位 setup.exe → 生成/复用发布说明 → publish-release.py 上传。
.PARAMETER SkipBuild
    跳过构建，仅发布已存在的 release/WorkloadEstimate-*-setup.exe（用于 CI 或重发）。
.PARAMETER DryRun
    仅打印将要执行的发布动作，不触碰 GitHub（等同设置 GH_DRY_RUN=1）。
#>
[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$DryRun
)

# 输出编码对齐（与 .bat 的 chcp 65001 匹配，陷阱 35/59）
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$ErrorActionPreference = 'Stop'

# 路径解析（相对于脚本自身，不写死层级，陷阱 62/67）
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir '..')).Path
$ConfigPath = Join-Path $ScriptDir 'publish.config.json'

# 读配置（零硬编码，规则 3）
if (-not (Test-Path $ConfigPath)) { Write-Error ("找不到配置: " + $ConfigPath); exit 1 }
$cfg = Get-Content -Raw -Encoding UTF8 $ConfigPath | ConvertFrom-Json

# 工具查找（candidates 列表，Test-Path 命中即返回；否则退化到 PATH 命令名）
function Find-Tool($cands) {
    foreach ($c in $cands) {
        $exp = [Environment]::ExpandEnvironmentVariables($c)
        # 候选项允许通配（如 versions\*\node.exe），否则版本一升级就写死过期；
        # 通配命中按名字排序取最后一个（多数情况下即最新的那份）
        try { $hits = @(Resolve-Path -Path $exp -ErrorAction Stop | Sort-Object Path) } catch { $hits = @() }
        if ($hits.Count -gt 0) { return $hits[-1].Path }
        try { $cmd = Get-Command $c -ErrorAction SilentlyContinue; if ($cmd) { return $cmd.Source } } catch {}
    }
    return $null
}

$Py = Find-Tool $cfg.runtime.python_candidates
$Node = Find-Tool $cfg.runtime.node_candidates

function Step($msg) {
    Write-Host ""
    Write-Host ("=" * 60)
    Write-Host ("  " + $msg)
    Write-Host ("=" * 60)
}
function Fail($msg) {
    Write-Host ("[FAIL] " + $msg) -ForegroundColor Red
    exit 1
}

# ---- 0) 前置检查 ----
Step "0/6 前置检查"
if (-not $Py) { Fail "未找到 Python（配置 runtime.python_candidates 均未命中，且不在 PATH）" }
if (-not $Node) { Fail "未找到 Node.js（配置 runtime.node_candidates 均未命中，且不在 PATH）" }
Write-Host ("  Python: " + $Py)
Write-Host ("  Node  : " + $Node)
try {
    $gitVer = (git --version 2>$null)
    if (-not $gitVer) { Fail "未找到 git" }
} catch { Fail "未找到 git" }
Write-Host ("  git   : " + $gitVer)

# 应用 CN 镜像（提升 electron 下载成功率，与参考脚本一致，陷阱 57 不硬编码路径）
$env:ELECTRON_MIRROR = $cfg.env.ELECTRON_MIRROR
$env:ELECTRON_BUILDER_BINARIES_MIRROR = $cfg.env.ELECTRON_BUILDER_BINARIES_MIRROR

# ---- 1) 版本号 ----
Step "1/6 读取版本号"
$pkgPath = Join-Path $RepoRoot 'package.json'
if (-not (Test-Path $pkgPath)) { Fail ("找不到 package.json: " + $pkgPath) }
$pkg = Get-Content -Raw -Encoding UTF8 $pkgPath | ConvertFrom-Json
$version = $pkg.version
if (-not $version) { Fail "package.json 缺少 version 字段" }
Write-Host ("  版本: " + $version)
$tag = ($cfg.version.tag_prefix + $version)

# 手写的 NSIS 片段（build/installer.nsh）不在构建产物里，靠 git 跟踪才随仓库走。
# 曾被目录级 build/ 规则一并忽略：本地有文件所以一路绿，干净克隆到别的机器才在 NSIS 步骤断
# —— 提前在这里断言它已被跟踪，报错点比构建中途清楚得多（T04013）。
$nsh = $pkg.build.nsis.include
if ($nsh) {
    $tracked = (git -C $RepoRoot ls-files -- $nsh)
    if (-not $tracked) {
        Fail ("nsis.include 指向的文件未被 git 跟踪: " + $nsh + "（干净克隆缺它，构建会在 NSIS 步骤断；先 .gitignore 放行并提交）")
    }
    Write-Host ("  NSIS 片段: " + $nsh + "（已跟踪）")
}

# ---- 2) 构建 ----
if (-not $SkipBuild) {
    Step "2/6 构建（调用 构建打包.bat）"
    $buildBat = Join-Path $RepoRoot $cfg.build.builder_bat
    if (-not (Test-Path $buildBat)) { Fail ("找不到构建脚本: " + $buildBat) }
    # 构建脚本复用同一份配置解析出的解释器（构建打包.bat 读 WE_PYTHON/WE_NODE），
    # 不再两边各维护一套候选路径
    $env:WE_PYTHON = $Py
    $env:WE_NODE = $Node
    # 构建打包.bat 末尾有 pause，自动化场景下用空 stdin 中和它（使其立即返回，避免卡住）
    $emptyInput = Join-Path $env:TEMP ("we_build_in_" + [guid]::NewGuid().ToString('N') + ".txt")
    '' | Out-File -Encoding ASCII -FilePath $emptyInput
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'cmd.exe'
    $psi.Arguments = ('/c "' + $buildBat + '"')
    $psi.RedirectStandardInput = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()
    $proc.StandardInput.Close()
    $timeoutMs = $cfg.build.timeout_ms
    if (-not $proc.WaitForExit($timeoutMs)) {
        try { $proc.Kill() } catch {}
        Fail ("构建超时（>${timeoutMs}ms），可能被 pause 卡住或 electron-builder 过慢；可用 -SkipBuild 仅发布已有包")
    }
    if ($proc.ExitCode -ne 0) {
        Fail ("构建失败，exit code=" + $proc.ExitCode + "（详见 构建打包.bat 的输出与 release\logs\pyinstaller.log）")
    }
    Write-Host "  构建完成"
    # 构建内 bump_version.py 已把日期序号 +1，发布必须以构建后的版本为准；
    # 沿用步骤1读到的旧值会让 tag / 发布说明 / 产物显示名指向上一版（实测 tag=…-002 而包为 …-3）
    $pkg = Get-Content -Raw -Encoding UTF8 $pkgPath | ConvertFrom-Json
    $version = $pkg.version
    $tag = ($cfg.version.tag_prefix + $version)
    Write-Host ("  构建后版本: " + $version)
} else {
    Step "2/6 跳过构建（-SkipBuild）"
}

# ---- 3) 免安装产物冒烟 ----
# npm test 全绿只覆盖开发态（electron.exe + 源码）。装包态另有三条前提只在成品里才成立：
# extraResources 的托盘 ico、asar 里必须含 window-prefs.js、sidecar 是 PyInstaller exe；
# 配错了回归套件也不会红——所以发布前必须拿真产物跑一遍（T04014）。
# 跳过口径由脚本自己管（无桌面会话 / 8020 被占 → 逐条 SKIP 并返回 0），
# 因此这里非 0 就代表产物真有问题，必须挡住上传。
Step "3/6 免安装产物冒烟（win-unpacked）"
if (-not $cfg.build.win_unpacked) { Fail "配置缺少 build.win_unpacked（免安装产物目录），无法定位冒烟目标" }
$smokeJs = Join-Path $RepoRoot 'tests\prod_smoke.mjs'
if (-not (Test-Path $smokeJs)) { Fail ("找不到冒烟脚本: " + $smokeJs) }
$Unpacked = Join-Path $RepoRoot $cfg.build.win_unpacked
if (-not (Test-Path $Unpacked)) {
    if ($SkipBuild) {
        Write-Warning ("免安装产物不存在（" + $Unpacked + "），-SkipBuild 场景跳过冒烟；正式构建发布请勿跳过这一步")
    } else {
        Fail ("构建未产出免安装目录: " + $Unpacked + "（electron-builder 只出了 setup.exe？查 release\logs\build_installer.log）")
    }
} else {
    # 冒烟脚本默认取 release\win-unpacked，这里仍以配置为准注入，避免两处各写一遍路径
    $env:WE_PROD_DIR = $Unpacked
    Write-Host ("  产物: " + $Unpacked)
    & $Node $smokeJs
    if ($LASTEXITCODE -ne 0) { Fail ("免安装产物冒烟未通过（exit=" + $LASTEXITCODE + "），已阻断发布：" + $Unpacked) }
    Write-Host "  冒烟通过"
}

# ---- 4) 定位安装包 ----
Step "4/6 定位安装包"
$setupGlob = Join-Path $RepoRoot $cfg.publish.setup_glob
$setupDir = Split-Path -Parent $setupGlob
$setupFilter = Split-Path -Leaf $setupGlob
$cands = Get-ChildItem -Path $setupDir -Filter $setupFilter -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
if (-not $cands) { Fail ("未找到安装包: " + $setupGlob + "（请先构建，或去掉 -SkipBuild）") }
$setup = $cands[0].FullName
Write-Host ("  安装包: " + $setup)

# ---- 5) 发布说明 ----
Step "5/6 准备发布说明"
$notesName = $cfg.publish.notes_glob -replace '\$\{version\}', $version
$notesPath = Join-Path $RepoRoot $notesName
if (-not (Test-Path $notesPath)) {
    Write-Host ("  未找到 " + $notesName + "，从 git log 自动生成...")
    $auto = Join-Path $RepoRoot ("release-notes-" + $version + ".auto.md")
    # 参数模式里 -$cfg.x.y 不会做属性展开（实测拼出 "-@{...}.publish..." 让 git 直接 fatal），
    # 先取成整数再以 "-N" 传入；git 输出是行数组，须 join 后才能进 StringBuilder
    $logCount = [int]$cfg.publish.auto_notes_git_log_count
    $log = @(git -C $RepoRoot log --no-merges --oneline "-$logCount" 2>$null) -join "`r`n"
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine("# WorkloadEval $version")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("自动生成的发布说明（基于 git 提交记录）。可用正式 release-notes-$version.md 覆盖。")
    [void]$sb.AppendLine("")
    if ($log) { [void]$sb.AppendLine($log) }   # join 后为单串，不再写出 Object[]
    [System.IO.File]::WriteAllText($auto, $sb.ToString(), [System.Text.Encoding]::UTF8)
    $notesPath = $auto
}
Write-Host ("  说明  : " + $notesPath)

# ---- 6) 发布 ----
Step "6/6 发布到 GitHub Releases"
if ($DryRun) { $env:GH_DRY_RUN = '1' }
if ($env:GH_DRY_RUN -eq '1') { Write-Host "  [DRY-RUN] 不会真正发布，仅打印动作" }
$env:GH_REPO = $cfg.publish.repo
$env:GH_TAG = $tag
$displayName = $cfg.publish.artifact_name_template -replace '\$\{version\}', $version
$pubPy = Join-Path $RepoRoot $cfg.publish.py_publisher
if (-not (Test-Path $pubPy)) { Fail ("找不到发布器: " + $pubPy) }
$pushArgs = @($setup, $notesPath, $displayName)
Write-Host ("  python " + $pubPy + " <setup> <notes> " + $displayName)
& $Py $pubPy @pushArgs
if ($LASTEXITCODE -ne 0) { Fail ("发布失败，exit code=" + $LASTEXITCODE) }

Write-Host ""
Write-Host ("[完成] 一键发布结束：" + $setup)
if ($env:GH_DRY_RUN -ne '1') {
    Write-Host ("  Release: https://github.com/" + $cfg.publish.repo + "/releases/tag/" + $tag)
}
exit 0
