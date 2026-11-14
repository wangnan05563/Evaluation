/** T04507 负载维度「首按吞掉率是否随并发负载放大」探针（仓内可重复、CI 可跑）。
 *
 *  背景 / 要回答的问题
 *  --------------------
 *  T04475/T04505 已确证：合成 BM_CLICK 的首按约 1/5~1/3 会被系统 TaskDialog 吞掉
 *  （空载两批各 15 次：5/15 + 2/15 = 7/30；T04505 当天最大一批 14 轮反而 0 次）。
 *  吞按率强烈依赖机器负载与当天批次——「任何一天的 0/N 都不等于问题消失」。
 *  本探针要量的是：当机器被 npm test / 多路 shell_close_smoke 这类重负载压着时，
 *  我们自己的「关闭决策弹框」首按吞掉率会不会被放大（即负载放大效应）。
 *
 *  为什么它是「缺环境」任务（自动验证的边界）
 *  ------------------------------------------
 *  真要复现「多路同类 Electron 实例并发」在本机被单实例锁 + 共享 shell.log 挡住
 *  （见 docs/设计-数据与运维.md 第 6/7 条与 T04549 互斥锁），所以负载维度必须在
 *  「具备并行交互桌面的 CI」上才能干净出数。本脚本就是那把自动化钥匙：
 *    · 仓内可重复、参数化，本地先跑 idle 基线把 harness 自身验证掉；
 *    · 在并行桌面 CI 上把 --load-cmd 指向 npm test / 多路 smoke，即可一键产出
 *      三种负载各 ≥15 次的首按吞掉率 + 接住耗时 + 机器水位读数。
 *
 *  设计要点（与既有套件同口径）
 *  ----------------------------
 *  · 复用 electron_cdp.mjs 的 makeLauncher（独立 user-data-dir + CDP，
 *    起前自动 reclaim 钉子户，剥掉 ELECTRON_RUN_AS_NODE/NODE_OPTIONS 沙箱钩子）；
 *  · 复用 win_dialog.mjs 的 driveDialog（BM_CLICK 通道 0，投递判据始终是
 *    「对话框窗口真没了」= DIALOG_AFTER=no，被吞=DIALOG_AFTER=yes，与 T04475 同口径）；
 *  · 每个样本 = 一次全新实例（null 偏好 → 关窗必弹框），点一次即量首按，然后 killTree，
 *    干净隔离，避免单实例锁互相挡（样本之间串行，加载生成器另起）；
 *  · 机器水位读数沿 docs/设计-数据与运维.md 第 6 条口径：spawnSync 调 tasklist
 *    （不经 shell，避开 MSYS 的 /FI 路径转换陷阱），数 node.exe 行，每次在「关前/关后」
 *    各采一次取大者；样本级与汇总级都报 min/中位/max；
 *  · 启动失败的样本记 launch_fail、弹框没出来的记 no_dialog，二者都不算吞按，
 *    单独计数——负载场景下偶发的单实例碰撞会被如实分出来，不会污染吞按率。
 *
 *  用法
 *  ----
 *  node tests/load_swallow_probe.mjs [--scenario idle|npmtest|smoke3]
 *                                    [--load-cmd "背景负载命令"]
 *                                    [--samples 15] [--button 1]
 *                                    [--port-base 9600] [--wait-cdp-ms 60000]
 *                                    [--warmup-ms 5000] [--wait-dlg-ms 20000]
 *                                    [--out logs/load_swallow_<场景>.json]
 *  · --scenario 仅是预设 --load-cmd 的便捷档：idle=无负载；npmtest=`npm test`；
 *    smoke3=三路 shell_close_smoke 并发（Windows 用 start，*nix 用 &）。
 *  · 想自定义负载（如并行桌面上的独立 checker）直接 --load-cmd，--scenario 被忽略。
 *  · 退出码：有 ≥1 个有效样本 → 0（纯数据采集，不判红）；0 个有效样本 → 2（harness/环境故障）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { makeLauncher, requestClose, killTree, sleep } from './electron_cdp.mjs'
import { removeTmp } from './tmp_janitor.mjs'
import { driveDialog, cleanupDialogScript } from './win_dialog.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = path.join(ROOT, 'dev-shell', 'node_modules', 'electron', 'dist', 'electron.exe')
const APP_DIR = path.join(ROOT, 'dev-shell')

// ---- 参数解析（极简，不引第三方）----
const argv = process.argv.slice(2)
const getOpt = (names, dflt) => {
  for (const n of names) {
    const i = argv.indexOf(n)
    if (i >= 0 && i + 1 < argv.length) return argv[i + 1]
  }
  return dflt
}
const HELP = argv.includes('-h') || argv.includes('--help')
const scenario = getOpt(['-s', '--scenario'], 'idle')
let loadCmd = getOpt(['-l', '--load-cmd'], null)
const SAMPLES = Math.max(1, Number(getOpt(['-n', '--samples'], '15')) || 15)
const BUTTON = Number(getOpt(['-b', '--button'], '1')) || 1
const PORT_BASE = Number(getOpt(['--port-base'], '9600')) || 9600
const WAIT_CDP_MS = Number(getOpt(['--wait-cdp-ms'], '60000')) || 60000
const WARMUP_MS = Number(getOpt(['--warmup-ms'], '5000')) || 5000
const WAIT_DLG_MS = Number(getOpt(['--wait-dlg-ms'], '20000')) || 20000
const OUT = getOpt(['--out'], null)

// 场景预设（--load-cmd 优先级最高）
if (!loadCmd) {
  if (scenario === 'npmtest') loadCmd = 'npm test'
  else if (scenario === 'smoke3') {
    // 三路 shell_close_smoke 并发作为机器负载代理（Windows 用 start 并行）
    const onWin = process.platform === 'win32'
    if (onWin) {
      loadCmd = 'cmd /c "start "" node tests/shell_close_smoke.mjs & start "" node tests/shell_close_smoke.mjs & start "" node tests/shell_close_smoke.mjs & timeout /t 900 /nobreak >nul"'
    } else {
      loadCmd = 'sh -c "node tests/shell_close_smoke.mjs & node tests/shell_close_smoke.mjs & node tests/shell_close_smoke.mjs & wait"'
    }
  }
}

if (HELP) {
  console.log(`T04507 负载维度首按吞掉率探针

用法: node tests/load_swallow_probe.mjs [--scenario idle|npmtest|smoke3]
                                      [--load-cmd "背景负载命令"]
                                      [--samples 15] [--button 1]
                                      [--port-base 9600] [--wait-cdp-ms 60000]
                                      [--warmup-ms 5000] [--wait-dlg-ms 20000]
                                      [--out 结果.json]
`)
  process.exit(0)
}

const WATCHDOG = Number(process.env.WE_LOAD_WATCHDOG_MS || 540000)
setTimeout(() => { console.error('[bk] WATCHDOG 超时，强制退出'); process.exit(3) }, WATCHDOG)

if (!fs.existsSync(ELECTRON)) {
  console.error(`[fatal] 找不到 electron.exe：${ELECTRON}\n本套件依赖可交互窗口站（原生 TaskDialog + UIA），非 Windows / 未装 dev-shell 依赖时请 SKIP。`)
  process.exit(2)
}

// 每个场景独立 user-data-dir（隔离偏好文件与单实例锁）。开发态用 WE_DEV_URL 把首页指到
// 一个空白 data: 页——本探针只量壳的关闭链与弹框投递，不依赖 sidecar 是否起得来。
const launcher = makeLauncher({
  exe: ELECTRON,
  baseArgs: [APP_DIR],
  baseEnv: { WE_DEV_URL: 'data:text/html,<html><head><meta charset="utf-8"><title>load probe</title></head><body>load probe</body></html>' },
  waitCdpMs: WAIT_CDP_MS
})

// 机器水位读数（docs/设计-数据与运维.md 第 6 条口径）：spawnSync 调 tasklist、数 node.exe 行，
// 不经由 shell 避免 MSYS 把 /FI 当路径转换（那样会假读成「没有匹配任务」）。
function readNodeCount() {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq node.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
  if (r.status !== 0) return -1
  const lines = (r.stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  return lines.length
}
const median = arr => {
  if (!arr.length) return -1
  const s = [...arr].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}

const scenario_ = launcher // 别名，便于阅读

async function sampleOne(i) {
  const port = PORT_BASE + i
  const s = await scenario_('ld_' + i, port, null) // null 偏好 → 关窗必弹框
  if (!s.ok) {
    return { ok: false, reason: 'launch_fail', detail: (s.detail || '').slice(0, 200) }
  }
  const before = readNodeCount()
  requestClose(s.child.pid) // 给可见主窗投 WM_CLOSE → 未记住选择则弹关闭决策框
  await sleep(1000)
  const drv = driveDialog(s.child.pid, { button: BUTTON, waitMs: WAIT_DLG_MS, graceMs: 700 })
  const after = readNodeCount()
  const out = drv.out
  const found = out.includes('DIALOG=found')
  const swallowed = out.includes('DIALOG_AFTER=yes') // 首按被吞（窗口 700ms 内没消失）
  const landed = out.includes('DIALOG_AFTER=no')     // 首按即接住
  const settleMatch = /SETTLE_MS=(-?\d+)/.exec(out)
  const settle = settleMatch ? Number(settleMatch[1]) : -1
  killTree(s.child.pid)
  try { s.ws.close() } catch { /* noop */ }
  removeTmp(s.base)
  return {
    ok: true, found, swallowed, landed, settle,
    before, after, load: Math.max(before, after),
    out: out.split('\n').slice(0, 6).join(' | ') // 精简取证，完整 out 不入库
  }
}

