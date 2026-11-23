/** T06179 / REQ-005 / AC-06：三栏证据复核工作台 UI 验收。 */
import path from 'node:path';
import { openPage, checker, sleep, OUT } from './cdp.mjs';

const { check, finish } = checker('review-workbench');
const page = await openPage({ width: 1440, height: 900 });

const data = [
  { desc: '数据查询', count_item: '', type: 'EQ', system: '', reuse: '低', modify: '新增', ok: false, basis: '' },
  { desc: '数据查询', count_item: '查询', type: 'EQ', system: '报表', reuse: '低', modify: '新增', ok: false, basis: '' },
  { desc: '票据影像批量导入接口', count_item: '', type: 'EI', system: '票据', reuse: '低', modify: '新增', ok: false, basis: '' },
  { desc: '内部文件', count_item: '内部文件', type: 'ILF', system: '票据', reuse: '低', modify: '新增', ok: true, basis: 'IFPUG ILF 低', cx: '低' },
  { desc: '外部接口', count_item: '外部接口', type: 'EIF', system: '票据', reuse: '低', modify: '新增', ok: true, basis: 'IFPUG EIF 低', cx: '低' }
];

async function setViewport(w, h = 900) {
  await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, page.S);
  await sleep(300);
  await page.ev(`goPage('work'); goStep('review'); render();`);
  await sleep(500);
}
async function cleanGuide() {
  await page.ev(`(() => { try { if (window.WLGuide && WLGuide.stop) WLGuide.stop(); } catch(e) {}
    document.querySelectorAll('.guide-mask,.guide-card,.guide-fab,.guide-glow').forEach(function(e){e.remove();}); })()`);
  await sleep(120);
}

