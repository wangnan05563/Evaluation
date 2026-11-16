// 工作量评估工具 Electron 桌面壳（开发态 / 生产态共用）
// 结构与 BempDiff 桌面壳一致：
//   1) 自适应屏幕创建主窗口
//   2) 以 sidecar 方式静默启动 PyInstaller 后端 exe（windowsHide，无控制台窗口）
//      开发态无 exe 时回退 python scripts/server.py
//   3) 应用退出时统一回收子进程与端口
// 生产打包由 electron-builder 复用同一 main.js，区别仅在于资源根路径（resourcesPath）。

const { app, BrowserWindow, screen, shell, dialog, Tray, Menu, nativeImage, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const net = require('node:net')
const http = require('node:http')
const { spawn, spawnSync } = require('node:child_process')
const { createStore: createWindowPrefs, CLOSE_ACTIONS, needsPrompt } = require('./window-prefs')
const { createT } = require('./i18n-shell')

// ---------- 配置 ----------
// 8020：otherProjects 全域端口普查后的专属端口（8000 与 MorningBrief/20_News 冲突，详见 README）
const PORT = 8020
const DEFAULT_W = 1280
const DEFAULT_H = 900
const MIN_W = 960
const MIN_H = 640
const APP_NAME = '工作量评估工具'   // 仅作为 sidecar exe 文件名与日志标识，不用于界面文案（T03957）

const ROOT = resolveRoot()
const LOGDIR = path.join(ROOT, 'logs')
const BACKEND_LOG = path.join(LOGDIR, 'backend.log')
const PRELOAD = path.join(__dirname, 'preload.js')
const ICON = path.join(__dirname, '..', 'assets', 'we_icon.ico')

// ---------- 壳侧文案（T03957） ----------
// 关闭决策弹框、托盘菜单、任务确认框都在渲染进程之外（原生 TaskDialog / Tray），
// 拿不到前端 i18n 字典，故按 app.getLocale()（Chromium 语言，可用 --lang 覆盖）选内置中英表。
// 语言在应用生命周期内不变，首次使用时解析一次即可（Tray 菜单也只在建托盘时取文案）。
function shellI18n() {
  if (!shellI18n.cache) shellI18n.cache = createT(app.getLocale())
  return shellI18n.cache
}
const tr = (key, vars) => shellI18n().t(key, vars)

let children = [] // sidecar 子进程，退出时回收
let backendPid = null
let windowPrefsStore = null
let tray = null
let trayCreating = null
let trayBalloonShown = false
let quitting = false
let lastWindowUrl = ''

// ---------- 资源根路径 ----------
// 开发态：dev-shell -> 项目根（..）
// 生产态：electron-builder extraResources 落地在 process.resourcesPath 下
function resolveRoot() {
  const res = process.resourcesPath
  if (res && fs.existsSync(path.join(res, 'we-eval'))) return res
  return path.resolve(__dirname, '..')
}

function appendLog(file, ...args) {
  try {
    if (!fs.existsSync(LOGDIR)) fs.mkdirSync(LOGDIR, { recursive: true })
    fs.appendFileSync(file, args.join(' ') + '\n')
  } catch (_) {}
}

const SHELL_LOG = path.join(LOGDIR, 'shell.log')
const SHELL_LOG_MAX = 2 * 1024 * 1024
function rotateAppend(file, text) {
  try {
    if (!fs.existsSync(LOGDIR)) fs.mkdirSync(LOGDIR, { recursive: true })
    if (fs.existsSync(file)) {
      const st = fs.statSync(file)
      if (st.size > SHELL_LOG_MAX) {
        try { fs.renameSync(file, file + '.old') } catch (_) {}
      }
    }
    fs.appendFileSync(file, text)
  } catch (_) {}
}
process.on('uncaughtException', (e) => {
  rotateAppend(SHELL_LOG, `[uncaughtException] ${e && e.stack ? e.stack : String(e)}\n`)
})
process.on('unhandledRejection', (r) => {
  rotateAppend(SHELL_LOG, `[unhandledRejection] ${r && r.stack ? r.stack : String(r)}\n`)
})

function openLog(file) {
  try {
    if (!fs.existsSync(LOGDIR)) fs.mkdirSync(LOGDIR, { recursive: true })
    return fs.openSync(file, 'a')
  } catch (_) {
    return 'ignore'
  }
}

// ---------- 端口探测 ----------
function isPortOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1')
    let done = false
    const finish = (v) => { if (!done) { done = true; s.destroy(); resolve(v) } }
    s.setTimeout(800)
    s.on('connect', () => finish(true))
    s.on('timeout', () => finish(false))
    s.on('error', () => finish(false))
  })
}

