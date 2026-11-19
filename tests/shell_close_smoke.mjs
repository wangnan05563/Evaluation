/** T03779 Electron 壳关闭行为实机烟测（真实 Electron 主进程 + CDP + 原生弹框驱动）。
 *  独立运行：node tests/shell_close_smoke.mjs
 *  覆盖：记住选择=最小化 → 关窗后进程存活且窗口隐藏、托盘建立；
 *        记住选择=直接关闭 → 关窗后进程退出；
 *        未记住选择 → 弹出模态框（进程存活、窗口仍可见、不自动落盘）；
 *        真实 preload IPC 往返（配置中心读写同一通道）与落盘原子性；
 *        真点模态框（UI Automation 驱动系统 TaskDialog）：勾选记住+退出→落盘、
 *        不勾选+最小化→执行但不改配置。
 *  说明：原生弹框不是 DOM，CDP 无法触达，改用 Windows UIA 定位并点击按钮/复选框。
 *  「窗口在不在屏幕上」一律用 Win32 IsWindowVisible 判：document.visibilityState 会把
 *  被其它窗口遮住的已显示窗口也记成 hidden（本机实测），拿它判「已隐藏」会假绿、判「仍可见」会假红。
 *  日志类断言（托盘/选表）只认本进程自己那一条：shell.log 全机共享，靠偏移不靠归属会读到别的
 *  进程写的行（T04450：H 项被 A 的 zh-CN 行喂成恒绿，而它自己压根没落行）。
 *  「点了按钮」不等于「主进程收到了」：合成 BM_CLICK 的首按实测约 1/4 被 TaskDialog 吞掉——
 *  消息照常投递成功（SendMessageTimeout 返回 TRUE），主进程既不落 [close] 也不落托盘行
 *  （T04450 那轮的 H 项就是这个形状）。T04475 在空载本机跑两批各 15 次，分别复现 5 次与 2 次，
 *  并否掉了「弹框刚创建、消息循环未就绪」这条解释：0ms 与 400ms 延时都会吞，弹框始终 enabled、
 *  前台归属也不相关，且探针看到对话框线程在创建后 13~142ms 就已在取消息；
 *  换鼠标消息 WM_LBUTTONDOWN/UP 仍吞（8 次 1 次），补按 8/8 都在 0~50ms 内生效。
 *  所以判据换成驱动自己能立刻观测的那一条：按完后对话框窗口真没了才算接住，还开着就补按，最多三次
 *  （旧写法是「等 5s 没等到 [close] 行再补按」，一次误判要白等 5s，且停手条件写的 not_found
 *  与驱动实际输出的 absent 对不上，那道保险从来没生效）。断言本身不重试——判据始终是本进程自己那一条，
 *  三次都没落地就报红。
 *  T04505 量完三条对照通道后的口径（本套件的打法不变，仍走驱动 -Mode 0 = BM_CLICK）：
 *  · UIA InvokePattern / LegacyIAccessible 这两条**压根发不出点击**，不是「发出去被吞」：TaskDialog 的按钮
 *    在 UIA 里是 ControlType.Pane（子树 6 元素、Button 0 个、带 pattern 0 个，按文案命中那个 Pane 也没 pattern），
 *    本机 UIA COM 客户端 ProgID 又未注册（0x80040154），managed 客户端压根没有 LegacyIAccessiblePattern 类型。
 *    所以「换 UIA 通道就能把吞按打到 0」这个假设从未成立过，别照它改驱动。
 *  · 「抢前台+给焦点再 BM_CLICK」批次 14 轮 0 次吞按，但接住耗时 min/中位/max = 213/298/525ms，比 BM_CLICK
 *    同日那批的 112/184/290ms 慢一倍以上、max 逼近本套件 700ms 判据窗口，且必须先自证真抢到（裸
 *    SetForegroundWindow 会被前台锁挡掉，抢不到时它就等于通道 0，数字全是假的）——不作为替代打法。
 *  · 吞按率随负载波动很大：T04475 是 7/30，T04505 当天 18 轮有效 2 次吞按（2/18，两次都出自单轮 sanity 批次，
 *    最大的那批 14 轮反倒 0 次）。某一天的 0/N 不等于问题消失，
 *    「按投递结果补按」这条兜底保留。逐轮数字与探针用法见 docs/设计-数据与运维.md 关键决策第 7 条。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeLauncher, waitExit, requestClose, killTree, sleep } from './electron_cdp.mjs'
import { removeTmp } from './tmp_janitor.mjs'
import { CLOSE_TEXTS, driveDialog, readDialogTexts, cleanupDialogScript, probeWindow } from './win_dialog.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = path.join(ROOT, 'dev-shell', 'node_modules', 'electron', 'dist', 'electron.exe')
const APP_DIR = path.join(ROOT, 'dev-shell')
const SHELL_LOG = path.join(ROOT, 'logs', 'shell.log')
const res = []
// 退出耗时预算：本机波动很大——空闲时 0.4~0.7s（T03779 实测 401/648ms），多个会话并发挤满时
// 用 probe 对照复测：HEAD 原码 22.2s、本单改动版 15.3s，说明与本单无关，是环境负载。
// 本套件验证的是「关窗后会不会退出」，不是性能门；整机被测试进程压满时 Electron 的进程退出
// 实测可超过 45s（S17 整套回归 B 分支超时，单独复跑 10.9s 通过）。默认给到 90s，
// 仍可用 WE_SHELL_EXIT_WAIT 收紧；性能预算由 tests/prod_smoke.mjs 单独断言。
const EXIT_WAIT = Number(process.env.WE_SHELL_EXIT_WAIT || 90000)
const check = (n, ok, d = '') => {
  res.push({ n, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`)
}
setTimeout(() => { console.error('[bk] WATCHDOG'); process.exit(3) }, Number(process.env.WE_SHELL_WATCHDOG_MS || 420000))

// 每个场景独立 user-data-dir：隔离偏好文件与单实例锁。开发态用 WE_DEV_URL 把首页指到
// 一个空白 data: 页——本套测的是壳的关闭链，不该依赖 sidecar 是否起得来。
const scenario = makeLauncher({
  exe: ELECTRON,
  baseArgs: [APP_DIR],
  baseEnv: { WE_DEV_URL: 'data:text/html,<html><head><meta charset="utf-8"><title>shell smoke</title></head><body>shell smoke</body></html>' }
})

// 原生弹框驱动与期望文案表见 tests/win_dialog.mjs（与免安装产物冒测 tests/prod_smoke.mjs 共用）


// 日志观测（T04450）：logs/shell.log 是全机共享的单个文件，同机并发会话和上一轮残留都往里写。
// 因此每个要读日志的场景先把基线拨到「当前末尾」，再只认「本进程自己落的那一条」：
// 托盘行带 pid=（见 dev-shell/main.js ensureTray），偏移只用来缩小范围，pid 才是归属判据。
// 只按「套件开头偏移 + 整段 includes」判会读到别人的行——H 被 A/F 的 zh-CN 喂成恒绿，
// G 真的缺行时打印出来的「证据」也是别人的 zh-CN，看着像「选表选错了」，其实本进程压根没落行。
const readStr = f => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
let logBase = readStr(SHELL_LOG).length
const resetLogBase = () => { logBase = readStr(SHELL_LOG).length }
// 变小了说明日志刚被 rotateAppend 转走（shell.log → shell.log.old）：基线作废，退回从头读，
// 反正归属判据是行尾的 pid=，不是偏移。
const tail = () => {
  const text = readStr(SHELL_LOG)
  if (text.length < logBase) logBase = 0
  return text.slice(logBase)
}
const trayLines = text => text.split(/\r?\n/).filter(l => l.startsWith('[tray] created'))
const trayLineOf = (text, pid) => trayLines(text).filter(l => l.endsWith(` pid=${pid}`)).slice(-1)[0] || ''
// 主进程落日志与断言读取有先后：轮询到本进程那条托盘行落地为止（最多 tries×250ms），
// 不再用写死的 sleep 赌它已经落完。本机实测「点下按钮→托盘行落地」空载 ≤114ms、
// 压满（10 个自旋进程 + 持续磁盘写）≤170ms，5s 是实测上限的 ~30 倍：
// 这门要挡的是「压根没建托盘/本进程没走到关闭链」，不是毫秒级抖动。
const TRAY_TRIES = Number(process.env.WE_SHELL_TRAY_TRIES || 20)
async function waitTrayLine(pid) {
  for (let i = 0; i < TRAY_TRIES; i++) {
    const l = trayLineOf(tail(), pid)
    if (l) return l
    await sleep(250)
  }
  return ''
}
const processAlive = pid => {
  try { process.kill(pid, 0); return true } catch { return false }
}
const closeLineOf = (text, pid) =>
  text.split(/\r?\n/).filter(l => l.startsWith('[close]') && l.endsWith(` pid=${pid}`)).slice(-1)[0] || ''
const lineCount = (text, prefix, pid) =>
  text.split(/\r?\n/).filter(l => l.startsWith(prefix) && !l.endsWith(` pid=${pid}`)).length
const trayEvidence = pid => {
  return `本进程 pid=${pid} 没落 [tray] created 行；段内其它进程的托盘行 ${lineCount(tail(), '[tray] created', pid)} 条` +
    `；进程存活=${processAlive(pid)}`
}
// 「没落 [close] 行」有两种成因，证据里都要说清，别只报一种：点击被对话框吞掉 / 决策里抛了异常
// （后者 main.js 会落 '[close] decision failed:'，那行没有 pid=，不能混进「其它进程的行」计数里）。
// T04475 起再加一节直接证据：askCloseAction 进/出各落一行 [close-dialog]（main.js），
// shown 有 resolved 无 = 弹框真弹出来了、决策链停在 await（即这一按压根没被接住）。
const dlgLineOf = (text, pid, tag) =>
  text.split(/\r?\n/).filter(l => l.startsWith('[close-dialog] ' + tag) && l.endsWith(` pid=${pid}`)).slice(-1)[0] || ''
const closeEvidence = pid => {
  const t = tail()
  const failed = t.split(/\r?\n/).filter(l => l.startsWith('[close] decision failed')).slice(-1)[0] || ''
  return `本进程 pid=${pid} 没落 [close] 行；` +
    `弹框进出行 shown=${dlgLineOf(t, pid, 'shown') ? 1 : 0} resolved=${dlgLineOf(t, pid, 'resolved') ? 1 : 0}；` +
    (failed ? `本段有失败行 ${failed.slice(0, 140)}；` :
      `本段没有 decision failed 行（即主进程还停在等这次决策，点击没被接住），其它进程的 [close] 行 ${lineCount(t, '[close] action', pid)} 条；`) +
    `进程存活=${processAlive(pid)}`
}
/** 等本进程那条 [close] 行：它是「用户/驱动点的按钮真的被执行了」的凭据（写在决策之后）。 */
async function waitCloseLine(pid, tries = TRAY_TRIES) {
  for (let i = 0; i < tries; i++) {
    const l = closeLineOf(tail(), pid)
    if (l) return l
    await sleep(250)
  }
  return ''
}
/** 点原生弹框的按钮。T04475 实测：合成 BM_CLICK 首按约 1/4 被 TaskDialog 吞掉（空载两批各 15 次，
 *  分别吞 5 次与 2 次）——消息投递成功（SendMessageTimeout 返回 TRUE）但决策没跑，而且与
 *  「点击距弹框创建的间隔」无关（0ms 和 400ms 都会吞，对话框线程 13~142ms 起就在取消息），
 *  所以不能靠「等一等再按」防它。判据换成驱动自己能立刻观测的那一条：
 *  对话框窗口真没了 = 这一按被接住；还开着就补按（实测补按 6/6 在 0~50ms 内生效）。
 *  重试的是「驱动动作」，不是把红用例赌第二次：最终判据仍是本进程自己那条 [close] 行。
 *  弹框已销毁时报 not_found 即停手，不会误触第二个动作（与 tests/prod_smoke.mjs P-A 同一打法）。
 *  重按时只补 button 不再补 tick：勾选是同一个对话框实例上的状态，再 tick 一次会被翻回 Off。 */
