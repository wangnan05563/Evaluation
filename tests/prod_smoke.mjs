/** T04014 免安装产物（win-unpacked）冒烟：装包态才成立的前提 + 关闭决策链 + 退出耗时门。
 *  独立运行：node tests/prod_smoke.mjs
 *  前置：先构建产物（scripts/build_desktop_installer.ps1，或 npm run dist:dir）；
 *        默认取 release/win-unpacked，可用 WE_PROD_DIR 指到别的产物目录。
 *
 *  为什么 npm test 全绿 ≠ 装好的包可用：回归套件跑的是开发态
 *  （dev-shell/node_modules/electron/dist/electron.exe + 源码），下面三处前提只在成品里才成立：
 *    1. extraResources 把 assets/we_icon.ico 落成 resources/we-icon.ico——漏配则托盘图标静默
 *       回退成通用 exe 图标（肉眼难查，只能靠 [tray] created ... icon= 断言兜住）；
 *    2. build.files 必须含 window-prefs.js——漏了主进程 require('./window-prefs') 直接启动失败；
 *    3. sidecar 在成品里是 PyInstaller exe，退出时的进程树回收路径与开发态 python 不同。
 *  这三条 S1~S17 都守不住，所以单独一套跑在真实产物上，并接进发布门（scripts/publish.ps1）。
 *
 *  跳过口径与 S17 一致：无交互桌面 / 产物未构建 / 8020 被占 → 显式 SKIP 并打印原因，不判红；
 *  静态落位与 asar 内容检查不受影响，任何环境都照跑。
 *  托盘实点（P-C）另外要求托盘图标在 UIA 里可枚举；本机 Win10 19045 实测四条通道都不可达，
 *  会走 SKIP（见 T03958 结论），换到能枚举的机器上会自动变成真判。 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { makeLauncher, waitExit, requestClose, killTree, sleep, isPortOpen } from './electron_cdp.mjs'
import { CLOSE_TEXTS, driveDialog, readDialogTexts, cleanupDialogScript, probeWindow } from './win_dialog.mjs'
import { removeTmp } from './tmp_janitor.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const APP_NAME = pkg.build.productName
const PROD_DIR = process.env.WE_PROD_DIR || path.join(ROOT, 'release', 'win-unpacked')
const EXE = path.join(PROD_DIR, APP_NAME + '.exe')
const RES = path.join(PROD_DIR, 'resources')
const ASAR = path.join(RES, 'app.asar')
const ICON = path.join(RES, 'we-icon.ico')
const SIDECAR = path.join(RES, 'we-eval', APP_NAME + '.exe')
const SHELL_LOG = path.join(RES, 'logs', 'shell.log')
// 壳主进程写死的 sidecar 端口（dev-shell/main.js: const PORT = 8020）
const SIDECAR_PORT = 8020
// 退出耗时门（T04543 起对负载不敏感）：装包态的关闭链比开发态慢——关闭前要打 /api/jobs/running
// 探任务（超时预算 1.5s），还要回收 detached 的 PyInstaller 进程树。本机同产物空载实测散布
// 1224 / 1437 / 2094 / 2825ms（开发态基线 401~648ms），基础门 5000ms ≈ 实测上限 1.8 倍。
// 但固定门在多会话并发下会假红：T04540 收口时同一份产物连跑三次，第 1 次 P-A2 6909ms 红、
// 第 2 次 P-B 7038ms 红、第 3 次全绿（当时机上有 40+ 个其它会话的 node.exe）——红的不是同一项、
// 产物与退出链都没变，所以不是回归。沿用 S17 的口径（docs 关键决策第 6 条）：**有水位证据才放宽**，
// 且放宽有上限，四档判定见下面 exitGate()：
//   基础门内 → PASS；有水位且 ≤ 宽松上限 → WARN（报告标注「并发环境下的宽松判定」，不判红）；
//   无水位证据却超基础门 / 超宽松上限 → 仍 FAIL；没退出（关不掉、卡死）→ 与负载无关，始终 FAIL。
// 宽松上限 15000ms = 基础门 3 倍，远低于 EXIT_WAIT 45s：这门要挡的是几十秒级的「关不掉」，
// 不是毫秒级抖动。水位阈值 12 是策略值不是拟合值（本轮跑测时实测 36 个 node.exe、T04540 假红时段
// 40+ 个；本机拿不到可复现的「真空载」读数，所以不假装阈值是量出来的），
// 它只决定「要不要放宽」，不决定「关不掉算不算红」，所以选宽选窄都放不过真回归。
// 三个数都可用环境变量覆盖：WE_PROD_EXIT_MS_BUDGET / WE_PROD_EXIT_MS_HARD / WE_PROD_LOAD_NODE_HIGH。
const EXIT_MS_BUDGET = Number(process.env.WE_PROD_EXIT_MS_BUDGET || 5000)
const EXIT_MS_HARD = Number(process.env.WE_PROD_EXIT_MS_HARD || 15000)
const LOAD_NODE_HIGH = Number(process.env.WE_PROD_LOAD_NODE_HIGH || 12)
const EXIT_WAIT = Number(process.env.WE_PROD_EXIT_WAIT || 45000)
// P-C 的隐藏判据（T04559）：原来是 sleep(3000) 后一次断言，与退出耗时门同一类毛病——
// 并发时关闭链要先打 /api/jobs/running 探活（超时预算 1.5s）、装包态还要起收 sidecar，
// 3s 被吃掉大半就假红（T04543 五轮里 1 红：VISIBLE=1，同一产物 T04540 三轮全绿）。
// 现在轮询到隐藏为止，四档与 exitGate 同口径：基础预算内 → PASS；有水位且 ≤ 宽松上限 → WARN；
// 无水位证据却超基础预算 / 超上限 → FAIL；进程退出（该最小化却退了）→ 与负载无关，始终 FAIL。
// 上限仍取基础预算 3 倍，与退出耗时门同一个比例。
const PC_WAIT_BUDGET = Number(process.env.WE_PROD_PC_WAIT_MS || 3000)
const PC_WAIT_HARD = Number(process.env.WE_PROD_PC_WAIT_HARD || PC_WAIT_BUDGET * 3)
const res = []
let skipReason = ''
const check = (n, ok, d = '') => {
  res.push({ n, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`)
}
// 环境不具备判定条件时记 SKIP，而不是判红——发布门不该被本机桌面形态拖住
const skip = (n, why) => {
  res.push({ n, ok: true })
  console.log(`SKIP  ${n}  — ${why}`)
}
// 超基础门但有水位证据时记 WARN：ok 仍为 true（不拖红发布门），但单独计数、在小结里点名，
// 免得「宽松判定」被读成「这项没测」。
const warns = []
const warn = (n, d) => {
  res.push({ n, ok: true, warn: true })
  warns.push(n)
  console.log(`WARN  ${n}  — ${d}`)
}

/** 同机 node.exe 并发度（含本测试自己那 1 个）。tasklist 走 CSV 无表头，按 CSV 行计数；
 *  没有匹配任务时它打的是一行「信息: …」而不是 CSV，会被下面的行首判据滤掉。
 *  非 Windows / 采样失败一律 count=null（水位未知 → 按基础门判，不放宽），不静默当成 0。 */