async function waitPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

function killPort(port) {
  try {
    spawnSync('powershell', ['-NoProfile', '-Command', killPortCommand(port)], { stdio: 'ignore' })
  } catch (_) {}
}

// 退出路径改用异步进程：PowerShell 冷启动可达数秒，同步等待会让「直接关闭应用」
// 表现为点 X 后十几秒才消失（T03779 实测 24s）。
function killPortAsync(port) {
  try {
    const p = spawn('powershell', ['-NoProfile', '-Command', killPortCommand(port)],
      { stdio: 'ignore', windowsHide: true, detached: true })
    p.unref()
  } catch (_) {}
}

function killPortCommand(port) {
  return `$p=${port};try{$id=(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue|Select-Object -First 1).OwningProcess;if($id -ne $null){Stop-Process -Id $id -Force -ErrorAction SilentlyContinue;Write-Host ('[STOP] port '+$p+' PID='+$id)}}catch{}`
}

// 强杀指定 PID 的整个进程树（Windows 下 detached 子进程 SIGTERM 无效，必须 taskkill /T）
function killTreePid(pid) {
  if (!pid) return
  try {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
  } catch (_) {}
}

// ---------- sidecar 定位 ----------
// 生产态：resources/we-eval/工作量评估工具.exe（electron-builder extraResources）
// 开发态：release/exe/工作量评估工具.exe（PyInstaller 产物）；无 exe 回退 python scripts/server.py
function findSidecar() {
  const exeName = APP_NAME + '.exe'
  const candidates = [
    path.join(ROOT, 'we-eval', exeName),
    path.join(ROOT, 'release', 'exe', exeName)
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return { kind: 'exe', path: c }
  }
  const serverPy = path.join(ROOT, 'scripts', 'server.py')
  const pyCandidates = [
    process.env.WE_PYTHON,
    'python'
  ].filter(Boolean)
  for (const py of pyCandidates) {
    try {
      const r = spawnSync(py, ['--version'], { stdio: 'ignore' })
      if (r.status === 0) return { kind: 'python', cmd: py, script: serverPy }
    } catch (_) {}
  }
  return null
}

// ---------- sidecar 启动（静默、无控制台窗口） ----------
async function startBackend() {
  if (await isPortOpen(PORT)) {
    appendLog(BACKEND_LOG, '[sidecar] backend already listening on', PORT)
    return true
  }
  const sc = findSidecar()
  rotateAppend(SHELL_LOG, `[boot] ROOT=${ROOT} resourcesPath=${process.resourcesPath || ''} sidecar=${sc ? sc.kind + ':' + urlSafe(sc.path || sc.script) : 'NULL'}\n`)
  if (!sc) {
    rotateAppend(SHELL_LOG, '[boot] NO_SIDECAR: 后端 exe 缺失且无可用 python，主窗将无法加载\n')
    console.error('[WorkloadEval] No backend sidecar found. Run the build script first.')
    return false
  }
  // 数据目录由 server.py 决定：frozen 时落 %APPDATA%\WorkloadEval，卸载/重装不丢配置。
  // 禁止在此注入 WE_DATA 指向安装目录——NSIS 卸载会整目录删除，配置随包丢失（T00850）。
  // WE_APP_VERSION：后端 /api/app-info 与更新检测用（Electron 打包内 package.json 是权威版本源）
  const env = { ...process.env, WE_APP_VERSION: app.getVersion() }
  let child
  const out = openLog(BACKEND_LOG)
  if (sc.kind === 'exe') {
    // --no-open：禁止后端自动打开浏览器（窗口由壳承载）
    child = spawn(sc.path, ['--no-open'], {
      cwd: path.dirname(sc.path),
      windowsHide: true,
      detached: true,
      stdio: ['ignore', out, out],
      env
    })
  } else {
    // 开发态：--serve-frontend 让本服务提供前端；非 frozen 且未传 --open，不会开浏览器
    child = spawn(sc.cmd, [sc.script, '--serve-frontend'], {
      cwd: ROOT,
      windowsHide: true,
      detached: true,
      stdio: ['ignore', out, out],
      env
    })
  }
  children.push(child)
  backendPid = child.pid || null
  appendLog(BACKEND_LOG, '[sidecar] backend started PID', child.pid)
  const ready = await waitPort(PORT, 30000)
  if (!ready) appendLog(BACKEND_LOG, '[sidecar] WARN: 后端 30s 内未就绪，窗口可能暂时无法访问 API')
  return ready
}

