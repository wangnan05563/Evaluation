/** T04505 原生弹框「投递通道」探针：量化合成点击被 TaskDialog 吞掉的比率。
 *
 *  为什么不进回归：这是一把量尺，不是一道断言。它跑一次要几十次真点击原生弹框，
 *  结论（各通道的吞按率）写进 tests/shell_close_smoke.mjs 头注释与
 *  docs/设计-数据与运维.md 关键决策第 7 条，回归里只保留「按投递结果补按」的打法。
 *  因此本文件刻意不登记进 tests/run.mjs。
 *
 *  用法（仓库根目录）：
 *    node tests/tools/native_dialog_probe.mjs --modes 0 --rounds 15 --out logs/t04505/probe.log
 *    可选：--graceMs 2000（第二条判据的宽限窗）、--noClickStop 999（发不出点击多少轮收轮）、
 *          --relaunch 3（连续多少轮不弹新框就换实例）、--noClear 1（不清场，只为验证换实例那条链）、--port
 *  五种通道（tests/win_dialog.mjs 的 -Mode）：
 *    0 = BM_CLICK（SendMessageTimeoutW，现行驱动打法）
 *    1 = UIA InvokePattern.Invoke()（COM CUIAutomation8）
 *    2 = UIA LegacyIAccessible.DoDefaultAction()（同上，pattern id 10015）
 *    3 = 先 SetForegroundWindow+SetFocus 再 BM_CLICK（T04475 留下的参照）
 *    4 = 原生 MSAA oleacc IAccessible.accDoDefaultAction()（T04539，不经任何 UIA 客户端）
 *  默认只跑 0,1,2,3；通道 4 要显式 --modes 4（它一次 oleacc 调用都不碰 UIA，跑法与其他四条同）。
 *
 *  判据口径与 T04475 一致，不看任何返回值，只看两件事：
 *    · 驱动侧：按完后 IsWindow(对话框句柄) 是否变 false（驱动输出的 DIALOG_AFTER=no|yes）
 *    · 产品侧：本进程有没有落 [close-dialog] resolved / [close] action 行
 *  首按没接住时算一次「吞按」，并当场补按把弹框关掉（保证下一轮从干净状态开始），
 *  补按是否救回也逐轮记录——「吞了但补得回来」和「吞了且救不回」是两回事。
 *
 *  T04540（批次作废）：一轮跑完本进程没落新 [close-dialog] shown，这台实例往后的轮次就只剩 not_found。
 *  量下来有两条独立的成因，都要治：
 *  ① 弹框停在 await：askCloseAction 还没返回时 main.js 的 win.__closeBusy 会按住之后每一次关闭请求，
 *     而挂着的模态框对第二次 WM_CLOSE 纹丝不动（exp1：MODAL_COUNT 恒为 1、resolved 恒为 0、主窗一直可见；
 *     exp2：这期间每轮驱动都报 not_found 且本进程 shown=0，形状和「实例已废」一模一样）。
 *     → 每轮收尾查一次「有没有弹框停在 await」，有就用 BM_CLICK 清掉（清场动作不计入任何通道结论）；
 *       连续 --relaunch（默认 3）轮都不弹新框就 killTree 换新实例接着跑剩余轮次，报告按实例分行，
 *       pid 变更与「实例 2（重启接管）」都写在行首，不把两台实例的数据混成同一个吞按率。
 *  ② 关闭请求压根没送到：工单怀疑「taskkill 不带 /F 会把 WM_CLOSE 投给所有顶层窗口、因而吃掉上一轮
 *     的弹框」——这条**没有证实**（①的实测就是它：模态框既不销毁也不回调）。但同一段代码有个方向相反的
 *     真毛病：主窗被「最小化到托盘」hide() 之后，不带 /F 的 taskkill 送不进 WM_CLOSE（它只发给可见顶层窗），
 *     于是这台实例之后再也不会弹框——健康如 BM_CLICK 通道也是第 1 轮有数据、第 2~4 轮全 not_found
 *     （exp3：主窗隐藏后连续两次 taskkill，shown 停在 1、2 不增；换 PostMessage(主窗, WM_CLOSE) 则 1→2、2→3）。
 *     → 探针的关闭请求换成 postCloseToMainWindow(pid)。S17 与装包烟测沿用 requestClose 不动：真实用户的
 *       X 点击永远发生在可见窗口上，那里 taskkill 等价且更贴近产品入口的打法。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeLauncher, killTree, sleep } from '../electron_cdp.mjs'
import { removeTmp } from '../tmp_janitor.mjs'
import { driveDialog, probeWindow, postCloseToMainWindow } from '../win_dialog.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ELECTRON = path.join(ROOT, 'dev-shell', 'node_modules', 'electron', 'dist', 'electron.exe')
const APP_DIR = path.join(ROOT, 'dev-shell')
const SHELL_LOG = path.join(ROOT, 'logs', 'shell.log')

const argv = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const ROUNDS = Number(argv('rounds', 15))
const MODES = String(argv('modes', '0,1,2,3')).split(',').map(s => Number(s.trim())).filter(Number.isInteger)
const BASE_PORT = Number(argv('port', 9470))
const OUT = argv('out', '')
// 只点「最小化到托盘」：进程留在，下一轮才还能把弹框唤出来。按钮位置序见 win_dialog.mjs。
const TRAY_BUTTON = 0
const MODE_NAMES = { 0: 'bm_click', 1: 'uia_invoke', 2: 'legacy_iaccessible', 3: 'foreground_focus', 4: 'msaa_default_action' }
// 「通道压根发不出点击」连续这么多轮就提前收轮（省时间）；要按「每种打法各 ≥15 次」出报告时，
// 用 --noClickStop 999 跑满轮次——发不出去本身就是要记进文档的数字，不能被提前收轮藏掉。
const NO_CLICK_STOP = Number(argv('noClickStop', 999))
// 第二条判据的宽限窗（只探针用，回归仍按 700ms 内 IsWindow 判定）。
// 为什么要两条口径：DIALOG_AFTER=yes 有两种形状——「这一按真被吞」和「销毁已经排队、只是慢」。
// 只报严格口径会把后者算进吞按率，结论就没法和产品侧的 [close] action 行对上。
const GRACE_MS = Number(argv('graceMs', 2000))
// T04540：连续这么多轮「本进程没再弹新框」就换一台实例接着跑（这类轮次一台实例上永远不会自己恢复）。
const RELAUNCH_AFTER = Number(argv('relaunch', 3))
// 自检开关：1 = 跳过所有清场动作，用来验证「连续不弹新框 → 重启接管」真的会触发。
const NO_CLEAR = String(argv('noClear', '0')) === '1'

const lines = []
const say = s => { lines.push(s); console.log(s) }
const saidOnce = new Set()
const sayOnce = s => { if (!saidOnce.has(s)) { saidOnce.add(s); say(s) } }
const pct = (a, b) => (b ? `${a}/${b}（${(100 * a / b).toFixed(1)}%）` : `${a}/0`)

const scenario = makeLauncher({
  exe: ELECTRON,
  baseArgs: [APP_DIR],
  baseEnv: { WE_DEV_URL: 'data:text/html,<html><head><meta charset="utf-8"><title>probe</title></head><body>probe</body></html>' }
})

const readStr = f => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
const ownCount = (text, prefix, pid) =>
  text.split(/\r?\n/).filter(l => l.startsWith(prefix) && l.endsWith(` pid=${pid}`)).length
const settled = ms => (Number.isFinite(ms) && ms >= 0 ? ms : null)

async function waitOwnLine(text0, prefix, pid, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const t = readStr(SHELL_LOG)
    if (ownCount(t, prefix, pid) > ownCount(text0, prefix, pid)) return true
    await sleep(250)
  }
  return false
}

const parseOut = out => {
  const tail = (out.match(/CHANNEL=(\S+) INVOKE=(\S+)/) || [])
  return {
    found: out.includes('DIALOG=found'),
    notFound: out.includes('DIALOG=not_found'),
    delivered: out.includes('DIALOG_AFTER=no'),
    // issued：这一按真的发出去了（驱动报 INVOKE=sent）。发不出去（pattern 拿不到、抛异常）
    // 与「发出去但被对话框吞掉」必须分开计，否则「通道不可用」会被读成「通道不可靠」。
    issued: tail[2] === 'sent',
    settle: settled(Number((out.match(/SETTLE_MS=(-?\d+)/) || [])[1])),
    // GRACE=closed@<ms> 表示严格口径判「被吞」、但宽限窗里窗口自己没了（销毁排队）；
    // open 才是宽限到点还在（真被吞）；off 表示这一路没开宽限判据。
    grace: (out.match(/GRACE=(\S+)/) || [])[1] || 'off',
    graceAt: settled(Number((out.match(/GRACE=closed@(-?\d+)/) || [])[1])),
    channel: tail[1] || '',
    invoke: tail[2] || '',
    // 各通道的自证行（UIA_* 通道 1/2、PRE= 通道 3、MSAA_* 通道 4）留一份进小结，
    // 「发不出去」的形状只有这些 token 能事后复核
    uia: out.split(/\r?\n/).filter(l => l.startsWith('UIA_') || l.startsWith('MSAA_') || l.startsWith('PRE=')).join(' | ')
  }
}

/** 等这一轮的关闭链走完，再发下一个 WM_CLOSE。
 *  main.js 的 handleCloseRequest 有 win.__closeBusy 门，而 [close] action 行落在 hideToTray 之前：
 *  只等到那行就发下一轮，会被这道门静默挡掉（实测：BM_CLICK 通道第 2 轮、UIA 两条通道后续 14 轮
 *  全是「驱动 not_found + 本进程 shown=0」，白烧轮次）。判据用 Win32 可见性——主窗真隐藏了才算走完。 */
