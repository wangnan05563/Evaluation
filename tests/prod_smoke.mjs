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
// 退出耗时门：装包态的关闭链比开发态慢——关闭前要打 /api/jobs/running 探任务（超时预算 1.5s），
// 还要回收 detached 的 PyInstaller 进程树。本机同产物实测散布 1224 / 1437 / 2094 / 2825ms
// （开发态基线 401~648ms），阈值取 5000ms（约为实测上限 1.8 倍），可用 WE_PROD_EXIT_MS_BUDGET 收紧。
// 阈值宁可略宽：这门要挡的是「关不掉/卡死」这类回归（真出问题时是几十秒级），不是毫秒级抖动。
const EXIT_MS_BUDGET = Number(process.env.WE_PROD_EXIT_MS_BUDGET || 5000)
const EXIT_WAIT = Number(process.env.WE_PROD_EXIT_WAIT || 45000)
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
const lastLine = (text, kw) => text.split('\n').filter(l => l.includes(kw)).slice(-1)[0] || `(本轮日志无 ${kw})`

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
  // ---- P-A：首启（userData 无偏好文件）关闭 → 必须弹框，文案来自壳侧表，真点「最小化到托盘」----
  {
    resetLogBase()
    const s = await scenario('prod_pa', 9461, null)
    if (!s.ok) {
      check('P-A 产物可启动且首页加载完成', false, s.detail)
    } else {
      check('P-A 产物可启动且首页加载完成', true, 'CDP readyState=complete')
      const boot = lastLine(await until('[boot]'), '[boot]')
      const field = (boot.match(/sidecar=(.+)$/) || [])[1] || ''
      // 装包态必须是 exe:资源目录里那份；出现 python: 说明 extraResources 没到位、回退到源码解释器
      check('P-A sidecar 走的是打进包的 exe（非 python 回退）',
        field === 'exe:' + SIDECAR.replace(/\\/g, '/'), field || boot)
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
      // BM_CLICK 的首按会被 TaskDialog 偶发吞掉（T04475 空载实测约 1/3；与「对话框还在初始化」无关，
      // 0ms/400ms 延时都吞），主进程既没落 [close] 也没隐藏窗口（run1 生效、run3 无反应）。
      // 点一次没反应就再点一次，最多三次；对话框已销毁时 driveDialog 报 not_found 即停手，
      // 不会误触第二个动作（这枚 token 在 T04475 之前与驱动输出的 absent 对不上，保险是空的）。
      const first = driveDialog(s.child.pid, { button: 0 })
      let clicked = first
      await sleep(2000)
      let after = probeWindow(s.child.pid)
      for (let i = 0; i < 2 && after.visible === 1; i++) {
        const again = driveDialog(s.child.pid, { button: 0 })
        if (again.out.includes('DIALOG=not_found')) break
        clicked = again
        await sleep(2000)
        after = probeWindow(s.child.pid)
      }
      const closeLine = lastLine(await until('[close]'), '[close]')
      const lang = (closeLine.match(/lang=(\S+)/) || [])[1] || ''
      const want = CLOSE_TEXTS[lang]
      const miss = []
      if (!want) miss.push(`主进程日志未给出可识别的 lang（${closeLine}）`)
      else {
        if (got.title !== want.title) miss.push(`title="${got.title}"`)
        if (!got.texts.includes(want.message)) miss.push('message 未出现')
        if (!got.texts.includes(want.detail)) miss.push('detail 未出现')
        if (got.checkbox !== want.checkbox) miss.push(`checkbox="${got.checkbox}"`)
        if (got.buttons[0] !== want.buttons[0] || got.buttons[1] !== want.buttons[1])
          miss.push('按钮文案/顺序不符：' + got.buttons.join('|'))
      }
      check('P-A 弹框标题/正文/复选框/按钮文案与壳侧语言一致', miss.length === 0, miss.join(' / ') || `lang=${lang}`)
      check('P-A 未勾选时复选框保持 Off',
        clicked.out.includes('CHECKBOX_BEFORE=Off') && clicked.out.includes('CHECKBOX_AFTER=Off'), clicked.out)
      // 投递判据用 DIALOG_AFTER=no（对话框窗口真没了），不用 INVOKE：SendMessageTimeout
      // 返回 TRUE 只证明消息进了队列，首按被吞掉时它照样是 sent（T04475）。
      check('P-A 真点「最小化到托盘」后窗口隐藏、进程不退出',
        clicked.out.includes('DIALOG_AFTER=no') && s.child.exitCode === null && after.visible === 0,
        `DIALOG_AFTER=${/DIALOG_AFTER=(\S+)/.exec(clicked.out)?.[1]} ${after.out}`)
      const trayLine = lastLine(await until('[tray]'), '[tray]')
      const iconSrc = (trayLine.match(/icon=(\S+)/) || [])[1] || ''
      check('P-A 托盘图标取自打进包的 we-icon.ico（非通用 exe 图标回退）',
        iconSrc !== 'FALLBACK-execIcon' && path.normalize(iconSrc) === ICON, trayLine)
      check('P-A 关闭决策日志为 action=minimize_to_tray prompted=true',
        /\[close\] action=minimize_to_tray prompted=true/.test(closeLine), closeLine)
      check('P-A 未勾选「记住」则不落盘偏好（下次仍弹）', !fs.existsSync(path.join(s.ud, 'window-prefs.json')))
      await teardown(s)
    }
  }

  // ---- P-A2：真点复选框「记住此选择」+「直接关闭应用」→ 落盘 + 退出 ----
  let a2 = null
  {
    const s = await scenario('prod_pa2', 9462, null)
    if (!s.ok) {
      check('P-A2 产物可启动', false, s.detail)
    } else {
      requestClose(s.child.pid)
      await sleep(2000)
      const dump = driveDialog(s.child.pid, { dump: 1, waitMs: 15000 })
      const got = readDialogTexts(dump.out)
      // 「直接关闭应用」按实机 dump 出的文案定位，取两种语言表里的第二个按钮名
      const exitIdx = got.buttons.findIndex(b => b === CLOSE_TEXTS['zh-CN'].buttons[1] || b === CLOSE_TEXTS['en-US'].buttons[1])
      const drv = exitIdx >= 0 ? driveDialog(s.child.pid, { tick: 1, button: exitIdx }) : { out: 'BUTTON=missing' }
      // 与 P-A 同一个首按被吞（T04475 实测约 1/3，与对话框是否还在初始化无关）：
      // 8s 内没退出就补点一次，补点只按按钮、不再勾复选框，免得把已勾上的「记住」又取消掉。
      let waited = exitIdx >= 0 ? await waitExit(s.child, 8000) : { exited: false, ms: 0 }
      let retries = 0
      while (!waited.exited && exitIdx >= 0 && retries < 2) {
        const again = driveDialog(s.child.pid, { button: exitIdx })
        retries++
        if (again.out.includes('DIALOG=not_found')) break
        waited = await waitExit(s.child, EXIT_WAIT)
      }
      const { exited, ms } = waited
      check('P-A2 模态框两个按钮都在、能按文案定位到「直接关闭应用」',
        dump.out.includes('DIALOG=found') && got.buttons.length === 2 && exitIdx >= 0, got.buttons.join(' | '))
      check('P-A2 界面勾选「记住此选择」生效',
        drv.out.includes('CHECKBOX_BEFORE=Off') && drv.out.includes('CHECKBOX_AFTER=On'),
        drv.out.split('\n').slice(-1)[0])
      check('P-A2 真点「直接关闭应用」后进程退出', exited,
        exited ? `耗时 ${ms}ms${retries ? `（补点 ${retries} 次后）` : ''}` : `${ms}ms 内未退出`)
      let onDisk = null
      try { onDisk = JSON.parse(fs.readFileSync(path.join(s.ud, 'window-prefs.json'), 'utf8')) } catch { /* 勾选后应落盘 */ }
      check('P-A2 选择落盘为 exit_app + remember_choice=true',
        !!onDisk && onDisk.close_action === 'exit_app' && onDisk.remember_choice === true, JSON.stringify(onDisk))
      check(`P-A2 本轮退出耗时在预算内（≤${EXIT_MS_BUDGET}ms）`, exited && ms <= EXIT_MS_BUDGET,
        exited ? `${ms}ms${retries ? `（补点 ${retries} 次后）` : ''}` : '未退出')
      a2 = s // userData 留给 P-A3 复用，临时目录到 A3 结束才删
    }
  }

  // ---- P-A3：同一 userData 冷重启 → 不再弹框，直接按记住的选择退出 ----
  if (!a2) {
    const why = 'P-A2 未能建立「已记住」状态'
    for (const n of ['冷重启可启动', '按记住的选择直接退出（不再弹框）', '关闭决策日志 prompted=false remembered=true', '偏好文件仍是上轮写入的那份'])
      skip('P-A3 ' + n, why)
  } else {
    resetLogBase()
    const s = await scenario('prod_pa3', 9463, null, { udDir: a2.ud })
    if (!s.ok) {
      check('P-A3 冷重启可启动', false, s.detail)
    } else {
      check('P-A3 冷重启可启动', true, a2.ud)
      requestClose(s.child.pid)
      const { exited, ms } = await waitExit(s.child, EXIT_WAIT)
      const closeLine = lastLine(await until('[close]'), '[close]')
      // 装包态「记住」生效 = 主进程根本没走 askCloseAction（prompted=false），比「屏幕没弹框」更硬
      check('P-A3 按记住的选择直接退出（不再弹框）', exited, exited ? `耗时 ${ms}ms` : `${ms}ms 内未退出`)
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

  // ---- P-B：预置「记住=退出」的干净退出耗时门（不走界面勾选路径）----
  {
    resetLogBase()
    const s = await scenario('prod_pb', 9464, { close_action: 'exit_app', remember_choice: true })
    if (!s.ok) {
      check('P-B 记住=退出场景可启动', false, s.detail)
    } else {
      requestClose(s.child.pid)
      const { exited, ms } = await waitExit(s.child, EXIT_WAIT)
      check(`P-B 关窗后进程退出且耗时 ≤ ${EXIT_MS_BUDGET}ms`, exited && ms <= EXIT_MS_BUDGET,
        `${exited ? `耗时 ${ms}ms` : `${ms}ms 内未退出`}（本机同产物实测散布 1224~2825ms）`)
      const closeLine = lastLine(await until('[close]'), '[close]')
      check('P-B 退出链未落入保底分支（action=exit_app 而非 decision failed）',
        /action=exit_app/.test(closeLine), closeLine)
      await teardown(s)
    }
  }

  // ---- P-C：托盘图标实点恢复窗口（要求托盘项在 UIA 可枚举，否则 SKIP）----
  {
    resetLogBase()
    const s = await scenario('prod_pc', 9465, { close_action: 'minimize_to_tray', remember_choice: true })
    if (!s.ok) {
      check('P-C 最小化到托盘场景可启动', false, s.detail)
    } else {
      requestClose(s.child.pid)
      await sleep(3000)
      const hidden = probeWindow(s.child.pid)
      check('P-C 记住=最小化后窗口隐藏、进程存活',
        s.child.exitCode === null && hidden.total >= 1 && hidden.visible === 0,
        `${hidden.out} exitCode=${s.child.exitCode} ${lastLine(await until('[tray]'), '[tray]')}`)
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
  }
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
  return { out: ((r.stdout || '') + (r.stderr || '')).replace(/\r/g, '').trim() }
}


cleanupDialogScript()
const failed = res.filter(r => !r.ok)
console.log(`\n==== 免安装产物冒烟（${PROD_DIR}）==== ` +
  (failed.length ? `失败 ${failed.length}/${res.length}` : `全绿 ${res.length} 项`))
if (skipReason) console.log(`说明：实机场景整体跳过——${skipReason}`)
process.exit(failed.length ? 1 : 0)
