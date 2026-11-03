/** 测试临时目录回收公共件（T04089）。
 *  约定：本项目跑测试产生的临时目录一律落在 os.tmpdir() 下、以 `we_` 开头
 *  （we_test_ / we_shell_ / we_prod_ / we_prefs_ / we_cli_ …），所以能按前缀整体清点。
 *  四层回收：
 *    1) 正常路径 —— 调用方显式 removeTmp()，或 S17/S18 各自的 teardown()；
 *    2) 本进程被打断 —— registerTmp() 登记过的目录在 exit / SIGINT / SIGTERM 里补删；
 *    3) 硬 kill 的孤儿 —— taskkill /F（run.mjs 超时杀子进程用的就是它）不触发任何钩子，
 *       所以每次开跑前按 mtime 收掉超龄的 we_* 目录。
 *    4) 当场删不掉的钉子户 —— 句柄要到进程死后几十秒才松开（本机实测见下），在退出路径上
 *       死等等于把整轮回归拖住；所以 removeTmp 只小额重试，仍失败就记进 we_tmp_stuck.json，
 *       下一轮开跑时 reclaimStaleTmp() 先按这张名单收（不看年龄），清单里的记录 7 天后弃。
 *  ⚠ 阈值默认 24 小时而不是「开跑就清」：本机常有多个会话同时在跑回归，
 *    单轮 npm test ≤ 半小时、S17/S18 预算 15min，真在用的目录不可能老到 24h，
 *    因此这条门只可能命中上一轮崩溃留下的尸体，不会把并发会话的现场删掉。
 *  ⚠ 删不掉先有界重试（见 removeTmp），仍失败才打 WARN，绝不把「目录被句柄占用」报成用例红。
 *  ⚠ 重试预算不能拍脑袋加长：本机 probe_chrome_settle 实测「headless Chrome 被
 *    taskkill /T /F 之后连续重试 30s（52 次）仍 EPERM，约 1 分钟后才可删」——
 *    tasklist 里已经没有一个 chrome.exe，锁仍在。所以加长同步步长在「删干净」之前
 *    先把回归拖长，这里选小额重试 + 交给下一轮，而不是就地死等。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const keepRequested = () => process.env.WE_KEEP_TMP === '1'
const registered = new Set()
let hooksInstalled = false

// 同步等待：回收点大多在 exit 钩子/teardown 里，那里不能用 await。
// Atomics.wait 在主线程可用；万一环境不给，就退化成「不等，少试一轮」。
const sleepSync = ms => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* 不等 */ }
}

/** 删一个目录；失败只警告并返回 false（回收失败不是用例失败）。
 *  为什么要重试：刚 taskkill 掉 Chrome/Electron 时，操作系统还没释放掉目录里的句柄，
 *  这一刻的 EPERM/EBUSY 过半秒就没了（本机实测：一轮回归后残留的 6 个目录，1 分钟后全部可删）。
 *  不重试就会把它们全留给 24h 那道门，等于每轮都往临时目录里堆一叠「其实当场能清」的尸体。
 *  真删不掉的（例如有活的 EXCEL.EXE 占住生成的 xlsx）才走 WARN + 记名 + 超龄回收兜底。 */
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EBADF'])
export function removeTmp(dir, { quiet = false, tries = 5, waitMs = 300 } = {}) {
  if (!dir) return false
  registered.delete(dir)
  let last
  for (let i = 0; i < tries; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      forgetStuck(dir)
      return true
    } catch (e) {
      last = e
      if (!RETRYABLE.has(e.code) || i === tries - 1) break
      sleepSync(waitMs)
    }
  }
  noteStuck(dir)
  if (!quiet) console.log(`  WARN 临时目录未能回收: ${dir}（${last.code || last.message}）`)
  return false
}