function sampleLoad() {
  if (process.platform !== 'win32') return { count: null, why: '非 Windows，未采样' }
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq node.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
  if (r.error || r.status !== 0) {
    return { count: null, why: `tasklist 失败（${r.error ? r.error.message : 'status=' + r.status}）` }
  }
  const n = (r.stdout || '').split('\n').filter(l => /^"[^"]*","/.test(l.trim())).length
  return { count: n, why: '' }
}
const loadSamples = []
/** 一次退出计时的水位取「关闭前 / 退出后」两次采样的大者：跑测期间别的会话会起停，
 *  只采一头会漏掉窗口期内挤进来的负载（T04540 三次重跑红的不是同一项，正是这种形状）。 */
function loadPeak(before) {
  const after = sampleLoad()
  const ns = [before.count, after.count].filter(n => n !== null)
  const peak = { count: ns.length ? Math.max(...ns) : null, why: before.why || after.why,
    before: before.count, after: after.count }
  loadSamples.push(peak)
  return peak
}
// LOAD_NODE= 这个 token 是给 T04507（负载是否放大吞按率）复用的水位读数，别改写法
const loadText = l => l.count === null
  ? `水位未知（${l.why}）`
  : `LOAD_NODE=${l.count}（关闭前 ${l.before} / 退出后 ${l.after}，阈值 ${LOAD_NODE_HIGH}${l.count >= LOAD_NODE_HIGH ? '，有水位' : '，无水位'}）`

/** 退出耗时四档判定（T04543）。「没退出」不进放宽逻辑——那是关不掉/卡死，与负载无关，始终判红。 */
function exitGate(n, waited, load, extra = '') {
  const { exited, ms } = waited
  const tail = extra ? `；${extra}` : ''
  if (!exited) {
    const reason = waited.notDelivered ? '这一按没被接住，未进入退出计时' : `${ms}ms 内未退出`
    return check(n, false, `${reason}——关不掉/卡死与负载无关，始终判红${tail}`)
  }
  if (ms <= EXIT_MS_BUDGET) return check(n, true, `${ms}ms ≤ 基础门 ${EXIT_MS_BUDGET}ms；${loadText(load)}${tail}`)
  if (load.count !== null && load.count >= LOAD_NODE_HIGH && ms <= EXIT_MS_HARD) {
    return warn(n, `本次为并发环境下的宽松判定：${ms}ms 超基础门 ${EXIT_MS_BUDGET}ms、未超宽松上限 ${EXIT_MS_HARD}ms；${loadText(load)}${tail}`)
  }
  const noEvidence = load.count === null || load.count < LOAD_NODE_HIGH
  return check(n, false, `${ms}ms 超门（基础 ${EXIT_MS_BUDGET}ms / 宽松上限 ${EXIT_MS_HARD}ms）；${loadText(load)}${noEvidence ? '——无水位证据，不放宽' : '——已超宽松上限'}${tail}`)
}