console.log(`== T04507 负载维度首按吞掉率探针 == 场景=${scenario} 样本=${SAMPLES} 按钮=${BUTTON}`)
console.log(`背景负载命令：${loadCmd || '（无，idle 基线）'}`)

// 启动背景负载（在并行桌面 CI 上这是真实重负载；本地 idle 不启）
let loadProc = null
if (loadCmd) {
  console.log(`启动背景负载（warmup ${WARMUP_MS}ms）…`)
  loadProc = spawn(loadCmd, { shell: true, cwd: ROOT, stdio: 'ignore', detached: true })
  loadProc.unref?.()
  await sleep(WARMUP_MS)
}

const results = []
let portCursor = 0
for (let i = 0; i < SAMPLES; i++) {
  const r = await sampleOne(i)
  results.push(r)
  if (!r.ok) {
    console.log(`  [${i + 1}/${SAMPLES}] launch_fail：${r.detail}`)
  } else if (!r.found) {
    console.log(`  [${i + 1}/${SAMPLES}] no_dialog（弹框未出现，记 infra，不算吞按） load=${r.load}`)
  } else if (r.swallowed) {
    console.log(`  [${i + 1}/${SAMPLES}] SWALLOW（首按被吞） settle=${r.settle}ms load=${r.load}`)
  } else {
    console.log(`  [${i + 1}/${SAMPLES}] land 接住耗时=${r.settle}ms load=${r.load}`)
  }
}
if (loadProc) {
  try { process.kill(-loadProc.pid) } catch { /* 已退出或无可杀 */ }
  try { loadProc.kill('SIGKILL') } catch { /* noop */ }
}
cleanupDialogScript()

