/** T06191 / REQ-013 / AC-15：实际人天、MAPE、偏差方向与校准建议。 */
import path from 'node:path';
import { openPage, checker, sleep, OUT, APP } from './cdp.mjs';

const { check, finish } = checker('calibration');
const BASE = APP.replace(/\/$/, '');
const page = await openPage({ width: 1440, height: 900 });

async function post(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

async function seedProject(name, actual) {
  const p = await post('/api/pert/project', { name, estimator: 'T06191' });
  if (!p.body.ok) throw new Error('创建项目失败: ' + JSON.stringify(p.body));
  const pid = p.body.project_id;
  const item = await post('/api/pert/item', { project_id: pid, phase: '开发', desc: '样例功能', optimistic: 10, most_likely: 10, pessimistic: 10 });
  if (!item.body.ok) throw new Error('写入估算失败: ' + JSON.stringify(item.body));
  if (actual != null) {
    const a = await post('/api/pert/actual', { project_id: pid, actual_days: actual, actual_note: '偏差原因-' + name });
    if (!a.body.ok) throw new Error('写入实际值失败: ' + JSON.stringify(a.body));
  }
  return pid;
}

try {
  // 4 个样本：未达门槛，不应给建议
  await seedProject('T06191-样本1', 12);
  await seedProject('T06191-样本2', 11);
  await seedProject('T06191-样本3', 10);
  await seedProject('T06191-样本4', 14);
  const four = await post('/api/pert/calibration', {});
  check('4 个样本不生成校准建议', four.body.ok === true && four.body.ready === false && four.body.sample_count === 4, JSON.stringify(four.body));
  check('未达门槛时不给建议系数', four.body.suggested_factor == null, `factor=${four.body.suggested_factor}`);

  // 第 5 个样本：实际 13 对估算 10，整体低估 20%，MAPE 20%
  const pid5 = await seedProject('T06191-样本5', 13);
  const five = await post('/api/pert/calibration', {});
  check('5 个样本生成校准建议', five.body.ok === true && five.body.ready === true && five.body.sample_count === 5, JSON.stringify(five.body));
  check('MAPE=20.0%（5 个样本平均绝对偏差）', five.body.mape === 20, `mape=${five.body.mape}`);
  check('偏差方向=整体低估', five.body.direction === 'underestimated' && five.body.bias_pct === 20, JSON.stringify(five.body));
  check('建议系数=1.2（总实际/总估算）', five.body.suggested_factor === 1.2 && five.body.factor === 1.2, `factor=${five.body.factor}/${five.body.suggested_factor}`);
  check('建议文案含样本量、MAPE、系数', /样本 5/.test(five.body.message) && /MAPE 20.0%/.test(five.body.message) && /×1.20/.test(five.body.message), five.body.message);

  // 写入实际值不能改历史三点估算
  const before = (await post('/api/pert/list', { project_id: pid5 })).body;
  const triBefore = JSON.stringify(before.items.map(i => [i.optimistic, i.most_likely, i.pessimistic]));
  const upd = await post('/api/pert/actual', { project_id: pid5, actual_days: 13, actual_note: '需求变更 2 次' });
  const after = (await post('/api/pert/list', { project_id: pid5 })).body;
  const triAfter = JSON.stringify(after.items.map(i => [i.optimistic, i.most_likely, i.pessimistic]));
  check('录入实际人天后历史三点估算不变', triBefore === triAfter, `${triBefore} -> ${triAfter}`);
  check('实际人天与原因已落库', upd.body.ok === true && after.project.actual_days === 13 && after.project.actual_note === '需求变更 2 次', JSON.stringify(after.project));
  check('负数实际人天被拒绝', (await post('/api/pert/actual', { project_id: pid5, actual_days: -1 })).status === 400, 'expected 400');
  check('不存在的项目被拒绝', (await post('/api/pert/actual', { project_id: 999999, actual_days: 5 })).status === 404, 'expected 404');

  await page.nav();
  await page.ev(`goPage('pert'); pertPid=${pid5}; pertStep('gen');`);
  await sleep(400);
  const ui0 = JSON.parse(await page.ev(`(async () => {
    await calibrationRender();
    const card=document.querySelector('#calibCard');
    return JSON.stringify({card:!!card, actual:card?card.querySelector('#calibActual').value:null,
      note:card?card.querySelector('#calibNote').value:null, msg:card?card.querySelector('#calibMsg').textContent:null});
  })()`));
  check('PERT 结果页出现实际值校准区', ui0.card === true, JSON.stringify(ui0));
  check('回显当前项目实际值/原因', Number(ui0.actual) === 13 && ui0.note === '需求变更 2 次', JSON.stringify(ui0));

  const saved = JSON.parse(await page.ev(`(async () => {
    const card=document.querySelector('#calibCard');
    card.querySelector('#calibActual').value='13';
    card.querySelector('#calibNote').value='需求变更 2 次';
    card.querySelector('#calibSaveBtn').click();
    await new Promise(r=>setTimeout(r,250));
    return JSON.stringify({msg:card.querySelector('#calibMsg').textContent});
  })()`));
  check('UI 保存实际值成功且提示历史未改动', /已保存/.test(saved.msg) && /历史估算未改动/.test(saved.msg), saved.msg);

  const run = JSON.parse(await page.ev(`(async () => {
    const card=document.querySelector('#calibCard');
    card.querySelector('#calibRunBtn').click();
    for(let i=0;i<30&&!/样本量/.test(card.querySelector('#calibOut').textContent);i++) await new Promise(r=>setTimeout(r,100));
    const out=card.querySelector('#calibOut');
    return JSON.stringify({text:out.textContent, rows:out.querySelectorAll('tbody tr').length,
      hasMape:/20%/.test(out.textContent), hasDir:/整体低估/.test(out.textContent), hasFactor:/×1.2/.test(out.textContent)});
  })()`));
  check('UI 生成校准建议', /样本量/.test(run.text) && run.rows === 5, JSON.stringify(run));
  check('UI 显示 MAPE/偏差方向/建议系数', run.hasMape && run.hasDir && run.hasFactor, JSON.stringify(run));

  await page.shot(path.join(OUT, 'screenshots', 'calibration_pert_1440.png'), false);
  check('无页面异常', page.exceptions.length === 0, page.exceptions.join(' | '));

  const r = finish({ samples: 5, mape: 20, direction: 'underestimated', factor: 1.2 });
  process.exitCode = r.checks.every(c => c.ok) ? 0 : 1;
} catch (e) {
  check('测试执行无异常', false, e.message);
  console.error(e);
  finish({ error: String(e.stack || e) });
  process.exitCode = 1;
} finally {
  await page.close().catch(() => {});
}