/** 轮询到「主窗隐藏」为止（T04559）。进程退出不算隐藏：close_action=minimize_to_tray 走到退出，
 *  是关闭链走错分支，与负载无关。返回实际观测到隐藏的耗时（ms），供四档判定。 */
async function waitHidden(child, msBudget) {
  const t0 = Date.now()
  for (;;) {
    const probe = probeWindow(child.pid)
    const ms = Date.now() - t0
    if (child.exitCode !== null) return { hidden: false, exited: true, ms, probe }
    if (probe.total >= 1 && probe.visible === 0) return { hidden: true, exited: false, ms, probe }
    if (ms >= msBudget) return { hidden: false, exited: false, ms, probe }
    await sleep(250)
  }
}

/** P-C 隐藏判据的四档（T04559），口径与 exitGate 一致，只是量的是「窗口多久隐藏」而不是「进程多久退出」。 */
function hideGate(n, waited, load, extra = '') {
  const tail = extra ? `；${extra}` : ''
  const bounds = `基础预算 ${PC_WAIT_BUDGET}ms / 宽松上限 ${PC_WAIT_HARD}ms`
  const noEvidence = load.count === null || load.count < LOAD_NODE_HIGH
  if (waited.exited) {
    return check(n, false, `进程已退出（close_action=minimize_to_tray 不该退出）——与负载无关，始终判红；${loadText(load)}${tail}`)
  }
  if (!waited.hidden) {
    return check(n, false, `${PC_WAIT_HARD}ms 内窗口始终可见（${waited.probe.out}）；${bounds}；${loadText(load)}${noEvidence ? '——无水位证据，不放宽' : '——已超宽松上限'}${tail}`)
  }
  if (waited.ms <= PC_WAIT_BUDGET) {
    return check(n, true, `窗口在 ${waited.ms}ms 内隐藏（≤ 基础预算 ${PC_WAIT_BUDGET}ms）；${loadText(load)}${tail}`)
  }
  if (!noEvidence && waited.ms <= PC_WAIT_HARD) {
    return warn(n, `本次为并发环境下的宽松判定：${waited.ms}ms 才隐藏、超基础预算 ${PC_WAIT_BUDGET}ms、未超宽松上限 ${PC_WAIT_HARD}ms；${loadText(load)}${tail}`)
  }
  return check(n, false, `${waited.ms}ms 才隐藏（${bounds}）；${loadText(load)}${noEvidence ? '——无水位证据，不放宽' : '——已超宽松上限'}${tail}`)
}
setTimeout(() => { console.error('[bk] WATCHDOG'); process.exit(3) }, Number(process.env.WE_PROD_WATCHDOG_MS || 900000))

const scenario = makeLauncher({ exe: EXE, baseArgs: [], waitCdpMs: 90000 })
const readStr = f => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
// 每个场景起头把基线拨到「当前日志末尾」，之后该场景只看它自己新写的那一段——
// 产物目录里的 shell.log 是跨轮累积的，不隔开会读到上一轮的行。
let logBase = readStr(SHELL_LOG).length
const resetLogBase = () => { logBase = readStr(SHELL_LOG).length }
const tail = () => readStr(SHELL_LOG).slice(logBase)
/** 主进程落日志和断言读取有先后：轮询到关键字出现为止（最多 tries×250ms）再返回整段增量。
 *  同一场景的多条断言各自取增量里的行，但不「读完即推进基线」——
 *  那样后一条会看不见前一条已经吞掉的行（实测 [tray] 就因此假失败过）。 */
async function until(kw, tries = 12) {
  for (let i = 0; i < tries; i++) {
    const t = tail()
    if (t.includes(kw)) return t
    await sleep(250)
  }
  return tail()
}
const lastLine = (text, kw) => text.split('\n').findLast(l => l.includes(kw)) || `(本轮日志无 ${kw})`

async function teardown(s, rmBase = true) {
  try { if (s.ws) s.ws.close() } catch { /* noop */ }
  if (s.child && s.child.exitCode === null) killTree(s.child.pid)
  await freeSidecarPort()
  if (rmBase && s.base) removeTmp(s.base)
}

// sidecar 是 detached 启动的，强杀壳可能留下仍在监听 8020 的孤儿；下一轮 startBackend()
// 会因「端口已开」直接跳过 [boot] 日志，把下一条断言变成假失败。只回收我们自己那个 exe。
function stopOurSidecar() {
  spawnSync('powershell', ['-NoProfile', '-Command',
    `$id=(Get-NetTCPConnection -LocalPort ${SIDECAR_PORT} -State Listen -ErrorAction SilentlyContinue|Select-Object -First 1).OwningProcess;` +
    `if($id){$p=(Get-Process -Id $id -ErrorAction SilentlyContinue).Path;` +
    `if($p -eq '${SIDECAR}') { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }}`], { stdio: 'ignore' })
}
async function freeSidecarPort() {
  for (let i = 0; i < 40; i++) {
    if (!(await isPortOpen(SIDECAR_PORT))) return true
    if (i === 20) stopOurSidecar()
    await sleep(500)
  }
  return false
}

