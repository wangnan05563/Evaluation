/** 三期验证编排器：隔离实例 8033 + 无头 Chrome 9335，顺序跑 phase3 UI 套件。
 *  默认启用 GPU 合成（AC-03 帧率口径）；PHASE3_CPU=1 退回纯 CPU 对照，PHASE3_HEADED=1 用有头窗口。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PY = process.env.PYTHON || 'F:\\Program Files\\Python3.14\\python.exe';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API_PORT = 8033, CDP_PORT = 9335, API = `http://127.0.0.1:${API_PORT}`, CDP = `http://127.0.0.1:${CDP_PORT}`;
const OUT = path.join(ROOT, 'docs', 'test-reports', 'phase3-20261122');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'we_phase3_'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const killTree = pid => { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* noop */ } };
let server = null, chrome = null, log = '';

const suites = [
  // T06177 性能与视觉回归基线：必须在共享实例仅有干净数据时先建立/比对，避免其他套件写入最近文档影响首屏截图。
  { id: 'regression-baseline', script: 'tests/phase3/regression_baseline.mjs', timeout: 180000 },
  // a11y 的 200% 缩放必须在 10k 全页截图之前跑：Chrome 157 在 44 万像素高截图后
  // 会在同一 profile 遗留视口状态，使后续 200% 度量稳定偏宽（doc=796、4 控件裁切）。
  { id: 'a11y-wcag22', script: 'tests/phase3/ui_a11y_wcag22.mjs', timeout: 180000 },
  { id: '10k-grid', script: 'tests/phase3/ui_10k_grid.mjs', timeout: 180000 },
  { id: 'edit-resilience', script: 'tests/phase3/ui_edit_resilience.mjs', timeout: 120000 },
  { id: 'theme-tokens', script: 'tests/phase3/ui_theme_tokens.mjs', timeout: 120000 },
  { id: 'ui-kit', script: 'tests/phase3/ui_ui_kit.mjs', timeout: 120000 },
  { id: 'calibration', script: 'tests/phase3/ui_calibration.mjs', timeout: 120000 },
  { id: 'montecarlo', script: 'tests/phase3/ui_montecarlo.mjs', timeout: 180000 },
  { id: 'ifpug-complexity', script: 'tests/phase3/ui_ifpug_complexity.mjs', timeout: 120000 },
  { id: 'stable-ids', script: 'tests/phase3/ui_stable_ids.mjs', timeout: 180000 },
  { id: 'data-migration', script: 'tests/phase3/ui_migration.mjs', timeout: 180000 },
  { id: 'i18n-pseudo', script: 'tests/phase3/ui_i18n_pseudo.mjs', timeout: 120000 },
  { id: 'single-machine', script: 'tests/phase3/ui_single_machine.mjs', timeout: 120000 },
  { id: 'empty-error', script: 'tests/phase3/ui_empty_error.mjs', timeout: 120000 },
  { id: 'proto-rowpool', script: 'tests/phase3/proto_10k_rowpool.mjs', timeout: 120000, proto: true },
  { id: 'proto-divgrid', script: 'tests/phase3/proto_10k_divgrid.mjs', timeout: 120000, proto: true },
  { id: 'proto-cssgrid', script: 'tests/phase3/proto_10k_cssgrid.mjs', timeout: 120000, proto: true },
  { id: 'proto-rowpoolgrid', script: 'tests/phase3/proto_10k_rowpoolgrid.mjs', timeout: 120000, proto: true },
  { id: 'proto-lite', script: 'tests/phase3/proto_10k_lite.mjs', timeout: 120000, proto: true },
  { id: 'proto-contain', script: 'tests/phase3/proto_10k_contain.mjs', timeout: 120000, proto: true },
];
const only = process.argv[2] === '--only' ? process.argv[3] : '';
const selected = only ? suites.filter(s => s.id === only) : suites.filter(s => !s.proto);

