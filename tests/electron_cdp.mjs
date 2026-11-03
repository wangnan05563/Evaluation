/** Electron 实机烟测公共件：起一个真实 Electron 实例（独立 user-data-dir + CDP），
 *  提供页面求值、优雅关窗（WM_CLOSE）、退出等待与进程树回收。
 *  开发态（tests/shell_close_smoke.mjs）与免安装产物（tests/prod_smoke.mjs）共用同一套驱动，
 *  差异只在「启动哪个 exe / 传什么参数」。 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { reclaimStaleTmp, registerTmp, removeTmp } from './tmp_janitor.mjs'

export const killTree = pid => {
  try { spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }) } catch { /* noop */ }
}

// 不带 /F 的 taskkill 会向进程顶层窗口发送 WM_CLOSE，等价于点击标题栏关闭按钮
export function requestClose(pid) {
  return spawnSync('taskkill', ['/PID', String(pid)], { encoding: 'utf8' })
}

export async function waitExit(child, timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (child.exitCode !== null) return { exited: true, ms: Date.now() - t0 }
    await sleep(200)
  }
  return { exited: false, ms: Date.now() - t0 }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms))

export function isPortOpen(port) {
  return new Promise(resolve => {
    const s = net.connect(port, '127.0.0.1')
    let done = false
    const finish = v => { if (!done) { done = true; s.destroy(); resolve(v) } }
    s.setTimeout(600)
    s.on('connect', () => finish(true))
    s.on('timeout', () => finish(false))
    s.on('error', () => finish(false))
  })
}

/** 造一个 scenario()：每个场景独立 user-data-dir（隔离偏好文件与单实例锁）。
 *  cfg = { exe, baseArgs, baseEnv, waitCdpMs } */
export function makeLauncher(cfg) {
  const waitCdpMs = cfg.waitCdpMs || 60000
  // 开跑前收一次上一轮崩溃留下的孤儿目录（本套件自己造的都走下面 registerTmp）
  const jan = reclaimStaleTmp()
  if (jan.removed || jan.stuck) {
    console.log(`  临时目录回收：清掉 ${jan.removed} 个超龄孤儿` +
      (jan.stuck ? `，${jan.stuck} 个被占用删不掉` : '') + `（保留 ${jan.keptFresh} 个未超龄）`)
  }
  return async function scenario(name, port, prefs, opts = {}) {
    const { extraArgs = [], udDir = null } = opts
    const base = udDir ? path.dirname(udDir) : registerTmp(fs.mkdtempSync(path.join(os.tmpdir(), `we_${name}_`)))
    const ud = udDir || path.join(base, 'ud')
    fs.mkdirSync(ud, { recursive: true })
    // prefs 为 null 时不预写文件——「首启无偏好」本身就是要验的状态
    if (prefs) fs.writeFileSync(path.join(ud, 'window-prefs.json'), JSON.stringify(prefs), 'utf8')
    const env = { ...process.env, ...cfg.baseEnv }
    // ELECTRON_RUN_AS_NODE 会让 electron.exe 退化成普通 node 解释器；NODE_OPTIONS 里的
    // 沙箱钩子会拦截产物清理。两者都必须剥掉，否则起的是「另一个东西」而不是被测应用。
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    const child = spawn(cfg.exe, [...cfg.baseArgs, `--remote-debugging-port=${port}`, `--user-data-dir=${ud}`, ...extraArgs],
      { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    child.stdout.on('data', d => { tail = (tail + d).slice(-4000) })
    child.stderr.on('data', d => { tail = (tail + d).slice(-4000) })
    const page = await waitCdpPage(port, waitCdpMs)
    if (!page) {
      killTree(child.pid)
      return { ok: false, detail: 'CDP 页面未就绪\n' + tail, base, child, ud }
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
    let ready = false
    for (let i = 0; i < 120; i++) {
      try {
        if ((await evaluate('document.readyState')).value === 'complete') { ready = true; break }
      } catch { /* 尚在加载 */ }
      await sleep(250)
    }
    return { ok: ready, ws, child, base, ud, evaluate, evaluateAwait,
      detail: ready ? '' : '页面未加载完成（document.readyState 非 complete）\n' + tail,
      tail: () => tail }
  }
}

async function waitCdpPage(port, timeoutMs) {
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