/** 读 asar 头部，返回条目路径列表。
 *  头部是「pickle 套 pickle」：偏移 0 固定 4，偏移 4 是头块长度 N，
 *  N 字节里偏移 0 是载荷长度、偏移 4 是 JSON 字符串长度，JSON 从偏移 8 起（按 4 字节对齐补零）。 */
function asarList(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(8)
    fs.readSync(fd, head, 0, 8, 0)
    const headerSize = head.readUInt32LE(4)
    if (headerSize <= 8 || headerSize > 8 * 1024 * 1024) return null
    const buf = Buffer.alloc(headerSize)
    fs.readSync(fd, buf, 0, headerSize, 8)
    const root = JSON.parse(buf.subarray(8, 8 + buf.readUInt32LE(4)).toString('utf8'))
    const out = []
    const walk = (node, prefix) => {
      for (const key of Object.keys(node.files || {})) {
        const p = prefix + '/' + key
        out.push(p)
        if (node.files[key].files) walk(node.files[key], p)
      }
    }
    walk(root, '')
    return out
  } catch {
    return null
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* noop */ } }
  }
}

const TRAY_PS = String.raw`param(
  [Parameter(Mandatory = $true)][string]$Names,
  [int]$Click = 0
)
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class TG {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
"@
$null = [TG]::SetProcessDPIAware()
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$PC = [System.Windows.Automation.PropertyCondition]
$CT = [System.Windows.Automation.ControlType]
$ct = $AE::ControlTypeProperty
$want = $Names.Split('|')
# 不同 Win10 版本把托盘项暴露成 Button / ListItem / Image，三种都扫；命中不了就报可枚举总数，
# 让「SKIP」带上可核对的数字，而不是一句空话。
$found = $null
$seen = 0
foreach ($t in @($CT::Button, $CT::ListItem, $CT::Image)) {
  foreach ($w in $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    $cn = $w.Current.ClassName
    if ($cn -ne 'Shell_TrayWnd' -and $cn -ne 'NotifyIconOverflowWindow') { continue }
    $items = $w.FindAll($TS::Descendants, (New-Object $PC($ct, $t)))
    $seen += $items.Count
    foreach ($i in $items) {
      if ($want -contains $i.Current.Name) { $found = $i; break }
    }
    if ($null -ne $found) { break }
  }
  if ($null -ne $found) { break }
}
Write-Output ('TRAY_ITEMS_SEEN=' + $seen)
if ($null -eq $found) { Write-Output 'TRAY_ICON=absent'; exit 2 }
$r = $found.Current.BoundingRectangle
Write-Output ('TRAY_ICON=found RECT=' + [int]$r.X + ',' + [int]$r.Y + ',' + [int]$r.Width + ',' + [int]$r.Height)
if ($Click -ne 1) { exit 0 }
$cx = [int]($r.X + $r.Width / 2)
$cy = [int]($r.Y + $r.Height / 2)
$null = [TG]::SetCursorPos($cx, $cy)
Start-Sleep -Milliseconds 200
# 0x0002 / 0x0004 = LEFTDOWN / LEFTUP
[TG]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[TG]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Write-Output ('CLICK=' + $cx + ',' + $cy)
`

// 各段实际断言条数，只用于「整体跳过时逐条打 SKIP」，让跳过清单和真跑清单对得上
const SCENARIOS = [
  ['P-A 首启关闭决策弹框（文案 + 真点「最小化到托盘」）', 11],
  ['P-A2 界面勾选「记住」+ 真点「直接关闭应用」', 5],
  ['P-A3 记住后同一 userData 冷重启不再弹框', 4],
  ['P-B 记住=退出时的退出耗时门', 2],
  ['P-C 托盘图标实点恢复窗口', 4],
]
const ALL_CHECKS = [['静态：产物落位与 asar 内容', 5], ...SCENARIOS]

