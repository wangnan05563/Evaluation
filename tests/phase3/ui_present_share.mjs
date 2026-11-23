/** T06182 / REQ-008 / AC-10：演示模式 + 脱敏分享包 UI 验收。 */
import fs from 'node:fs';
import path from 'node:path';
import { openPage, checker, sleep, OUT, APP } from './cdp.mjs';

const { check, finish } = checker('ui-present-share');
const BASE = APP.replace(/\/$/, '');
const page = await openPage({ width: 1440, height: 900 });
const items17 = Array.from({ length: 17 }, (_, i) => ({
  desc: `分享样本功能项 ${i + 1}：票据标识录入与查询链路`,
  count_item: `分享样本功能项 ${i + 1}`,
  type: ['EI', 'ILF', 'EQ', 'EO', 'EIF'][i % 5],
  system: '票据核心', reuse: '中', modify: '新增', ok: true,
  note: i === 0 ? 'SECRET_NOTE_INTERNAL_ONLY' : '',
}));
const post = async (pathname, body) => {
  const r = await fetch(BASE + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const waitFor = async (fn, timeout = 30000, label = '') => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await fn()) return true; await sleep(120); }
  console.log('  !! timeout ' + label);
  return false;
};

try {
  const gen = await post('/api/generate', { method: '估算功能点', title: '演示分享UI项目', items: items17, cx_mode: '企业母版' });
  check('17 项结果快照生成成功', gen.body.ok === true && gen.body.items.length === 17 && !!gen.body.summary, gen.body.sid || '');

  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('wl_guide_done_pages_v1',JSON.stringify({work:true,pert:true,config:true,help:true}));}catch(e){}` }, page.S);
  await page.nav();
  await page.ev(`document.querySelectorAll('.guide-mask,.guide-card,.guide-glow,.guide-fab').forEach(e=>e.remove())`);
  await page.ev(`items=${JSON.stringify(gen.body.items)}.map((x,i)=>({...x,seq:i+1,cx:x.cx||'中',ok:i<15,note:i===0?'SECRET_NOTE_INTERNAL_ONLY':''}));
    gSummary=${JSON.stringify(gen.body.summary)}; gSid=${JSON.stringify(gen.body.sid)};
    render(); goStep('result');`);
  await sleep(300);
  check('进入结果页', (await page.ev(`document.body.dataset.step`)) === 'result');

  const btn = JSON.parse(await page.ev(`(()=>{const b=document.querySelector('#presentBtn');return JSON.stringify({exists:!!b,label:b&&b.textContent.trim()})})()`));
  check('结果页有演示模式入口', btn.exists === true && /演示模式/.test(btn.label), JSON.stringify(btn));
  await page.ev(`document.querySelector('#presentBtn').click()`);
  const opened = await waitFor(async () => (await page.ev(`(()=>{const p=document.querySelector('#presenter');return p&&!p.hidden})()`)) === true, 5000, '演示打开');
  check('演示模式打开', opened);
  await sleep(300);
  const aria = JSON.parse(await page.ev(`(()=>{const p=document.querySelector('#presenter');return JSON.stringify({role:p.getAttribute('role'),modal:p.getAttribute('aria-modal'),hidden:p.hidden,focus:document.activeElement&&document.activeElement.id,bodyLock:document.body.classList.contains('pz-open')})})()`));
  check('演示对话框语义与焦点入层', aria.role === 'dialog' && aria.modal === 'true' && aria.hidden === false && aria.focus === 'presenterExit' && aria.bodyLock === true, JSON.stringify(aria));
  const stage = JSON.parse(await page.ev(`(()=>{const s=document.querySelector('#presenterStage');const h=s.querySelector('h1');const c=document.querySelector('#presenterCounter');return JSON.stringify({counter:c?c.textContent:'',font:h?parseFloat(getComputedStyle(h).fontSize):0,text:s.textContent,slides:document.querySelectorAll('.pz-slide').length})})()`));
  check('第一页为大字号封面', stage.font >= 36 && stage.text.includes('演示模式') || stage.font >= 36 && stage.text.includes('WORKLOAD EVALUATION'), JSON.stringify({ font: stage.font, counter: stage.counter }));
  check('演示分页计数为 1 / 6', /^1 \/ 6$/.test(stage.counter), stage.counter);
  check('投屏隐藏内部备注与未确认项', !stage.text.includes('SECRET_NOTE') && !stage.text.includes('分享样本功能项 16') && !stage.text.includes('分享样本功能项 17'), 'sentinel hidden');
  await page.shot(path.join(OUT, 'screenshots', 'presenter_1440.png'), false);

  const before = await page.ev(`document.querySelector('#presenterStage').textContent`);
  await page.ev(`document.querySelector('#presenterNext').click()`);
  await sleep(200);
  const after = JSON.parse(await page.ev(`(()=>{const s=document.querySelector('#presenterStage');const c=document.querySelector('#presenterCounter');return JSON.stringify({counter:c.textContent,text:s.textContent})})()`));
  check('下一页翻页生效', after.counter === '2 / 6' && after.text !== before, after.counter);
  const expectedUfp = await page.ev(`(()=>{const ok=items.filter(x=>x.ok);let n=0;ok.forEach(x=>{n+=ufp(x)});return n})()`);
  const shownUfp = await page.ev(`(()=>{const b=document.querySelector('.pz-kpi b');return b?parseFloat(b.textContent):-1})()`);
  check('投屏 KPI 按已确认项重算', shownUfp === expectedUfp, `shown=${shownUfp} expected=${expectedUfp}`);
  await page.shot(path.join(OUT, 'screenshots', 'presenter_summary_1440.png'), false);
  await page.ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await sleep(200);
  const closed = await page.ev(`document.querySelector('#presenter').hidden`);
  check('Esc 退出演示模式', closed === true);
  const focusBack = await page.ev(`document.activeElement && document.activeElement.id`);
  check('退出后焦点回到演示入口', focusBack === 'presentBtn', focusBack);

  await page.ev(`document.querySelectorAll('.guide-mask,.guide-card,.guide-glow,.guide-fab').forEach(e=>e.remove());
    try{rAnchor('dlSec')}catch(e){}; const d=document.querySelector('#dlSec');if(d)d.scrollIntoView({block:'center'});
    (()=>{const m=document.querySelector('#expMenu');if(m)m.style.display='block';})()`);
  await sleep(450);
  const share = JSON.parse(await page.ev(`(()=>{const b=document.querySelector('#shareBtn');return JSON.stringify({exists:!!b,label:b&&b.textContent.trim()})})()`));
  check('导出菜单含脱敏分享包按钮', share.exists === true && /脱敏分享包/.test(share.label), JSON.stringify(share));
  await page.shot(path.join(OUT, 'screenshots', 'share_menu_1440.png'), false);
  const t0 = Date.now();
  await page.ev(`document.querySelector('#shareBtn').click()`);
  const busy = await waitFor(async () => (await page.ev(`(()=>{const b=document.querySelector('#shareBtn');return b&&b.disabled})()`)) === true, 5000, '分享生成中');
  check('点击后分享按钮进入生成中状态', busy);
  const done = await waitFor(async () => /脱敏分享包已生成/.test(await page.ev(`document.querySelector('#toast').textContent`)), 15000, '分享完成 toast');
  const elapsed = Date.now() - t0;
  const toast = await page.ev(`document.querySelector('#toast').textContent`);
  check('分享完成并提示项数/大小', done && /脱敏分享包已生成：\d+ 项/.test(toast), toast);
  check('分享包 UI 全程 ≤15 秒', elapsed <= 15000, `${elapsed} ms`);
  const afterBtn = JSON.parse(await page.ev(`(()=>{const b=document.querySelector('#shareBtn');return JSON.stringify({disabled:b.disabled,label:b.textContent.trim()})})()`));
  check('分享完成后按钮恢复', afterBtn.disabled === false && /脱敏分享包/.test(afterBtn.label), JSON.stringify(afterBtn));

  const dataDir = process.env.PHASE3_DATA || '';
  const shareDir = path.join(dataDir, 'share_packages');
  const files = fs.existsSync(shareDir) ? fs.readdirSync(shareDir).filter(f => /^share_.*\.html$/.test(f)) : [];
  const newest = files.map(f => ({ f, t: fs.statSync(path.join(shareDir, f)).mtimeMs, s: fs.statSync(path.join(shareDir, f)).size })).sort((a, b) => b.t - a.t)[0];
  let html = '';
  if (newest) html = fs.readFileSync(path.join(shareDir, newest.f), 'utf8');
  check('服务端落盘分享 HTML', !!newest && newest.s > 5000, newest ? `${newest.f} ${newest.s}B` : 'none');
  check('分享 HTML 无内部备注/未确认项/外链', !!newest && !html.includes('SECRET_NOTE') && !html.includes('分享样本功能项 16') && !/https?:\/\//.test(html) && !/<link|<script|src=/.test(html),
        newest ? `${html.length} chars` : 'none');
  check('全程无页面异常', page.exceptions.length === 0, page.exceptions.slice(0, 2).join(' | '));
} catch (e) {
  check('执行异常', false, e && e.stack || String(e));
} finally {
  const result = finish();
  await page.close().catch(() => {});
  process.exitCode = result.checks.every(c => c.ok) ? 0 : 1;
}
