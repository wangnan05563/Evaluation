/** T06189：增强项目分类 UI 全链路（真实基线历史 → 自动建议 → 逐项复核 → 改判 → EFP 导出）。
 *  验收点：ADD/CHG/DEL/CFP、只建议不自动确认、人工复核 100% 后方可导出、CSV 公式可追溯。
 */
import fs from 'node:fs';
import path from 'node:path';
import { openPage, checker, sleep, OUT, loadAxe, axeAudit } from './cdp.mjs';

const { check, finish } = checker('ui-enhancement');
const page = await openPage({ width: 1440, height: 900 });
const dlDir = path.join(OUT, 'enhancement-downloads');
fs.rmSync(dlDir, { recursive: true, force: true });
fs.mkdirSync(dlDir, { recursive: true });
let summaryBefore = '', summaryAfter = '', csvFile = '';

async function waitFor(fn, timeout = 10000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true;
    await sleep(150);
  }
  throw new Error(`等待超时: ${label}`);
}

const baseItems = [
  ['F1', '用户管理', 'ILF', '新增', false],
  ['F2', '登录', 'EI', '新增', false],
  ['F3', '报表', 'EO', '新增', false],
  ['F4', '查询', 'EQ', '新增', false],
  ['F5', '订单转换', 'ILF', '新增', true],
  ['F6', '支付', 'EI', '新增', false],
  ['F7', '外部接口', 'EIF', '新增', false],
  ['F8', '旧报表', 'ILF', '新增', false],
  ['F9', '旧入口', 'EI', '新增', false],
  ['F10', '帮助', 'EQ', '新增', false],
];
const curItems = [
  ['F1', '用户管理', 'ILF', '新增', false, ''],
  ['F2', '登录认证', 'EI', '修改', false, ''],
  ['F3', '报表', 'EQ', '修改', false, ''],
  ['F4', '查询', 'EQ', '删除', false, ''],
  ['F5', '订单转换', 'ILF', '新增', true, ''],
  ['F7', '外部接口', 'EIF', '新增', false, ''],
  ['F91', '旧入口', 'EO', '修改', false, 'F9'],
  ['F10', '帮助', 'EQ', '新增', false, ''],
  ['F11', '发票', 'EI', '新增', false, ''],
  ['F12', '配置', 'ILF', '新增', false, ''],
];
const expected = { F1: 'UNCHANGED', F2: 'CHG', F3: 'CHG', F4: 'DEL', F5: 'CFP', F7: 'UNCHANGED', F91: 'CHG', F10: 'UNCHANGED', F11: 'ADD', F12: 'ADD', F6: 'DEL', F8: 'DEL' };
const codeOf = label => /ADD/.test(label) ? 'ADD' : /CHG/.test(label) ? 'CHG' : /DEL/.test(label) ? 'DEL' : /CFP/.test(label) ? 'CFP' : /未变更|Unchanged/i.test(label) ? 'UNCHANGED' : label;

function item([sid, desc, type, modify, conversion, replaces]) {
  return {
    stable_id: sid, system: '票据业务系统', m1: '', desc, count_item: '计数项 1',
    type, reuse: '中', modify, cx: '中', conversion: !!conversion,
    ...(replaces ? { replaces_id: replaces } : {})
  };
}