function urlSafe(s) { return String(s).replace(/\\/g, '/') }

// T01835：关闭前运行任务检测——查询 sidecar /api/jobs/running，
// 有进行中的生成/补算、更新包下载或 AI 识别时弹确认框，防误关中断长任务。
function fetchRunningJobs(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/jobs/running', timeout: timeoutMs }, (res) => {
      let d = ''
      res.on('data', (c) => { d += c })
      res.on('end', () => {
        try {
          const j = JSON.parse(d)
          resolve(Array.isArray(j.jobs) ? j.jobs : [])
        } catch (_) { resolve([]) }
      })
    })
    req.on('timeout', () => { req.destroy(); resolve([]) })
    req.on('error', () => resolve([]))   // 后端不可达时不阻塞关闭（宁可少拦截不可关不掉）
  })
}

// ---------- 窗口关闭行为（T03779） ----------
function prefsStore() {
  if (!windowPrefsStore) windowPrefsStore = createWindowPrefs(app.getPath('userData'))
  return windowPrefsStore
}

function resolveTrayIcon() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'we-icon.ico') : '',
    path.join(__dirname, '..', 'assets', 'we_icon.ico')
  ]
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      const img = nativeImage.createFromPath(p)
      if (!img.isEmpty()) return { img, src: p }
    }
  }
  return null
}

let trayIconSource = 'unset'

async function trayIcon() {
  const fromAsset = resolveTrayIcon()
  if (fromAsset) {
    trayIconSource = fromAsset.src
    return fromAsset.img
  }
  // 生产态 asar 内不带 assets：退化为可执行文件自身的图标
  try {
    const img = await app.getFileIcon(process.execPath, { size: 'small' })
    if (!img.isEmpty()) {
      trayIconSource = 'FALLBACK-execIcon'
      return img
    }
  } catch (_) {}
  trayIconSource = 'EMPTY'
  return nativeImage.createEmpty()
}

function showMainWindow() {
  const w = mainWindow
  if (!w || w.isDestroyed()) {
    if (lastWindowUrl) mainWindow = createWindow(lastWindowUrl)
    return
  }
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
}

function ensureTray() {
  if (tray) return Promise.resolve(tray)
  if (trayCreating) return trayCreating
  trayCreating = (async () => {
    try {
      tray = new Tray(await trayIcon())
      tray.setToolTip(tr('app_name'))
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: tr('tray_show'), click: showMainWindow },
        { label: tr('tray_minimize'), click: () => { const w = mainWindow; if (w && !w.isDestroyed()) w.hide() } },
        { type: 'separator' },
        { label: tr('tray_quit'), click: () => requestQuit() }
      ]))
      tray.on('click', showMainWindow)
      tray.on('double-click', showMainWindow)
      // pid= 是给测试用的：logs/shell.log 是全机共享的一个文件，同机并发会话、上一轮残留都往里写，
      // 不带归属就只能靠日志偏移猜「这条是不是本进程写的」——猜错会把「本进程没落行」读成「选表选错语言」（T04450）。
      rotateAppend(SHELL_LOG, `[tray] created lang=${shellI18n().lang} icon=${trayIconSource} pid=${process.pid}\n`)
      return tray
    } catch (e) {
      rotateAppend(SHELL_LOG, `[tray] create failed: ${e && e.stack ? e.stack : e}\n`)
      return null
    } finally {
      trayCreating = null
    }
  })()
  return trayCreating
}