async function waitWindowHidden(pid, tries = 24) {
  for (let i = 0; i < tries; i++) {
    const w = probeWindow(pid)
    if (w.total < 0) return false
    if (w.visible === 0) { await sleep(400); return true }
    await sleep(250)
  }
  return false
}

/** 本进程有没有「弹出来了但没人点」的弹框挂在 await 里。
 *  shown 行数 > resolved 行数 = askCloseAction 还停在 await，main.js 的 win.__closeBusy 门就此按住，
 *  之后每轮 WM_CLOSE 都不会有新弹框（T04540 实测：模态框被第二次 WM_CLOSE 打得纹丝不动，
 *  MODAL_COUNT 一直是 1、resolved 一直是 0，整批轮次就这么废掉）。 */
const parkedDialogs = pid => {
  const t = readStr(SHELL_LOG)
  return ownCount(t, '[close-dialog] shown', pid) - ownCount(t, '[close-dialog] resolved', pid)
}

/** 用一个不属于任何通道结论的动作把挂着的弹框收掉（走现行可用的 BM_CLICK）。 */
function clearParkedDialog(pid) {
  // --noClear 1 是给「连续不弹新框 → 换实例」这条链做自检用的：不清场，通道 2 那种
  // 「第一次按发不出去」的打法就会把弹框一直挂着，第二轮起必然全废，正好把重启路径跑出来。
  if (NO_CLEAR) { sayOnce('  （--noClear=1：故意不清场，只为验证重启接管这条链）'); return false }
  let cleared = false
  for (let k = 0; k < 2; k++) {
    const clr = parseOut(driveDialog(pid, { button: TRAY_BUTTON, mode: 0 }).out)
    if (clr.delivered || clr.notFound) { cleared = true; break }
  }
  return cleared
}