// ---- 门禁一：产物在不在——不在则连静态检查都无从判，整套 SKIP（npm test 基线不能被「还没构建」拖红）----
let productGate = null
if (process.env.WE_PROD_SMOKE === '0') productGate = 'WE_PROD_SMOKE=0 显式跳过免安装产物冒烟'
else if (!fs.existsSync(EXE)) productGate = `免安装产物未构建：${EXE}（先跑 scripts/build_desktop_installer.ps1 或 npm run dist:dir）`
if (productGate) {
  skipReason = productGate
  for (const [name, n] of ALL_CHECKS) for (let i = 1; i <= n; i++) skip(`${name} #${i}`, productGate)
} else {
  // ---- 0) 产物落位与 asar 内容（不起进程，任何环境都能判）----
  {
    check('免安装产物目录存在', fs.existsSync(PROD_DIR), PROD_DIR)
    check('主程序 exe 存在', fs.existsSync(EXE), EXE)
    check('sidecar 落位 resources/we-eval/（extraResources 到位）', fs.existsSync(SIDECAR), SIDECAR)
    check('托盘图标落位 resources/we-icon.ico（extraResources 到位）', fs.existsSync(ICON), ICON)
    const names = fs.existsSync(ASAR) ? asarList(ASAR) : null
    if (!names) {
      check('app.asar 头部可解析', false, ASAR)
    } else {
      // 漏任何一个都会让主进程 require 失败、启动即崩；开发态跑散文件，永远测不出来
      const need = ['main.js', 'preload.js', 'window-prefs.js', 'i18n-shell.js', 'package.json']
      const miss = need.filter(f => !names.includes('/' + f))
      check('app.asar 含壳侧全部依赖文件（含 window-prefs.js）', miss.length === 0,
        miss.length ? '缺 ' + miss.join(',') : need.join(','))
    }
  }

  // ---- 门禁二：能不能跑实机场景（静态检查已经判过了，这里只跳过要桌面/要端口的部分）----
  let gate = null
  if (process.platform !== 'win32') gate = `非 Windows（${process.platform}）：原生弹框/托盘驱动不可用`
  else if (!/explorer\.exe/i.test(spawnSync('tasklist', ['/FI', 'IMAGENAME eq explorer.exe', '/NH'], { encoding: 'utf8' }).stdout || ''))
    gate = '当前会话无交互桌面（explorer.exe 未运行）：无法驱动原生模态框'
  else if (await isPortOpen(SIDECAR_PORT)) {
    // 上一轮崩溃时 teardown 跑不到，会留下属于本产物的孤儿 sidecar。先回收一次再判：
    // 否则整套实机断言会被「全部 SKIP 也算绿」静默架空，发布门形同没门。
    stopOurSidecar()
    await sleep(1500)
    if (await isPortOpen(SIDECAR_PORT))
      gate = `端口 ${SIDECAR_PORT} 已被占用（且不是本产物的 sidecar）：产物会复用那个后端，[boot] 与任务探测断言都不可信`
  }

  if (gate) {
    skipReason = gate
    for (const [name, n] of SCENARIOS) for (let i = 1; i <= n; i++) skip(`${name} #${i}`, gate)
  } else {
    await runScenarios()
  }
}

async function runScenarios() {
  await scenarioPA()
  const a2 = await scenarioPA2()
  await scenarioPA3(a2)
  await scenarioPB()
  await scenarioPC()
}

/** 首按可能被 TaskDialog 吞掉（T04475/T04506）：补按到 DIALOG_AFTER=no 或 not_found 为止（≤2 次）。 */
function clickUntilGone(pid, button, first) {
  let clicked = first
  let retries = 0
  for (let i = 0; i < 2 && clicked.out.includes('DIALOG_AFTER=yes'); i++) {
    clicked = driveDialog(pid, { button })
    retries++
    if (clicked.out.includes('DIALOG=not_found')) break
  }
  return { clicked, retries }
}

/** 弹框文案与壳侧语言表比对，返回不一致项（空数组=全对）。 */
function dialogMismatches(got, closeLine, lang) {
  const want = CLOSE_TEXTS[lang]
  if (!want) return [`主进程日志未给出可识别的 lang（${closeLine}）`]
  const miss = []
  if (got.title !== want.title) miss.push(`title="${got.title}"`)
  if (!got.texts.includes(want.message)) miss.push('message 未出现')
  if (!got.texts.includes(want.detail)) miss.push('detail 未出现')
  if (got.checkbox !== want.checkbox) miss.push(`checkbox="${got.checkbox}"`)
  if (got.buttons[0] !== want.buttons[0] || got.buttons[1] !== want.buttons[1])
    miss.push('按钮文案/顺序不符：' + got.buttons.join('|'))
  return miss
}

/** 读 userData 下的 window-prefs.json（缺失/坏 JSON 返回 null）。 */
function readWindowPrefs(ud) {
  try { return JSON.parse(fs.readFileSync(path.join(ud, 'window-prefs.json'), 'utf8')) } catch { return null }
}

/** 等主窗真正显示后再发 WM_CLOSE。CDP readyState=complete 只代表页面加载完，
 *  窗口可能还在 show()/ready-to-show 的间隙；此时 taskkill 找不到可见顶层窗口，
 *  P-A / P-A3 会误判成「关不掉」，实测同一产物两次跑出不同结果（T06353 发布门）。 */
async function waitWindowVisible(pid, timeoutMs = 10000) {
  const t0 = Date.now()
  let probe = null
  while (Date.now() - t0 < timeoutMs) {
    probe = probeWindow(pid)
    if (probe.total >= 1 && probe.visible >= 1) return probe
    await sleep(250)
  }
  return probe || probeWindow(pid)
}

