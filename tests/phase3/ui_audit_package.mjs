/** T06181 / REQ-007 / AC-08：结果页「七部分审计包」导出入口 UI 验收。
 *  用 17 项结果快照驱动真实按钮 → API → 下载链接；PDF 结构由 tests/audit_package.py 深验。
 */
import fs from 'node:fs';
import path from 'node:path';
import { openPage, checker, sleep, OUT, APP } from './cdp.mjs';

const { check, finish } = checker('ui-audit-package');
const BASE = APP.replace(/\/$/, '');
const page = await openPage({ width: 1440, height: 900 });
const items17 = Array.from({ length: 17 }, (_, i) => ({
  desc: `审计样本功能项 ${i + 1}：票据标识录入与查询链路`,
  count_item: `审计样本功能项 ${i + 1}`,
  type: ['EI', 'ILF', 'EQ', 'EO', 'EIF'][i % 5],
  system: '票据核心', reuse: '中', modify: '新增', ok: true,
}));
const post = async (pathname, body) => {
  const r = await fetch(BASE + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const waitFor = async (fn, timeout = 60000, label = '') => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await fn()) { return true; } await sleep(120); }
  console.log('  !! timeout ' + label);
  return false;
};

try {
  const gen = await post('/api/generate', { method: '估算功能点', title: '审计包UI项目', items: items17, cx_mode: '企业母版' });
  check('17 项结果快照生成成功', gen.body.ok === true && gen.body.items.length === 17 && !!gen.body.summary, gen.body.sid || '');

  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('wl_guide_done_pages_v1',JSON.stringify({work:true,pert:true,config:true,help:true}));}catch(e){}` }, page.S);
  await page.nav();
  await page.ev(`document.querySelectorAll('.guide-mask,.guide-card,.guide-glow,.guide-fab').forEach(e=>e.remove())`);
  await page.ev(`items=${JSON.stringify(gen.body.items)}.map((x,i)=>({...x,seq:i+1,cx:x.cx||'中',ok:true}));
    gSummary=${JSON.stringify(gen.body.summary)}; gSid=${JSON.stringify(gen.body.sid)};
    render(); goStep('result');`);
  await sleep(300);
  check('进入结果页', (await page.ev(`document.body.dataset.step`)) === 'result');
  await page.ev(`try{rAnchor('dlSec')}catch(e){}; document.querySelectorAll('.guide-mask,.guide-card,.guide-glow,.guide-fab').forEach(e=>e.remove());
    (()=>{const m=document.querySelector('#expMenu');if(m)m.style.display='block';})()`);
  await sleep(250);
  const btn = JSON.parse(await page.ev(`(()=>{const b=document.querySelector('#auditBtn');return JSON.stringify({exists:!!b,disabled:b&&b.disabled,label:b&&b.textContent.trim()})})()`));
  check('导出菜单含「七部分审计包」按钮', btn.exists === true && /七部分审计包/.test(btn.label), JSON.stringify(btn));
  await page.shot(path.join(OUT, 'screenshots', 'audit_package_menu_1440.png'), false);

  const t0 = Date.now();
  await page.ev(`document.querySelector('#auditBtn').click()`);
  const busy = await waitFor(async () => (await page.ev(`(()=>{const b=document.querySelector('#auditBtn');return b&&b.disabled&&/正在生成/.test(b.textContent)})()`)) === true, 5000, '生成中状态');
  check('点击后按钮进入生成中状态', busy);
  const okay = await waitFor(async () => /审计包已生成/.test(await page.ev(`document.querySelector('#toast').textContent`)), 60000, '生成完成 toast');
  const elapsed = Date.now() - t0;
  const toast = await page.ev(`document.querySelector('#toast').textContent`);
  check('生成完成并提示页数/秒数', okay && /审计包已生成：\d+ 页/.test(toast), toast);
  check('UI 全程 ≤30 秒（AC-08）', elapsed <= 30000, `${elapsed} ms`);
  const after = JSON.parse(await page.ev(`(()=>{const b=document.querySelector('#auditBtn');return JSON.stringify({disabled:b.disabled,label:b.textContent.trim()})})()`));
  check('完成后按钮恢复可用', after.disabled === false && /七部分审计包/.test(after.label), JSON.stringify(after));

  const dataDir = process.env.PHASE3_DATA || '';
  const auditDir = path.join(dataDir, 'audit_packages');
  const pdfs = fs.existsSync(auditDir) ? fs.readdirSync(auditDir).filter(f => /^audit_.*\.pdf$/.test(f)) : [];
  const newest = pdfs.map(f => ({ f, t: fs.statSync(path.join(auditDir, f)).mtimeMs, s: fs.statSync(path.join(auditDir, f)).size })).sort((a, b) => b.t - a.t)[0];
  check('服务端落盘审计包 PDF', !!newest && newest.s > 100000, newest ? `${newest.f} ${newest.s}B` : 'none');
  check('全程无页面异常', page.exceptions.length === 0, page.exceptions.slice(0, 2).join(' | '));
} catch (e) {
  check('执行异常', false, e && e.stack || String(e));
} finally {
  const result = finish();
  await page.close().catch(() => {});
  process.exitCode = result.checks.every(c => c.ok) ? 0 : 1;
}