async function hideToTray(win) {
  await ensureTray()
  if (win && !win.isDestroyed()) win.hide()
  // 仅首次提示，避免每次关闭都弹气泡打扰
  if (tray && process.platform === 'win32' && !trayBalloonShown) {
    trayBalloonShown = true
    try {
      tray.displayBalloon({ title: tr('app_name'), content: tr('tray_balloon') })
    } catch (_) {}
  }
}

async function confirmCloseWithRunningJobs(win) {
  const jobs = await fetchRunningJobs()
  if (!jobs.length) return true
  const names = jobs.map((j) => tr('jobs_item', { name: j.name }) +
    (typeof j.pct === 'number' ? tr('jobs_item_pct', { pct: j.pct }) : '')).join('\n')
  const opts = {
    type: 'warning',
    title: tr('jobs_title'),
    message: tr('jobs_message'),
    detail: names,
    buttons: [tr('jobs_cancel'), tr('jobs_force')],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }
  const parent = win && !win.isDestroyed() && win.isVisible() ? win : null
  const { response } = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts)
  return response === 1
}

// 未记住选择时弹模态框：两个选项 + 「记住此选择」复选框。
// 勾选才落盘（写 close_action 与 remember_choice=true）；不勾选仅执行本次操作。
async function askCloseAction(win) {
  const opts = {
    type: 'question',
    title: tr('close_title'),
    message: tr('close_message'),
    detail: tr('close_detail'),
    buttons: [tr('close_minimize'), tr('close_exit')],
    defaultId: 0,
    cancelId: 0,
    checkboxLabel: tr('close_remember'),
    checkboxChecked: false,
    noLink: true
  }
  const parent = win && !win.isDestroyed() && win.isVisible() ? win : null
  // shown/resolved 两行是「弹框弹出来了但没人点」与「点了但主进程没收到决策」的唯一区分依据：
  // 只有 shown 没有 resolved = 决策链停在 await 里（T04475：合成点击被 TaskDialog 吞掉时就是这个形状）。
  rotateAppend(SHELL_LOG, `[close-dialog] shown parent=${parent ? 'win' : 'none'} lang=${shellI18n().lang} pid=${process.pid}\n`)
  const { response, checkboxChecked } = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts)
  rotateAppend(SHELL_LOG, `[close-dialog] resolved response=${response} checkbox=${checkboxChecked} pid=${process.pid}\n`)
  const action = response === 1 ? CLOSE_ACTIONS.EXIT : CLOSE_ACTIONS.MINIMIZE
  if (checkboxChecked) {
    try {
      prefsStore().write({ close_action: action, remember_choice: true })
    } catch (e) {
      rotateAppend(SHELL_LOG, `[prefs] save failed: ${e && e.stack ? e.stack : e}\n`)
    }
  }
  return action
}

function quitApp(win) {
  quitting = true
  if (win && !win.isDestroyed()) win.__forceClose = true
  app.quit()
}

async function handleCloseRequest(win) {
  if (win.__closeBusy) return
  win.__closeBusy = true
  try {
    const prefs = prefsStore().read()
    const prompted = needsPrompt(prefs)
    const action = prompted ? await askCloseAction(win) : prefs.close_action
    // pid= 同上（[tray] 行）：这行是「用户/测试的点击真的被本进程接住了」的唯一凭据，
    // 测试拿它判断点击有没有落地，没落地才重按一次原生按钮。
    rotateAppend(SHELL_LOG, `[close] action=${action} prompted=${prompted} remembered=${prefs.remember_choice} lang=${shellI18n().lang} pid=${process.pid}\n`)
    if (action === CLOSE_ACTIONS.MINIMIZE) {
      await hideToTray(win)
      return
    }
    if (!(await confirmCloseWithRunningJobs(win))) return
    quitApp(win)
  } catch (e) {
    // 决策链异常时保底最小化：宁可退到托盘也不能让用户关不掉窗口
    rotateAppend(SHELL_LOG, `[close] decision failed: ${e && e.stack ? e.stack : e}\n`)
    await hideToTray(win).catch(() => {})
  } finally {
    win.__closeBusy = false
  }
}