// —— 钉子户名单 ——
// removeTmp 当场删不掉，不代表永远删不掉：句柄松开通常在几十秒到 1 分钟之间，
// 而那早已超出「在退出路径上等得起」的范围。所以把目录记进这张名单，
// 下一轮开跑时 reclaimStaleTmp() 先按名单收（不看年龄），残尸体最多活过一轮。
// 名单自身也落在 tmp 里，名字同样带 we_ 前缀，但它是文件——目录扫描有 isDirectory() 门，不会误伤。
// 并发两进程各写各的会互相覆盖：真发生了也只是那一轮没记住，目录退回 24h 那道门，不丢数据。
const STUCK_FILE = path.join(os.tmpdir(), 'we_tmp_stuck.json')
const STUCK_TTL_MS = 7 * 24 * 3600e3
const readStuck = () => {
  try {
    const rows = JSON.parse(fs.readFileSync(STUCK_FILE, 'utf8'))
    return Array.isArray(rows) ? rows.filter(r => r && typeof r.dir === 'string') : []
  } catch { return [] }
}
const writeStuck = list => {
  try { fs.writeFileSync(STUCK_FILE, JSON.stringify(list)) } catch { /* 记不上只是少一轮兜底，不影响用例 */ }
}
function noteStuck(dir) {
  const rows = readStuck()
  if (rows.some(r => r.dir === dir)) return
  rows.push({ dir, at: Date.now() })
  writeStuck(rows.slice(-200))
}
function forgetStuck(dir) {
  const rows = readStuck()
  const rest = rows.filter(r => r.dir !== dir)
  if (rest.length !== rows.length) writeStuck(rest)
}

/** 登记「本进程造出来、还没回收」的目录；首次调用时顺手挂上退出钩子。 */
export function registerTmp(dir) {
  if (!dir) return dir
  registered.add(dir)
  if (hooksInstalled || keepRequested()) return dir
  hooksInstalled = true
  // 钩子里重试给小一点：退出路径不该被回收卡住几秒，兜底还有超龄那道门
  const flush = () => { for (const d of [...registered]) removeTmp(d, { quiet: true, tries: 3, waitMs: 250 }) }
  process.on('exit', flush)
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flush(); process.exit(130) })
  return dir
}

// 目录自身的 mtime 只在增删条目时才变，而浏览器/Electron 的现场是子目录里在动，
// 所以取「自身 + 一层子项」里最新的那个；读不到就返回 Infinity（宁可不删）。
function newestMtime(dir) {
  let t
  try { t = fs.statSync(dir).mtimeMs } catch { return Infinity }
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      try {
        const m = fs.statSync(path.join(dir, e.name)).mtimeMs
        if (m > t) t = m
      } catch { /* 子项读不到就不作为判据 */ }
    }
  } catch { /* 空目录/无权限 */ }
  return t
}

/** 开跑前回收：先按上一轮的钉子户名单收（不看年龄），再按 mtime 收掉超龄的 we_* 孤儿。
 *  返回 { removed, stuck, keptFresh, listed }。 */
export function reclaimStaleTmp() {
  const out = { removed: 0, stuck: 0, keptFresh: 0, listed: 0 }
  if (keepRequested()) return out
  // 名单先走：这些是「上一轮明知没删掉」的目录，句柄这会儿大概率已经松了。
  // 7 天还没松手的（真有活的 EXCEL.EXE 之类）从名单里弃记，免得清单无限长——
  // 目录本身仍归下面那道超龄门管，不算丢。
  const now = Date.now()
  for (const rec of readStuck()) {
    const agedOut = !Number.isFinite(rec.at) || now - rec.at > STUCK_TTL_MS
    if (agedOut || !fs.existsSync(rec.dir)) { forgetStuck(rec.dir); continue }
    out.listed++
    removeTmp(rec.dir, { quiet: true }) ? out.removed++ : out.stuck++
  }
  const hours = Number(process.env.WE_TMP_RECLAIM_HOURS || 24)
  const cutoff = now - hours * 3600e3
  let entries = []
  try { entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('we_')) continue
    const full = path.join(os.tmpdir(), e.name)
    if (newestMtime(full) > cutoff) { out.keptFresh++; continue }
    removeTmp(full, { quiet: true }) ? out.removed++ : out.stuck++
  }
  return out
}