/** P-A：首启（userData 无偏好文件）关闭 → 必须弹框，文案来自壳侧表，真点「最小化到托盘」。 */
async function scenarioPA() {
  resetLogBase()
  const s = await scenario('prod_pa', 9461, null)
  if (!s.ok) {
    check('P-A 产物可启动且首页加载完成', false, s.detail)
    return
  }
  check('P-A 产物可启动且首页加载完成', true, 'CDP readyState=complete')
  const boot = lastLine(await until('[boot]'), '[boot]')
  const field = (boot.match(/sidecar=(.+)$/) || [])[1] || ''
  // 装包态必须是 exe:资源目录里那份；出现 python: 说明 extraResources 没到位、回退到源码解释器
  check('P-A sidecar 走的是打进包的 exe（非 python 回退）',
    field === 'exe:' + SIDECAR.replaceAll('\\', '/'), field || boot)
  await waitWindowVisible(s.child.pid, 90000)
  requestClose(s.child.pid)
  await sleep(2500)
  check('P-A 未记住选择时进程保持运行（等待用户决策）', s.child.exitCode === null, `exitCode=${s.child.exitCode}`)
  const before = probeWindow(s.child.pid)
  check('P-A 弹框前主窗仍可见（模态框未替用户做选择）', before.visible === 1, before.out)
  // 先 dump 再按文案取按钮——写死 0/1 会在换语言/换系统按钮顺序时假失败
  const dump = driveDialog(s.child.pid, { dump: 1, waitMs: 15000 })
  const got = readDialogTexts(dump.out)
  check('P-A 模态框出现且暴露两个按钮', dump.out.includes('DIALOG=found') && got.buttons.length === 2,
    dump.out.split('\n')[0] + ' buttons=' + got.buttons.length)
  // BM_CLICK 的首按会被 TaskDialog 偶发吞掉（T04475 空载实测 30 次吞 7 次；与「对话框还在初始化」无关，
  // 0ms/400ms 延时都吞），主进程既没落 [close] 也没隐藏窗口（run1 生效、run3 无反应）。
  // 判据与开发态套件 tests/shell_close_smoke.mjs 的 clickDialog() 对齐（T04506）：只看驱动自己
  // 报出的 DIALOG_AFTER——按完对话框窗口真没了才算接住，还开着才补按（≤3 次），不再拿
  // 「固定 sleep + 主窗可见性」当重试触发器（那既慢又是间接信号：最小化到托盘后主窗本就隐藏，
  // 两个信号在这里恰好同向纯属巧合）。driveDialog 自己已经轮询 IsWindow 约 700ms 才报这一行，
  // 所以这里不需要额外等。
  const first = driveDialog(s.child.pid, { button: 0 })
  const { clicked, retries } = clickUntilGone(s.child.pid, 0, first)
  // 决策已接住，给主进程一点时间把窗口收进托盘，再读「窗口在不在屏幕上」这条独立断言。
  await sleep(2000)
  const after = probeWindow(s.child.pid)
  const closeLine = lastLine(await until('[close]'), '[close]')
  const lang = (closeLine.match(/lang=(\S+)/) || [])[1] || ''
  const miss = dialogMismatches(got, closeLine, lang)
  check('P-A 弹框标题/正文/复选框/按钮文案与壳侧语言一致', miss.length === 0, miss.join(' / ') || `lang=${lang}`)
  // 勾选状态只看第一次（补按不再翻勾，但证据要落在真正带勾选动作的那次上）
  check('P-A 未勾选时复选框保持 Off',
    first.out.includes('CHECKBOX_BEFORE=Off') && first.out.includes('CHECKBOX_AFTER=Off'), first.out)
  // 投递判据用 DIALOG_AFTER=no（对话框窗口真没了），不用 INVOKE：SendMessageTimeout
  // 返回 TRUE 只证明消息进了队列，首按被吞掉时它照样是 sent（T04475）。
  const retryNote = retries ? `被吞、补按 ${retries} 次后 DIALOG_AFTER=no` : '即接住（0 次补按）'
  check('P-A 真点「最小化到托盘」后窗口隐藏、进程不退出',
    clicked.out.includes('DIALOG_AFTER=no') && s.child.exitCode === null && after.visible === 0,
    `首按${retryNote}；${after.out}`)
  const trayLine = lastLine(await until('[tray]'), '[tray]')
  const iconSrc = (trayLine.match(/icon=(\S+)/) || [])[1] || ''
  check('P-A 托盘图标取自打进包的 we-icon.ico（非通用 exe 图标回退）',
    iconSrc !== 'FALLBACK-execIcon' && path.normalize(iconSrc) === ICON, trayLine)
  check('P-A 关闭决策日志为 action=minimize_to_tray prompted=true',
    /\[close\] action=minimize_to_tray prompted=true/.test(closeLine), closeLine)
  check('P-A 未勾选「记住」则不落盘偏好（下次仍弹）', !fs.existsSync(path.join(s.ud, 'window-prefs.json')))
  await teardown(s)
}

