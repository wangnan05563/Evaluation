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
 *  ⚠ WARN 里的归因只报实测持有者（holdersOf → Restart Manager），不报猜测：
 *    以前那句「多为 Excel 重算实例仍占着 generated/」是猜的，T04451 那一轮根本不是 Excel。
 *  ⚠ 重试预算不能拍脑袋加长：本机 probe_chrome_settle 实测「headless Chrome 被
 *    taskkill /T /F 之后连续重试 30s（52 次）仍 EPERM，约 1 分钟后才可删」——
 *    tasklist 里已经没有一个 chrome.exe，锁仍在。所以加长同步步长在「删干净」之前
 *    先把回归拖长，这里选小额重试 + 交给下一轮，而不是就地死等。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// —— 句柄归属取证（T04451）——
// 「删不掉是因为谁」以前是猜的（「多为 Excel 重算实例」），猜错的归因会把人往错的方向引
// （实测那一轮机器上已经没有我们起的存活 Excel，被钉住的却是 Chrome/Electron 的弹框目录）。
// 这里改问 Windows 自己：Restart Manager（rstrtmgr.dll）按路径报出持有开放句柄的进程，
// 与安装程序「文件被占用」提示同源，不需要管理员权限，也不需要 Sysinternals handle.exe。
// 局限照实说：RM 只认「文件」，目录对象上的句柄它看不见；跨会话/受保护进程也可能不报。
// 所以查不到时报「未查到」，绝不回填一个猜测。
// 本机实测（scratch/check_warn）：PowerShell 以 FileShare.None 独占 generated/ 里的文件时
// unlink→EBUSY、rmSync→EPERM，holdersOf 如实报出 `pid=<持有者> Windows/RmConsole`，
// 持有者退出后再删即成功；无人持有时报「RM 未报持有者」而不是编一个名字出来。
const RM_PS = String.raw`param(
  [Parameter(Mandatory = $true)][string]$ListFile
)
$ErrorActionPreference = 'Continue'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class RM {
  [StructLayout(LayoutKind.Sequential)]
  public struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  public enum RM_APP_TYPE { RmUnknownApp = 0, RmMainWindow = 1, RmOtherWindow = 2, RmService = 3, RmExplorer = 4, RmConsole = 5, RmCritical = 1000 }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public RM_APP_TYPE ApplicationType; public uint AppStatus; public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmStartSession(out uint session, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmRegisterResources(uint session, uint nFiles, string[] files,
    uint nApps, RM_UNIQUE_PROCESS[] apps, uint nSvcs, string[] svcs);
  [DllImport("rstrtmgr.dll")]
  static extern int RmGetList(uint session, out uint needed, ref uint count,
    [In, Out] RM_PROCESS_INFO[] info, ref uint reasons);
  static string Esc(string s) {
    StringBuilder o = new StringBuilder();
    foreach (char c in (s ?? "")) {
      if (c >= 32 && c < 127 && c != '"') o.Append(c);
      else o.Append("\\u").Append(((int)c).ToString("x4"));
    }
    return o.ToString();
  }
  public static List<string> Probe(string[] paths) {
    List<string> res = new List<string>();
    if (paths.Length == 0) { res.Add("NOTHING_TO_ASK"); return res; }
    uint session = 0; StringBuilder key = new StringBuilder(65);
    int rc = RmStartSession(out session, 0, key);
    if (rc != 0) { res.Add("RM_START=" + rc); return res; }
    try {
      rc = RmRegisterResources(session, (uint)paths.Length, paths, 0, null, 0, null);
      if (rc != 0) { res.Add("RM_REGISTER=" + rc); return res; }
      uint needed = 0, count = 0, reasons = 0;
      rc = RmGetList(session, out needed, ref count, null, ref reasons);
      if (rc == 0) { res.Add("HOLDER_COUNT=0"); return res; }
      if (rc != 234) { res.Add("RM_PROBE=" + rc); return res; }   // 234 = ERROR_MORE_DATA
      RM_PROCESS_INFO[] arr = new RM_PROCESS_INFO[needed];
      count = needed; reasons = 0; needed = 0;
      rc = RmGetList(session, out needed, ref count, arr, ref reasons);
      if (rc != 0) { res.Add("RM_LIST=" + rc); return res; }
      res.Add("HOLDER_COUNT=" + count);
      for (int i = 0; i < (int)count; i++)
        res.Add("HOLDER pid=" + arr[i].Process.dwProcessId + " name=" + Esc(arr[i].strAppName) +
                " type=" + arr[i].ApplicationType + " restartable=" + arr[i].bRestartable);
    } finally { RmEndSession(session); }
    return res;
  }
}
"@
$paths = [string[]]@(Get-Content -LiteralPath $ListFile | Where-Object { $_.Length -gt 0 })
try {
  foreach ($line in [RM]::Probe($paths)) { Write-Output $line }
} catch {
  # RM 侧任何异常都只报类型名：诊断文本里可能带非 ASCII，GBK 控制台会把字节毁掉
  Write-Output ('RM_THROWN=' + $_.Exception.GetType().Name)
}
`
const unescU = s => { try { return JSON.parse('"' + s + '"') } catch { return s } }
const RM_FILES_RE = /^we_rm_(holders|list)_\d+\.(ps1|txt)$/
let rmScript = null
const rmScriptPath = () => {
  if (!rmScript) {
    rmScript = path.join(os.tmpdir(), `we_rm_holders_${process.pid}.ps1`)
    // BOM：Windows PowerShell 5.1 无 BOM 时脚本内容解析不稳（同 tests/win_dialog.mjs）
    fs.writeFileSync(rmScript, '\ufeff' + RM_PS)
  }
  return rmScript
}
/** 取目录里最新动过的若干文件路径：把目录钉住的多半是刚写过的那个，
 *  RM 又只认文件不认目录，所以给它的是一份文件清单（不是目录名）。 */
