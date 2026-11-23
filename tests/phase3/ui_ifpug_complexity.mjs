/** T06188 / REQ-010 / AC-16：标准 IFPUG（DET/RET/FTR）与企业母版切换。 */
import path from 'node:path';
import { openPage, checker, sleep, OUT, APP } from './cdp.mjs';

const { check, finish } = checker('ifpug-complexity');
const BASE = APP.replace(/\/$/, '');
const page = await openPage({ width: 1440, height: 900 });

const manual = [
  { system: '票据', desc: '内部文件', count_item: 'ILF-1', type: 'ILF', det: 10, ret: 1, reuse: '低', modify: '新增' },
  { system: '票据', desc: '外部接口', count_item: 'EIF-1', type: 'EIF', det: 30, ret: 6, reuse: '低', modify: '新增' },
  { system: '票据', desc: '录入', count_item: 'EI-1', type: 'EI', det: 16, ftr: 1, reuse: '低', modify: '新增' },
  { system: '票据', desc: '统计报表', count_item: 'EO-1', type: 'EO', det: 6, ftr: 4, reuse: '低', modify: '新增' },
  { system: '票据', desc: '查询', count_item: 'EQ-1', type: 'EQ', det: 5, ftr: 2, reuse: '低', modify: '新增' },
];

async function post(pathname, body) {
  const r = await fetch(BASE + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

try {
  const std = await post('/api/ifpug/summary', { items: manual, cx_mode: '标准IFPUG' });
  check('标准模式汇总成功', std.body.ok === true && std.body.cx_mode === '标准IFPUG', JSON.stringify(std.body).slice(0, 200));
  check('标准模式 UFP=33、US=33（手工矩阵）', std.body.summary.ufp === 33 && std.body.summary.us === 33, JSON.stringify(std.body.summary));
  const cx = std.body.items.map(i => i.complexity).join('/');
  const ufp = std.body.items.map(i => i.ufp).join('/');
  check('复杂度矩阵=低/高/高/高/低', cx === '低/高/高/高/低', cx);
  check('逐项 UFP=7/10/6/7/3', ufp === '7/10/6/7/3', ufp);

  const ent = await post('/api/ifpug/summary', { items: manual, cx_mode: '企业母版' });
  check('企业母版默认口径不回归（UFP=30）', ent.body.summary.ufp === 30 && ent.body.summary.us === 30, JSON.stringify(ent.body.summary));

  const defaults = await post('/api/ifpug/summary', { items: manual.map(({ det, ret, ftr, ...x }) => x), cx_mode: '标准IFPUG' });
  check('缺省 DET/RET/FTR 时标准模式默认中复杂度（UFP=30）', defaults.body.summary.ufp === 30, JSON.stringify(defaults.body.summary));
  check('非法口径被拒绝', (await post('/api/ifpug/summary', { items: manual, cx_mode: 'unknown' })).status === 400, 'expected 400');
  check('空明细被拒绝', (await post('/api/ifpug/summary', { items: [], cx_mode: '标准IFPUG' })).status === 400, 'expected 400');

  await page.nav();
  await page.ev(`goPage('work'); items=${JSON.stringify(manual)}.map((x,i)=>({...x,seq:i+1,cx:'中',ok:true})); gSummary=null; render(); goStep('review');`);
  await sleep(350);
  const ui0 = JSON.parse(await page.ev(`(() => JSON.stringify({
    hasSel: !!document.querySelector('#cxModeSel'),
    mode: document.querySelector('#cxModeSel') && document.querySelector('#cxModeSel').value,
    ufp: document.querySelector('#treeUfp').textContent,
    us: document.querySelector('#dockUs').textContent,
    rows: document.querySelectorAll('#tbody .rowr').length
  }))()`));
  check('复核页出现复杂度口径选择器', ui0.hasSel === true && ui0.rows === 5, JSON.stringify(ui0));
  check('企业母版初始 UFP=30 / US=30.00', ui0.ufp === '30' && ui0.us === '30.00', JSON.stringify(ui0));

  const uiStd = JSON.parse(await page.ev(`(() => {
    document.querySelector('#cxModeSel').value='标准IFPUG'; onCxModeChange();
    return JSON.stringify({
      mode: document.querySelector('#cxModeSel').value,
      ufp: document.querySelector('#treeUfp').textContent,
      us: document.querySelector('#dockUs').textContent,
      inputs: document.querySelectorAll('#tbody input[data-k="det"]').length,
      cx: [...document.querySelectorAll('#tbody [data-cx]')].map(x=>x.textContent).join('/'),
      hint: document.querySelector('#cxHint').textContent
    });
  })()`));
  check('切换到标准 IFPUG 后出现 DET/RET/FTR 输入', uiStd.mode === '标准IFPUG' && uiStd.inputs === 5, JSON.stringify(uiStd));
  check('UI 标准模式 UFP=33 / US=33.00', uiStd.ufp === '33' && uiStd.us === '33.00', JSON.stringify(uiStd));
  check('UI 自动判定复杂度=低/高/高/高/低', uiStd.cx === '低/高/高/高/低', uiStd.cx);
  check('UI 提示切换为标准 IFPUG 口径', /标准 IFPUG/.test(uiStd.hint), uiStd.hint);

  const uiChange = JSON.parse(await page.ev(`(() => {
    const inp=document.querySelector('#tbody .rowr[data-seq="1"] input[data-k="det"]');
    inp.value='60'; inp.dispatchEvent(new Event('change',{bubbles:true}));
    const row=document.querySelector('#tbody .rowr[data-seq="1"]');
    return JSON.stringify({ufp:document.querySelector('#treeUfp').textContent,us:document.querySelector('#dockUs').textContent,
      rowUfp:row.querySelector('[data-u]').textContent,rowCx:row.querySelector('[data-cx]').textContent});
  })()`));
  check('修改 DET 后实时重算 UFP/US', uiChange.ufp === '36' && uiChange.us === '36.00' && uiChange.rowUfp === '10', JSON.stringify(uiChange));
  check('修改 DET 后复杂度同步为中', uiChange.rowCx === '中', uiChange.rowCx);

  await page.ev(`document.querySelectorAll('.guide-mask,.guide-card,.guide-glow,.guide-fab').forEach(e=>e.remove())`);
  await page.shot(path.join(OUT, 'screenshots', 'ifpug_standard_1440.png'), false);
  check('无页面异常', page.exceptions.length === 0, page.exceptions.join(' | '));

  const result = finish({ standard_ufp: 33, enterprise_ufp: 30, manual_matrix: cx, ufp });
  process.exitCode = result.checks.every(c => c.ok) ? 0 : 1;
} catch (e) {
  check('测试执行无异常', false, e.message);
  console.error(e);
  finish({ error: String(e.stack || e) });
  process.exitCode = 1;
} finally {
  await page.close().catch(() => {});
}