/** P-A2：真点复选框「记住此选择」+「直接关闭应用」→ 落盘 + 退出。返回实例供 P-A3 复用。 */
async function scenarioPA2() {
  const s = await scenario('prod_pa2', 9462, null)
  if (!s.ok) {
    check('P-A2 产物可启动', false, s.detail)
    return null
  }
  const loadBefore = sampleLoad()
  await waitWindowVisible(s.child.pid, 90000)
  requestClose(s.child.pid)
  await sleep(2000)
  const dump = driveDialog(s.child.pid, { dump: 1, waitMs: 15000 })
  const got = readDialogTexts(dump.out)
  // 「直接关闭应用」按实机 dump 出的文案定位，取两种语言表里的第二个按钮名
  const exitIdx = got.buttons.findIndex(b => b === CLOSE_TEXTS['zh-CN'].buttons[1] || b === CLOSE_TEXTS['en-US'].buttons[1])
  const drv = exitIdx >= 0 ? driveDialog(s.child.pid, { tick: 1, button: exitIdx }) : { out: 'BUTTON=missing' }
  // 与 P-A 同一个首按被吞（T04475 实测约 1/4，与对话框是否还在初始化无关）。T04506 起补点的
  // 触发条件换成驱动自己报的 DIALOG_AFTER=yes：原先拿「8s 内没退出」当信号，会把一次被吞的按
  // 误判成「退出链慢」，最坏白等 8s 再补点、再等 45s。补点只按按钮、不再翻勾，
  // 免得把已勾上的「记住」又取消掉。
  const { clicked: last, retries } = exitIdx >= 0 ? clickUntilGone(s.child.pid, exitIdx, drv) : { clicked: drv, retries: 0 }
  // 三按都没接住时对话框还开着，等退出必然等到超时——直接带证据判红，不再空等 EXIT_WAIT。
  const delivered = last.out.includes('DIALOG_AFTER=no') || last.out.includes('DIALOG=not_found')
  const waited = delivered ? await waitExit(s.child, EXIT_WAIT) : { exited: false, ms: 0, notDelivered: true }
  const load = loadPeak(loadBefore)
  const { exited, ms } = waited
  check('P-A2 模态框两个按钮都在、能按文案定位到「直接关闭应用」',
    dump.out.includes('DIALOG=found') && got.buttons.length === 2 && exitIdx >= 0, got.buttons.join(' | '))
  check('P-A2 界面勾选「记住此选择」生效',
    drv.out.includes('CHECKBOX_BEFORE=Off') && drv.out.includes('CHECKBOX_AFTER=On'),
    drv.out.split('\n').at(-1))
  const retryTag = retries ? `（补点 ${retries} 次后）` : '（首按即接住）'
  check('P-A2 真点「直接关闭应用」后进程退出', exited,
    exited ? `耗时 ${ms}ms${retryTag}`
      : delivered ? `${ms}ms 内未退出` : `这一按没被接住：${last.out.split('\n').at(-1)}`)
  const onDisk = readWindowPrefs(s.ud)
  check('P-A2 选择落盘为 exit_app + remember_choice=true',
    !!onDisk && onDisk.close_action === 'exit_app' && onDisk.remember_choice === true, JSON.stringify(onDisk))
  exitGate('P-A2 本轮退出耗时在预算内', waited, load,
    retries ? `补点 ${retries} 次后` : '首按即接住')
  return s // userData 留给 P-A3 复用，临时目录到 A3 结束才删
}

/** P-A3：同一 userData 冷重启 → 不再弹框，直接按记住的选择退出。 */
async function scenarioPA3(a2) {
  if (!a2) {
    const why = 'P-A2 未能建立「已记住」状态'
    for (const n of ['冷重启可启动', '按记住的选择直接退出（不再弹框）', '关闭决策日志 prompted=false remembered=true', '偏好文件仍是上轮写入的那份'])
      skip('P-A3 ' + n, why)
    return
  }
  resetLogBase()
  const s = await scenario('prod_pa3', 9463, null, { udDir: a2.ud })
  if (!s.ok) {
    check('P-A3 冷重启可启动', false, s.detail)
  } else {
    check('P-A3 冷重启可启动', true, a2.ud)
    const loadBefore = sampleLoad()
    await waitWindowVisible(s.child.pid, 90000)
    requestClose(s.child.pid)
    const waited = await waitExit(s.child, EXIT_WAIT)
    const load = loadPeak(loadBefore)
    const { exited, ms } = waited
    const closeLine = lastLine(await until('[close]'), '[close]')
    // 装包态「记住」生效 = 主进程根本没走 askCloseAction（prompted=false），比「屏幕没弹框」更硬
    // P-A3 只判「有没有退出」、不设耗时门；耗时与水位一并落进明细，给 T04507 当负载读数用。
    const exitText = exited ? `耗时 ${ms}ms` : `${ms}ms 内未退出`
    check('P-A3 按记住的选择直接退出（不再弹框）', exited,
      `${exitText}；${loadText(load)}`)
    check('P-A3 关闭决策日志 prompted=false remembered=true',
      /\[close\] action=exit_app prompted=false remembered=true/.test(closeLine), closeLine)
    let onDisk = null
    try { onDisk = JSON.parse(fs.readFileSync(path.join(s.ud, 'window-prefs.json'), 'utf8')) } catch { /* noop */ }
    check('P-A3 偏好文件仍是上轮写入的那份',
      !!onDisk && onDisk.close_action === 'exit_app' && onDisk.remember_choice === true, JSON.stringify(onDisk))
  }
  await teardown(a2, false)
  await teardown(s, true)
}

/** P-B：预置「记住=退出」的干净退出耗时门（不走界面勾选路径）。 */
async function scenarioPB() {
  resetLogBase()
  const s = await scenario('prod_pb', 9464, { close_action: 'exit_app', remember_choice: true })
  if (!s.ok) {
    check('P-B 记住=退出场景可启动', false, s.detail)
    return
  }
  const loadBefore = sampleLoad()
  await waitWindowVisible(s.child.pid, 90000)
  requestClose(s.child.pid)
  const waited = await waitExit(s.child, EXIT_WAIT)
  const load = loadPeak(loadBefore)
  exitGate('P-B 关窗后进程退出且耗时在预算内', waited, load, '空载同产物实测散布 1224~2825ms')
  const closeLine = lastLine(await until('[close]'), '[close]')
  check('P-B 退出链未落入保底分支（action=exit_app 而非 decision failed）',
    /action=exit_app/.test(closeLine), closeLine)
  await teardown(s)
}

