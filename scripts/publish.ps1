#Requires -Version 5.1

<#

.SYNOPSIS

    WorkloadEval 一键发布：构建（PyInstaller + electron-builder）→ 发布 GitHub Release。

.DESCRIPTION

    纯 logic 脚本（UTF-8 BOM），由 一键发布.bat 委派调用。

    流程：前置检查 → 调用 构建打包.bat 出包（含构建期 win-unpacked 冒烟，结果非 0 即阻断）→ 校验冒烟结果 → 定位 setup.exe → 生成/复用发布说明 → publish-release.py 上传。

    前置检查把「构建 30 分钟后才发现缺凭据/缺文件/配置不全」的失败提前挡住：

      工具(Python/Node/git) · 配置必需字段 · 发布链必需文件 · GitHub 凭据(env/.env 或 git 凭据库，不回显)

      · origin 与 publish.repo 一致性(告警) · 脏工作树/非主分支(告警，构建自身会 bump 版本) · DryRun 语义。

.PARAMETER SkipBuild

    跳过构建，仅发布已存在的 release/WorkloadEstimate-*-setup.exe（用于 CI 或重发）。

.PARAMETER DryRun

    仅打印将要执行的发布动作，不触碰 GitHub（等同设置 GH_DRY_RUN=1）。

    注意：构建与免安装产物冒烟仍会执行，只是不上传 Release；要连构建一起跳过请叠加 -SkipBuild。

.PARAMETER PreflightOnly

    只跑前置检查（工具/配置/文件/凭据/仓库状态），不构建、不冒烟、不上传。

    供发布前自检或 CI 门禁使用；缺凭据且非演练时仍会判失败。

#>

[CmdletBinding()]