try {
  await page.nav();
  await page.ev(`localStorage.removeItem('we_form_state_v1'); true`);
  await page.nav();
  await sleep(400);
  await cleanGuide();
  await page.ev(`(() => {
    items=${JSON.stringify(data)}.map((x,i)=>({...x,seq:i+1,cx:x.cx||'中'}));
    goPage('work'); goStep('review'); render();
  })()`);
  await sleep(500);
  await cleanGuide();

  const layout = JSON.parse(await page.ev(`(() => {
    const av=document.querySelector('#v-review .av.rwb');
    const cols=(getComputedStyle(av).gridTemplateColumns.match(/minmax\\([^)]*\\)|[^\\s]+/g)||[]);
    return JSON.stringify({cols, page:document.body.dataset.page, step:document.body.dataset.step, left:!!document.querySelector('.rwb-left'), center:!!document.querySelector('.rwb-center'),
      evidence:!!document.querySelector('#evidenceDrawer'), outline:document.querySelector('#riskOutline').textContent,
      pills:[...document.querySelectorAll('.rwb-risk-pill')].map(x=>x.textContent.trim())});
  })()`));
  check('1440 三栏布局 200/中间/290', layout.page === 'work' && layout.step === 'review' && layout.cols.length === 3 && layout.left && layout.center && layout.evidence, JSON.stringify({cols:layout.cols,page:layout.page,step:layout.step}));
  check('左侧风险大纲按高/中/待复核分组', layout.pills.length === 3 && layout.pills[0].includes('1') && layout.pills[1].includes('2') && layout.pills[2].includes('3'), JSON.stringify(layout.pills));
  check('风险列表展示 Top 风险项', /数据查询/.test(layout.outline) && /票据影像批量导入/.test(layout.outline), layout.outline.slice(0, 80));

  await page.ev(`document.querySelector('.rwb-risk-pill.high').click()`); await sleep(350);
  const high = JSON.parse(await page.ev(`(() => JSON.stringify({rows:document.querySelectorAll('#tbody .rowr').length,
    active:document.querySelector('.rwb-risk-pill.high').classList.contains('on'), list:document.querySelector('#listCnt').textContent,
    seq:document.querySelector('#tbody .rowr')?document.querySelector('#tbody .rowr').dataset.seq:null}))()`));
  check('高风险筛选只保留 1 行', high.rows === 1 && high.active === true && high.seq === '1', JSON.stringify(high));
  await page.ev(`document.querySelector('.rwb-risk-pill.high').click()`); await sleep(350);

  await page.ev(`document.querySelector('.rwb-sort-btn').click()`); await sleep(350);
  const sorted = JSON.parse(await page.ev(`(() => {
    const rows=[...document.querySelectorAll('#tbody .rowr')];
    return JSON.stringify({order:rows.map(r=>+r.dataset.seq), scores:rows.map(r=>RWB.score(items.find(i=>i.seq===+r.dataset.seq)),), sortOn:document.querySelector('.rwb-sort-btn').classList.contains('on')});
  })()`));
  check('风险排序把最高风险置顶', sorted.order[0] === 1 && sorted.sortOn === true && sorted.scores[0] === 59, JSON.stringify(sorted));

  await page.ev(`document.querySelector('#tbody .rowr[data-seq="1"]').click()`);
  const ev1 = JSON.parse(await page.ev(`(() => {
    const d=document.querySelector('#evidenceDrawer'), b=document.querySelector('#evidenceBody');
    return JSON.stringify({title:b.querySelector('.rwb-ev-title')?.textContent, chip:b.querySelector('.rwb-risk-chip')?.textContent,
      sections:b.querySelectorAll('.rwb-ev-sec').length, quote:!!b.querySelector('.rwb-quote'), rule:!!b.querySelector('#rwbSecRule'),
      ai:!!b.querySelector('#rwbSecAi'), conf:b.querySelector('.rwb-conf')?.textContent, source:b.querySelector('.rwb-ai-badge')?.textContent,
      actions:[...b.querySelectorAll('.rwb-ev-actions .uik-btn')].map(x=>x.textContent.trim()), ms:window.__rwbLastMs,
      sel:document.querySelector('#tbody .rowr.rwb-sel')?.dataset.seq, open:d.classList.contains('open'), vis:getComputedStyle(d).visibility});
  })()`));
  check('点击行同步打开右证据抽屉', ev1.open === true && ev1.vis === 'visible' && ev1.sel === '1', JSON.stringify({open:ev1.open,vis:ev1.vis,sel:ev1.sel}));
  check('抽屉展示原文/规则/AI 建议三段', ev1.sections === 3 && ev1.quote && ev1.rule && ev1.ai, `sections=${ev1.sections}`);
  check('AI 建议带置信度与来源标注', /置信度 \d+%/.test(ev1.conf || '') && ev1.source === '本地规则（占位）' && /T06195/.test(await page.ev(`document.querySelector('#evidenceBody .rwb-ai-note').textContent`)), `${ev1.conf} / ${ev1.source}`);
  check('点击行到证据可见 ≤300ms', ev1.ms != null && ev1.ms <= 300, `ms=${ev1.ms}`);
  check('证据抽屉含定位与确认动作', ev1.actions.length === 2 && ev1.actions[0].includes('定位原文') && ev1.actions[1].includes('标记确认'), JSON.stringify(ev1.actions));

  await page.ev(`document.querySelector('#evidenceBody .rwb-ev-actions .uik-btn-primary').click()`); await sleep(800);
  const confirmed = JSON.parse(await page.ev(`JSON.stringify({ok:items.find(i=>i.seq===1).ok,state:document.querySelector('#evidenceBody .rwb-state')?.textContent,btn:[...document.querySelectorAll('#evidenceBody .rwb-ev-actions .uik-btn')].map(x=>x.textContent.trim())})`));
  check('抽屉内可标记确认并同步复核状态', confirmed.ok === true && /已确认/.test(confirmed.state) && confirmed.btn[1] === '取消确认', JSON.stringify(confirmed));

  await page.ev(`(() => { const r=document.querySelector('#tbody .rowr[data-seq="2"]'); r.focus(); r.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); })()`);
  await sleep(600);
  const kb = JSON.parse(await page.ev(`JSON.stringify({sel:document.querySelector('#tbody .rowr.rwb-sel')?.dataset.seq,title:document.querySelector('#evidenceBody .rwb-ev-title')?.textContent,focus:document.activeElement?.dataset?.seq})`));
  check('键盘 Enter 打开行证据', kb.sel === '2' && kb.title === '数据查询' && kb.focus === '2', JSON.stringify(kb));

  await page.ev(`scrollTo(0,0)`); await sleep(2400);
  await page.shot(path.join(OUT, 'screenshots', 'review_workbench_1440.png'), true);
  await page.ev(`document.querySelector('#rwbEvidenceClose').click()`); await sleep(250);

  await setViewport(1024);
  await cleanGuide();
  const mid = JSON.parse(await page.ev(`(() => { const av=document.querySelector('#v-review .av.rwb'); const cols=[...av.children].filter(c=>getComputedStyle(c).display!=='none'&&getComputedStyle(c).position!=='fixed').map(c=>Math.round(c.getBoundingClientRect().left)).filter((v,i,a)=>a.indexOf(v)===i).length; return JSON.stringify({cols, page:document.body.dataset.page, step:document.body.dataset.step, evVis:getComputedStyle(document.querySelector('#evidenceDrawer')).visibility, drawer:document.querySelector('#evidenceDrawer').getBoundingClientRect().width, scrim:!document.querySelector('#evidenceScrim').hidden}); })()`));
  check('1024 切两栏且证据抽屉默认隐藏', mid.page === 'work' && mid.step === 'review' && mid.cols === 2 && mid.evVis === 'hidden' && mid.drawer >= 400 && mid.scrim === false, JSON.stringify(mid));
  await page.ev(`document.querySelector('#tbody .rowr[data-seq="1"]').click()`); await sleep(350);
  const mid2 = JSON.parse(await page.ev(`(() => { const d=document.querySelector('#evidenceDrawer'); return JSON.stringify({open:d.classList.contains('open'), vis:getComputedStyle(d).visibility, w:d.getBoundingClientRect().width, vw:innerWidth, scrim:!document.querySelector('#evidenceScrim').hidden, body:document.body.classList.contains('rwb-drawer-open')}); })()`));
  check('1024 点击行打开覆盖式抽屉', mid2.open && mid2.vis === 'visible' && mid2.w <= 420 && mid2.vw > mid2.w && mid2.scrim && mid2.body, JSON.stringify(mid2));
  await page.ev(`document.querySelector('#rwbEvidenceClose').click()`); await sleep(350);
  const mid3 = JSON.parse(await page.ev(`JSON.stringify({vis:getComputedStyle(document.querySelector('#evidenceDrawer')).visibility, scrim:document.querySelector('#evidenceScrim').hidden, body:document.body.classList.contains('rwb-drawer-open'), overflow:getComputedStyle(document.body).overflow})`));
  check('1024 抽屉可关闭并恢复滚动', mid3.vis === 'hidden' && mid3.scrim === true && mid3.body === false, JSON.stringify(mid3));
  await page.ev(`scrollTo(0,0)`);
  await page.shot(path.join(OUT, 'screenshots', 'review_workbench_1024.png'), true);

  await setViewport(768);
  await cleanGuide();
  const small = JSON.parse(await page.ev(`(() => { const av=document.querySelector('#v-review .av.rwb'); const cols=[...av.children].filter(c=>getComputedStyle(c).display!=='none'&&getComputedStyle(c).position!=='fixed').map(c=>Math.round(c.getBoundingClientRect().left)).filter((v,i,a)=>a.indexOf(v)===i).length; return JSON.stringify({cols, page:document.body.dataset.page, step:document.body.dataset.step, riskGrid:getComputedStyle(document.querySelector('.rwb-risk-list-items')).gridTemplateColumns.split(' ').length, sw:document.documentElement.scrollWidth, iw:innerWidth, table:document.querySelector('.rwb-center .ct-wrap').clientWidth}); })()`));
  check('768 单栏、风险列表两列且无横向溢出', small.page === 'work' && small.step === 'review' && small.cols === 1 && small.riskGrid === 2 && small.sw <= small.iw + 1 && small.table > 0, JSON.stringify(small));
  check('768 表格在面板内滚动', small.table <= small.iw, `table=${small.table}/${small.iw}`);
  await page.ev(`scrollTo(0,0)`);
  await page.shot(path.join(OUT, 'screenshots', 'review_workbench_768.png'), true);

  check('运行期无 JS 异常', page.exceptions.length === 0, page.exceptions.slice(0, 4).join(' | '));
  await page.ev(`localStorage.removeItem('we_form_state_v1'); true`);
  const result = finish();
  process.exit(result.pass === result.total ? 0 : 1);
} finally {
  await page.close();
}


