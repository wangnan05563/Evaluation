/** T03779 Electron 壳关闭行为实机烟测（真实 Electron 主进程 + CDP）。
 *  独立运行：node tests/shell_close_smoke.mjs
 *  覆盖：记住选择=最小化 → 关窗后进程存活且窗口隐藏、托盘建立；
 *        记住选择=直接关闭 → 关窗后进程退出；
 *        未记住选择 → 弹出模态框（进程存活、窗口仍可见、不自动落盘）。
 *  说明：模态框内的人工选择无法在无头/无人值守下点击，此路径由单测
 *  （needsPrompt/nextPrefsOnChoice）与配置中心 UI 测试覆盖，本脚本只验证「必须先决策」。
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
  await send('Page.enable')
  await send('Runtime.enable')
  for (let i = 0; i < 60; i++) {
    try { if ((await evaluate('document.readyState')).value === 'complete') break } catch { /* 尚在加载 */ }
    await sleep(250)
  }
  return { ok: true, ws, child, base, ud, evaluate, tail: () => tail }
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

const failed = res.filter(r => !r.ok)
console.log(`\n==== Electron 关闭行为烟测 ==== ${failed.length ? `失败 ${failed.length}/${res.length}` : `全绿 ${res.length}/${res.length}`}`)
process.exit(failed.length ? 1 : 0)