async function clickDialog(pid, { tick, button, dump = 0 }) {
  const first = driveDialog(pid, { tick, button, dump })
  let last = first
  let retries = 0
  for (let i = 0; i < 2 && last.out.includes('DIALOG_AFTER=yes'); i++) {
    last = driveDialog(pid, { button })
    retries++
    if (last.out.includes('DIALOG=not_found')) break
  }
  const landed = await waitCloseLine(pid)
  // 文案/勾选只看第一次（带 dump+tick）的输出；重按只补按钮，不再翻勾
  return { drv: first, landed, retries, last }
}
const landedNote = ({ landed, retries }) => landed + (retries ? `（重按 ${retries} 次才生效）` : '')

// ---- A：记住选择 = 最小化到托盘 ----
{
  resetLogBase()
  const s = await scenario('min', 9451, { close_action: 'minimize_to_tray', remember_choice: true })
  if (!s.ok) {
    check('A 最小化场景可启动', false, s.detail)
  } else {
    requestClose(s.child.pid)
    await sleep(3000)
    const alive = s.child.exitCode === null
    check('A 关窗后进程不退出', alive, `exitCode=${s.child.exitCode}`)
    const vis = probeWindow(s.child.pid)
    check('A 窗口已隐藏（IsWindowVisible=0）', vis.visible === 0, vis.out)
    let prefsBack = null
    try { prefsBack = JSON.parse(fs.readFileSync(path.join(s.ud, 'window-prefs.json'), 'utf8')) } catch { /* 文件应存在 */ }
    check('A 配置未被本次关闭改写', prefsBack && prefsBack.close_action === 'minimize_to_tray' && prefsBack.remember_choice === true, JSON.stringify(prefsBack))
    const tray = await waitTrayLine(s.child.pid)
    check('A 托盘已建立（shell.log 记录本进程那条）', !!tray, tray || trayEvidence(s.child.pid))
    // T03958：图标来源必须落日志——回退到 getFileIcon 就是「通用图标」，肉眼难查，只能靠这条断言兜住
    const iconSrc = (tray.match(/ icon=(\S+)/) || [])[1] || ''
    check('A 托盘图标取自 ico 资源（非通用 exe 图标回退）',
      /\.ico$/i.test(iconSrc) && fs.existsSync(iconSrc), iconSrc || '日志缺 icon= 字段')
    killTree(s.child.pid)
    try { s.ws.close() } catch { /* noop */ }
    removeTmp(s.base)
  }
}

