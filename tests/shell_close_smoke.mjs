/** T03779 Electron 壳关闭行为实机烟测（真实 Electron 主进程 + CDP + 原生弹框驱动）。
 *  独立运行：node tests/shell_close_smoke.mjs
 *  覆盖：记住选择=最小化 → 关窗后进程存活且窗口隐藏、托盘建立；
 *        记住选择=直接关闭 → 关窗后进程退出；
 *        未记住选择 → 弹出模态框（进程存活、窗口仍可见、不自动落盘）；
 *        真实 preload IPC 往返（配置中心读写同一通道）与落盘原子性；
 *        真点模态框（UI Automation 驱动系统 TaskDialog）：勾选记住+退出→落盘、
 *        不勾选+最小化→执行但不改配置。
 *  说明：原生弹框不是 DOM，CDP 无法触达，改用 Windows UIA 定位并点击按钮/复选框。
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = path.join(ROOT, 'dev-shell', 'node_modules', 'electron', 'dist', 'electron.exe')
const APP_DIR = path.join(ROOT, 'dev-shell')
const SHELL_LOG = path.join(ROOT, 'logs', 'shell.log')
const res = []
const check = (n, ok, d = '') => {
  res.push({ n, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const killTree = pid => { try { spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }) } catch { /* noop */ } }
setTimeout(() => { console.error('[bk] WATCHDOG'); process.exit(3) }, 180000)

async function waitCdpPage(port, timeoutMs = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch { /* 未就绪 */ }
    await sleep(300)
  }
  return null
}

// 每个场景独立 user-data-dir：隔离偏好文件与单实例锁
async function scenario(name, port, prefs) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `we_shell_${name}_`))
  const ud = path.join(base, 'ud')
  fs.mkdirSync(ud, { recursive: true })
  if (prefs) fs.writeFileSync(path.join(ud, 'window-prefs.json'), JSON.stringify(prefs), 'utf8')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  env.WE_DEV_URL = 'data:text/html,<html><head><meta charset="utf-8"><title>shell smoke</title></head><body>shell smoke</body></html>'
  const child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${port}`, `--user-data-dir=${ud}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let tail = ''
  child.stdout.on('data', d => { tail = (tail + d).slice(-4000) })
  child.stderr.on('data', d => { tail = (tail + d).slice(-4000) })
  const page = await waitCdpPage(port)
  if (!page) {
    killTree(child.pid)
    return { ok: false, detail: 'CDP 页面未就绪\n' + tail, base, child }
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no })
  let id = 0
  const pend = new Map()
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id); pend.delete(m.id)
      m.error ? p.no(new Error(JSON.stringify(m.error))) : p.ok(m.result)
    }
  }
  const send = (method, params) => {
    const i = ++id
    ws.send(JSON.stringify({ id: i, method, params }))
    return new Promise((ok, no) => {
      pend.set(i, { ok, no })
      setTimeout(() => { if (pend.has(i)) { pend.delete(i); no(new Error('cdp timeout: ' + method)) } }, 15000)
    })
  }
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: true })
    return { value: r.result?.value, closed: false }
  }
  const evaluateAwait = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error')
    return r.result?.value
  }
  await send('Page.enable')
  await send('Runtime.enable')
  for (let i = 0; i < 60; i++) {
    try { if ((await evaluate('document.readyState')).value === 'complete') break } catch { /* 尚在加载 */ }
    await sleep(250)
  }
  return { ok: true, ws, child, base, ud, evaluate, evaluateAwait, tail: () => tail }
}

async function waitExit(child, timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (child.exitCode !== null) return { exited: true, ms: Date.now() - t0 }
    await sleep(200)
  }
  return { exited: false, ms: Date.now() - t0 }
}

// 不带 /F 的 taskkill 会向进程顶层窗口发送 WM_CLOSE，等价于点击标题栏关闭按钮
function requestClose(pid) {
  return spawnSync('taskkill', ['/PID', String(pid)], { encoding: 'utf8' })
}

