/** T06190 / REQ-012：Schema 迁移向导、双读兼容与失败回滚。 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openPage, checker, sleep, OUT } from './cdp.mjs';

const { check, finish } = checker('data-migration');
const BASE = (process.env.PHASE3_APP || 'http://127.0.0.1:8033/').replace(/\/$/, '');
const DATA = process.env.PHASE3_DATA || '';
const PY = process.env.PYTHON || String.raw`F:\Program Files\Python3.14\python.exe`;
const LEGACY_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LEGACY_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const page = await openPage({ width: 1440, height: 900 });

async function post(pathname) {
  const r = await fetch(BASE + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  return { status: r.status, body: await r.json() };
}
async function get(pathname) {
  const r = await fetch(BASE + pathname, { cache: 'no-store' });
  return { status: r.status, body: await r.json() };
}
const sidList = body => (body.row && body.row.items || []).map(x => x.stable_id || '');

try {
  check('测试数据目录可用', !!DATA, DATA);
  const seed = `
import os, sqlite3, json
db = os.environ['DB']
its = json.dumps([
  {'desc':'内部文件','type':'ILF','system':'票据','reuse':'低','modify':'新增','count_item':'内部文件'},
  {'desc':'外部接口','type':'EIF','system':'票据','reuse':'低','modify':'新增','count_item':'外部接口'}
], ensure_ascii=False)
con = sqlite3.connect(db)
con.executescript("""
CREATE TABLE IF NOT EXISTS estimation_history (
 id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, title TEXT NOT NULL,
 source_name TEXT, method TEXT NOT NULL, params_json TEXT NOT NULL, items_json TEXT NOT NULL,
 summary_json TEXT, sid TEXT, version_group TEXT NOT NULL DEFAULT 'g-legacy',
 version_no INTEGER NOT NULL DEFAULT 1, schema_ver INTEGER NOT NULL DEFAULT 1);
""")
for i, hid in enumerate([os.environ['A'], os.environ['B']], 1):
    con.execute("INSERT OR REPLACE INTO estimation_history(id,created_at,updated_at,title,method,params_json,items_json,summary_json,sid,version_group,version_no,schema_ver) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      (hid,'2026-11-24T02:00:00','2026-11-24T02:00:00','旧项目迁移演练','估算功能点','{}',its,
       json.dumps({'count':2,'us_total':17}, ensure_ascii=False),'legacy.xlsx','g-legacy',i,1))
con.commit(); con.close()
print('seeded')
`;
  const r = spawnSync(PY, ['-c', seed], { env: { ...process.env, DB: path.join(DATA, 'estimation.db'), A: LEGACY_A, B: LEGACY_B }, encoding: 'utf8' });
  check('旧库注入两版本文档', r.status === 0 && /seeded/.test(r.stdout), (r.stdout || r.stderr || '').trim());

  const st0 = await get('/api/history/ids/status');
  check('迁移前状态显示 2 版本待迁移', st0.body.ok === true && st0.body.rows >= 2 && st0.body.missing_items === 4 && st0.body.legacy_rows >= 2, JSON.stringify(st0.body));
  check('迁移前双读可读旧版本', (await get('/api/history/' + LEGACY_A)).body.ok === true, 'legacy get');
  const old = await get('/api/history/' + LEGACY_A);
  check('旧版本明细未丢失（2 项）', old.body.row.items.length === 2 && old.body.row.items[0].desc === '内部文件', old.body.row.items.map(x => x.desc).join('/'));

  const mg1 = await post('/api/history/ids/migrate');
  check('迁移接口执行成功', mg1.body.ok === true && mg1.body.migrated >= 2, JSON.stringify(mg1.body));
  const st1 = await get('/api/history/ids/status');
  check('迁移后无缺失、有备份', st1.body.missing_items === 0 && st1.body.backups >= 2 && st1.body.mapped >= 2,
    JSON.stringify({ missing: st1.body.missing_items, backups: st1.body.backups, mapped: st1.body.mapped }));
  const a1 = await get('/api/history/' + LEGACY_A);
  const b1 = await get('/api/history/' + LEGACY_B);
  check('迁移后跨版本稳定ID一致', sidList(a1.body).join(',') === sidList(b1.body).join(',') && sidList(a1.body).every(s => s.startsWith('F-')), sidList(a1.body).join(','));
  check('迁移后旧明细数量不变', a1.body.row.items.length === 2 && b1.body.row.items.length === 2, '2/2');

  const rb = await post('/api/history/ids/rollback');
  check('回滚接口恢复 2 条历史', rb.body.ok === true && rb.body.restored >= 2, JSON.stringify(rb.body));
  const st2 = await get('/api/history/ids/status');
  check('回滚后回到待迁移且无备份', st2.body.missing_items === 4 && st2.body.legacy_rows >= 2 && st2.body.can_rollback === false, JSON.stringify(st2.body));
  const a2 = await get('/api/history/' + LEGACY_A);
  check('回滚后旧数据仍在且无稳定ID', a2.body.ok === true && a2.body.row.items.length === 2 && !a2.body.row.items[0].stable_id, sidList(a2.body).join(','));
  const d2 = await get(`/api/history/diff?a=${LEGACY_A}&b=${LEGACY_B}`);
  check('回滚后双读 diff 正常', d2.body.ok === true && d2.body.summary.changed === 0, JSON.stringify(d2.body.summary));

  await page.nav();
  await page.ev(`goPage('work'); histOpen(); const d=document.getElementById('migrationCard'); if(d)d.open=true;`);
  await sleep(700);
  const uiPending = JSON.parse(await page.ev(`(() => JSON.stringify({
    badge: document.getElementById('migrationBadge').textContent,
    runDisabled: document.getElementById('migrationRunBtn').disabled,
    rbDisabled: document.getElementById('migrationRollbackBtn').disabled,
    info: document.getElementById('migrationInfo').textContent,
    btnTexts: ['migrationRunBtn','migrationRollbackBtn'].map(id => document.getElementById(id).innerText.trim()),
    rows: document.querySelectorAll('#histRows tr[data-hid]').length
  }))()`));
  check('向导显示待迁移状态', /待迁移|4/.test(uiPending.badge) && uiPending.runDisabled === false && uiPending.rbDisabled === true, JSON.stringify(uiPending));
  check('向导按钮文案可见', uiPending.btnTexts[0].includes('执行迁移') && uiPending.btnTexts[1].includes('回滚迁移'), uiPending.btnTexts.join('/'));
  check('向导显示双读兼容开启', /双读兼容/.test(uiPending.info), uiPending.info.slice(0, 120));
  check('历史列表读取旧记录', uiPending.rows >= 2, String(uiPending.rows));

  await page.ev(`document.querySelectorAll('.guide-mask,.guide-card,.guide-glow,.guide-fab').forEach(e=>e.remove())`);
  await page.shot(path.join(OUT, 'screenshots', 'migration_pending_1440.png'), false);

  await page.ev(`migrationRun()`);
  await sleep(700);
  const uiDone = JSON.parse(await page.ev(`(() => JSON.stringify({
    badge: document.getElementById('migrationBadge').textContent,
    msg: document.getElementById('migrationMsg').textContent,
    info: document.getElementById('migrationInfo').textContent
  }))()`));
  check('UI 执行迁移后显示已完成', /已完成/.test(uiDone.badge) && /迁移完成/.test(uiDone.msg), JSON.stringify(uiDone));
  await page.ev(`document.querySelectorAll('.guide-mask,.guide-card,.guide-glow,.guide-fab').forEach(e=>e.remove())`);
  await page.shot(path.join(OUT, 'screenshots', 'migration_done_1440.png'), false);

  const val = await get('/api/history/ids/validate');
  check('UI 迁移后映射校验通过', val.body.ok === true, JSON.stringify(val.body.issues || []));
  const st3 = await get('/api/history/ids/status');
  check('UI 迁移后状态与接口一致', st3.body.missing_items === 0 && st3.body.mapped >= 2, JSON.stringify({ missing: st3.body.missing_items, mapped: st3.body.mapped }));
  check('无页面异常', page.exceptions.length === 0, page.exceptions.join(' | '));
} catch (e) {
  check('执行异常', false, e && e.stack || String(e));
} finally {
  const result = finish();
  await page.close().catch(() => {});
  process.exitCode = result.checks.every(c => c.ok) ? 0 : 1;
}