// ---- B：记住选择 = 直接关闭应用 ----
{
  const s = await scenario('exit', 9452, { close_action: 'exit_app', remember_choice: true })
  if (!s.ok) {
    check('B 退出场景可启动', false, s.detail)
  } else {
    requestClose(s.child.pid)
    const { exited, ms } = await waitExit(s.child, EXIT_WAIT)
    check('B 关窗后进程退出', exited, exited ? `耗时 ${ms}ms` : (s.tail() || `${ms}ms 内未退出`))
    if (!exited) killTree(s.child.pid)
    try { s.ws.close() } catch { /* noop */ }
    removeTmp(s.base)
  }
}

// ---- C：未记住选择 → 必须先弹框决策，不得自动关窗/落盘 ----
{
  const s = await scenario('ask', 9453, null)
  if (!s.ok) {
    check('C 首次运行场景可启动', false, s.detail)
  } else {
    resetLogBase()
    requestClose(s.child.pid)
    await sleep(2500)
    check('C 未记住选择时进程保持运行（等待用户决策）', s.child.exitCode === null, `exitCode=${s.child.exitCode}`)
    const vis = probeWindow(s.child.pid)
    check('C 窗口仍可见（模态框未替用户做选择）', vis.visible === 1, vis.out)
    check('C 未做选择时不落盘配置', !fs.existsSync(path.join(s.ud, 'window-prefs.json')))
    // T04475 的可观测出口：shown 有、resolved 无 = 「弹框真弹出来了，但没人点/点击没被接住」。
    // 这条是 closeEvidence 里那句推断的正面依据，缺了它只能靠「没落 [close]」反推。
    const t = tail()
    const shown = dlgLineOf(t, s.child.pid, 'shown')
    check('C 弹框进入落了 [close-dialog] shown（含 parent 与 lang）',
      !!shown && /parent=(win|none)/.test(shown) && /lang=\S+/.test(shown), shown || closeEvidence(s.child.pid))
    check('C 未决策时不落 resolved 行（「点了没回调」与「没人点」可区分）',
      !dlgLineOf(t, s.child.pid, 'resolved'), dlgLineOf(t, s.child.pid, 'resolved'))
    killTree(s.child.pid)
    try { s.ws.close() } catch { /* noop */ }
    removeTmp(s.base)
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
    removeTmp(s.base)
  }
}