// ---- 原生模态框驱动（Windows UIA + Win32 BM_CLICK）----
// 关闭弹框是系统 TaskDialog（#32770），不是 DOM，CDP 触达不到。定位路径经实测：
// UIA 里它挂在主窗口的后代节点下，按钮以 ControlType.Pane（无 Invoke pattern）暴露，
// 但 Win32 侧是 class=Button 的真实子窗口，故复选框走 UIA Toggle、按钮走 BM_CLICK。
// 脚本只保留 ASCII，避免 Windows PowerShell 5.1 的源码编码歧义。
const UIA_PS = String.raw`param(
  [Parameter(Mandatory = $true)][int]$ProcId,
  [int]$Tick = 0,
  [int]$Button = 0,
  [int]$WaitMs = 20000
)
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WD {
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
}
"@
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$PC = [System.Windows.Automation.PropertyCondition]
$ctProp = $AE::ControlTypeProperty
$clsCond = New-Object $PC($AE::ClassNameProperty, '#32770')
$deadline = [datetime]::Now.AddMilliseconds($WaitMs)
$dlg = $null
while ([datetime]::Now -lt $deadline) {
  foreach ($w in $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($w.Current.ProcessId -ne $ProcId) { continue }
    if ($w.Current.ClassName -eq '#32770') { $dlg = $w; break }
    $d = $w.FindFirst($TS::Descendants, $clsCond)
    if ($null -ne $d) { $dlg = $d; break }
  }
  if ($null -ne $dlg) { break }
  Start-Sleep -Milliseconds 300
}
if ($null -eq $dlg) { Write-Output 'DIALOG=absent'; exit 2 }
$dlgHwnd = [IntPtr]$dlg.Current.NativeWindowHandle
$btnHwnds = New-Object 'System.Collections.Generic.List[System.IntPtr]'
$kcb = [WD+EnumProc] { param($h, $l)
  $sb = New-Object System.Text.StringBuilder 256
  $null = [WD]::GetClassNameW($h, $sb, 256)
  if ($sb.ToString() -eq 'Button' -and [WD]::IsWindowVisible($h)) { $null = $script:btnHwnds.Add($h) }
  return $true }
$null = [WD]::EnumChildWindows($dlgHwnd, $kcb, [IntPtr]::Zero)
Write-Output ('DIALOG=found HWND=' + ($dlgHwnd -ne [IntPtr]::Zero) + ' BUTTONS=' + $btnHwnds.Count)
$chk = $dlg.FindFirst($TS::Descendants, (New-Object $PC($ctProp, [System.Windows.Automation.ControlType]::CheckBox)))
if ($null -eq $chk) { Write-Output 'CHECKBOX=absent'; exit 4 }
$tp = $chk.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
$sp = [System.Windows.Automation.TogglePattern]::ToggleStateProperty
$before = [string]$chk.GetCurrentPropertyValue($sp)
if ($Tick -eq 1) { $null = $tp.Toggle() }
$after = [string]$chk.GetCurrentPropertyValue($sp)
Write-Output ('CHECKBOX_BEFORE=' + $before + ' CHECKBOX_AFTER=' + $after)
if ($Button -ge $btnHwnds.Count) { Write-Output 'BUTTON=missing'; exit 3 }
$null = [WD]::SendMessageW($btnHwnds[$Button], 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
Write-Output 'INVOKE=ok'
`
let uiaScript = null
function driveDialog(pid, { tick = 0, button = 0 } = {}) {
  if (!uiaScript) {
    // BOM：Windows PowerShell 5.1 无 BOM 时脚本内容解析不稳
    uiaScript = path.join(os.tmpdir(), `we_uia_dialog_${process.pid}.ps1`)
    fs.writeFileSync(uiaScript, '\ufeff' + UIA_PS)
  }
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', uiaScript,
    '-ProcId', String(pid), '-Tick', String(tick), '-Button', String(button)], { encoding: 'utf8' })
  return { out: (r.stdout || '').trim() + (r.stderr ? ' | ERR:' + r.stderr.trim() : ''), code: r.status }
}

const logBefore = (() => { try { return fs.readFileSync(SHELL_LOG, 'utf8').length } catch { return 0 } })()