async function openInstance(mode, seq, port) {
  const s = await scenario(`probe_m${mode}_${seq}`, port, null)
  if (!s.ok) return { error: s.detail }
  return {
    seq, port, ws: s.ws, base: s.base, child: s.child, pid: s.child.pid,
    stats: {
      mode, name: MODE_NAMES[mode] || `mode${mode}`, seq, pid: s.child.pid, port,
      startRound: 0, relaunched: false,
      rounds: 0, shown: 0, resolved: 0, dropped: 0, rescued: 0, unrecoverable: 0,
      noDialog: 0, noClick: 0, dead: 0, settles: [], uiainfo: ''
    }
  }
}

async function closeInstance(inst) {
  killTree(inst.pid)
  try { inst.ws.close() } catch { /* noop */ }
  await sleep(1200)
  removeTmp(inst.base)
}

async function runMode(mode, port) {
  const name = MODE_NAMES[mode] || `mode${mode}`
  say(`\n=== 通道 ${mode} ${name} —— ${ROUNDS} 轮 ===`)
  const modeResult = { mode, name, instances: [], error: '' }
  let inst = await openInstance(mode, 1, port)
  if (inst.error) { say(`  启动失败：${inst.error}`); modeResult.error = inst.error; return modeResult }
  inst.stats.startRound = 1
  let stats = inst.stats
  // T04540：一轮下来本进程没落新 shown = 这台实例已经不产数据了，连续这么多轮就换实例。
  // 判据用 shown 行数而不是「驱动 not_found」：挂着旧弹框时驱动照样 found（找到的是上一轮那个），
  // 两种形状都会把整批轮次废掉，而 shown=0 是它们共同的因。
  let deadStreak = 0
  let modeNoClick = 0
  const guardDead = async r => {
    const pid = inst.pid
    if (stats.shownThisRound > 0) { deadStreak = 0; return true }
    stats.dead++
    deadStreak++
    const parked = parkedDialogs(pid)
    if (parked > 0) {
      say(`      本进程有 ${parked} 个弹框停在 await（决策链没走完，__closeBusy 按住后续轮次），先清场`)
      clearParkedDialog(pid)
      await waitWindowHidden(pid, 8)
      if (parkedDialogs(pid) === 0 && deadStreak < RELAUNCH_AFTER) return true
    }
    if (deadStreak < RELAUNCH_AFTER || r === ROUNDS) return true
    say(`  连续 ${deadStreak} 轮本进程不再弹新框，判这台实例已废 —— 重启实例接管剩余轮次`)
    const next = await openInstance(mode, inst.seq + 1, port + (inst.seq * 10))
    if (next.error) { say(`  重启失败：${next.error}；停止本通道`); await closeInstance(inst); return false }
    const oldPid = inst.pid
    modeResult.instances.push(stats)
    await closeInstance(inst)
    inst = next
    next.stats.startRound = r + 1
    next.stats.relaunched = true
    say(`  已换实例 ${next.seq}（pid ${oldPid} → ${next.pid}），从第 ${r + 1} 轮接着跑`)
    deadStreak = 0
    return true
  }

  for (let r = 1; r <= ROUNDS; r++) {
    const pid = inst.pid
    stats = inst.stats
    stats.shownThisRound = 0
    if (inst.child.exitCode !== null) { say(`  第 ${r} 轮：应用进程已退出，停止本通道`); break }
    const before = readStr(SHELL_LOG)
    // 关闭请求走「只对主窗句柄 PostMessage(WM_CLOSE)」，不走 requestClose(taskkill)：
    // 本通道每轮都点「最小化到托盘」，主窗 hide() 之后不带 /F 的 taskkill 是静默空操作
    // （它只给可见顶层窗发 WM_CLOSE）——实测 exp3：主窗隐藏后连续两次 taskkill，
    // [close-dialog] shown 一直停在 1、2（不增），换 PostMessage(主窗, WM_CLOSE) 则 1→2、2→3 每轮都弹。
    // 判据不变：仍只看本进程自己的 shown 行，PostMessage 的返回值一律不采信。
    const closeReq = postCloseToMainWindow(pid)
    if (closeReq.posted === 0) say(`  第 ${r} 轮：该 pid 名下没有 Chrome_WidgetWin_1 主窗，WM_CLOSE 无处可投（进程可能已退）`)
    // 一次调用做完「等弹框出现 + 按第 TRAY_BUTTON 个按钮」：驱动内部定位到对话框后立刻按，
    // 等价于 S17/装包烟测里的真实打法，不给「等一等再按」留余地（T04475 已证延时防不住）。
    const clickRaw = driveDialog(pid, { button: TRAY_BUTTON, mode, waitMs: 20000, graceMs: GRACE_MS })
    const click = parseOut(clickRaw.out)
    const shownNew = ownCount(readStr(SHELL_LOG), '[close-dialog] shown', pid) - ownCount(before, '[close-dialog] shown', pid)
    stats.shownThisRound = shownNew
    if (!click.found) {
      // not_found 有两种形状：弹框压根没弹出来（shown 也没落），或弹出来又被别的东西收掉了。
      // 用本进程自己的 shown 行分开，别把驱动的手忙脚乱算成产品行为。
      stats.noDialog++
      say(`  第 ${r} 轮：驱动没找到对话框（${click.notFound ? 'not_found' : '超时'}）；本进程 shown=${shownNew} —— 不计入吞按率`)
      if (shownNew > 0) stats.shown += shownNew
      // 补一次「清场」：not_found 也可能是模态框还挂着、只是这一轮驱动没找着它。
      // 挂着不清会导致之后每一轮的 WM_CLOSE 都被模态吞掉（实测通道 2 第 2~5 轮全废），
      // 所以这里按投递判据再试两次把可能存在的弹框收掉，收掉的动作不计入任何通道结论。
      clearParkedDialog(pid)
      await waitWindowHidden(pid, 8)
      if (!await guardDead(r)) break
      continue
    }
    if (!stats.uiainfo && click.uia) stats.uiainfo = click.uia
    if (shownNew > 0) stats.shown += shownNew
    // 「这一按被吞」和「这一按压根没发出去」是两件事：后者（UIA 拿不到 pattern）不能算进吞按率，
    // 否则会把「通道不可用」读成「通道 100% 不可靠」。发不出点击的轮次单列 noClick。
    if (!click.issued) {
      stats.noClick++
      modeNoClick++
      const landed0 = await waitOwnLine(before, '[close] action=', pid)
      say(`  第 ${r} 轮：${click.channel} 发不出点击（INVOKE=${click.invoke}）；不计入吞按率；主进程收到决策=${landed0 ? '是' : '否'}`)
      say(`      RAW: ${clickRaw.out.replace(/\n/g, ' ⏎ ')}`)
      // 用现行可用的 BM_CLICK 把弹框关掉，保证下一轮从干净状态开始（不计入本通道结论）
      clearParkedDialog(pid)
      await waitWindowHidden(pid)
      if (modeNoClick >= NO_CLICK_STOP) {
        say(`  通道 ${name}：累计 ${modeNoClick} 轮发不出点击，按 --noClickStop=${NO_CLICK_STOP} 提前收轮`)
        break
      }
      if (!await guardDead(r)) break
      continue
    }
    stats.rounds++
    let note = ''
    if (click.delivered && click.settle !== null) stats.settles.push(click.settle)
    if (!click.delivered) {
      stats.dropped++
      // 吞了就当场补按，把弹框关掉好开下一轮；最多补两次，还不掉就记「救不回」
      let fix = null
      for (let k = 0; k < 2; k++) {
        fix = parseOut(driveDialog(pid, { button: TRAY_BUTTON, mode }).out)
        if (fix.delivered || fix.notFound) break
      }
      if (fix && (fix.delivered || fix.notFound)) stats.rescued++
      else stats.unrecoverable++
      note = ` → 补按${fix ? `${fix.delivered ? '接住' : fix.notFound ? '（弹框已消失）' : '仍没关掉'}${fix.settle !== null ? ` ${fix.settle}ms` : ''}` : '未跑'}`
    }
    // 产品侧凭据：本进程有没有落 [close] action 行（决策真的被执行）
    const landed = await waitOwnLine(before, '[close] action=', pid)
    if (landed) stats.resolved++
    say(`  第 ${r} 轮：首按${click.delivered ? '接住' : '被吞'}（${click.channel} INVOKE=${click.invoke}` +
      `${click.settle !== null ? ` ${click.settle}ms` : ''}）；shown=${shownNew > 0 ? '有' : '无'} 主进程收到决策=${landed ? '是' : '否'}${note}`)
    // 原始输出逐轮留档：吞按这种概率现象，只有原始 token 能被事后复核
    say(`      RAW: ${clickRaw.out.replace(/\n/g, ' ⏎ ')}`)
    await waitWindowHidden(pid)
    if (!await guardDead(r)) break
  }

  await closeInstance(inst)
  // 重启时旧实例的账已经推进去了，循环刚换完实例就收轮的话这里不能再推一遍（否则同一份数据算两次）
  if (!modeResult.instances.includes(stats)) modeResult.instances.push(stats)
  const median = a => { const v = [...a].sort((x, y) => x - y); return v.length ? v[Math.floor((v.length - 1) / 2)] : null }
  // T04540：一台实例一个数。重启前后混在同一个吞按率里，就等于把「换了个进程」这件事藏掉了。
  for (const st of modeResult.instances) {
    say(`  小结 ${name} 实例${st.seq}（pid=${st.pid}${st.relaunched ? '，中途重启接管' : ''}，第 ${st.startRound} 轮起）：` +
      `${pct(st.dropped, st.rounds)} 首按被吞，` +
      `其中补按救回 ${st.rescued} 次、救不回 ${st.unrecoverable} 次；` +
      `发不出点击 ${st.noClick} 轮、弹框未出现 ${st.noDialog} 轮、无新弹框 ${st.dead} 轮；主进程收到决策 ${st.resolved}/${st.rounds}` +
      `（shown ${st.shown} 次）` +
      `${st.settles.length ? `；接住耗时 min/中位/max = ${Math.min(...st.settles)}/${median(st.settles)}/${Math.max(...st.settles)}ms` : ''}`)
    if (st.uiainfo) say(`  UIA 侧自证：${st.uiainfo}`)
  }
  return modeResult
}

