/** T06196 / REQ-019 / AC-20：离线 AI 质量评测与提交前自检 UI 验收。 */
import { openPage, checker, sleep, OUT, loadAxe, axeAudit } from './cdp.mjs';
import path from 'node:path';

const { check, finish } = checker('ai-eval-ui');
const page = await openPage({ width: 1440, height: 900 });

async function wait(fn, ms = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await page.ev(`(${fn})()`);
    if (v) return v;
    await sleep(250);
  }
  return null;
}
async function setViewport(w, h = 900) {
  await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, page.S);
  await sleep(250);
}
async function goConfig() {
  await page.ev(`goPage('config')`);
  await sleep(500);
  await wait(`() => !!document.querySelector('#evalBadge') && typeof evalRun==='function'`, 15000);
}
async function snapshot(file) {
  await page.shot(path.join(OUT, 'screenshots', file));
}

try {
  await page.nav();
  await sleep(300);
  await goConfig();

  const init = JSON.parse(await page.ev(`JSON.stringify({
    samples: document.querySelector('#evalSampleBig')?.textContent,
    groups: document.querySelector('#evalGroups')?.textContent,
    badge: document.querySelector('#evalBadge')?.textContent,
    badgeClass: document.querySelector('#evalBadge')?.className,
    hasButton: !!document.querySelector('#evalRunBtn'),
    panel: !!document.querySelector('.eval-panel')
  })`));
  check('配置中心存在质量评测面板与运行按钮',
    init.panel === true && init.hasButton === true && init.samples === '120',
    JSON.stringify(init));
  check('数据集分组 12、徽标结构可识别（无最新 run 时显示未运行）',
    /12/.test(init.groups || '') && /eval-badge/.test(init.badgeClass || ''),
    `${init.groups} / ${init.badge}`);

  // 首次点击：真实后端 120 条 docx 回放，耗时约 3 秒
  await page.ev(`evalRun()`);
  const done = await wait(`() => {
    const b=document.querySelector('#evalBadge');
    return b && /pass|fail/i.test(b.className) && (window.lastEvalRun||null);
  }`, 60000);
  check('点击运行后完成并写入 window.lastEvalRun', !!done, String(done && done.run_id));
  const ui = JSON.parse(await page.ev(`JSON.stringify({
    p: document.querySelector('#evalPrecision')?.textContent,
    r: document.querySelector('#evalRecall')?.textContent,
    f: document.querySelector('#evalF1')?.textContent,
    samples: document.querySelector('#evalSampleBig')?.textContent,
    badge: document.querySelector('#evalBadge')?.textContent,
    badgeClass: document.querySelector('#evalBadge')?.className,
    meta: document.querySelector('#evalRunMeta')?.textContent,
    matrixRows: document.querySelectorAll('#evalMatrixWrap table tr').length,
    matrixCells: document.querySelectorAll('#evalMatrixWrap table td').length,
    diag: document.querySelectorAll('#evalMatrixWrap table td.diag').length,
    off: document.querySelectorAll('#evalMatrixWrap table td.off').length,
    offSum: Array.from(document.querySelectorAll('#evalMatrixWrap table td.off')).reduce((s,td)=>s+Number(td.textContent||0),0),
    wrongChips: document.querySelectorAll('#evalSelf .eval-wrong span').length,
    chips: document.querySelectorAll('#evalSelf .eval-chip').length,
    stored: JSON.parse(localStorage.getItem('wl_eval_latest')||'null')
  })`));
  check('KPI 显示 P/R/F1 均 90.0%、样本 120',
    ui.p === '90.0%' && ui.r === '90.0%' && ui.f === '90.0%' && ui.samples === '120',
    `${ui.p}/${ui.r}/${ui.f}`);
  check('门禁徽标 PASS 且 run meta 含耗时',
    /pass/.test(ui.badgeClass) && /EVAL-/.test(ui.meta || '') && /ms/.test(ui.meta || ''),
    `${ui.badge} / ${ui.meta}`);
  check('混淆矩阵 5×5 完整，对角线 5 格 108 / 非对角 12',
    ui.matrixRows === 6 && ui.matrixCells === 25 && ui.diag === 5 && ui.off === 7 && ui.offSum === 12,
    `rows=${ui.matrixRows} cells=${ui.matrixCells} diag=${ui.diag} off=${ui.off} offSum=${ui.offSum}`);
  check('自检 chips 6 个，误判清单前 6 条', ui.chips === 6 && ui.wrongChips === 6,
    `chips=${ui.chips} wrong=${ui.wrongChips}`);
  check('localStorage 摘要可离线读取且 P=0.9',
    ui.stored && ui.stored.metrics && ui.stored.metrics.precision === 0.9
      && ui.stored.dataset && ui.stored.dataset.samples === 120,
    JSON.stringify(ui.stored && { id: ui.stored.run_id, p: ui.stored.metrics.precision }));

  await snapshot('ai_eval_1440.png');

  // 提交前自检：重复/空描述/非法类型/无证据
  const pre = JSON.parse(await page.ev(`(async () => {
    const bad=[
      {seq:1,count_item:'重复候选',desc:'重复候选说明',type:'EI',origin:'ai',evidence:[]},
      {seq:2,count_item:'重复候选',desc:'',type:'ZZ',origin:'ai',evidence:[]}
    ];
    const r=await qualityPrecheck(bad,{stage:'ui-test',job:'T06196-ui'});
    return JSON.stringify({r, dom:document.querySelector('#evalPrecheck')?.innerHTML||'',
      stored:window.lastEvalPrecheck});
  })()`));
  check('提交前自检接口返回重复 1 / 非法 1 / 证据缺失 2',
    pre.r && pre.r.precheck && pre.r.precheck.duplicate_count === 1
      && pre.r.precheck.invalid.length === 1 && pre.r.precheck.evidence_missing.length === 2,
    JSON.stringify(pre.r && pre.r.precheck && {
      dup: pre.r.precheck.duplicate_count,
      invalid: pre.r.precheck.invalid.length,
      ev: pre.r.precheck.evidence_missing.length
    }));
  check('面板显示自检告警并写入 window.lastEvalPrecheck',
    /warn/.test(pre.dom) && pre.stored && pre.stored.run_id === pre.r.run_id,
    pre.r && pre.r.run_id);

  // 响应式：1024 / 768 不出现面板级横向溢出，矩阵与按钮仍可见
  for (const [w, file] of [[1024, 'ai_eval_1024.png'], [768, 'ai_eval_768.png']]) {
    await setViewport(w);
    await goConfig();
    const lay = JSON.parse(await page.ev(`JSON.stringify({
      overflow: (() => { const p=document.querySelector('.eval-panel'); return p ? p.scrollWidth - p.clientWidth : -1; })(),
      matrix: !!document.querySelector('#evalMatrixWrap table'),
      btn: !!document.querySelector('#evalRunBtn'),
      cols: getComputedStyle(document.querySelector('.eval-kpis')).gridTemplateColumns
    })`));
    check(`${w}px 评测面板无横向溢出且矩阵/按钮可见`,
      lay.overflow <= 2 && lay.matrix && lay.btn && /px/.test(lay.cols || ''),
      JSON.stringify(lay));
    await snapshot(file);
  }

  await loadAxe(page);
  const axe = await axeAudit(page, 'config-ai-eval');
  const blockers = axe.violations.filter(v => v.impact === 'critical' || v.impact === 'serious');
  check('配置中心评测面板无 critical/serious 可访问性问题',
    blockers.length === 0, JSON.stringify(blockers.slice(0, 3)));

  const exceptions = page.exceptions;
  check('页面运行无 JS 异常', exceptions.length === 0, JSON.stringify(exceptions.slice(0, 3)));

  finish({ screenshots: ['ai_eval_1440.png', 'ai_eval_1024.png', 'ai_eval_768.png'], axe });
  await page.close();
} catch (e) {
  console.error('SUITE ERROR', e);
  try { finish({ error: String(e) }); } catch {}
  try { await page.close(); } catch {}
  process.exitCode = 1;
}