function sampleFiles(dir, cap = 40, maxScan = 800) {
  const found = []
  let scanned = 0
  const walk = (d, depth) => {
    if (scanned > maxScan || depth > 4) return
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (scanned > maxScan) return
      const full = path.join(d, e.name)
      scanned++
      if (e.isDirectory()) walk(full, depth + 1)
      else {
        let m = 0
        try { m = fs.statSync(full).mtimeMs } catch { /* 当作最旧 */ }
        found.push([m, full])
      }
    }
  }
  walk(dir, 0)
  return found.sort((a, b) => b[0] - a[0]).slice(0, cap).map(([, p]) => p)
}
/** 谁正持有这个目录里的文件：返回一行可直接拼进日志的描述，查不到/不适用返回 ''。
 *  只在「当场删不掉」这条支路上跑（一次 PowerShell 冷启动约 1~2s），退出钩子里不调用它。 */
export function holdersOf(dir) {
  try {
    const files = sampleFiles(dir)
    if (!files.length) return '(目录里没有文件——钉住的是目录对象本身，RM 查不到)'
    const listFile = path.join(os.tmpdir(), `we_rm_list_${process.pid}.txt`)
    fs.writeFileSync(listFile, files.join('\r\n') + '\r\n')
    try {
      const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', rmScriptPath(), '-ListFile', listFile], { encoding: 'utf8', timeout: 20000 })
      const lines = (r.stdout || '').replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean)
      const count = (lines.find(l => l.startsWith('HOLDER_COUNT=')) || '').split('=')[1]
      const holders = lines.filter(l => l.startsWith('HOLDER pid='))
        .map(l => {
          const pid = (l.match(/pid=(\d+)/) || [])[1]
          const name = unescU((l.match(/name=(\S+)/) || [])[1] || '')
          const type = (l.match(/type=(\S+)/) || [])[1]
          return `pid=${pid} ${name || '?'}${type && type !== 'RmUnknownApp' ? '/' + type : ''}`
        })
      if (holders.length) return `${holders.length} 个进程持有（探测 ${files.length} 个文件）：${[...new Set(holders)].join('、')}`
      if (count === '0') return `RM 未报持有者（探测 ${files.length} 个文件；句柄可能属于其它会话或目录对象本身）`
      return `RM 未给出持有者（${lines[0] || '无输出'}${r.stderr ? ' / ' + String(r.stderr).trim().slice(0, 120) : ''}）`
    } finally { try { fs.rmSync(listFile, { force: true }) } catch { /* noop */ } }
  } catch (e) {
    return `RM 查询失败（${e.code || e.message}）`
  }
}

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
 *  真删不掉的才走 WARN + 记名 + 下一轮收，WARN 里由 holdersOf() 当场问出持有者（T04451）。 */
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
  if (!quiet) {
    // 归属当场取证：句柄松开是几十秒级的事，等到下一轮再查已经查不到这一轮的持有者了
    console.log(`  WARN 临时目录未能回收: ${dir}（${last.code || last.message}） 持有者：${holdersOf(dir) || '未查'}`)
  }
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
  const flush = () => {
    for (const d of [...registered]) removeTmp(d, { quiet: true, tries: 3, waitMs: 250 })
    if (rmScript) { try { fs.rmSync(rmScript, { force: true }) } catch { /* 归因脚本删不掉有超龄门兜底 */ } }
  }
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
    const full = path.join(os.tmpdir(), e.name)
    if (!e.isDirectory()) {
      // holdersOf 的归因脚本每次进程落一个 we_rm_holders_<pid>.ps1；下面那道门只看目录，
      // 不管文件，所以在这里按同样的龄期顺手收掉，不然跑几十轮就往 temp 堆几十个脚本。
      // 只认自己这两个前缀，别把 we_tmp_stuck.json（名单）之类误伤。
      if (RM_FILES_RE.test(e.name) && newestMtime(full) <= cutoff) {
        try { fs.rmSync(full, { force: true }); out.removed++ } catch { out.stuck++ }
      }
      continue
    }
    if (!e.name.startsWith('we_')) continue
    if (newestMtime(full) > cutoff) { out.keptFresh++; continue }
    removeTmp(full, { quiet: true }) ? out.removed++ : out.stuck++
  }
  return out
}