// ---- 汇总 ----
const valid = results.filter(r => r.ok && r.found)
const launchFail = results.filter(r => !r.ok)
const noDialog = results.filter(r => r.ok && !r.found)
const swallowCount = valid.filter(r => r.swallowed).length
const landCount = valid.filter(r => r.landed).length
const swallowRate = valid.length ? (swallowCount / valid.length) : 0
const settleArr = valid.filter(r => r.landed && r.settle >= 0).map(r => r.settle)
const loadArr = results.filter(r => r.ok).map(r => r.load).filter(v => v >= 0)
const summary = {
  scenario, samples: SAMPLES, button: BUTTON, loadCmd: loadCmd || null,
  valid: valid.length, launchFail: launchFail.length, noDialog: noDialog.length,
  swallow: swallowCount, land: landCount,
  swallowRate: Number(swallowRate.toFixed(4)),
  settleMs: { min: Math.min(...(settleArr.length ? settleArr : [-1])), median: median(settleArr), max: Math.max(...(settleArr.length ? settleArr : [-1])) },
  loadNode: { min: Math.min(...(loadArr.length ? loadArr : [-1])), median: median(loadArr), max: Math.max(...(loadArr.length ? loadArr : [-1])) },
  ts: new Date().toISOString()
}
console.log(`\n==== 汇总（场景=${scenario}）====`)
console.log(`有效样本(valid)=${valid.length}  启动失败(launch_fail)=${launchFail.length}  无弹框(no_dialog)=${noDialog.length}`)
console.log(`首按吞掉(swallow)=${swallowCount}  首按接住(land)=${landCount}  吞掉率=${summary.swallowRate}`)
console.log(`接住耗时 settle ms：min/median/max = ${summary.settleMs.min}/${summary.settleMs.median}/${summary.settleMs.max}`)
console.log(`机器水位 node.exe 计数：min/median/max = ${summary.loadNode.min}/${summary.loadNode.median}/${summary.loadNode.max}`)
console.log(`（对照：T04475 空载 7/30≈0.233；T04505 当天最大批 0/14、另有 2/15≈0.133。负载场景应观察吞掉率是否明显高于此区间）`)

if (OUT) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify({ summary, results }, null, 2), 'utf8')
  console.log(`\n结果已写入：${OUT}`)
}

const exitCode = valid.length ? 0 : 2
process.exit(exitCode)
