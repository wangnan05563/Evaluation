/** T04505 原生弹框「投递通道」探针：量化合成点击被 TaskDialog 吞掉的比率。
 *
 *  为什么不进回归：这是一把量尺，不是一道断言。它跑一次要几十次真点击原生弹框，
 *  结论（各通道的吞按率）写进 tests/shell_close_smoke.mjs 头注释与
 *  docs/设计-数据与运维.md 关键决策第 7 条，回归里只保留「按投递结果补按」的打法。
 *  因此本文件刻意不登记进 tests/run.mjs。
 *
 *  用法（仓库根目录）：
 *    node tests/tools/native_dialog_probe.mjs --modes 0,1,2,3 --rounds 15 --out logs/t04505/probe.log
 *  四种通道（tests/win_dialog.mjs 的 -Mode）：
 *    0 = BM_CLICK（SendMessageTimeoutW，现行驱动打法）
 *    1 = UIA InvokePattern.Invoke()（COM CUIAutomation8）
 *    2 = UIA LegacyIAccessible.DoDefaultAction()（同上，pattern id 10015）
 *    3 = 先 SetForegroundWindow+SetFocus 再 BM_CLICK（T04475 只有 8 次样本的那条参照）
 *
 *  判据口径与 T04475 一致，不看任何返回值，只看两件事：
 *    · 驱动侧：按完后 IsWindow(对话框句柄) 是否变 false（驱动输出的 DIALOG_AFTER=no|yes）
 *    · 产品侧：本进程有没有落 [close-dialog] resolved / [close] action 行
 *  首按没接住时算一次「吞按」，并当场补按把弹框关掉（保证下一轮从干净状态开始），
 *  补按是否救回也逐轮记录——「吞了但补得回来」和「吞了且救不回」是两回事。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeLauncher, requestClose, killTree, sleep } from '../electron_cdp.mjs'
import { removeTmp } from '../tmp_janitor.mjs'
import { driveDialog, probeWindow } from '../win_dialog.mjs'

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
const MODE_NAMES = { 0: 'bm_click', 1: 'uia_invoke', 2: 'legacy_iaccessible', 3: 'foreground_focus' }
// 「通道压根发不出点击」连续这么多轮就提前收轮（省时间）；要按「每种打法各 ≥15 次」出报告时，
// 用 --noClickStop 999 跑满轮次——发不出去本身就是要记进文档的数字，不能被提前收轮藏掉。
const NO_CLICK_STOP = Number(argv('noClickStop', 999))
// 第二条判据的宽限窗（只探针用，回归仍按 700ms 内 IsWindow 判定）。
// 为什么要两条口径：DIALOG_AFTER=yes 有两种形状——「这一按真被吞」和「销毁已经排队、只是慢」。
// 只报严格口径会把后者算进吞按率，结论就没法和产品侧的 [close] action 行对上。
const GRACE_MS = Number(argv('graceMs', 2000))

const lines = []
const say = s => { lines.push(s); console.log(s) }
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
    uia: out.split(/\r?\n/).filter(l => l.startsWith('UIA_')).join(' | ')
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

async function runMode(mode, port) {
  const name = MODE_NAMES[mode] || `mode${mode}`
  say(`\n=== 通道 ${mode} ${name} —— ${ROUNDS} 轮 ===`)
  const s = await scenario(`probe_m${mode}`, port, null)
  if (!s.ok) { say(`  启动失败：${s.detail}`); return { mode, name, error: s.detail } }
  const pid = s.child.pid
  const stats = { mode, name, pid, rounds: 0, shown: 0, resolved: 0, dropped: 0, rescued: 0, unrecoverable: 0, noDialog: 0, noClick: 0, settles: [], uiainfo: '' }

  for (let r = 1; r <= ROUNDS; r++) {
    if (s.child.exitCode !== null) { say(`  第 ${r} 轮：应用进程已退出，停止本通道`); break }
    const before = readStr(SHELL_LOG)
    requestClose(pid)
    // 一次调用做完「等弹框出现 + 按第 TRAY_BUTTON 个按钮」：驱动内部定位到对话框后立刻按，
    // 等价于 S17/装包烟测里的真实打法，不给「等一等再按」留余地（T04475 已证延时防不住）。
    const clickRaw = driveDialog(pid, { button: TRAY_BUTTON, mode, waitMs: 20000, graceMs: GRACE_MS })
    const click = parseOut(clickRaw.out)
    const shownNew = ownCount(readStr(SHELL_LOG), '[close-dialog] shown', pid) - ownCount(before, '[close-dialog] shown', pid)
    if (!click.found) {
      // not_found 有两种形状：弹框压根没弹出来（shown 也没落），或弹出来又被别的东西收掉了。
      // 用本进程自己的 shown 行分开，别把驱动的手忙脚乱算成产品行为。
      stats.noDialog++
      say(`  第 ${r} 轮：驱动没找到对话框（${click.notFound ? 'not_found' : '超时'}）；本进程 shown=${shownNew} —— 不计入吞按率`)
      if (shownNew > 0) stats.shown += shownNew
      // 补一次「清场」：not_found 也可能是模态框还挂着、只是这一轮驱动没找着它。
      // 挂着不清会导致之后每一轮的 WM_CLOSE 都被模态吞掉（实测通道 2 第 2~5 轮全废），
      // 所以这里按投递判据再试两次把可能存在的弹框收掉，收掉的动作不计入任何通道结论。
      for (let k = 0; k < 2; k++) {
        const clr = parseOut(driveDialog(pid, { button: TRAY_BUTTON, mode: 0 }).out)
        if (clr.delivered || clr.notFound) break
      }
      await waitWindowHidden(pid, 8)
      continue
    }
    if (!stats.uiainfo && click.uia) stats.uiainfo = click.uia
    if (shownNew > 0) stats.shown += shownNew
    // 「这一按被吞」和「这一按压根没发出去」是两件事：后者（UIA 拿不到 pattern）不能算进吞按率，
    // 否则会把「通道不可用」读成「通道 100% 不可靠」。发不出点击的轮次单列 noClick。
    if (!click.issued) {
      stats.noClick++
      const landed0 = await waitOwnLine(before, '[close] action=', pid)
      say(`  第 ${r} 轮：${click.channel} 发不出点击（INVOKE=${click.invoke}）；不计入吞按率；主进程收到决策=${landed0 ? '是' : '否'}`)
      say(`      RAW: ${clickRaw.out.replace(/\n/g, ' ⏎ ')}`)
      // 用现行可用的 BM_CLICK 把弹框关掉，保证下一轮从干净状态开始（不计入本通道结论）
      let clean = null
      for (let k = 0; k < 2; k++) {
        clean = parseOut(driveDialog(pid, { button: TRAY_BUTTON, mode: 0 }).out)
        if (clean.delivered || clean.notFound) break
      }
      await waitWindowHidden(pid)
      if (stats.noClick >= NO_CLICK_STOP) {
        say(`  通道 ${name}：连续 ${stats.noClick} 轮都发不出点击，按 --noClickStop=${NO_CLICK_STOP} 提前收轮`)
        break
      }
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
  }

  killTree(pid)
  try { s.ws.close() } catch { /* noop */ }
  await sleep(1200)
  removeTmp(s.base)
  const median = a => { const v = [...a].sort((x, y) => x - y); return v.length ? v[Math.floor((v.length - 1) / 2)] : null }
  say(`  小结 ${name}：${pct(stats.dropped, stats.rounds)} 首按被吞，` +
    `其中补按救回 ${stats.rescued} 次、救不回 ${stats.unrecoverable} 次；` +
    `发不出点击 ${stats.noClick} 轮、弹框未出现 ${stats.noDialog} 轮；主进程收到决策 ${stats.resolved}/${stats.rounds}` +
    `（shown ${stats.shown} 次）` +
    `${stats.settles.length ? `；接住耗时 min/中位/max = ${Math.min(...stats.settles)}/${median(stats.settles)}/${Math.max(...stats.settles)}ms` : ''}`)
  if (stats.uiainfo) say(`  UIA 侧自证：${stats.uiainfo}`)
  return stats
}

const results = []
for (let i = 0; i < MODES.length; i++) {
  results.push(await runMode(MODES[i], BASE_PORT + i))
  await sleep(1500)
}
say('\n=== 汇总 ===')
for (const r of results) {
  if (r.error) { say(`  ${r.name}: 启动失败`); continue }
  say(`  ${r.mode} ${r.name}: 有效轮次=${r.rounds} 首按吞按率=${pct(r.dropped, r.rounds)} 补按救回=${r.rescued} 救不回=${r.unrecoverable} 发不出点击=${r.noClick} 决策落地=${r.resolved}/${r.rounds}`)
}
say('  口径：投递只看 IsWindow(对话框) 变 false；主进程侧只看本进程 [close] action 行。')
if (OUT) {
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true })
  fs.writeFileSync(path.resolve(OUT), lines.join('\n') + '\n', 'utf8')
  console.log(`（明细已落 ${OUT}）`)
}
// 任一通道出现「补按都救不回」→ 非零退出，提醒这不只是「慢」而是会丢决策
process.exitCode = results.some(r => r.unrecoverable > 0 || r.error) ? 1 : 0
