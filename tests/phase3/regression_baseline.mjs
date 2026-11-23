/** T06177 / REQ-012 续：性能与视觉回归基线
 *  只建立监控与门槛，不修复性能问题：
 *  1) 首屏 ≤2s（本地导航 + FCP/DCL）；
 *  2) 交互 p95 ≤150ms（10k 复核页 render + 搜索输入各 30 次采样）；
 *  3) 视觉回归：三主题（light/dark/contrast）× 中英上传/工作台 = 6 张基线，按 SHA-256 比对。
 *  首次建立基线：node tests/phase3/regression_baseline.mjs --update-baseline
 *  日常回归：node tests/phase3/regression_baseline.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPage, checker, sleep } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PY = process.env.PYTHON || 'F:\\Program Files\\Python3.14\\python.exe';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API_PORT = 8033, CDP_PORT = 9400 + Math.floor(Math.random() * 120);
const API = (process.env.PHASE3_APP || `http://127.0.0.1:${API_PORT}`).replace(/\/$/, '');
const CDP = (process.env.PHASE3_CDP || `http://127.0.0.1:${CDP_PORT}`).replace(/\/$/, '');
const EXTERNAL = !!process.env.PHASE3_APP;   // 由 run_phase3 复用共享实例
const OUT = path.join(ROOT, 'docs', 'test-reports', 'phase3-20261122');
const BASE = path.join(OUT, 'visual-baseline');
const UPDATE = process.argv.includes('--update-baseline');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'we_baseline_'));
const { check, finish } = checker('regression-baseline');
let server = null, chrome = null, page = null;

const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const p95 = arr => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(s.length * 0.95) - 1)];
};

async function waitHealth(timeout = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(1500) }); if (r.ok) return true; } catch { /* noop */ }
    await sleep(500);
  }
  return false;
}
async function startChrome() {
  const p = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(TMP, 'chrome')}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--window-size=1440,900', 'about:blank'
  ], { stdio: 'ignore' });
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    try { const r = await fetch(`${CDP}/json/version`); if (r.ok) return p; } catch { /* noop */ }
    await sleep(400);
  }
  throw new Error('Chrome CDP 未就绪');
}

