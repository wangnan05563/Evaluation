/** T06195 / REQ-018 / AC-19、AC-22：AI 证据、置信度与无证据阻断 UI 验收。 */
import path from 'node:path';
import { openPage, checker, sleep, OUT, loadAxe, axeAudit } from './cdp.mjs';

const { check, finish } = checker('evidence-confidence-ui');
const page = await openPage({ width: 1440, height: 900 });
const STAMP = '2026-11-24T12:01:51+0800';

const data = [
  {
    seq: 1, desc: '票据签发申请', count_item: '票据签发申请', type: 'EI', system: '票据', reuse: '低', modify: '新增',
    ok: false, basis: 'IFPUG EI 低', stable_id: 'FP-001', origin: 'llm', confidence: 0.42, can_confirm: true,
    evidence: [{
      kind: 'table_row', locator: '表格 1 · 第 2 行', quote: '校验出票人、收款人与金额',
      context: '票据签发申请：校验出票人、收款人与金额，校验通过后写入签发登记簿。', verified: true
    }],
    ai: { model: 'fake-evidence-model', prompt_version: 'identify-evidence-v1', created_at: STAMP, confidence: 0.42 },
    human_decision: 'pending'
  },
  {
    seq: 2, desc: '票据影像导入', count_item: '票据影像导入', type: 'EI', system: '票据', reuse: '低', modify: '新增',
    ok: true, basis: 'IFPUG EI 低', stable_id: 'FP-002', origin: 'rule', confidence: 0.86, can_confirm: true,
    evidence: [{
      kind: 'table_row', locator: '表格 1 · 第 3 行', quote: '批量导入票据影像',
      context: '票据影像导入：批量导入票据影像并按票号建立索引。', verified: true
    }],
    ai: { model: '本地规则', prompt_version: 'rules-evidence-v1', created_at: STAMP, confidence: 0.86 },
    human_decision: 'confirmed', decision_at: STAMP
  },
  {
    seq: 3, desc: '模型补充的幽灵功能', count_item: '幽灵功能', type: 'EQ', system: '票据', reuse: '中', modify: '新增',
    ok: false, basis: '模型补漏', stable_id: 'FP-003', origin: 'llm', confidence: 0, can_confirm: false,
    evidence: [],
    ai: { model: 'fake-evidence-model', prompt_version: 'identify-evidence-v1', created_at: STAMP, confidence: 0 },
    human_decision: 'pending'
  },
  {
    seq: 4, desc: '人工补充的报表功能', count_item: '报表功能', type: 'EQ', system: '报表', reuse: '中', modify: '新增',
    ok: false, basis: '人工录入', stable_id: 'FP-004', origin: 'manual', confidence: 0.9, can_confirm: true,
    evidence: [{
      kind: 'manual', locator: '人工补录', quote: '按机构汇总票据签发量',
      context: '按机构汇总票据签发量并导出日报。', verified: true
    }]
  }
];

async function setViewport(w, h = 900) {
  await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, page.S);
  await sleep(300);
  await page.ev(`goPage('work'); goStep('review'); render();`);
  await sleep(450);
}
async function cleanGuide() {
  await page.ev(`(() => { try { if (window.WLGuide && WLGuide.stop) WLGuide.stop(); } catch(e) {}
    document.querySelectorAll('.guide-mask,.guide-card,.guide-fab,.guide-glow').forEach(function(e){e.remove();}); })()`);
  await sleep(120);
}
async function seed() {
  await page.ev(`(() => {
    items=${JSON.stringify(data)}.map(x=>({...x,cx:x.cx||'中'}));
    lastRecogMeta={llm:{enabled:true,model:'fake-evidence-model',prompt_version:'identify-evidence-v1',
      created_at:'${STAMP}',evidence_required:true},
      evidence:{required:true,total:4,matched:3,unverified:1,low_confidence:2,low_confidence_threshold:0.7},
      rules:{rules_version:'rules-v1'}};
    window.lastRecogMeta=lastRecogMeta;
    goPage('work'); goStep('review'); render();
    return true;
  })()`);
  await sleep(500);
  await cleanGuide();
}

