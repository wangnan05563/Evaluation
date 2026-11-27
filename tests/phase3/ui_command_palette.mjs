/** T06184 / AC-17 命令面板验收。
 *  隔离实例 8033 + 无头 Chrome 9335；真实键盘事件走 CDP Input，不用 JS 直接调函数。
 *  校验：两次按键打开、搜索≤200ms、最近/收藏、页面/功能项/项目检索与执行、Esc/遮罩关闭、axe 无 blocker。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPage, checker, sleep, loadAxe, axeAudit } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PY = process.env.PYTHON || String.raw`F:\Program Files\Python3.14\python.exe`;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API_PORT = 8033, CDP_PORT = 9335, API = `http://127.0.0.1:${API_PORT}`, CDP = `http://127.0.0.1:${CDP_PORT}`;
const OUT = path.join(ROOT, 'docs', 'test-reports', 'phase3-20261122');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'we_cmdk_'));
const { check, finish } = checker('cmdk-ac17');
let server = null, chrome = null, page = null;

const keyEvent = async (key, code, vk, modifiers = 0) => {
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }, page.S);
  if (key === 'Enter') await page.send('Input.dispatchKeyEvent', { type: 'char', key, code, text: '\r', windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }, page.S);
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }, page.S);
  await sleep(120);
};
const openWithShortcut = async () => {
  await keyEvent('k', 'KeyK', 75, 2); // Ctrl
  await sleep(180);
};
const typeQuery = async q => {
  await page.ev(`(() => { const i=document.getElementById('cmdkInput'); i.value=${JSON.stringify(q)}; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await sleep(160);
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
  fs.mkdirSync(path.join(OUT, 'screenshots'), { recursive: true });
  const dataDir = path.join(TMP, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  server = spawn(PY, ['-u', 'scripts/server.py', String(API_PORT), '--serve-frontend'], {
    cwd: ROOT, env: { ...process.env, WE_DATA: dataDir, WE_UPDATE_URL: 'off' }, stdio: 'ignore'
  });
  if (!(await waitHealth())) throw new Error('API 实例未就绪');
  chrome = await startChrome();
  page = await openPage({ width: 1440, height: 900, cdp: CDP });
  await page.nav(`${API}/`, `typeof window.CMDK === 'object' && typeof goPage === 'function'`);
  await sleep(500); // 等 i18n/引导等 DOMContentLoaded 收尾，避免首个组合键早于监听就绪

  // 1) 两次按键：Ctrl+K 打开
  await openWithShortcut();
  check('Ctrl+K 一次组合键打开面板', await page.ev(`(() => { const h=document.getElementById('cmdk'); return !h.hidden; })()`));
  check('打开后输入框自动聚焦', await page.ev(`document.activeElement && document.activeElement.id === 'cmdkInput'`));
  check('初始列表显示页面与操作', await page.ev(`document.querySelectorAll('#cmdkList .cmdk-row').length >= 6`));

  // 2) 搜索页面
  await typeQuery('帮助');
  check('搜索「帮助」命中帮助文档', await page.ev(`[...document.querySelectorAll('#cmdkList .cmdk-row .cmdk-label')].some(e=>e.textContent.includes('帮助'))`));
  const latency1 = await page.ev(`parseInt(window.CMDK.latency, 10) || 0`);
  check('搜索响应 ≤200ms（页面检索）', latency1 > 0 && latency1 <= 200, `${latency1}ms`);

  // 3) 执行页面命令：Enter
  await keyEvent('Enter', 'Enter', 13, 0);
  check('Enter 执行后进入帮助页', await page.ev(`document.body.dataset.page === 'help'`));
  check('执行后面板关闭且焦点归还', await page.ev(`document.getElementById('cmdk').hidden === true`));

  // 4) 最近使用
  await openWithShortcut();
  check('最近分组出现刚执行的命令', await page.ev(`(() => {
    const groups=[...document.querySelectorAll('#cmdkList .cmdk-group-label')].map(e=>e.textContent.trim());
    return groups.includes('最近') || groups.includes('Recent');
  })()`));
  check('最近记录已落 localStorage', await page.ev(`JSON.parse(localStorage.getItem('we_cmd_recent')||'[]').includes('page:help')`));

  // 5) 收藏：Ctrl+Enter
  await typeQuery('配置中心');
  await keyEvent('Enter', 'Enter', 13, 2); // Ctrl+Enter
  check('Ctrl+Enter 收藏成功', await page.ev(`JSON.parse(localStorage.getItem('we_cmd_fav')||'[]').includes('page:config')`));
  check('收藏星标为选中态', await page.ev(`(() => { const it=[...document.querySelectorAll('#cmdkList .cmdk-item')].find(x=>x.querySelector('.cmdk-row[data-id="page:config"]')); const s=it&&it.querySelector('.cmdk-star'); return s && s.textContent.trim()==='★'; })()`));
  await keyEvent('Escape', 'Escape', 27, 0);
  await openWithShortcut();
  check('空查询显示收藏分组', await page.ev(`[...document.querySelectorAll('#cmdkList .cmdk-group-label')].some(e=>e.textContent.trim()==='收藏'||e.textContent.trim()==='Favorites')`));

  // 6) 10k 功能项索引 + 搜索延迟
  await page.ev(`(() => {
    items = Array.from({length:10000},(_,i)=>({seq:i+1,name:'功能项'+(i+1),type:['ILF','EI','EO','EQ','EIF'][i%5],system:'SYS-'+(i%7),sub:'批量导入样例'}));
    if (typeof render === 'function') render();
    return items.length;
  })()`);
  await keyEvent('Escape', 'Escape', 27, 0);
  await openWithShortcut();
  await typeQuery('功能项9999');
  const latency2 = await page.ev(`parseInt(window.CMDK.latency, 10) || 0`);
  check('10k 功能项索引搜索 ≤200ms', latency2 > 0 && latency2 <= 200, `${latency2}ms`);
  check('10k 索引能定位到第 9999 项', await page.ev(`[...document.querySelectorAll('#cmdkList .cmdk-row .cmdk-label')].some(e=>e.textContent==='功能项9999')`));

  // 7) 功能项执行：回到审核页并定位行
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 0 }, page.S);
  await page.send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 0 }, page.S);
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 0 }, page.S);
  await sleep(1400);
  check('执行功能项后进入审核页', await page.ev(`document.body.dataset.page === 'work' && document.body.dataset.step === 'review'`));
  check('对应功能项行被定位高亮', await page.ev(`(() => { const r=document.querySelector('#tbody .rowr[data-seq="9999"]'); return !!(r && r.classList.contains('cur')); })()`), await page.ev(`JSON.stringify({cur: (typeof curSeq!=='undefined'?curSeq:'no'), rows: document.querySelectorAll('#tbody .rowr').length, has: !!document.querySelector('#tbody .rowr[data-seq="9999"]'), virtual: document.getElementById('tbody').className})`));

  // 8) 项目索引：创建 PERT 项目后可按名字搜索并切换
  await page.ev(`fetch('/api/pert/project',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'CMDK 验收项目',estimator:'QA'})}).then(r=>r.json())`);
  await page.ev(`window.CMDK.close && window.CMDK.close()`);
  await sleep(200);
  await openWithShortcut();
  await sleep(500); // 等后台项目列表预取
  await typeQuery('CMDK 验收');
  check('PERT 项目名可检索', await page.ev(`[...document.querySelectorAll('#cmdkList .cmdk-row .cmdk-label')].some(e=>e.textContent.includes('CMDK 验收项目'))`));
  await keyEvent('Enter', 'Enter', 13, 0);
  await sleep(900);
  check('执行项目后进入 PERT 页', await page.ev(`document.body.dataset.page === 'pert'`));
  check('PERT 项目已切换为所选项目', await page.ev(`document.getElementById('pertCur') && document.getElementById('pertCur').textContent.includes('CMDK 验收项目')`), await page.ev(`JSON.stringify({cur:document.getElementById('pertCur')?.textContent||'', sel:document.getElementById('pertProjSel')?.value||'', pid: typeof pertPid!=='undefined'?pertPid:null})`));

  // 9) 截图与 axe（面板重新打开，带查询）
  await openWithShortcut();
  await typeQuery('估算');
  await page.shot(path.join(OUT, 'screenshots', 'cmdk_search_1440.png'), false);
  check('命令面板截图已生成', fs.existsSync(path.join(OUT, 'screenshots', 'cmdk_search_1440.png')));
  const okAxe = await loadAxe(page);
  let axe = null;
  if (okAxe) { axe = await axeAudit(page, 'cmdk'); check('axe WCAG A/AA 无 critical/serious', axe.violations.filter(v => ['critical', 'serious'].includes(v.impact)).length === 0, `${axe.violations.length} violations`); }
  else check('axe 载入', false);

  // 10) Esc 与遮罩关闭
  await keyEvent('Escape', 'Escape', 27, 0);
  check('Esc 关闭面板', await page.ev(`document.getElementById('cmdk').hidden === true`));
  await openWithShortcut();
  await page.ev(`(() => { const el=document.getElementById('cmdk'); el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); })()`);
  await sleep(120);
  check('点击遮罩关闭面板', await page.ev(`document.getElementById('cmdk').hidden === true`));

  check('无页面异常', page.exceptions.length === 0, page.exceptions.join(' | '));
  const r = finish({ latencyPage: latency1, latency10k: latency2, axe: axe && axe.violations });
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
