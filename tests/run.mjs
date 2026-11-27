#!/usr/bin/env node
/** M4/FR-5.2 编排器：npm test 一条命令跑核心链路自动化测试。
 *  用法：npm test [-- --only=S1,S3] [-- --with-flaky]
 *  套件：S1/S2/S10/S19/S20 单测(python) · S3 API 冒烟(隔离实例) · S4/S5/S6/S7/S8/S9/S11/S12 UI 冒烟(CDP+无头 Chrome)
 *       · S13/S14 桌面壳单测(node) · S15/S16 UI 冒烟(壳配置面/降级态) · S17 Electron 实机烟测 · S18 免安装产物冒烟，20 套全部默认纳入。
 *  T05688：内置 GitHub Releases 更新源默认启用，隔离实例统一用 WE_UPDATE_URL=off 关掉外网自动检测
 *  （否则 S12 的「检查更新」断言会被 10s 网络超时拖成假红）；要验在线链路显式传 WE_TEST_UPDATE_URL。
 *  S18 只在「已构建 release/win-unpacked」时才真判，产物没构建就整套 SKIP（原因逐条打印）；
 *  发布门 scripts/publish.ps1 里它排在 electron-builder 之后、上传之前，那里产物必定存在。
 *  （--with-flaky 为历史开关：S6 曾在 T01079 前被标 flaky 默认跳过，夹具改绝对路径后已转 default-on，现无套件挂 flaky。）
 *  S17 要真起 Electron 并驱动原生模态框（UIA + BM_CLICK），非 Windows／未装 dev-shell 依赖／无交互桌面时
 *  显式 SKIP 并打印原因（不能让它假失败拖红基线）；用 WE_SHELL_TEST=1 强制跑、=0 强制跳。
 *  另有独立 WCAG 对比度审计：python tests/a11y_contrast.py（FR-UI05，非 npm test 套件）。
 *  临时目录约定：跑测试只往 os.tmpdir() 里写 we_* 前缀的目录，跑完自动回收；
 *  要留着查现场就 WE_KEEP_TMP=1（届时也不会去收孤儿），手动清理见 README「测试临时目录」。
 *  ⚠ 须用带依赖的解释器：PYTHON="/f/Program Files/Python3.14/python" npm test
 *    （默认 python 缺 openpyxl，会导致 S3~S12 全部「API 实例未就绪」假失败）。 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reclaimStaleTmp, registerTmp, removeTmp } from './tmp_janitor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.env.PYTHON || 'python';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API_PORT = 8032, CDP_PORT = 9334;
const API = `http://127.0.0.1:${API_PORT}`;
const CDP = `http://127.0.0.1:${CDP_PORT}`;
const args = process.argv.slice(2);
const only = (args.find(a => a.startsWith('--only=')) || '').split('=')[1];
const withFlaky = args.includes('--with-flaky');
// 本轮夹具总目录：登记后即使被 Ctrl-C／看门狗打断也会补删（WE_KEEP_TMP=1 时保留查现场）
const TMP = registerTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'we_test_')));
const results = [];
const log = (...a) => console.log(...a);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const portFree = port => new Promise(res => {
  const s = net.createServer();
  s.once('error', () => res(false));
  s.once('listening', () => s.close(() => res(true)));
  s.listen(port, '127.0.0.1');
});
const killTree = pid => { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* noop */ } };