/** P-C：托盘图标实点恢复窗口（要求托盘项在 UIA 可枚举，否则 SKIP）。 */
async function scenarioPC() {
  resetLogBase()
  const s = await scenario('prod_pc', 9465, { close_action: 'minimize_to_tray', remember_choice: true })
  if (!s.ok) {
    check('P-C 最小化到托盘场景可启动', false, s.detail)
    return
  }
  const loadBefore = sampleLoad()
  await waitWindowVisible(s.child.pid, 90000)
  requestClose(s.child.pid)
  const waitedHide = await waitHidden(s.child, PC_WAIT_HARD)
  const load = loadPeak(loadBefore)
  // 决策行原文进明细：没有 [close] 行 = 决策压根没到（不是判据问题），有行但落得晚 = 本单要治的那种。
  const closeLine = lastLine(await until('[close]'), '[close]')
  hideGate('P-C 记住=最小化后窗口隐藏、进程存活', waitedHide, load, `决策行=${closeLine}`)
  const probe = probeTrayIcon(1)
  if (!probe.out.includes('TRAY_ICON=found')) {
    const why = '托盘图标在本机 UIA 中不可枚举（T03958 实测四条通道均不可达）：' + (probe.out.split('\n').slice(0, 2).join(' ') || '无输出')
    skip('P-C 托盘图标可枚举且 tooltip 为应用名', why)
    skip('P-C 实点托盘图标后窗口重新可见', why)
    skip('P-C 恢复窗口后进程仍是同一个（未重启）', why)
  } else {
    check('P-C 托盘图标可枚举且 tooltip 为应用名', true, probe.out.split('\n').slice(0, 2).join(' '))
    await sleep(2000)
    const shown = probeWindow(s.child.pid)
    check('P-C 实点托盘图标后窗口重新可见', shown.visible === 1, `${shown.out} ${probe.out.split('\n')[2] || ''}`)
    check('P-C 恢复窗口后进程仍是同一个（未重启）', s.child.exitCode === null, `exitCode=${s.child.exitCode}`)
  }
  await teardown(s)
}

/** 托盘图标定位 + 真点。应用名可能含中文，作参数传进去（argv 走 UTF-16，不经代码页）；
 *  指针移动前必须 SetProcessDPIAware，否则 PS 进程被 DPI 虚拟化，UIA 的物理坐标点偏。 */
function probeTrayIcon(click) {
  const require = createRequire(import.meta.url)
  const { createT } = require(path.join(ROOT, 'dev-shell', 'i18n-shell.js'))
  const names = [createT('zh-CN').t('app_name'), createT('en-US').t('app_name')].join('|')
  const f = path.join(os.tmpdir(), `we_tray_probe_${process.pid}.ps1`)
  fs.writeFileSync(f, '\ufeff' + TRAY_PS)
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f,
    '-Names', names, '-Click', String(click)], { encoding: 'utf8' })
  try { fs.rmSync(f, { force: true }) } catch { /* noop */ }
  return { out: ((r.stdout || '') + (r.stderr || '')).replaceAll('\r', '').trim() }
}


cleanupDialogScript()
const failed = res.filter(r => !r.ok)
console.log(`\n==== 免安装产物冒烟（${PROD_DIR}）==== ` +
  (failed.length ? `失败 ${failed.length}/${res.length}` : `全绿 ${res.length} 项`) +
  (warns.length ? `；另有 ${warns.length} 项并发环境下的宽松判定 WARN（ok=true，不计入失败）` : ''))
if (skipReason) console.log(`说明：实机场景整体跳过——${skipReason}`)
// 负载水位读数（T04543）：每次退出计时都采了「关闭前 / 退出后」两个数并取大者。
// 这一行同时是 T04507（吞按率是否随负载放大）要的水位口径，两边用同一个 LOAD_NODE= 计数法。
const ns = loadSamples.map(l => l.count).filter(n => n !== null).sort((a, b) => a - b)
const mid = ns.length ? (ns.length % 2 ? ns.at((ns.length - 1) / 2) : (ns.at(ns.length / 2 - 1) + ns.at(ns.length / 2)) / 2) : null
console.log(`负载水位：node.exe 采样 ${loadSamples.length} 次` +
  (ns.length ? `，min/中位/max = ${ns[0]}/${mid}/${ns.at(-1)}` : '（未采到计数）') +
  `；高水位阈值 ${LOAD_NODE_HIGH}；退出耗时门 基础 ${EXIT_MS_BUDGET}ms / 有水位时宽松上限 ${EXIT_MS_HARD}ms`)
if (warns.length) console.log(`宽松判定项：${warns.join('；')}`)
process.exit(failed.length ? 1 : 0)