function startServer(dataDir) {
  const p = spawn(PY, ['-u', 'scripts/server.py', String(API_PORT), '--serve-frontend'], {
    cwd: ROOT, env: { ...process.env, WE_DATA: dataDir, WE_UPDATE_URL: 'off' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', d => { log += d; });
  p.stderr.on('data', d => { log += d; });
  return p;
}
async function waitHealth(timeout = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(1500) }); if (r.ok) return true; } catch { /* noop */ }
    await sleep(500);
  }
  return false;
}
async function startChrome() {
  const headed = process.env.PHASE3_HEADED === '1';
  // T06174 的 AC-03 帧率口径需要 GPU 合成；默认启用，PHASE3_CPU=1 时退回纯 CPU 对照。
  const useGpu = process.env.PHASE3_CPU !== '1';
  const args = [
    ...(headed ? [] : ['--headless=new']),
    ...(useGpu ? [] : ['--disable-gpu']),
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(TMP, 'chrome')}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--window-size=1440,900', 'about:blank',
  ];
  const p = spawn(CHROME, args, { stdio: 'ignore' });
  const t0 = Date.now();
  const waitMs = headed ? 45000 : 30000;
  while (Date.now() - t0 < waitMs) {
    try { const r = await fetch(`${CDP}/json/version`); if (r.ok) return p; } catch { /* noop */ }
    await sleep(400);
  }
  throw new Error('Chrome CDP 未就绪');
}
function runSuite(s, dataDir) {
  return new Promise(res => {
    const p = spawn(process.execPath, [s.script], { cwd: ROOT, env: { ...process.env, PHASE3_APP: `${API}/`, PHASE3_CDP: CDP, PHASE3_DATA: dataDir } });
    let tail = '';
    p.stdout.on('data', d => { const t = d.toString(); tail += t; if (tail.length > 20000) tail = tail.slice(-20000); process.stdout.write(t); });
    p.stderr.on('data', d => { const t = d.toString(); tail += t; if (tail.length > 20000) tail = tail.slice(-20000); process.stderr.write(t); });
    const killer = setTimeout(() => { killTree(p.pid); }, s.timeout);
    p.on('exit', code => { clearTimeout(killer); res({ code, tail }); });
  });
}

fs.mkdirSync(OUT, { recursive: true });
const results = [];
try {
  const dataDir = path.join(TMP, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  server = startServer(dataDir);
  if (!(await waitHealth())) throw new Error(`API 实例未就绪：${log.slice(-2000)}`);
  chrome = await startChrome();
  console.log(`# 三期验证环境就绪 API=${API} CDP=${CDP} DATA=${dataDir}\n`);
  for (const s of selected) {
    console.log(`\n== ${s.id} ==`);
    const r = await runSuite(s, dataDir);
    const ok = r.code === 0;
    results.push({ id: s.id, ok, code: r.code, tail: r.tail.slice(-3000) });
    console.log(`== ${s.id} ${ok ? 'PASS' : 'FAIL'} ==\n`);
  }
} catch (e) {
  console.error(`# 编排失败：${e.message}`);
  results.push({ id: 'orchestrator', ok: false, tail: e.message });
} finally {
  if (server) killTree(server.pid);
  if (chrome) killTree(chrome.pid);
}
const pass = results.filter(r => r.ok).length;
const md = ['# 三期验证批次结果', `${new Date().toLocaleString('zh-CN')}`, '', '| 套件 | 结果 |', '|---|---|',
  ...results.map(r => `| ${r.id} | ${r.ok ? 'PASS' : '**FAIL**'} |`), '', `通过 ${pass}/${results.length}`].join('\n');
fs.writeFileSync(path.join(OUT, 'phase3-run.log'), log + '\n\n' + results.map(r => `## ${r.id}\n${r.tail}`).join('\n\n'));
fs.writeFileSync(path.join(OUT, 'phase3-results.md'), md);
console.log(`\n==== 三期批次 ${pass}/${results.length} 通过 ====`);
process.exit(pass === results.length ? 0 : 1);
