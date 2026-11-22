/** 三期验证编排器：隔离实例 8033 + 无头 Chrome 9335，顺序跑 phase3 UI 套件。 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
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
  { id: '10k-grid', script: 'tests/phase3/ui_10k_grid.mjs', timeout: 180000 },
  { id: 'a11y-wcag22', script: 'tests/phase3/ui_a11y_wcag22.mjs', timeout: 180000 },
  { id: 'i18n-pseudo', script: 'tests/phase3/ui_i18n_pseudo.mjs', timeout: 120000 },
  { id: 'single-machine', script: 'tests/phase3/ui_single_machine.mjs', timeout: 120000 },
  { id: 'empty-error', script: 'tests/phase3/ui_empty_error.mjs', timeout: 120000 },
];
const only = process.argv[2] === '--only' ? process.argv[3] : '';
const selected = only ? suites.filter(s => s.id === only) : suites;

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
  const useGpu = process.env.PHASE3_GPU === '1';
  const args = [
    ...(headed ? [] : ['--headless=new']),
    ...(useGpu ? [] : ['--disable-gpu']),
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(TMP, 'chrome')}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--window-size=1440,900', 'about:blank',
  ];
  const p = spawn(CHROME, args, { stdio: 'ignore' });
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    try { const r = await fetch(`${CDP}/json/version`); if (r.ok) return p; } catch { /* noop */ }
    await sleep(400);
  }
  throw new Error('Chrome CDP 未就绪');
}
function runSuite(s) {
  return new Promise(res => {
    const p = spawn(process.execPath, [s.script], { cwd: ROOT, env: { ...process.env, PHASE3_APP: `${API}/`, PHASE3_CDP: CDP } });
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
    const r = await runSuite(s);
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