// 托盘「退出」：显式退出同样先查进行中任务（T01835），不受关闭行为配置影响
async function requestQuit() {
  if (quitting) return
  if (!(await confirmCloseWithRunningJobs(mainWindow))) return
  quitApp(mainWindow)
}

ipcMain.handle('weval:window-behavior:get', () => prefsStore().read())
ipcMain.handle('weval:window-behavior:set', (_e, patch) => prefsStore().write(patch))

// ---------- 窗口自适应 ----------
function computeSize() {
  const area = screen.getPrimaryDisplay().workAreaSize
  const w = Math.min(DEFAULT_W, Math.floor(area.width * 0.92))
  const h = Math.min(DEFAULT_H, Math.floor(area.height * 0.92))
  const cw = Math.max(MIN_W, w)
  const ch = Math.max(MIN_H, h)
  if (cw >= area.width || ch >= area.height) return { maximize: true }
  return { maximize: false, width: cw, height: ch }
}

function createWindow(url) {
  lastWindowUrl = url
  const size = computeSize()
  const win = new BrowserWindow({
    width: size.maximize ? MIN_W : size.width,
    height: size.maximize ? MIN_H : size.height,
    minWidth: MIN_W,
    minHeight: MIN_H,
    icon: fs.existsSync(ICON) ? ICON : undefined,
    title: tr('app_name'),
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.loadURL(url)

  // T03779：关闭按钮先按「关闭窗口行为」决策（未记住选择时弹模态框），
  // 选择退出再走 T01835 进行中任务确认；最小化到托盘不中断任务，无需确认。
  // 决策异常一律保底最小化，保证「关不掉」永远不会发生。
  win.on('close', (e) => {
    if (win.__forceClose || quitting) return
    e.preventDefault()
    handleCloseRequest(win)
  })

  win.once('ready-to-show', () => {
    if (!size.maximize) win.center()
    win.show()
  })

  win.webContents.on('did-fail-load', () => {
    win.show()
  })

  // 开发便利：F12 打开 DevTools
  win.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') {
      if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools()
      else win.webContents.openDevTools()
      event.preventDefault()
    }
  })

  // 外部链接走系统默认浏览器，不在壳内打开
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    require('electron').shell.openExternal(u)
    return { action: 'deny' }
  })

  return win
}

// ---------- 进程回收 ----------
// before-quit 与 will-quit 都会调用，必须一次性：重复清理会让退出路径上的
// 子进程回收与端口释放做两遍，放大关闭延迟（T03779）。
let sidecarStopped = false
function stopSidecar() {
  if (sidecarStopped) return
  sidecarStopped = true
  killTreePid(backendPid)
  backendPid = null
  for (const c of children) {
    try { c.kill('SIGTERM') } catch (_) {}
  }
  children = []
  // WE_DEV_URL 模式下后端由外部（dev server）持有，壳无权释放该端口
  if (!process.env.WE_DEV_URL) killPortAsync(PORT)
}

// ---------- Shell 集成：单实例锁 ----------
let mainWindow = null

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  app.on('before-quit', () => {
    quitting = true
    stopSidecar()
  })
  app.on('will-quit', () => {
    if (tray) { tray.destroy(); tray = null }
    stopSidecar()
  })

  app.whenReady().then(async () => {
    let initialUrl = process.env.WE_DEV_URL
    if (!initialUrl) {
      killPort(PORT)
      await startBackend()
      initialUrl = `http://127.0.0.1:${PORT}/`
    }
    mainWindow = createWindow(initialUrl)
    app.on('activate', () => {
      showMainWindow()
    })
  })
}

app.on('window-all-closed', () => {
  app.quit()
})