const results = []
for (let i = 0; i < MODES.length; i++) {
  results.push(await runMode(MODES[i], BASE_PORT + i * 100))
  await sleep(1500)
}
say('\n=== 汇总 ===')
for (const r of results) {
  if (r.error) { say(`  ${r.name}: 启动失败`); continue }
  for (const st of r.instances) {
    say(`  ${r.mode} ${r.name} 实例${st.seq} pid=${st.pid}${st.relaunched ? '（重启接管）' : ''}：` +
      `有效轮次=${st.rounds} 首按吞按率=${pct(st.dropped, st.rounds)} 补按救回=${st.rescued} 救不回=${st.unrecoverable} ` +
      `发不出点击=${st.noClick} 无新弹框=${st.dead} 决策落地=${st.resolved}/${st.rounds}`)
  }
}
say('  口径：投递只看 IsWindow(对话框) 变 false；主进程侧只看本进程 [close] action 行；' +
  '同一通道若有多个实例，各行分开算，不合并吞按率。')
if (OUT) {
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true })
  fs.writeFileSync(path.resolve(OUT), lines.join('\n') + '\n', 'utf8')
  console.log(`（明细已落 ${OUT}）`)
}
// 任一通道出现「补按都救不回」→ 非零退出，提醒这不只是「慢」而是会丢决策
process.exitCode = results.some(r => r.error || r.instances.some(st => st.unrecoverable > 0)) ? 1 : 0