// ---- A：记住选择 = 最小化到托盘 ----
{
  const s = await scenario('min', 9451, { close_action: 'minimize_to_tray', remember_choice: true })
  if (!s.ok) {
    check('A 最小化场景可启动', false, s.detail)
  } else {
    requestClose(s.child.pid)
    await sleep(3000)
    const alive = s.child.exitCode === null
    check('A 关窗后进程不退出', alive, `exitCode=${s.child.exitCode}`)
    let vis = ''
    try { vis = (await s.evaluate('document.visibilityState')).value } catch { vis = 'unreachable' }
    check('A 窗口已隐藏（visibilityState=hidden）', vis === 'hidden', vis)
    let prefsBack = null
    try { prefsBack = JSON.parse(fs.readFileSync(path.join(s.ud, 'window-prefs.json'), 'utf8')) } catch { /* 文件应存在 */ }
    check('A 配置未被本次关闭改写', prefsBack && prefsBack.close_action === 'minimize_to_tray' && prefsBack.remember_choice === true, JSON.stringify(prefsBack))
    const logAfter = (() => { try { return fs.readFileSync(SHELL_LOG, 'utf8').slice(logBefore) } catch { return '' } })()
    check('A 托盘已建立（shell.log 记录）', logAfter.includes('[tray] created'), logAfter.split('\n').filter(l => l.includes('tray')).slice(-2).join(' | '))
    killTree(s.child.pid)
    try { s.ws.close() } catch { /* noop */ }
    try { fs.rmSync(s.base, { recursive: true, force: true }) } catch { /* noop */ }
  }
}

// ---- B：记住选择 = 直接关闭应用 ----
{
  const s = await scenario('exit', 9452, { close_action: 'exit_app', remember_choice: true })
  if (!s.ok) {
    check('B 退出场景可启动', false, s.detail)
  } else {
    requestClose(s.child.pid)
    const { exited, ms } = await waitExit(s.child, Number(process.env.WE_SHELL_EXIT_WAIT || 12000))
    check('B 关窗后进程退出', exited, exited ? `耗时 ${ms}ms` : (s.tail() || `${ms}ms 内未退出`))
    if (!exited) killTree(s.child.pid)
    try { s.ws.close() } catch { /* noop */ }
    try { fs.rmSync(s.base, { recursive: true, force: true }) } catch { /* noop */ }
  }
}

// ---- C：未记住选择 → 必须先弹框决策，不得自动关窗/落盘 ----
{
  const s = await scenario('ask', 9453, null)
  if (!s.ok) {
    check('C 首次运行场景可启动', false, s.detail)
  } else {
    requestClose(s.child.pid)
    await sleep(2500)
    check('C 未记住选择时进程保持运行（等待用户决策）', s.child.exitCode === null, `exitCode=${s.child.exitCode}`)
    let vis = ''
    try { vis = (await s.evaluate('document.visibilityState')).value } catch { vis = 'unreachable' }
    check('C 窗口仍可见（模态框未替用户做选择）', vis === 'visible', vis)
    check('C 未做选择时不落盘配置', !fs.existsSync(path.join(s.ud, 'window-prefs.json')))
    killTree(s.child.pid)
    try { s.ws.close() } catch { /* noop */ }
    try { fs.rmSync(s.base, { recursive: true, force: true }) } catch { /* noop */ }
  }
}

// ---- D：真实 preload IPC 往返（配置中心读写走的同一通道，非 mock）----
{
  const s = await scenario('ipc', 9454, null)
  if (!s.ok) {
    check('D 桥接场景可启动', false, s.detail)
  } else {
    const hasBridge = await s.evaluateAwait(`!!(window.weval&&window.weval.windowBehavior&&window.weval.desktop)`)
    check('D 渲染进程可见 weval.windowBehavior 桥接', hasBridge === true, String(hasBridge))
    const got = await s.evaluateAwait(`window.weval.windowBehavior.get()`)
    check('D get() 返回首启默认值', got && got.close_action === 'minimize_to_tray' && got.remember_choice === false, JSON.stringify(got))
    const set = await s.evaluateAwait(`window.weval.windowBehavior.set({close_action:'exit_app', remember_choice:true})`)
    check('D set() 返回合并后的配置', set && set.close_action === 'exit_app' && set.remember_choice === true, JSON.stringify(set))
    let onDisk = null
    try { onDisk = JSON.parse(fs.readFileSync(path.join(s.ud, 'window-prefs.json'), 'utf8')) } catch { /* 应已落盘 */ }
    check('D set() 由主进程原子落盘到 userData', onDisk && onDisk.close_action === 'exit_app' && onDisk.remember_choice === true, JSON.stringify(onDisk))
    const back = await s.evaluateAwait(`window.weval.windowBehavior.get()`)
    check('D 回读与落盘一致（读写同一条通道）', back && back.close_action === 'exit_app' && back.remember_choice === true, JSON.stringify(back))
    const tmpLeft = fs.readdirSync(s.ud).filter(f => f.endsWith('.tmp'))
    check('D 落盘无临时文件残留', tmpLeft.length === 0, tmpLeft.join(','))
    killTree(s.child.pid)
    try { s.ws.close() } catch { /* noop */ }
    try { fs.rmSync(s.base, { recursive: true, force: true }) } catch { /* noop */ }
  }
}