// ---- E：真点模态框——勾选「记住此选择」+ 选「直接关闭应用」（场景 A 完整闭环）----
{
  const s = await scenario('dlg_exit', 9455, null)
  if (!s.ok) {
    check('E 弹框退出场景可启动', false, s.detail)
  } else {
    resetLogBase()
    requestClose(s.child.pid)
    await sleep(1500)
    const { drv, landed, retries } = await clickDialog(s.child.pid, { tick: 1, button: 1 })
    const { exited, ms } = await waitExit(s.child, EXIT_WAIT)
    check('E 模态框出现且「直接关闭应用」被本进程接住',
      drv.out.includes('DIALOG=found') && drv.out.includes('BUTTONS=2') && !!landed,
      landed ? landedNote({ landed, retries }) : drv.out)
    check('E 勾选「记住此选择」生效', drv.out.includes('CHECKBOX_BEFORE=Off') && drv.out.includes('CHECKBOX_AFTER=On'), drv.out)
    check('E 选「直接关闭应用」后进程退出', exited, exited ? `耗时 ${ms}ms` : (s.tail() || `${ms}ms 内未退出`))
    let onDisk = null
    try { onDisk = JSON.parse(fs.readFileSync(path.join(s.ud, 'window-prefs.json'), 'utf8')) } catch { /* 勾选后应落盘 */ }
    check('E 选择被持久化为 exit_app + remember_choice=true',
      onDisk && onDisk.close_action === 'exit_app' && onDisk.remember_choice === true, JSON.stringify(onDisk))
    if (!exited) killTree(s.child.pid)
    try { s.ws.close() } catch { /* noop */ }
    removeTmp(s.base)
  }
}