try {
  await page.nav();
  await page.ev(`localStorage.setItem('wl_guide_done_pages_v1', JSON.stringify({work:true,pert:true,config:true,help:true})); try{localStorage.setItem('wl_role_v1',JSON.stringify({id:'evaluator'}));}catch(e){}; window.RoleOnboard&&RoleOnboard.close(); WLGuide&&WLGuide.stop();`);
  await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

  // 1) 真实生成一份基线并落历史库；当前版本在页面内构造，保留 stable_id / replaces_id / conversion。
  const seed = JSON.parse(await page.ev(`(async () => {
    const base = ${JSON.stringify(baseItems.map(item))};
    const r = await fetch(API + '/api/generate', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({items:base, hist_items:base, method:'估算功能点', cx_mode:'企业母版', title:'T06189增强分类基线', job:'enh-'+Date.now()})
    });
    const j = await r.json();
    if (!j.ok) return JSON.stringify({ok:false,msg:j.msg||'generate failed'});
    localStorage.removeItem('wl_last_history');
    const cur = ${JSON.stringify(curItems.map(item))};
    items = cur.map((x,i)=>({...x,seq:i+1,cx:x.cx||'中',ok:true}));
    curFile = {name:'T06189增强分类.docx'};
    goPage('work'); goStep('review'); render();
    return JSON.stringify({ok:true, history_id:j.history_id, base:base.length, current:items.length});
  })()`));
  check('基线历史生成成功（10 项）', seed.ok === true && seed.base === 10 && !!seed.history_id, JSON.stringify(seed));

  const entry = JSON.parse(await page.ev(`(()=>{const b=document.querySelector('#enhBtn');return JSON.stringify({exists:!!b,label:b&&b.textContent.trim(),inMenu:!!document.querySelector('#expMenu')})})()`));
  check('结果页导出菜单含「增强项目分类（EFP）」入口', entry.exists && /增强项目分类/.test(entry.label), JSON.stringify(entry));

  // 2) 通过真实入口打开：默认加载最近基线并请求 /api/enhancement/classify。
  await page.ev(`(()=>{const m=document.querySelector('#expMenu');if(m)m.style.display='block';document.querySelector('#enhBtn').click();})()`);
  await waitFor(async () => (await page.ev(`(()=>{const o=document.querySelector('#enhOverlay');return !!(o&&!o.hidden);})()`)) === true, 5000, '弹层打开');
  await waitFor(async () => (await page.ev(`document.querySelectorAll('#enhRows tr').length`)) > 0, 15000, '分类结果');
  const opened = JSON.parse(await page.ev(`(()=>{
    const o=document.querySelector('#enhOverlay'), t=document.querySelector('#enhTitle');
    return JSON.stringify({
      title:t&&t.textContent, status:(document.querySelector('#enhStatus')||{}).textContent,
      rows:document.querySelectorAll('#enhRows tr').length,
      baseline:(document.querySelector('#enhBase')||{}).value,
      baselineLabel:(document.querySelector('#enhBase')||{}).selectedOptions?.[0]?.textContent||'',
      meta:(document.querySelector('#enhBaseMeta')||{}).textContent,
      summary:(document.querySelector('#enhSummary')||{}).textContent,
      checked:[...document.querySelectorAll('#enhRows .enh-review')].filter(x=>x.checked).length,
      csvDisabled:document.querySelector('#enhCsv').disabled
    });
  })()`));
  check('增强分类弹层打开并显示标题', opened.title === '增强项目分类', JSON.stringify(opened));
  check('自动载入历史基线（10 项，兼容旧数据按 desc+system 匹配）', opened.rows === 13 && !!opened.baseline, JSON.stringify(opened));
  check('历史基线路径正确输出 ADD3/CHG2/DEL4/CFP1', /匹配 7/.test(opened.status) && /ADD 3/.test(opened.status) && /CHG 2/.test(opened.status) && /DEL 4/.test(opened.status) && /CFP 1/.test(opened.status), opened.status);
  check('默认只给建议：0 行已复核、CSV 禁用', opened.checked === 0 && opened.csvDisabled === true, JSON.stringify({ checked: opened.checked, csvDisabled: opened.csvDisabled }));

  // 历史库新组会重新发号：再用保留 stable_id / replaces_id 的基线走导入路径，验证 100% 稳定 ID 匹配。
  await page.ev(`enhClose()`);
  await sleep(100);
  await page.ev(`enhanceOpen(${JSON.stringify(baseItems.map(item))})`);
  await waitFor(async () => (await page.ev(`document.querySelectorAll('#enhRows tr').length`)) === 12, 15000, '稳定 ID 基线分类');
  const exact = JSON.parse(await page.ev(`(()=>{
    return JSON.stringify({
      rows:document.querySelectorAll('#enhRows tr').length,
      summary:(document.querySelector('#enhSummary')||{}).textContent,
      status:(document.querySelector('#enhStatus')||{}).textContent,
      baseline:(document.querySelector('#enhBase')||{}).value,
      checked:[...document.querySelectorAll('#enhRows .enh-review')].filter(x=>x.checked).length,
      csvDisabled:document.querySelector('#enhCsv').disabled
    });
  })()`));
  check('导入稳定 ID 基线输出 12 行、ADD2/CHG3/DEL3/CFP1', exact.rows === 12 && /ADD 2/.test(exact.status) && /CHG 3/.test(exact.status) && /DEL 3/.test(exact.status) && /CFP 1/.test(exact.status), JSON.stringify(exact));
  check('稳定 ID 路径仍只给建议，不自动确认', exact.checked === 0 && exact.csvDisabled === true, JSON.stringify({ checked: exact.checked, csvDisabled: exact.csvDisabled }));

  const rows = JSON.parse(await page.ev(`JSON.stringify([...document.querySelectorAll('#enhRows tr')].map(tr=>({
    id:(tr.querySelector('.enh-name small')||{}).textContent||'',
    auto:(tr.querySelector('.enh-badge')||{}).textContent.trim(),
    final:(tr.querySelector('select')||{}).value,
    confidence:(tr.querySelector('.enh-conf')||{}).textContent.trim(),
    reviewed:!!(tr.querySelector('.enh-review')||{}).checked
  })))`));
  const rowMap = Object.fromEntries(rows.map(r => [r.id, { ...r, auto: codeOf(r.auto) }]));
  const missing = Object.keys(expected).filter(id => !rowMap[id]);
  const wrong = Object.keys(expected).filter(id => rowMap[id] && rowMap[id].auto !== expected[id]);
  check('自动分类 ADD/CHG/DEL/CFP 与预期逐项一致（100%）', missing.length === 0 && wrong.length === 0, `missing=${missing} wrong=${JSON.stringify(wrong.map(id => `${id}:${rowMap[id].auto}`))}`);
  check('每条均显示置信度且未自动确认', rows.every(r => /高|中|低/.test(r.confidence) && r.reviewed === false), JSON.stringify(rows.map(r => [r.id, r.confidence])));

  // 3) 全部标记已复核 → 导出解锁；再人工改判 F11 ADD → UNCHANGED，验证 mismatch 与 KPI 重算。
  summaryBefore = await page.ev(`document.querySelector('.enh-kpi.efp b').textContent`);
  await page.ev(`document.querySelector('#enhAcceptAll').click()`);
  await sleep(120);
  const accepted = JSON.parse(await page.ev(`JSON.stringify((()=>({
    checked:[...document.querySelectorAll('#enhRows .enh-review')].filter(x=>x.checked).length,
    progress:(document.querySelector('#enhProgress')||{}).textContent,
    csvDisabled:document.querySelector('#enhCsv').disabled
  }))())`));
  check('全部标记已复核后 12/12 且导出解锁', accepted.checked === 12 && /12\/12/.test(accepted.progress) && accepted.csvDisabled === false, JSON.stringify(accepted));

  const override = JSON.parse(await page.ev(`(()=>{
    // 行 ID 由分类器生成；按 F11 的名称定位更稳妥
    const row=[...document.querySelectorAll('#enhRows tr')].find(tr=>tr.textContent.includes('F11'));
    const sel=row.querySelector('select');
    sel.value='UNCHANGED'; sel.dispatchEvent(new Event('change',{bubbles:true}));
    return JSON.stringify({
      id:row.querySelector('.enh-name small').textContent,
      final:sel.value, mismatch:row.classList.contains('mismatch'),
      reviewed:row.querySelector('.enh-review').checked,
      progress:(document.querySelector('#enhProgress')||{}).textContent
    });
  })()`));
  await sleep(120);
  summaryAfter = await page.ev(`document.querySelector('.enh-kpi.efp b').textContent`);
  check('人工改判 F11 → UNCHANGED 标记 mismatch 且保持已复核', override.id === 'F11' && override.final === 'UNCHANGED' && override.mismatch === true && override.reviewed === true, JSON.stringify(override));
  check('改判后 EFP 汇总即时重算', /^\d+$/.test(summaryBefore) && /^\d+$/.test(summaryAfter) && summaryBefore !== summaryAfter, `before=${summaryBefore} after=${summaryAfter}`);

  const finalRows = JSON.parse(await page.ev(`JSON.stringify([...document.querySelectorAll('#enhRows tr')].map(tr=>({
    id:(tr.querySelector('.enh-name small')||{}).textContent||'',
    final:(tr.querySelector('select')||{}).value,
    reviewed:!!(tr.querySelector('.enh-review')||{}).checked
  })))`));
  const finalWrong = finalRows.filter(r => r.id !== 'F11' && expected[r.id] && r.final !== expected[r.id]);
  const finalF11 = finalRows.find(r => r.id === 'F11');
  check('人工复核后 12/12 行均勾选，最终分类可追溯', finalRows.length === 12 && finalRows.every(r => r.reviewed) && finalF11 && finalF11.final === 'UNCHANGED' && finalWrong.length === 0, JSON.stringify(finalRows));

  await page.shot(path.join(OUT, 'screenshots', 'enhancement_1440.png'), false);

  // 4) 导出 CSV：真实下载，校验表头、改判标记、公式汇总。
  await page.ev(`document.querySelector('#enhCsv').click()`);
  let f = null;
  for (let i = 0; i < 40; i++) {
    const fsx = fs.readdirSync(dlDir).filter(n => /_EFP\.csv$/.test(n));
    if (fsx.length) { f = path.join(dlDir, fsx[0]); break; }
    await sleep(200);
  }
  if (f) csvFile = f;
  const csv = f ? fs.readFileSync(f, 'utf8') : '';
  check('CSV 下载成功', !!f, f || 'no file');
  check('CSV 含 F11 改判行与「是否改判=是」', /F11/.test(csv) && /UNCHANGED/.test(csv) && /是/.test(csv), csv.slice(0, 500));
  check('CSV 含 EFP 合计行且 EFP 与页面汇总一致', /合计/.test(csv) && new RegExp(`EFP.*${summaryAfter}`).test(csv), csv.slice(-500));

  // 5) Esc 关闭后焦点回到入口；再开一次做 a11y 与 1024 响应式。
  await page.ev(`document.querySelector('#enhOverlay').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await sleep(120);
  const closed = await page.ev(`document.querySelector('#enhOverlay').hidden`);
  check('Esc 关闭弹层', closed === true);

  await page.ev(`document.querySelector('#enhBtn').click()`);
  await waitFor(async () => (await page.ev(`document.querySelectorAll('#enhRows tr').length`)) > 0, 15000, '二次打开');
  await loadAxe(page);
  const audit = await axeAudit(page, 'enhancement');
  const blockers = (audit.violations || []).filter(v => v.impact === 'critical' || v.impact === 'serious');
  check('增强分类弹层无 WCAG A/AA 严重阻断', blockers.length === 0, JSON.stringify(blockers));

  await page.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false }, page.S);
  await sleep(250);
  const resp = JSON.parse(await page.ev(`JSON.stringify((()=>({
    doc:document.documentElement.scrollWidth, win:innerWidth,
    overlay:document.querySelector('#enhOverlay').scrollWidth,
    tableWrap:document.querySelector('#enhTableWrap').clientWidth,
    table:document.querySelector('.enh-table').scrollWidth,
    summaryCols:getComputedStyle(document.querySelector('#enhSummary')).gridTemplateColumns.split(' ').length
  }))())`));
  check('1024px 无页面级横向溢出，表格完整落入容器', resp.doc <= resp.win + 1 && resp.overlay <= 1024 && resp.table <= resp.tableWrap + 1, JSON.stringify(resp));
  await page.shot(path.join(OUT, 'screenshots', 'enhancement_1024.png'), false);

  await page.send('Emulation.setDeviceMetricsOverride', { width: 768, height: 900, deviceScaleFactor: 1, mobile: false }, page.S);
  await sleep(250);
  const resp768 = JSON.parse(await page.ev(`JSON.stringify((()=>({
    doc:document.documentElement.scrollWidth, win:innerWidth,
    overlay:document.querySelector('#enhOverlay').scrollWidth,
    tableWrap:document.querySelector('#enhTableWrap').clientWidth,
    table:document.querySelector('.enh-table').scrollWidth,
    overflow:getComputedStyle(document.querySelector('#enhTableWrap')).overflowX
  }))())`));
  check('768px 无页面级横向溢出，宽表在容器内横向滚动', resp768.doc <= resp768.win + 1 && resp768.overlay <= 768 && resp768.table > resp768.tableWrap && resp768.overflow === 'auto', JSON.stringify(resp768));
  await page.shot(path.join(OUT, 'screenshots', 'enhancement_768.png'), false);

  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, page.S);

  // 6) 英文态：关闭后切换语言，再从真实入口重开，静态标题/按钮与动态标签均应为英文。
  await page.ev(`document.querySelector('#enhClose').click()`);
  await sleep(100);
  await page.ev(`(async()=>{ await setLang('en-US'); return true; })()`);
  await sleep(200);
  await page.ev(`(()=>{const m=document.querySelector('#expMenu');if(m)m.style.display='block';document.querySelector('#enhBtn').click();})()`);
  await waitFor(async () => (await page.ev(`document.querySelectorAll('#enhRows tr').length`)) > 0, 15000, '英文态分类结果');
  await sleep(100);
  const en = JSON.parse(await page.ev(`JSON.stringify((()=>({
    title:(document.querySelector('#enhTitle')||{}).textContent,
    csv:(document.querySelector('#enhCsv')||{}).textContent.trim(),
    status:(document.querySelector('#enhStatus')||{}).textContent,
    progress:(document.querySelector('#enhProgress')||{}).textContent,
    cat:(document.querySelector('#enhSummary .enh-kpi:first-child span')||{}).textContent
  }))())`));
  check('英文态标题/导出按钮已本地化', /Enhancement classification/.test(en.title) && /Export EFP/.test(en.csv), JSON.stringify(en));
  check('英文态动态状态/进度/分类标签已本地化', /Compared/.test(en.status) && /reviewed/i.test(en.progress) && /Add/.test(en.cat), JSON.stringify(en));
  await page.shot(path.join(OUT, 'screenshots', 'enhancement_en_1440.png'), false);
} catch (e) {
  check('增强分类套件无异常', false, e.message);
} finally {
  const r = finish({ rows: 12, expected, summaryBefore, summaryAfter, csvFile: csvFile ? path.basename(csvFile) : null });
  await page.close();
  process.exit(r.pass === r.total ? 0 : 1);
}