// T04125：Excel 重算实例是 COM 起的，不在 python 的进程树里，killTree(/T) 带不走它，
// 硬 kill sidecar 后它就变成钉住 generated/ 的孤儿。sidecar 把生命周期写进台账
// （`BEGIN <py>` / `PID <py> <excel>` / `NOPID <py>`，只有设了 WE_EXCEL_LEDGER 才写，生产不写）。
// 关键在 BEGIN：DispatchEx 会阻塞 5~15s，这期间 Excel 已经被 DCOM 拉起、PID 却还没人知道，
// 套件一跑完就杀 sidecar 正好落在这个窗口里（实测单跑 S3 必漏一个）——所以杀之前先有界地
// 等在飞的 Dispatch 报上 PID。回收本身只认台账里的 PID，且先确认它确实是 EXCEL.EXE
// （防 PID 复用），绝不按映像名杀——那会连带杀掉用户自己打开的 Excel。
const LEDGER = path.join(TMP, 'we_excel_ledger.txt');
const readLedger = () => {
  try { return fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/).map(l => l.trim().split(/\s+/)).filter(r => r.length); }
  catch { return []; }
};
const procAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const pendingDispatches = () => {
  const begun = new Map();
  for (const r of readLedger()) {
    if (r[0] === 'BEGIN') begun.set(r[1], (begun.get(r[1]) || 0) + 1);
    else if (r[0] === 'PID' || r[0] === 'NOPID') begun.set(r[1], Math.max(0, (begun.get(r[1]) || 0) - 1));
  }
  // sidecar 若在 Dispatch 途中就没了（被硬 kill／崩溃），这条 BEGIN 永远不会落地，
  // 再等下去只是白等满预算——按 python PID 判活，死了的不计入待等。
  let n = 0;
  for (const [pyPid, cnt] of begun) {
    if (cnt > 0 && procAlive(Number(pyPid))) n += cnt;
  }
  return n;
};
const settleLedger = async (maxMs = 25000) => {
  const t0 = Date.now();
  while (pendingDispatches() && Date.now() - t0 < maxMs) await sleep(500);
  return pendingDispatches() === 0;
};
const reapOwnedExcel = () => {
  const owned = readLedger().filter(r => r[0] === 'PID' && Number.isInteger(+r[2]) && +r[2] > 0);
  let n = 0;
  for (const [, , pidStr] of owned) {
    const pid = Number(pidStr);
    const t = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' });
    if (!/EXCEL\.EXE/i.test(t.stdout || '')) continue;
    spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
    n++;
  }
  if (n) log(`# 定向回收 sidecar 起的 Excel 实例 ${n} 个（按 PID，不碰用户自己的 Excel）`);
  return n;
};

function startServer(dataDir, port = API_PORT) {
  const token = ++serverToken;
  serverLog = '';
  serverExit = null;
  serverError = null;
  const p = spawn(PY, ['-u', 'scripts/server.py', String(port), '--serve-frontend'],
    { cwd: ROOT, env: { ...process.env, WE_DATA: dataDir, WE_EXCEL_LEDGER: LEDGER,
      // T05688：测试实例不访问外网；S19 自己起隔离实例验证内置源的在线/离线行为
      WE_UPDATE_URL: process.env.WE_TEST_UPDATE_URL || 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const grab = d => {
    if (serverToken !== token) return;   // 上一组被 kill 的实例可能在新实例启动后才吐最后几行，别污染本轮日志
    serverLog += d.toString();
    if (serverLog.length > 8000) serverLog = serverLog.slice(-8000);
  };
  p.stdout.on('data', grab); p.stderr.on('data', grab);
  // spawn 本身失败（EAGAIN/ENOENT 等）不会走 exit，只会发 error；不接住就会表现成
  // 「serverExit=null、serverLog 为空、等 30s 后 API 实例未就绪」。整机跑多个构建时实测出现过。
  p.once('error', e => { if (serverToken === token) serverError = e; });
  // 退出事件必须按「实例代次」归属，不能按 `server === p`：startServer() 返回前 `server`
  // 仍指向上一组，旧实例的 exit 恰在这时到达会把返回值写成新实例的 serverExit，下一组
  // waitHealth 第一轮就直接判死（2026-11-19：S5~S9/S12 间歇整组「API 实例未就绪」）。
  p.once('exit', code => { if (serverToken === token) serverExit = code; });
  return p;
}
const stopServer = async () => {
  if (!server) return;
  if (!(await settleLedger())) log('# 台账里有 Dispatch 迟迟未落地，本次不再等（可能有实例认领不到）');
  killTree(server.pid); server = null;
  // 端口释放要等实：上一组刚 kill 时 Windows 上偶发仍在 LISTEN（S12 曾因此整组报
  // 「API 实例未就绪」）。这里等到端口能重新 bind 再返回，下一组 startServer 才不会 EADDRINUSE。
  if (!(await waitPortFree(API_PORT, 8000))) {
    log(`# 端口 ${API_PORT} 在 8s 内未释放；下一组启动可能失败`);
  }
  reapOwnedExcel();
};
async function waitPortFree(port, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await portFree(port)) return true;
    await sleep(300);
  }
  return false;
}
async function waitHealth(timeoutMs = 120000) {
  // 120s 不是性能门：实测整机被别的构建压满时，`import server`（docx/openpyxl/datakeeper）
  // 单次就要 51.72s（2026-11-19 16:32 探针），30s 会让 UI 组整组假失败。正常机器 < 1s。
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (serverExit !== null || serverError !== null) return false;
    try {
      const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch { /* 未就绪 */ }
    await sleep(500);
  }
  return false;
}
const serverFailureDetail = () => {
  const tail = serverLog.split(/\r?\n/).filter(Boolean).slice(-4).join(' | ');
  const why = serverError ? `spawn ${serverError.code || ''} ${serverError.message || serverError}` :
    (serverExit !== null ? `server 退出码 ${serverExit}` : '');
  return `${why}${tail ? (why ? '；' : '') + tail : ''}`;
};
/** 起测试实例并等到 /health；失败时把 server 自己的 stderr / spawn error 带进异常，避免只报
 *  一句「API 实例未就绪」而看不到真正的 EADDRINUSE/导入错误。
 *  整机并发构建时实测 Windows 偶发进程创建失败（EAGAIN），故失败后清场重试一次。 */
async function startTestServer(dataDir) {
  let last = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(1500);
    if (!(await waitPortFree(API_PORT, 8000))) {
      last = `端口 ${API_PORT} 被占用，无法启动测试实例`;
      continue;
    }
    server = startServer(dataDir);
    if (await waitHealth()) return;
    last = serverFailureDetail();
    if (server && server.pid) killTree(server.pid);
    server = null;
  }
  throw new Error('API 实例未就绪' + (last ? '：' + last : ''));
}
async function startChrome(dataDir) {
  const p = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${dataDir}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'],
    { stdio: 'ignore' });
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    try { const r = await fetch(`${CDP}/json/version`); if (r.ok) return p; } catch { /* 未就绪 */ }
    await sleep(400);
  }
  throw new Error('Chrome CDP 未就绪');
}
function runSuite(cmd, cargs, env, timeoutMs = 300000) {
  return new Promise(res => {
    const p = spawn(cmd, cargs, { cwd: ROOT, env: { ...process.env, ...env } });
    let tail = '';
    const grab = d => { tail += d.toString(); if (tail.length > 8000) tail = tail.slice(-8000); };
    p.stdout.on('data', d => { process.stdout.write(d); grab(d); });
    p.stderr.on('data', d => { process.stderr.write(d); grab(d); });
    const killer = setTimeout(() => { try { killTree(p.pid); } catch { /* noop */ } }, timeoutMs);
    p.on('exit', code => { clearTimeout(killer); res({ code, tail }); });
  });
}

