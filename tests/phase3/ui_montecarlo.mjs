/** T06192 / REQ-014 / AC-14：PERT-Beta 蒙特卡洛、P50/P80/P95、固定种子复现、敏感性 Top5、情景对比与达标概率。 */
import path from 'node:path';
import { openPage, checker, sleep, OUT, APP } from './cdp.mjs';

const { check, finish } = checker('montecarlo');
const BASE = APP.replace(/\/$/, '');
const page = await openPage({ width: 1440, height: 900 });

async function post(pathname, body) {
  const r = await fetch(BASE + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

try {
  const p = await post('/api/pert/project', { name: 'T06192-200任务-' + Date.now(), estimator: 'T06192' });
  if (!p.body.ok) throw new Error('创建项目失败: ' + JSON.stringify(p.body));
  const pid = p.body.project_id;
  for (let i = 0; i < 200; i++) {
    const r = await post('/api/pert/item', {
      project_id: pid, phase: '开发', system: 'S' + (i % 5), module: 'M' + (i % 10),
      desc: '任务' + String(i).padStart(3, '0'),
      optimistic: 6, most_likely: 10, pessimistic: 14 + (i % 20),
    });
    if (!r.body.ok) throw new Error('写入任务失败(' + i + '): ' + JSON.stringify(r.body));
  }

  const t0 = Date.now();
  const run1 = await post('/api/pert/montecarlo', { project_id: pid, simulations: 10000, seed: 424242, target_days: 2300 });
  const wall = Date.now() - t0;
  check('200 任务 1 万次模拟返回成功', run1.body.ok === true && run1.body.tasks === 200 && run1.body.simulations === 10000, JSON.stringify({ ok: run1.body.ok, tasks: run1.body.tasks, sims: run1.body.simulations }));
  check('模拟耗时 ≤2s（服务端计时）', run1.body.duration_ms <= 2000, `duration_ms=${run1.body.duration_ms} wall=${wall}ms`);
  check('P50/P80/P95 顺序正确', run1.body.p50 < run1.body.p80 && run1.body.p80 < run1.body.p95, `${run1.body.p50}/${run1.body.p80}/${run1.body.p95}`);
  check('达标概率在 0–100', run1.body.probability_pct >= 0 && run1.body.probability_pct <= 100, `prob=${run1.body.probability_pct}`);
  check('敏感性 Top5 返回 5 项且按贡献降序', run1.body.sensitivity.length === 5 && run1.body.sensitivity.every((s, i, a) => i === 0 || a[i - 1].share_pct >= s.share_pct), JSON.stringify(run1.body.sensitivity));
  check('敏感性口径=方差贡献', run1.body.sensitivity_method === 'variance_share' && run1.body.sensitivity[0].share_pct > 0, run1.body.sensitivity_method);
  check('三个情景均返回 P50/P80/P95', run1.body.scenarios.length === 3 && run1.body.scenarios.every(s => s.p50 > 0 && s.p80 > s.p50 && s.p95 > s.p80), JSON.stringify(run1.body.scenarios));
  check('基准情景与整体分位一致', Math.abs(run1.body.scenarios.find(s => s.factor === 1).p50 - run1.body.p50) < 0.011, JSON.stringify(run1.body.scenarios));

  const run2 = await post('/api/pert/montecarlo', { project_id: pid, simulations: 10000, seed: 424242, target_days: 2300 });
  const repro = ['p50', 'p80', 'p95', 'mean', 'probability_pct'].every(k => run1.body[k] === run2.body[k]);
  check('固定种子结果完全可复现', repro, JSON.stringify(['p50', 'p80', 'p95', 'mean', 'probability_pct'].map(k => [run1.body[k], run2.body[k]])));
  const run3 = await post('/api/pert/montecarlo', { project_id: pid, simulations: 10000, seed: 424243, target_days: 2300 });
  check('不同种子产生不同结果', run1.body.p50 !== run3.body.p50 || run1.body.p95 !== run3.body.p95, `${run1.body.p50}/${run3.body.p50}`);

  check('少于 1000 次模拟被拒绝', (await post('/api/pert/montecarlo', { project_id: pid, simulations: 999 })).status === 400, 'expected 400');
  check('负数目标人天被拒绝', (await post('/api/pert/montecarlo', { project_id: pid, target_days: -1 })).status === 400, 'expected 400');
  check('不存在的项目被拒绝', (await post('/api/pert/montecarlo', { project_id: 999999 })).status === 404, 'expected 404');

  await page.nav();
  await page.ev(`goPage('pert'); pertPid=${pid}; pertStep('gen');`);
  await sleep(500);
  const card = JSON.parse(await page.ev(`(async () => {
    await monteCarloRender();
    const c=document.querySelector('#mcCard');
    return JSON.stringify({card:!!c, msg:c?c.querySelector('#mcMsg').textContent:null, target:c?c.querySelector('#mcTarget').value:null});
  })()`));
  check('PERT 结果页出现蒙特卡洛区', card.card === true, JSON.stringify(card));
  check('回显任务数量与当前项目', /200 个估算条目/.test(card.msg), card.msg);

  const ui = JSON.parse(await page.ev(`(async () => {
    const c=document.querySelector('#mcCard');
    c.querySelector('#mcSims').value='10000';
    c.querySelector('#mcSeed').value='424242';
    c.querySelector('#mcTarget').value='2300';
    c.querySelector('#mcRunBtn').click();
    for(let i=0;i<50&&!/P50/.test(c.querySelector('#mcOut').textContent);i++) await new Promise(r=>setTimeout(r,100));
    const out=c.querySelector('#mcOut');
    const tables=out.querySelectorAll('table');
    return JSON.stringify({text:out.textContent, msg:c.querySelector('#mcMsg').textContent,
      tables:tables.length, sensRows:tables[0]?tables[0].querySelectorAll('tbody tr').length:0,
      scenRows:tables[1]?tables[1].querySelectorAll('tbody tr').length:0,
      hasProb:/达标概率/.test(out.textContent), hasSens:/敏感性 Top5/.test(out.textContent),
      hasScenario:/情景对比/.test(out.textContent)});
  })()`));
  check('UI 运行模拟并显示 P50/P80/P95', /P50/.test(ui.text) && /P80/.test(ui.text) && /P95/.test(ui.text), JSON.stringify({tables: ui.tables}));
  check('UI 敏感性表 5 行、情景表 3 行', ui.sensRows === 5 && ui.scenRows === 3, JSON.stringify(ui));
  check('UI 显示达标概率与情景对比', ui.hasProb && ui.hasSens && ui.hasScenario, JSON.stringify({prob: ui.hasProb, sens: ui.hasSens, scen: ui.hasScenario}));
  check('UI 显示固定种子与耗时', /固定种子 424242/.test(ui.msg) && /耗时/.test(ui.msg), ui.msg);

  await page.shot(path.join(OUT, 'screenshots', 'montecarlo_pert_1440.png'), false);
  check('无页面异常', page.exceptions.length === 0, page.exceptions.join(' | '));

  const result = finish({ tasks: 200, simulations: 10000, duration_ms: run1.body.duration_ms, p50: run1.body.p50, p80: run1.body.p80, p95: run1.body.p95, seed: 424242 });
  process.exitCode = result.checks.every(c => c.ok) ? 0 : 1;
} catch (e) {
  check('测试执行无异常', false, e.message);
  console.error(e);
  finish({ error: String(e.stack || e) });
  process.exitCode = 1;
} finally {
  await page.close().catch(() => {});
}