// ---- E：真点模态框——勾选「记住此选择」+ 选「直接关闭应用」（场景 A 完整闭环）----
{
  const s = await scenario('dlg_exit', 9455, null)
  if (!s.ok) {
    check('E 弹框退出场景可启动', false, s.detail)
  } else {
    requestClose(s.child.pid)
    await sleep(1500)
    const drv = driveDialog(s.child.pid, { tick: 1, button: 1 })
    const { exited, ms } = await waitExit(s.child, Number(process.env.WE_SHELL_EXIT_WAIT || 15000))
    check('E 模态框出现且按钮可驱动', drv.out.includes('DIALOG=found') && drv.out.includes('INVOKE=ok') && drv.out.includes('BUTTONS=2'), drv.out)
    check('E 勾选「记住此选择」生效', drv.out.includes('CHECKBOX_BEFORE=Off') && drv.out.includes('CHECKBOX_AFTER=On'), drv.out)
    check('E 选「直接关闭应用」后进程退出', exited, exited ? `耗时 ${ms}ms` : (s.tail() || `${ms}ms 内未退出`))
    let onDisk = null
    try { onDisk = JSON.parse(fs.readFileSync(path.join(s.ud, 'window-prefs.json'), 'utf8')) } catch { /* 勾选后应落盘 */ }
    check('E 选择被持久化为 exit_app + remember_choice=true',
      onDisk && onDisk.close_action === 'exit_app' && onDisk.remember_choice === true, JSON.stringify(onDisk))
    if (!exited) killTree(s.child.pid)
    try { s.ws.close() } catch { /* noop */ }
    try { fs.rmSync(s.base, { recursive: true, force: true }) } catch { /* noop */ }
  }
}

// ---- F：真点模态框——不勾选 + 选「最小化到托盘」：执行但不改配置，下次仍弹 ----
{
  const s = await scenario('dlg_min', 9456, null)
  if (!s.ok) {
    check('F 弹框最小化场景可启动', false, s.detail)
  } else {
    requestClose(s.child.pid)
    await sleep(1500)
    const drv = driveDialog(s.child.pid, { tick: 0, button: 0 })
    await sleep(2500)
    check('F 模态框按「最小化到托盘」执行', drv.out.includes('DIALOG=found') && drv.out.includes('INVOKE=ok'), drv.out)
    check('F 未勾选时复选框保持 Off', drv.out.includes('CHECKBOX_AFTER=Off'), drv.out)
    check('F 应用进程未退出（最小化到托盘）', s.child.exitCode === null, `exitCode=${s.child.exitCode}`)
    let vis = ''
    try { vis = (await s.evaluate('document.visibilityState')).value } catch { vis = 'unreachable' }
    check('F 窗口已隐藏', vis === 'hidden', vis)
    check('F 未勾选「记住」则不落盘（下次仍弹窗）', !fs.existsSync(path.join(s.ud, 'window-prefs.json')))
    killTree(s.child.pid)
    try { s.ws.close() } catch { /* noop */ }
    try { fs.rmSync(s.base, { recursive: true, force: true }) } catch { /* noop */ }
  }
}

try { if (uiaScript) fs.rmSync(uiaScript, { force: true }) } catch { /* noop */ }

const failed = res.filter(r => !r.ok)
console.log(`\n==== Electron 关闭行为烟测 ==== ${failed.length ? `失败 ${failed.length}/${res.length}` : `全绿 ${res.length}/${res.length}`}`)
process.exit(failed.length ? 1 : 0)