// 桌面会话能力探测（T03955）：S17 需要能真的看见并点原生模态框，缺任一条件都只能 skip。
// 返回 null 表示可跑，否则返回给用户看的跳过原因。
function desktopGate() {
  if (process.env.WE_SHELL_TEST === '1') return null;
  if (process.env.WE_SHELL_TEST === '0') return 'WE_SHELL_TEST=0 显式跳过实机烟测';
  if (process.platform !== 'win32') return `非 Windows（${process.platform}）：原生弹框/托盘驱动不可用`;
  const exe = path.join(ROOT, 'dev-shell', 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(exe)) return '未安装桌面壳依赖：先 cd dev-shell && npm install（缺 dev-shell/node_modules/electron）';
  // 服务会话/CI 里没有可交互窗口站，TaskDialog 弹不出来也点不到；explorer 在跑是最低门槛判据
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq explorer.exe', '/NH'], { encoding: 'utf8' });
  if (!/explorer\.exe/i.test(r.stdout || '')) return '当前会话无交互桌面（explorer.exe 未运行）：无法驱动原生模态框';
  return null;
}

const suites = [
  { id: 'S1', title: '识别规则表驱动单测（对拍/回退/坏正则）', kind: 'py', script: 'tests/unit_rules.py' },
  { id: 'S2', title: '引擎口径单测', kind: 'py', script: 'tests/unit_engine.py' },
  { id: 'S3', title: 'API 冒烟（隔离实例全链路）', kind: 'api', script: 'tests/api_smoke.py' },
  { id: 'S4', title: 'UI 冒烟（四图+导出管线）', kind: 'ui', script: 'tests/ui_smoke.mjs' },
  { id: 'S5', title: 'UI M3（表格增强+规则沉淀）', kind: 'ui', script: 'tests/ui_m3.mjs' },
  { id: 'S6', title: 'UI 进度/失败/超时（T01079 已闭环：夹具改绝对路径，2026-10-10 起 default-on）', kind: 'ui', script: 'tests/ui_progress.mjs' },
  { id: 'S7', title: 'UI 版本 diff 对比（FR-FE05）', kind: 'ui', script: 'tests/ui_diff.mjs' },
  { id: 'S8', title: 'UI 主题色定制（FR-TH02）', kind: 'ui', script: 'tests/ui_theme.mjs', env: { PYTHON: PY } },
  { id: 'S9', title: 'UI 键盘可完成主链路（FR-UI05）', kind: 'ui', script: 'tests/ui_a11y_keyboard.mjs' },
  { id: 'S10', title: '命令行/无人值守模式（FR-FE10）', kind: 'py', script: 'tests/unit_cli.py' },
  { id: 'S11', title: 'UI 动效/骨架屏/空态插画（FR-UI04/UI07）', kind: 'ui', script: 'tests/ui_motion.mjs' },
  { id: 'S12', title: 'UI 界面多语言（FR-5.5）', kind: 'ui', script: 'tests/ui_i18n.mjs' },
  { id: 'S13', title: '桌面壳窗口偏好存储单测（T03779）', kind: 'node', script: 'tests/unit_window_prefs.mjs' },
  { id: 'S14', title: '桌面壳文案双语单测（T03957）', kind: 'node', script: 'tests/unit_shell_i18n.mjs' },
  { id: 'S15', title: 'UI 配置中心「窗口行为」卡片（T03779）', kind: 'ui', script: 'tests/ui_window_behavior.mjs' },
  { id: 'S16', title: 'UI 配置中心降级态（T03956）', kind: 'ui', script: 'tests/ui_rates_unavail.mjs' },
  // 实机烟测：自己起 Electron（不占 8032/9334），8 个场景轮转启动+真点弹框。
  // 空载实测 1m37s，但本机多会话并发时退出链能被拖到 20s+/场景，故预算给到 15min，
  // 并把用例内自杀看门狗同步抬高——否则负载下它会先把自己判死，基线出现假红。
  { id: 'S17', title: 'Electron 关闭行为实机烟测（需桌面会话）', kind: 'shell', script: 'tests/shell_close_smoke.mjs',
    env: { WE_SHELL_WATCHDOG_MS: '840000' }, timeoutMs: 900000 },
  // 免安装产物冒烟（T04014）：装包态才成立的三条前提（extraResources 的托盘 ico、asar 里的
  // window-prefs.js、sidecar 是 exe）S1~S17 都守不住——回归全绿仍可能交付打不开/图标不对的包。
  // 不进 desktopGate：它跳过与否取决于「产物是否已构建」，脚本自己逐条判并打印原因，缺什么就 SKIP 什么。
  { id: 'S18', title: '免安装产物冒烟（T04014，需 release/win-unpacked）', kind: 'node',
    script: 'tests/prod_smoke.mjs', timeoutMs: 900000 },
  // T05688：内置更新源默认启用后，必须有离线用例守住「默认地址/覆盖/停用/Release 解析」
  { id: 'S19', title: '内置 GitHub 更新源单测（T05688）', kind: 'py',
    script: 'tests/unit_update_source.py', timeoutMs: 180000 },
  // 一键发布前置检查（对齐 AirMirror 一键发布.bat）：静态守卫 + 临时沙箱并行实跑 bat/ps1，
  // 发布器换 stub 隔断真实 GitHub。4 个 -PreflightOnly 分支 + 1 条完整 DryRun 链路；
  // 沙箱里每个外部进程都有秒级固定开销，故给足预算（实测并行约 4min）。
  { id: 'S20', title: '一键发布前置检查离线回归', kind: 'py',
    script: 'tests/unit_publish_precheck.py', timeoutMs: 900000 },
];