try {
  await page.nav();
  await sleep(350);
  const real = JSON.parse(await page.ev(`(async () => {
    const s=await (await fetch('/api/onboarding/sample')).json();
    const resp=await fetch('/api/recognize',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name:s.name,b64:s.b64,params:{}})});
    const r=await resp.json();
    if(!r.ok) return JSON.stringify({ok:false,msg:r.msg});
    applyRecognitionResult(r);
    await new Promise(x=>setTimeout(x,300));
    return JSON.stringify({ok:true,n:items.length,origin:items[0]?.origin,conf:items[0]?.confidence,
      loc:items[0]?.evidence?.[0]?.locator,quote:items[0]?.evidence?.[0]?.quote,
      matched:r.meta?.evidence?.matched,unverified:r.meta?.evidence?.unverified});
  })()`));
  check('真实识别接口把规则候选绑定到原文证据',
    real.ok === true && real.n === 6 && real.origin === 'rule' && real.conf === 0.86
      && /表格 1 · 第 2 行/.test(real.loc || '') && real.quote === '票据签发申请'
      && real.matched === 6 && real.unverified === 0, JSON.stringify(real));

  await page.ev(`localStorage.removeItem('we_form_state_v1'); localStorage.setItem('wl_lang','zh-CN'); true`);
  await page.nav();
  await sleep(350);
  await seed();

  const layout = JSON.parse(await page.ev(`(() => {
    const rows=[...document.querySelectorAll('#tbody .rowr')];
    const av=document.querySelector('#v-review .av.rwb');
    const cols=(getComputedStyle(av).gridTemplateColumns.match(/minmax\\([^)]*\\)|[^\\s]+/g)||[]);
    return JSON.stringify({cols, order:rows.map(r=>+r.dataset.seq),
      badges:[...document.querySelectorAll('#tbody .rwb-conf-badge')].map(x=>x.textContent.trim()),
      confOn:document.querySelector('.rwb-conf-btn')?.classList.contains('on'),
      noev:document.querySelector('.rwb-noev')?.textContent.trim(),
      checkbox3:document.querySelector('#tbody .rowr[data-seq="3"] .ck')?.disabled});
  })()`));
  check('1440 三栏布局保留', layout.cols.length === 3, JSON.stringify(layout.cols));
  check('低置信优先默认开启并按 0%→42%→86%→90% 排序',
    layout.confOn === true && layout.order[0] === 3 && layout.order[1] === 1 && layout.order[2] === 2 && layout.order[3] === 4,
    JSON.stringify(layout.order));
  check('表格显示真实置信徽标', layout.badges.some(x => x.includes('42%')) && layout.badges.some(x => x.includes('86%')), JSON.stringify(layout.badges));
  check('左侧统计无证据项并在行内禁用确认', /无证据 1/.test(layout.noev || '') && layout.checkbox3 === true, `${layout.noev} / disabled=${layout.checkbox3}`);

  await page.ev(`document.querySelector('#tbody .rowr[data-seq="1"]').click()`); await sleep(450);
  const drawer = JSON.parse(await page.ev(`(() => {
    const b=document.querySelector('#evidenceBody');
    return JSON.stringify({open:document.querySelector('#evidenceDrawer').classList.contains('open'),
      sections:b.querySelectorAll('.rwb-ev-sec').length,
      cards:b.querySelectorAll('.rwb-evidence-card').length,
      loc:b.querySelector('.rwb-evidence-loc')?.textContent.trim(),
      quote:b.querySelector('.rwb-evidence-quote')?.textContent.trim(),
      source:b.querySelector('.rwb-ai-badge')?.textContent.trim(),
      conf:b.querySelector('.rwb-conf')?.textContent.trim(),
      actions:[...b.querySelectorAll('.rwb-ev-actions .uik-btn')].map(x=>({t:x.textContent.trim(),d:x.disabled})),
      state:b.querySelector('.rwb-state')?.textContent.trim(), ms:window.__rwbLastMs});
  })()`));
  check('点击低置信行打开证据抽屉', drawer.open === true && drawer.state === '待复核', JSON.stringify(drawer));
  check('抽屉含证据卡并显示真实位置与逐字引用',
    drawer.cards === 1 && /表格 1 · 第 2 行/.test(drawer.loc || '') && drawer.quote === '校验出票人、收款人与金额',
    `${drawer.cards} / ${drawer.loc} / ${drawer.quote}`);
  check('模型来源/提示词/置信度 42% 可见', drawer.source === 'AI 模型' && /置信度 42%/.test(drawer.conf || ''), `${drawer.source} / ${drawer.conf}`);
  check('定位与确认动作均可用', drawer.actions.length === 2 && drawer.actions.every(a => !a.d), JSON.stringify(drawer.actions));
  check('点击行到证据可见 ≤300ms', drawer.ms != null && drawer.ms <= 300, `ms=${drawer.ms}`);

  await page.ev(`document.querySelector('#evidenceBody .rwb-evidence-card').click()`); await sleep(300);
  const source = JSON.parse(await page.ev(`(() => {
    const b=document.querySelector('#rwbSourceView');
    return JSON.stringify({hidden:b.hidden, loc:b.querySelector('.rwb-source-head b')?.textContent.trim(),
      mark:b.querySelector('mark')?.textContent.trim(), text:b.querySelector('.rwb-source-context')?.textContent.trim()});
  })()`));
  check('点击证据卡定位原文并高亮逐字引用',
    source.hidden === false && /表格 1 · 第 2 行/.test(source.loc || '') && source.mark === '校验出票人、收款人与金额'
      && /票据签发申请/.test(source.text || ''), JSON.stringify(source));
  await page.ev(`RWB.hideSource()`);

  await page.ev(`document.querySelector('#evidenceBody .rwb-ev-actions .uik-btn-primary').click()`); await sleep(500);
  const confirmed = JSON.parse(await page.ev(`(() => { const it=items.find(x=>x.seq===1); return JSON.stringify({ok:it.ok,
    decision:it.human_decision, at:it.decision_at, state:document.querySelector('#evidenceBody .rwb-state')?.textContent,
    actions:[...document.querySelectorAll('#evidenceBody .rwb-ev-actions .uik-btn')].map(x=>x.textContent.trim())}); })()`));
  check('确认后写人工决策与决策时间',
    confirmed.ok === true && confirmed.decision === 'confirmed' && (confirmed.at || '').startsWith('2026-')
      && confirmed.state === '已确认' && confirmed.actions[1] === '取消确认', JSON.stringify(confirmed));

  await page.ev(`document.querySelector('#tbody .rowr[data-seq="3"]').click()`); await sleep(400);
  const noev = JSON.parse(await page.ev(`(() => {
    const b=document.querySelector('#evidenceBody');
    return JSON.stringify({state:b.querySelector('.rwb-state')?.textContent.trim(),
      count:b.querySelector('.rwb-ev-count')?.textContent,
      box:!!b.querySelector('.rwb-noev-box'), boxText:b.querySelector('.rwb-noev-box p')?.textContent.trim(),
      actions:[...b.querySelectorAll('.rwb-ev-actions .uik-btn')].map(x=>({t:x.textContent.trim(),d:x.disabled})),
      add:!!b.querySelector('#rwbAddQuote'), rowCk:document.querySelector('#tbody .rowr[data-seq="3"] .ck')?.disabled});
  })()`));
  check('无证据项显示阻断态与补充证据入口',
    noev.state === '无证据' && noev.count === '0' && noev.box === true && /不能确认/.test(noev.boxText || '') && noev.add === true,
    JSON.stringify(noev));
  check('无证据项禁用定位/确认并禁用行复选框', noev.actions.length === 2 && noev.actions.every(a => a.d) && noev.rowCk === true,
    JSON.stringify(noev.actions));

  const blocked = JSON.parse(await page.ev(`(() => { RWB.toggleConfirm(3); const it=items.find(x=>x.seq===3); return JSON.stringify({ok:it.ok, decision:it.human_decision, box:!!document.querySelector('#evidenceBody .rwb-noev-box')}); })()`));
  check('绕过按钮调用确认仍被门禁拦截', blocked.ok === false && blocked.decision === 'pending' && blocked.box === true, JSON.stringify(blocked));

  await page.ev(`window.toggleAllCk(true)`); await sleep(500);
  const batch = JSON.parse(await page.ev(`(() => JSON.stringify({items:items.map(x=>({seq:x.seq,ok:x.ok,dec:x.human_decision})),
    toast:document.querySelector('#toast')?.textContent||''}))()`));
  check('批量确认跳过无证据项', batch.items.every(x => x.seq === 3 ? x.ok === false : x.ok === true), JSON.stringify(batch.items));

  const payload = JSON.parse(await page.ev(`JSON.stringify(buildGeneratePayload())`));
  const p1 = payload.items.find(x => x.desc === '票据签发申请');
  check('生成 payload 携带证据/置信度/决策',
    p1 && p1.origin === 'llm' && p1.confidence === 0.42 && p1.can_confirm === true
      && Array.isArray(p1.evidence) && p1.evidence[0].locator === '表格 1 · 第 2 行'
      && p1.human_decision === 'confirmed' && (p1.decision_at || '').startsWith('2026-'), JSON.stringify(p1));

  const audit = JSON.parse(await page.ev(`JSON.stringify(AUDIT.buildPayload().ai.items)`));
  const a1 = audit.find(x => x.stable_id === 'FP-001');
  const a3 = audit.find(x => x.stable_id === 'FP-003');
  check('审计逐项记录模型/提示词/时间/置信度/决策',
    a1 && a1.model === 'fake-evidence-model' && a1.prompt_version === 'identify-evidence-v1'
      && a1.created_at === STAMP && a1.confidence === '42%' && a1.decision === 'confirmed'
      && a3 && a3.confidence === '0%' && a3.decision === 'pending', JSON.stringify({a1, a3}));

  await page.ev(`RWB.select(1); RWB.showSource(1,0); true`); await sleep(350);
  await page.ev(`scrollTo(0,0)`); await sleep(800);
  await page.shot(path.join(OUT, 'screenshots', 'evidence_confidence_1440.png'), true);

  const axe = await loadAxe(page);
  check('axe 可用', axe === true);
  const axeR = await axeAudit(page, 'evidence-confidence-1440');
  check('证据抽屉 axe critical/serious=0',
    axeR.violations.filter(v => ['critical', 'serious'].includes(v.impact)).length === 0,
    JSON.stringify(axeR.violations.slice(0, 4)));

  await setViewport(1024);
  await cleanGuide();
  const mid = JSON.parse(await page.ev(`(() => { const av=document.querySelector('#v-review .av.rwb'); const cols=[...av.children].filter(c=>getComputedStyle(c).display!=='none'&&getComputedStyle(c).position!=='fixed').map(c=>Math.round(c.getBoundingClientRect().left)).filter((v,i,a)=>a.indexOf(v)===i).length; return JSON.stringify({cols, drawer:getComputedStyle(document.querySelector('#evidenceDrawer')).visibility, sw:document.documentElement.scrollWidth, iw:innerWidth}); })()`));
  check('1024 两栏且无横向溢出', mid.cols === 2 && mid.sw <= mid.iw + 1, JSON.stringify(mid));
  await page.ev(`document.querySelector('#tbody .rowr[data-seq="1"]').click()`); await sleep(350);
  const midDrawer = JSON.parse(await page.ev(`JSON.stringify({vis:getComputedStyle(document.querySelector('#evidenceDrawer')).visibility,w:document.querySelector('#evidenceDrawer').getBoundingClientRect().width,vw:innerWidth,scrim:!document.querySelector('#evidenceScrim').hidden})`));
  check('1024 证据抽屉覆盖式打开', midDrawer.vis === 'visible' && midDrawer.w <= 420 && midDrawer.vw > midDrawer.w && midDrawer.scrim, JSON.stringify(midDrawer));
  await page.ev(`scrollTo(0,0)`);
  await page.shot(path.join(OUT, 'screenshots', 'evidence_confidence_1024.png'), true);
  await page.ev(`document.querySelector('#rwbEvidenceClose').click()`); await sleep(250);

  await setViewport(768);
  await cleanGuide();
  const small = JSON.parse(await page.ev(`(() => { const av=document.querySelector('#v-review .av.rwb'); const cols=[...av.children].filter(c=>getComputedStyle(c).display!=='none'&&getComputedStyle(c).position!=='fixed').map(c=>Math.round(c.getBoundingClientRect().left)).filter((v,i,a)=>a.indexOf(v)===i).length; return JSON.stringify({cols, sw:document.documentElement.scrollWidth, iw:innerWidth}); })()`));
  check('768 单栏且无横向溢出', small.cols === 1 && small.sw <= small.iw + 1, JSON.stringify(small));
  await page.ev(`document.querySelector('#tbody .rowr[data-seq="1"]').click()`); await sleep(350);
  await page.ev(`scrollTo(0,0)`);
  await page.shot(path.join(OUT, 'screenshots', 'evidence_confidence_768.png'), true);

  await page.ev(`document.querySelector('#rwbEvidenceClose').click()`); await sleep(250);
  await page.ev(`RWB.select(3); true`); await sleep(350);
  await page.ev(`setLang('en-US')`); await sleep(900);
  const en = JSON.parse(await page.ev(`(() => JSON.stringify({conf:document.querySelector('.rwb-conf-btn')?.textContent.trim(),
    evidence:document.querySelector('#rwbSecEvidence h3')?.textContent.trim(),
    noev:document.querySelector('#rwbSecEvidence .rwb-noev-box p')?.textContent.trim(),
    blocked:document.querySelector('.rwb-noev')?.textContent.trim()}))()`));
  check('英文态证据/置信度文案已本地化',
    /Low confidence first/.test(en.conf || '') && /Source evidence/.test(en.evidence || '')
      && /No source evidence/.test(en.noev || '') && /No evidence/.test(en.blocked || ''), JSON.stringify(en));
  await page.ev(`setLang('zh-CN')`); await sleep(500);

  check('运行期无 JS 异常', page.exceptions.length === 0, page.exceptions.slice(0, 4).join(' | '));
  await page.ev(`localStorage.removeItem('we_form_state_v1'); localStorage.setItem('wl_lang','zh-CN'); true`);
  const result = finish();
  process.exit(result.pass === result.total ? 0 : 1);
} finally {
  await page.close();
}
