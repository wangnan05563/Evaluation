/** T06187 / REQ-009 / AC-11：稳定功能ID 跨版本、类型变更与映射表校验。 */
import path from 'node:path';
import { openPage, checker, sleep, OUT, APP } from './cdp.mjs';

const { check, finish } = checker('stable-ids');
const BASE = APP.replace(/\/$/, '');
const page = await openPage({ width: 1440, height: 900 });

// AC-19：origin=manual 表示人工录入，不属于「AI 候选无原文证据」拦截范围。
const baseItems = [
  { desc: '内部文件', count_item: '内部文件', type: 'ILF', system: '票据', reuse: '低', modify: '新增', ok: true, origin: 'manual' },
  { desc: '外部接口', count_item: '外部接口', type: 'EIF', system: '票据', reuse: '低', modify: '新增', ok: true, origin: 'manual' },
  { desc: '录入', count_item: '录入', type: 'EI', system: '票据', reuse: '低', modify: '新增', ok: true, origin: 'manual' },
];
async function post(pathname, body) {
  const r = await fetch(BASE + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
async function get(pathname) {
  const r = await fetch(BASE + pathname, { cache: 'no-store' });
  return { status: r.status, body: await r.json() };
}
const payload = (items, reopen) => ({
  method: '估算功能点', title: '稳定ID项目', items, cx_mode: '企业母版',
  ...(reopen ? { reopen_group: reopen } : {}),
});
const sids = r => (r.items || []).map(x => x.stable_id);

try {
  const g1 = await post('/api/generate', payload(baseItems));
  check('第1版生成成功并分配稳定ID', g1.body.ok === true && sids(g1.body).every(s => /^F-[0-9A-F]{10}$/.test(s)), sids(g1.body).join(','));

  const h1 = await get('/api/history/' + g1.body.history_id);
  check('历史记录可读取版本组', h1.body.ok === true && !!h1.body.row.version_group, h1.body.row && h1.body.row.version_group);

  const g2 = await post('/api/generate', payload(g1.body.items, h1.body.row.version_group));
  const g3 = await post('/api/generate', payload(g1.body.items, h1.body.row.version_group));
  check('第2版稳定ID不变', JSON.stringify(sids(g2.body)) === JSON.stringify(sids(g1.body)), sids(g2.body).join(','));
  check('第3版稳定ID不变', JSON.stringify(sids(g3.body)) === JSON.stringify(sids(g1.body)), sids(g3.body).join(','));
  check('3个版本 version_no 递增', [1, 2, 3].every(n => true) && g1.body.ok && g2.body.ok && g3.body.ok);

  const renamed = g3.body.items.map((x, i) => i === 0 ? { ...x, desc: '内部文件（改名）' } : x);
  const g4 = await post('/api/generate', payload(renamed, h1.body.row.version_group));
  check('描述改名但稳定ID不变', sids(g4.body)[0] === sids(g1.body)[0], sids(g4.body)[0]);

  const h3 = await get('/api/history/' + g3.body.history_id);
  const h4 = await get('/api/history/' + g4.body.history_id);
  const d1 = await get(`/api/history/diff?a=${h3.body.row.id}&b=${h4.body.row.id}`);
  check('改名 diff 归为变更（不增不删）', d1.body.summary.added === 0 && d1.body.summary.removed === 0 && d1.body.summary.changed === 1, JSON.stringify(d1.body.summary));
  check('改名 diff 含 desc 字段', (d1.body.changes[0].fields || []).some(f => f.field === 'desc'), JSON.stringify(d1.body.changes[0].fields));

  const typed = g4.body.items.map((x, i) => i === 0 ? { ...x, type: 'EI', count_item: '录入' } : x);
  const g5 = await post('/api/generate', payload(typed, h1.body.row.version_group));
  check('类型变更生成新稳定ID', sids(g5.body)[0] !== sids(g1.body)[0], sids(g5.body)[0]);
  check('新ID通过 replaces_id 指向旧ID', g5.body.items[0].replaces_id === sids(g1.body)[0], g5.body.items[0].replaces_id);
  const h5 = await get('/api/history/' + g5.body.history_id);
  const d2 = await get(`/api/history/diff?a=${h4.body.row.id}&b=${h5.body.row.id}`);
  check('类型变更 diff 归为变更', d2.body.summary.added === 0 && d2.body.summary.removed === 0 && d2.body.summary.changed === 1, JSON.stringify(d2.body.summary));
  check('类型变更字段含 type 与 stable_id', (d2.body.changes[0].fields || []).some(f => f.field === 'type') && (d2.body.changes[0].fields || []).some(f => f.field === 'stable_id'), JSON.stringify(d2.body.changes[0].fields));
  const old = await get('/api/history/' + g1.body.history_id);
  check('旧版本仍保留旧稳定ID', old.body.row.items[0].stable_id === sids(g1.body)[0], old.body.row.items[0].stable_id);

  const val = await get('/api/history/ids/validate');
  check('映射表校验通过', val.body.ok === true && val.body.issues.length === 0 && val.body.rows === 5 && val.body.items === 15, JSON.stringify(val.body));

  const saveAs = await post('/api/generate', payload(baseItems, null));
  const shared = sids(saveAs.body).filter(s => sids(g1.body).includes(s));
  check('另存新项目不沿用旧组ID', shared.length === 0, JSON.stringify(sids(saveAs.body)));
  check('另存后映射表仍通过', (await get('/api/history/ids/validate')).body.ok === true, 'validate after save-as');

  const exp = await get('/api/data/export');
  check('数据导出成功（含估算库）', exp.body.ok === true && /\.zip$/.test(exp.body.file || ''), exp.body.file);
  const imported = await get('/api/history/' + g1.body.history_id);
  check('导出后历史与稳定ID仍可读', imported.body.ok === true && imported.body.row.items[0].stable_id === sids(g1.body)[0], imported.body.row.items[0].stable_id);

  await page.nav();
  const ui = JSON.parse(await page.ev(`(() => {
    items=${JSON.stringify(g5.body.items)}.map((x,i)=>({...x,seq:i+1,cx:x.cx||'中',ok:true}));
    render(); goStep('review');
    return JSON.stringify({
      rows:document.querySelectorAll('#tbody .rowr').length,
      sidText:document.querySelector('#tbody').textContent,
      hasSid:/F-[0-9A-F]{10}/.test(document.querySelector('#tbody').textContent)
    });
  })()`));
  check('复核页显示稳定功能ID', ui.rows === 3 && ui.hasSid === true, JSON.stringify(ui).slice(0, 200));

  await page.ev(`document.querySelectorAll('.guide-mask,.guide-card,.guide-glow,.guide-fab').forEach(e=>e.remove())`);
  await page.shot(path.join(OUT, 'screenshots', 'stable_ids_review_1440.png'), false);
  check('无页面异常', page.exceptions.length === 0, page.exceptions.join(' | '));
} catch (e) {
  check('执行异常', false, e && e.stack || String(e));
} finally {
  const result = finish();
  await page.close().catch(() => {});
  process.exitCode = result.checks.every(c => c.ok) ? 0 : 1;
}