let server = null, chrome = null, serverLog = '', serverExit = null, serverError = null, serverToken = 0;
async function cleanup() {
  await stopServer();
  if (chrome) { killTree(chrome.pid); chrome = null; }
  // 端口回收确认：占用的 python/chrome 子树已随 killTree 终止
  process.exitCode = results.some(r => !r.ok) ? 1 : 0;
}

process.on('exit', () => {
  if (server) killTree(server.pid)
  if (chrome) killTree(chrome.pid)
  reapOwnedExcel()
})
process.on('SIGINT', async () => { await cleanup(); process.exit(130) })
process.on('SIGTERM', async () => { await cleanup(); process.exit(130) })

// 主体改用顶层 await（S7785：不再用 async IIFE）
{
  log(`# 核心链路自动化测试（M4/FR-5.2） ${new Date().toLocaleString('zh-CN')}`);
  // 开跑前收一次：上一轮记下的钉子户 + 上一轮硬 kill 留下的超龄孤儿
  // （runSuite 超时用 taskkill /F，子进程钩子不会跑，只能靠这道门兜）
  const jan = reclaimStaleTmp();
  if (jan.removed || jan.stuck) log(`# 临时目录回收：清掉 ${jan.removed} 个` +
    (jan.listed ? `（其中上一轮记名 ${jan.listed} 个）` : '') +
    (jan.stuck ? `，${jan.stuck} 个仍被占用` : '') + `（保留 ${jan.keptFresh} 个未超龄）`);
  log(`# 夹具: ${ROOT}/data/testdocs · 临时数据: ${TMP} · flaky: ${withFlaky ? '开启' : '跳过'}\n`);
  for (const port of [API_PORT, CDP_PORT]) {
    if (!(await portFree(port))) { log(`端口 ${port} 被占用，请先释放（避免双监听）`); process.exit(2); }
  }
  // 分层：--only 选中的才进队列；跑不了的（flaky 开关、实机烟测缺桌面）进 skipped 并保留原因
  const shellSkip = desktopGate();
  const list = [], skipped = [];
  for (const s of suites) {
    if (only && !only.split(',').includes(s.id)) continue;
    if (s.flaky && !withFlaky) { skipped.push({ s, why: 'flaky（--with-flaky 开启）' }); continue; }
    if (s.kind === 'shell' && shellSkip) { skipped.push({ s, why: shellSkip }); continue; }
    list.push(s);
  }
  for (const s of list) {
    log(`\n== ${s.id} ${s.title} ==`);
    let code = 1;
    try {
      if (s.kind === 'py') {
        ({ code } = await runSuite(PY, [s.script], {}, s.timeoutMs));
      } else if (s.kind === 'api') {
        const dataDir = path.join(TMP, s.id.toLowerCase(), 'data');
        fs.mkdirSync(dataDir, { recursive: true });
        await startTestServer(dataDir);
        ({ code } = await runSuite(PY, [s.script, String(API_PORT)], {}, s.timeoutMs));
        await stopServer();
      } else if (s.kind === 'node' || s.kind === 'shell') {
        // 脚本自带运行环境：壳单测纯 node 即可，实机烟测自己起 Electron（不共用 8032 实例/CDP Chrome）
        ({ code } = await runSuite(process.execPath, [s.script], { ...s.env }, s.timeoutMs));
      } else if (s.kind === 'ui') {
        if (!chrome) chrome = await startChrome(path.join(TMP, 'chrome'));
        const dataDir = path.join(TMP, s.id.toLowerCase(), 'data');
        fs.mkdirSync(dataDir, { recursive: true });
        await startTestServer(dataDir);
        ({ code } = await runSuite(process.execPath, [s.script], { WE_DATA: dataDir, ...s.env }, s.timeoutMs));
        await stopServer();
      }
    } catch (e) {
      log(`  FAIL  套件异常: ${e.message}`);
      code = 1;
    } finally {
      await stopServer();
    }
    const ok = code === 0;
    results.push({ id: s.id, title: s.title, ok, skipped: false });
    log(`== ${s.id} ${ok ? '全绿' : '失败'} ==\n`);
  }
  for (const { s, why } of skipped) {
    results.push({ id: s.id, title: s.title, ok: true, skipped: true, why });
    log(`== ${s.id} SKIP（${why}）==`);
  }
  await cleanup();

  const repRows = results.map(r => {
    const why = r.why ? `（跳过原因：${r.why}）` : ''
    return `| ${r.id} | ${r.title}${why} | ${r.skipped ? 'SKIP' : r.ok ? 'PASS' : '**FAIL**'} | |`
  })
  const rep = ['# 核心链路自动化测试报告', `${new Date().toLocaleString('zh-CN')}`, '',
    '| 套件 | 说明 | 结果 |', '|---|---|---|',
    ...repRows, ''];
  const repPath = path.join(ROOT, 'logs', `test_report_${Date.now()}.md`);
  fs.writeFileSync(repPath, rep.join('\n'));
  log(`\n==== 汇总 ==== 通过 ${results.filter(r => r.ok && !r.skipped).length}/${results.filter(r => !r.skipped).length}` +
    `（skip ${results.filter(r => r.skipped).length}）报告: ${path.relative(ROOT, repPath)}`);
  // 汇总之后才回收：留着 TMP 到这一步是为了失败时还能翻现场，报完数就该还给机器
  if (process.env.WE_KEEP_TMP === '1') log(`# WE_KEEP_TMP=1，保留临时目录: ${TMP}`);
  else if (removeTmp(TMP)) log('# 临时目录已回收');
  else log('# 主夹具没删净：已记名，下一轮开跑先收（持有者见上面那条 WARN 的 RM 取证）；手动清法见 README「测试临时目录」');
}