param(

    [switch]$SkipBuild,

    [switch]$DryRun,

    [switch]$PreflightOnly

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

function Invoke-Git([string[]]$GitArgs) {

    # PowerShell 5.1 会把 native command 的 stderr 转成 ErrorRecord；在 $ErrorActionPreference='Stop'

    # 下，「非 git 目录 / 未配 origin / config 无匹配」这类只读探测会直接终止整条发布流水线。

    # 前置检查只需要「取不到就走告警」，这里临时降级并吞掉 stderr，返回空数组表示不可用。

    $prev = $ErrorActionPreference

    $ErrorActionPreference = 'Continue'

    try {

        return @(& git @GitArgs 2>$null)

    } catch {

        return @()

    } finally {

        $ErrorActionPreference = $prev

    }

}

# ---- 0) 前置检查：所有可预知的失败都挡在耗时的构建之前 ----

Step "0/6 前置检查"

if (-not $Py) { Fail "未找到 Python（配置 runtime.python_candidates 均未命中，且不在 PATH）" }

if (-not $Node) { Fail "未找到 Node.js（配置 runtime.node_candidates 均未命中，且不在 PATH）" }

Write-Host ("  Python: " + $Py)

Write-Host ("  Node  : " + $Node)

# 0.05 Python 构建依赖：PATH 上常有缺 openpyxl/python-docx 的托管解释器，

# 构建脚本到 2/6 才报「缺依赖」，白等一轮版本 bump/清目录。这里在构建前一次性校验，

# 模块清单由 publish.config.json 的 runtime.python_required_modules 提供（零硬编码）。

$requiredModules = @($cfg.runtime.python_required_modules)

if ($requiredModules.Count -gt 0) {

    $modArgs = ($requiredModules -join ', ')

    $depScript = "import " + ($requiredModules -join ', ')

    $depOk = $false

    try {

        $null = & $Py -c $depScript 2>$null

        $depOk = ($LASTEXITCODE -eq 0)

    } catch { $depOk = $false }

    if (-not $depOk) {

        Fail ("Python 缺少构建依赖（" + $modArgs + "）: " + $Py +

              "。请用带依赖的解释器（调整 PATH / runtime.python_candidates，或设置 WE_PYTHON）。")

    }

    Write-Host ("  依赖  : Python " + $modArgs + " 就绪")

}

try {

    $gitVer = (@(Invoke-Git @('--version')) -join '')

    if (-not $gitVer) { Fail "未找到 git" }

} catch { Fail "未找到 git" }

Write-Host ("  git   : " + $gitVer)

# 0.1 配置完整性：缺字段若不在前置拦住，会在构建/冒烟/上传中途以空值报错，排查成本极高。

# tag_prefix 允许为空（当前就是空串），故不在必需非空清单里。

$requiredCfg = @(

    'runtime.python_candidates', 'runtime.node_candidates',

    'env.ELECTRON_MIRROR', 'env.ELECTRON_BUILDER_BINARIES_MIRROR',

    'build.builder_bat', 'build.timeout_ms', 'build.win_unpacked',

    'publish.repo', 'publish.setup_glob', 'publish.artifact_name_template',

    'publish.notes_glob', 'publish.auto_notes_git_log_count', 'publish.py_publisher'

)

foreach ($cfgPath in $requiredCfg) {

    $cfgNode = $cfg

    foreach ($seg in $cfgPath.Split('.')) {

        if ($null -eq $cfgNode) { break }

        $prop = $cfgNode.PSObject.Properties[$seg]

        if ($null -eq $prop) { $cfgNode = $null; break }

        $cfgNode = $prop.Value

    }

    if ($null -eq $cfgNode -or ($cfgNode -is [string] -and [string]::IsNullOrWhiteSpace($cfgNode))) {

        Fail ("publish.config.json 缺少必需字段: " + $cfgPath)

    }

}

Write-Host ("  配置  : " + $ConfigPath + " 字段齐全")

# 0.2 发布链必需文件：统一在构建前判定，避免出包后才发现发布器或冒烟脚本缺失。

$requiredFiles = @(

    (Join-Path $RepoRoot 'package.json'),

    (Join-Path $RepoRoot 'tests\prod_smoke.mjs'),

    (Join-Path $RepoRoot $cfg.publish.py_publisher)

)

if (-not $SkipBuild) { $requiredFiles += (Join-Path $RepoRoot $cfg.build.builder_bat) }

foreach ($f in $requiredFiles) {

    if (-not (Test-Path $f)) { Fail ("缺少发布链必需文件: " + $f) }

}

Write-Host ("  文件  : " + $requiredFiles.Count + " 个必需文件齐全")

# 0.3 凭据：env / .env（bat 已载入）或 git 凭据库；绝不回显 token 值。

# GITHUB_TOKEN 是 gh CLI 的通用叫法，publish-release.py 只认 GH_TOKEN，这里补一次映射。

if ([string]::IsNullOrWhiteSpace($env:GH_TOKEN) -and -not [string]::IsNullOrWhiteSpace($env:GITHUB_TOKEN)) {

    $env:GH_TOKEN = $env:GITHUB_TOKEN

}

$hasEnvToken = -not [string]::IsNullOrWhiteSpace($env:GH_TOKEN)

# 只读 git config，不调用 credential fill（凭据管理器可能阻塞十几秒甚至弹窗）

$credHelper = @(Invoke-Git @('config', '--get-regexp', '^credential\..*helper$'))

$isDry = $DryRun -or $env:GH_DRY_RUN -eq '1'

if ($hasEnvToken) {

    Write-Host "  凭据  : GH_TOKEN（环境变量 / .env，值不回显）"

} elseif ($credHelper.Count -gt 0) {

    Write-Host "  凭据  : git credential.helper 已配置（publish-release.py 将自动取用，值不回显）"

} else {

    $credMsg = "缺少 GitHub 凭据：请在仓库根 .env 写 GH_TOKEN=...（见 scripts\.env.example），或配置 git credential.helper"

    if ($isDry) { Write-Warning ($credMsg + "；DryRun 允许继续") } else { Fail $credMsg }

}

if ($isDry) { Write-Host "  [INFO] DryRun：构建与冒烟仍会执行，仅跳过 GitHub 上传" }

# 0.4 仓库坐标 / 工作树 / 分支：只告警不阻断。

# 构建内 bump_version.py 会改根与 dev-shell 的 package.json，故「干净工作树」不能当硬门槛（与 AirMirror 不同）。

$origin = (@(Invoke-Git @('-C', $RepoRoot, 'remote', 'get-url', 'origin')) -join '').Trim()

if ($origin -match 'github\.com[:/]+([^/]+)/([^/]+?)(?:\.git)?/*$') {

    $originRepo = "$($Matches[1])/$($Matches[2])"

    if ($originRepo -ne $cfg.publish.repo) {

        Write-Warning ("origin(" + $originRepo + ") 与 publish.repo(" + $cfg.publish.repo + ") 不一致；发布目标以配置为准")

    } else {

        Write-Host ("  仓库  : " + $originRepo + "（origin 与配置一致）")

    }

} else {

    Write-Warning ("无法从 origin 解析 GitHub 仓库；发布目标以配置为准: " + $cfg.publish.repo)

}

$dirty = @(Invoke-Git @('-C', $RepoRoot, 'status', '--porcelain'))

if ($dirty.Count -gt 0) {

    Write-Warning ("工作树有 " + $dirty.Count + " 处未提交改动（构建会 bump 版本号，不阻断发布）；发布后请提交版本号变更")

    $dirty | Select-Object -First 5 | ForEach-Object { Write-Host ("    " + $_) }

}

$branch = (@(Invoke-Git @('-C', $RepoRoot, 'rev-parse', '--abbrev-ref', 'HEAD')) -join '').Trim()

if ($branch -and $branch -ne 'main' -and $branch -ne 'master') {

    Write-Warning ("当前分支 " + $branch + " 不是 main/master，请确认发布分支")

}

# 自检模式：前置检查全部通过即可收口，不进入构建/冒烟/上传（CI 门禁、发布前体检）

if ($PreflightOnly) {

    Write-Host ""

    Write-Host "[完成] 前置检查通过（-PreflightOnly：未构建、未上传）" -ForegroundColor Green

    exit 0

}

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

    $tracked = @(Invoke-Git @('-C', $RepoRoot, 'ls-files', '--', $nsh))

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

    # 发布模式：让构建脚本(a) 对 electron-builder 失败返回非 0，(b) 在临时目录清理前

    # 就地跑 win-unpacked 冒烟并把退出码写 release\logs\prod_smoke.exit。

    # 手动构建不设这两个变量，行为不变（不会在 release 留中间产物）。

    $env:WE_PUBLISH = '1'

    $env:WE_PROD_SMOKE = '1'

    # 构建脚本末尾有 pause，自动化场景下用空 stdin 中和它（使其立即返回，避免卡住）

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

# 构建脚本的既定策略（历史修复）是 electron-builder 输出到系统临时目录，成功只把

# setup.exe 移回 release，win-unpacked 在清理前删除——因此发布模式下由构建脚本就地

# 冒烟并落结果标记（release\logs\prod_smoke.exit / prod_smoke.log），这里读结果；

# 旧布局或手工构建的 release\win-unpacked 仍可直接冒烟。

Step "3/6 免安装产物冒烟（win-unpacked）"

if (-not $cfg.build.win_unpacked) { Fail "配置缺少 build.win_unpacked（免安装产物目录），无法定位冒烟目标" }

$smokeJs = Join-Path $RepoRoot 'tests\prod_smoke.mjs'

if (-not (Test-Path $smokeJs)) { Fail ("找不到冒烟脚本: " + $smokeJs) }

$Unpacked = Join-Path $RepoRoot $cfg.build.win_unpacked

$smokeMarker = Join-Path $RepoRoot 'release\logs\prod_smoke.exit'

$smokeLog = Join-Path $RepoRoot 'release\logs\prod_smoke.log'

$smokeRc = -1

$smokeDone = $false

if (-not $SkipBuild -and (Test-Path $smokeMarker)) {

    $rcText = (Get-Content -Raw $smokeMarker).Trim()

    if (-not [int]::TryParse($rcText, [ref]$smokeRc)) {

        Fail ("构建期冒烟结果标记无法解析: " + $smokeMarker + "（内容: " + $rcText + "）")

    }

    $smokeDone = $true

} elseif (Test-Path $Unpacked) {

    # 兼容手工构建 / 旧布局：产物就在配置目录时直接跑（冒烟脚本自己处理 SKIP 口径）

    $env:WE_PROD_DIR = $Unpacked

    Write-Host ("  产物: " + $Unpacked)

    & $Node $smokeJs

    $smokeRc = $LASTEXITCODE

    $smokeDone = $true

}

if (-not $smokeDone) {

    if ($SkipBuild) {

        Write-Warning ("免安装产物不存在（" + $Unpacked + " / " + $smokeMarker + "），-SkipBuild 场景跳过冒烟；正式构建发布请勿跳过这一步")

    } else {

        Fail ("构建未执行免安装产物冒烟：既无 " + $smokeMarker + " 也无 " + $Unpacked +

              "。检查 electron-builder 是否成功（发布模式下构建脚本失败会直接非 0 退出），或构建脚本的 WE_PROD_SMOKE 钩子是否被跳过。")

    }

} else {

    if ($smokeRc -ne 0) { Fail ("免安装产物冒烟未通过（exit=" + $smokeRc + "，日志: " + $smokeLog + "），已阻断发布") }

    Write-Host ("  冒烟通过（构建期临时产物；日志: " + $smokeLog + "）")

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

    $log = (@(Invoke-Git @('-C', $RepoRoot, 'log', '--no-merges', '--oneline', "-$logCount")) -join "`r`n")

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

# 幂等发布：tag 已存在不阻断（publish-release.py 会按 tag 复用 Release、跳过同名资产）

$tagExists = (@(Invoke-Git @('-C', $RepoRoot, 'tag', '--list', $tag)) -join '').Trim()

if ($tagExists) { Write-Host ("  [INFO] 本地已有 tag " + $tag + "，将按幂等规则复用已有 Release") }

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