// ---- F：真点模态框——不勾选 + 选「最小化到托盘」：执行但不改配置，下次仍弹 ----
{
  const s = await scenario('dlg_min', 9456, null)
  if (!s.ok) {
    check('F 弹框最小化场景可启动', false, s.detail)
  } else {
    resetLogBase()
    requestClose(s.child.pid)
    await sleep(1500)
    const { drv, landed, retries } = await clickDialog(s.child.pid, { tick: 0, button: 0 })
    await sleep(2500)
    check('F 模态框按「最小化到托盘」执行（本进程落了 [close] 行）',
      drv.out.includes('DIALOG=found') && !!landed, landed ? landedNote({ landed, retries }) : drv.out)
    check('F 未勾选时复选框保持 Off', drv.out.includes('CHECKBOX_AFTER=Off'), drv.out)
    check('F 应用进程未退出（最小化到托盘）', s.child.exitCode === null, `exitCode=${s.child.exitCode}`)
    const vis = probeWindow(s.child.pid)
    check('F 窗口已隐藏', vis.visible === 0, vis.out)
    check('F 未勾选「记住」则不落盘（下次仍弹窗）', !fs.existsSync(path.join(s.ud, 'window-prefs.json')))
    // 出口行：response 是原生对话框返回给主进程的那个数（0=最小化）。shown 有 resolved 无
    // 就是 T04475 描述的「点了没回调」，有这行才不用再靠「没落 [close]」反推。
    const resolved = dlgLineOf(tail(), s.child.pid, 'resolved')
    check('F 弹框退出落了 [close-dialog] resolved response=0（决策真回到主进程）',
      /response=0\b/.test(resolved), resolved || closeEvidence(s.child.pid))
    killTree(s.child.pid)
    try { s.ws.close() } catch { /* noop */ }
    removeTmp(s.base)
  }
}