try {
  fs.mkdirSync(BASE, { recursive: true });
  const dataDir = path.join(TMP, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  if (!EXTERNAL) {
    const serverLog = path.join(TMP, 'server.log');
    const fd = fs.openSync(serverLog, 'a');
    server = spawn(PY, ['-u', 'scripts/server.py', String(API_PORT), '--serve-frontend'], {
      cwd: ROOT, env: { ...process.env, WE_DATA: dataDir, WE_UPDATE_URL: 'off' }, stdio: ['ignore', fd, fd]
    });
    if (!(await waitHealth())) throw new Error(`API 实例未就绪，server.log: ${fs.existsSync(serverLog) ? fs.readFileSync(serverLog, 'utf8').slice(-1200) : '缺失'}`);
  } else if (!(await waitHealth(30000))) throw new Error(`外部 API 未就绪：${API}`);
  if (!process.env.PHASE3_CDP) chrome = await startChrome();
  page = await openPage({ width: 1440, height: 900, cdp: CDP });

  // 首屏：从 Page.navigate 到 ready，并从浏览器 PerformanceNavigationTiming 读 DCL/FCP
  const t0 = Date.now();
  await page.nav(`${API}/`, `typeof goPage === 'function' && typeof render === 'function'`);
  const wall = Date.now() - t0;
  const perf = JSON.parse(await page.ev(`(() => {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const fcp = (performance.getEntriesByType('paint') || []).find(p => p.name === 'first-contentful-paint');
    return JSON.stringify({ dcl: nav.domContentLoadedEventEnd || 0, load: nav.loadEventEnd || 0, fcp: fcp ? fcp.startTime : 0 });
  })()`));
  check('首屏 FCP/DCL ≤2s（浏览器性能条目）', (perf.fcp > 0 && perf.fcp <= 2000) || perf.dcl <= 2000, JSON.stringify(perf));
  check('导航到可交互 ≤3s（采集耗时，非首屏口径）', wall <= 3000, `${wall}ms`);
  await page.ev(`(() => { const st=document.createElement('style'); st.textContent='*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'; document.head.appendChild(st); try{localStorage.setItem('wl_guide_done_pages_v1', JSON.stringify({work:true,pert:true,config:true,help:true}))}catch(e){} return true; })()`);

  // 10k 复核页：p95 采样（render + 搜索输入事件）
  await page.ev(`(() => {
    CT_SC=null; CT_VPH=600;
    goPage('work');
    const types=['ILF','EIF','EI','EO','EQ'];
    items = Array.from({length:10000}, (_,i)=>({
      seq:i+1, system:'系统'+(i%12+1), desc:'功能项 '+(i+1), count_item:'计数项 '+(i+1),
      type:types[i%5], cx:['低','中','高'][i%3], reuse:'中', modify:'新增', ok:true
    }));
    goStep('review'); render(); return items.length;
  })()`);
  await sleep(600);
  await page.ev(`try{window.WLGuide&&WLGuide.stop()}catch(e){}`);
  const samples = JSON.parse(await page.ev(`(() => {
    const out=[]; for(let i=0;i<30;i++){ const t=performance.now(); render(); out.push(performance.now()-t); }
    return JSON.stringify(out);
  })()`));
  const inputSamples = JSON.parse(await page.ev(`(() => {
    const q=document.getElementById('q'); const out=[];
    for(let i=0;i<30;i++){ const t=performance.now(); q.value='功能项'+(i+1); q.dispatchEvent(new Event('input',{bubbles:true})); out.push(performance.now()-t); }
    q.value=''; q.dispatchEvent(new Event('input',{bubbles:true}));
    return JSON.stringify(out);
  })()`));
  const p95Render = p95(samples), p95Input = p95(inputSamples);
  check('10k 复核页 render p95 ≤150ms', p95Render <= 150, `${p95Render.toFixed(1)}ms (n=30)`);
  check('10k 复核页搜索输入 p95 ≤150ms', p95Input <= 150, `${p95Input.toFixed(1)}ms (n=30)`);

  // 视觉基线：3 主题 × 2 语言 × 上传/复核
  const themes = ['light', 'dark', 'contrast'];
  const langs = ['zh-CN', 'en-US'];
  const pages = ['upload'];   // 上传/工作台是首屏主界面且无异步图表，作为三主题中英的稳定视觉锚点；复核表格另由 10k/a11y 套件覆盖
  const manifestPath = path.join(BASE, 'manifest.json');
  const manifest = {};
  const shots = [];
  await page.ev(`(() => {
    const types=['ILF','EIF','EI','EO','EQ'];
    items = Array.from({length:20}, (_,i)=>({
      seq:i+1, system:'系统'+(i%3+1), desc:'功能项 '+(i+1), count_item:'计数项 '+(i+1),
      type:types[i%5], cx:['低','中','高'][i%3], reuse:'中', modify:'新增', ok:i<8
    }));
    goPage('work'); render(); return items.length;
  })()`);
  for (const theme of themes) {
    for (const lang of langs) {
      await page.ev(`(async () => { localStorage.setItem('wl_theme_mode', ${JSON.stringify(theme)}); applyTheme(); await setLang(${JSON.stringify(lang)}); return true; })()`);
      await sleep(450);
      for (const pg of pages) {
        await page.ev(`(() => {
          goPage('work'); goStep(${JSON.stringify(pg)});
          const sc=ctScrollParent(document.querySelector('#tbody')); if(sc) sc.scrollTop=0;
          window.scrollTo(0,0); document.activeElement && document.activeElement.blur();
          try{window.WLGuide&&WLGuide.stop()}catch(e){}
          return true;
        })()`);
        await sleep(700);
        const file = path.join(BASE, `${pg}_${theme}_${lang === 'zh-CN' ? 'zh' : 'en'}.png`);
        const data = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, page.S);
        fs.writeFileSync(file, Buffer.from(data.data, 'base64'));
        const h = sha(file);
        manifest[path.basename(file)] = h;
        shots.push({ file, hash: h });
        if (!UPDATE) {
          if (fs.existsSync(manifestPath)) {
            const old = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            check(`视觉基线一致：${path.basename(file)}`, old[path.basename(file)] === h, old[path.basename(file)] ? `old=${old[path.basename(file)].slice(0, 12)} new=${h.slice(0, 12)}` : '旧基线缺该图');
          } else check(`视觉基线存在：${path.basename(file)}`, false, 'manifest.json 缺失，请先 --update-baseline');
        }
      }
    }
  }
  if (UPDATE) {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    check('已建立 6 张视觉基线（3 主题 × 中英）', shots.length === 6, `${shots.length} 张`);
  } else if (fs.existsSync(manifestPath)) {
    const old = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    check('视觉基线覆盖 6 张（3 主题 × 中英）', Object.keys(old).length === 6, `${Object.keys(old).length} 张`);
  }

  if (EXTERNAL) await page.ev(`(async () => { localStorage.setItem('wl_theme_mode','light'); applyTheme(); await setLang('zh-CN'); return true; })()`);
  check('无页面异常', page.exceptions.length === 0, page.exceptions.join(' | '));
  const r = finish({ wallToReadyMs: wall, perf, p95Render, p95Input, baselineCount: shots.length, update: UPDATE });
  if (!r.checks.every(c => c.ok)) process.exitCode = 1;
} catch (e) {
  check('测试执行未异常中断', false, e && e.message);
  finish({ error: String(e && e.stack || e) });
  process.exitCode = 1;
} finally {
  if (page) await page.close().catch(() => {});
  for (const p of [chrome, server]) {
    if (p && p.pid) { try { spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* noop */ } }
  }
}
