#!/usr/bin/env node
/** M4/FR-5.2 编排器：npm test 一条命令跑核心链路自动化测试。
 *  用法：npm test [-- --only=S1,S3] [-- --with-flaky]
 *  套件：S1/S2/S10 单测(python) · S3 API 冒烟(隔离实例) · S4/S5/S6/S7/S8/S9/S11/S12 UI 冒烟(CDP+无头 Chrome)
 *       · S13/S14 桌面壳单测(node) · S15/S16 UI 冒烟(壳配置面/降级态) · S17 Electron 实机烟测 · S18 免安装产物冒烟，18 套全部默认纳入。
 *  S18 只在「已构建 release/win-unpacked」时才真判，产物没构建就整套 SKIP（原因逐条打印）；
 *  发布门 scripts/publish.ps1 里它排在 electron-builder 之后、上传之前，那里产物必定存在。
 *  （--with-flaky 为历史开关：S6 曾在 T01079 前被标 flaky 默认跳过，夹具改绝对路径后已转 default-on，现无套件挂 flaky。）
 *  S17 要真起 Electron 并驱动原生模态框（UIA + BM_CLICK），非 Windows／未装 dev-shell 依赖／无交互桌面时
 *  显式 SKIP 并打印原因（不能让它假失败拖红基线）；用 WE_SHELL_TEST=1 强制跑、=0 强制跳。
 *  另有独立 WCAG 对比度审计：python tests/a11y_contrast.py（FR-UI05，非 npm test 套件）。
 *  ⚠ 须用带依赖的解释器：PYTHON="/f/Program Files/Python3.14/python" npm test
 *    （默认 python 缺 openpyxl，会导致 S3~S12 全部「API 实例未就绪」假失败）。 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.env.PYTHON || 'python';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API_PORT = 8032, CDP_PORT = 9334;
const API = `http://127.0.0.1:${API_PORT}`;
const CDP = `http://127.0.0.1:${CDP_PORT}`;
const args = process.argv.slice(2);
const only = (args.find(a => a.startsWith('--only=')) || '').split('=')[1];
const withFlaky = args.includes('--with-flaky');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'we_test_'));
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

function startServer(dataDir, port = API_PORT) {
  const p = spawn(PY, ['-u', 'scripts/server.py', String(port), '--serve-frontend'],
    { cwd: ROOT, env: { ...process.env, WE_DATA: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.resume(); p.stderr.resume();
  return p;
}
async function waitHealth(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`${API}/health`); if (r.ok) return true; } catch { /* 未就绪 */ }
    await sleep(500);
  }
  return false;
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
];

let server = null, chrome = null;
async function cleanup() {
  if (server) { killTree(server.pid); server = null; }
  if (chrome) { killTree(chrome.pid); chrome = null; }
  // 端口回收确认：占用的 python/chrome 子树已随 killTree 终止
  process.exitCode = results.some(r => !r.ok) ? 1 : 0;
}

process.on('exit', () => { if (server) killTree(server.pid); 
if (chrome) killTree(chrome.pid); });
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, async () => { await cleanup(); process.exit(130); }));

// 主体改用顶层 await（S7785：不再用 async IIFE）
{
  log(`# 核心链路自动化测试（M4/FR-5.2） ${new Date().toLocaleString('zh-CN')}`);
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
        server = startServer(dataDir);
        if (!(await waitHealth())) throw new Error('API 实例未就绪');
        ({ code } = await runSuite(PY, [s.script, String(API_PORT)], {}, s.timeoutMs));
        killTree(server.pid); server = null;
        await sleep(800);
      } else if (s.kind === 'node' || s.kind === 'shell') {
        // 脚本自带运行环境：壳单测纯 node 即可，实机烟测自己起 Electron（不共用 8032 实例/CDP Chrome）
        ({ code } = await runSuite(process.execPath, [s.script], { ...s.env }, s.timeoutMs));
      } else if (s.kind === 'ui') {
        if (!chrome) chrome = await startChrome(path.join(TMP, 'chrome'));
        const dataDir = path.join(TMP, s.id.toLowerCase(), 'data');
        fs.mkdirSync(dataDir, { recursive: true });
        server = startServer(dataDir);
        if (!(await waitHealth())) throw new Error('API 实例未就绪');
        ({ code } = await runSuite(process.execPath, [s.script], { WE_DATA: dataDir, ...(s.env || {}) }, s.timeoutMs));
        killTree(server.pid); server = null;
        await sleep(800);
      }
    } catch (e) {
      log(`  FAIL  套件异常: ${e.message}`);
      code = 1;
    } finally {
      if (server) { killTree(server.pid); server = null; }
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

  const rep = ['# 核心链路自动化测试报告', `${new Date().toLocaleString('zh-CN')}`, '',
    '| 套件 | 说明 | 结果 |', '|---|---|---|',
    ...results.map(r => `| ${r.id} | ${r.title}${r.why ? `（跳过原因：${r.why}）` : ''} | ${r.skipped ? 'SKIP' : r.ok ? 'PASS' : '**FAIL**'} | |`), ''];
  const repPath = path.join(ROOT, 'logs', `test_report_${Date.now()}.md`);
  fs.writeFileSync(repPath, rep.join('\n'));
  log(`\n==== 汇总 ==== 通过 ${results.filter(r => r.ok && !r.skipped).length}/${results.filter(r => !r.skipped).length}` +
    `（skip ${results.filter(r => r.skipped).length}）报告: ${path.relative(ROOT, repPath)}`);
}