// ---- G/H：关闭决策弹框文案随语言切换（T03957）----
// 原生 TaskDialog 的文案由主进程内置中英表给出，这里用真实弹框验证「选表」确实生效：
// 同一份代码分别以 --lang=en-US / --lang=zh-CN 启动，读回屏幕上的标题/正文/按钮/复选框文本。
// 期望文案表 CLOSE_TEXTS 见 tests/win_dialog.mjs（逐字硬编码，不复用表内容）。
for (const [tag, port, lang] of [['G', 9457, 'en-US'], ['H', 9458, 'zh-CN']]) {
  const want = CLOSE_TEXTS[lang]
  resetLogBase()
  const s = await scenario('dlg_' + lang.replace('-', '_'), port, null, { extraArgs: [`--lang=${lang}`] })
  if (!s.ok) {
    check(`${tag} ${lang} 弹框场景可启动`, false, s.detail)
    continue
  }
  requestClose(s.child.pid)
  await sleep(1500)
  // button 0 = 「最小化到托盘」：顺带触发 ensureTray，让 shell.log 落下 lang= 证据
  const { drv, landed, retries } = await clickDialog(s.child.pid, { tick: 0, button: 0, dump: 1 })
  const got = readDialogTexts(drv.out)
  const miss = []
  if (got.title !== want.title) miss.push(`title="${got.title}"`)
  if (!got.texts.includes(want.message)) miss.push('message 未出现')
  if (!got.texts.includes(want.detail)) miss.push('detail 未出现')
  if (got.checkbox !== want.checkbox) miss.push(`checkbox="${got.checkbox}"`)
  check(`${tag} ${lang} 弹框标题/正文/复选框为目标语言`, miss.length === 0, miss.join(' / ') || `title=${got.title}`)
  check(`${tag} ${lang} 两个按钮文案与顺序正确`,
    got.buttons.length === 2 && got.buttons[0] === want.buttons[0] && got.buttons[1] === want.buttons[1], got.buttons.join(' | '))
  // 没找到/没点着弹框时本进程压根不会走 hideToTray，也就不会落托盘行——
  // 这种情况必须报「弹框没被驱动/点击没生效」，不能让它伪装成「选表选错语言」（T04450 的红就是这么来的）。
  check(`${tag} ${lang} 弹框被找到且「最小化到托盘」被本进程接住（落了 [close] 行）`,
    drv.out.includes('DIALOG=found') && !!landed,
    landed ? landedNote({ landed, retries }) : (drv.out.split('\n')[0] || '(驱动无输出)') + ' / ' + closeEvidence(s.child.pid))
  const tray = await waitTrayLine(s.child.pid)
  check(`${tag} 主进程按 ${lang} 选表（本进程托盘行 lang=${lang}）`,
    tray.includes('lang=' + lang), tray || `本进程 [close] 行：${landed || '无'}；${trayEvidence(s.child.pid)}`)
  check(`${tag} 关闭后未落盘偏好（未勾选记住）`, !fs.existsSync(path.join(s.ud, 'window-prefs.json')))
  killTree(s.child.pid)
  try { s.ws.close() } catch { /* noop */ }
  removeTmp(s.base)
}

cleanupDialogScript()

const failed = res.filter(r => !r.ok)
const summary = failed.length ? `失败 ${failed.length}/${res.length}` : `全绿 ${res.length}/${res.length}`
console.log(`\n==== Electron 关闭行为烟测 ==== ${summary}`)
process.exit(failed.length ? 1 : 0)
