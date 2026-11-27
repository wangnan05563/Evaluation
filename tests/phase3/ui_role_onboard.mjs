/** T06183：首次启动角色化引导 — 评估师 5 分钟样例端到端。
 *  真跳转 ?welcome=1，点“评估师”后走内置样例识别 → 全确认 → 生成结果；
 *  断言 ≤5 分钟、6 项、摘要非零、角色/耗时写本地匿名记录。
 */
import { APP, openPage, checker, sleep, OUT, loadAxe, axeAudit } from './cdp.mjs';
import path from 'node:path';

const { check, finish } = checker('ui-role-onboarding');
const page = await openPage({ width: 1440, height: 900 });
const t0 = Date.now();
let resultRows = 0, summaryFp = 0, summaryScale = 0, metrics = null, role = null;

try {
  await page.nav(`${APP}?welcome=1`, `typeof RoleOnboard === 'object' && typeof goPage === 'function'`);
  await sleep(500);
  const modal = JSON.parse(await page.ev(`(() => {
    const r = document.querySelector('#roleWelcome');
    const roles = [...document.querySelectorAll('.rw-role')];
    return JSON.stringify({
      exists: !!r, hidden: r ? r.hidden : true,
      dialog: r ? (r.querySelector('.rw-card') || {}).getAttribute && r.querySelector('.rw-card').getAttribute('role') : '',
      modal: r ? r.querySelector('.rw-card')?.getAttribute('aria-modal') : '',
      roles: roles.length,
      checked: roles.map(x => [x.dataset.role, x.getAttribute('aria-checked')]),
      cta: (document.querySelector('#rwGoTxt') || {}).textContent || '',
      bodyLock: document.body.classList.contains('rw-open')
    });
  })()`));
  check('首次启动显示角色选择', modal.exists && modal.hidden === false, JSON.stringify(modal));
  check('角色弹窗语义正确', modal.dialog === 'dialog' && modal.modal === 'true', `${modal.dialog}/${modal.modal}`);
  check('提供 3 个角色且默认评估师', modal.roles === 3 && modal.checked.some(([id, v]) => id === 'evaluator' && v === 'true'), JSON.stringify(modal.checked));
  check('评估师 CTA 明确 5 分钟样例', /样例/.test(modal.cta) && /5/.test(modal.cta), modal.cta);
  check('打开弹窗锁定背景滚动', modal.bodyLock === true);
  const axeLoaded = await loadAxe(page);
  const axe = await axeAudit(page, 'role-onboarding');
  const blockers = axe.violations.filter(v => ['critical', 'serious'].includes(v.impact));
  check('角色引导 axe 无 serious/critical', axeLoaded && blockers.length === 0,
    blockers.map(v => `${v.id}:${v.nodes}`).join(' | ') || `violations=${axe.violations.length}, passes=${axe.passes}`);

  await page.shot(path.join(OUT, 'screenshots', 'onboarding_1440.png'), false);
  // 角色单选可切换，CTA 随角色变化；切回评估师再继续
  await page.ev(`document.querySelector('.rw-role[data-role="pmo"]').click()`);
  const pmo = JSON.parse(await page.ev(`(() => { const r=document.querySelector('.rw-role[data-role="pmo"]'); return JSON.stringify({checked:r.getAttribute('aria-checked'),cta:document.querySelector('#rwGoTxt').textContent}) })()`));
  check('切换项目经理角色生效', pmo.checked === 'true' && /历史/.test(pmo.cta), JSON.stringify(pmo));
  await page.ev(`document.querySelector('.rw-role[data-role="evaluator"]').click()`);
  const back = JSON.parse(await page.ev(`(() => { const r=document.querySelector('.rw-role[data-role="evaluator"]'); return JSON.stringify({checked:r.getAttribute('aria-checked'),cta:document.querySelector('#rwGoTxt').textContent}) })()`));
  check('切回评估师角色生效', back.checked === 'true' && /样例/.test(back.cta), JSON.stringify(back));

  await page.ev(`document.querySelector('#rwGo').click()`);
  let done = false, last = '';
  for (let i = 0; i < 600; i++) {
    const st = JSON.parse(await page.ev(`(() => {
      const r=document.querySelector('#roleWelcome');
      return JSON.stringify({hidden:r?r.hidden:true, step:document.body.dataset.step, fp:document.querySelector('#rFp')?.textContent||'', scale:document.querySelector('#rScale')?.textContent||'', rows:document.querySelectorAll('#tbody .rowr').length, status:document.querySelector('#rwStatus')?.textContent||''});
    })()`));
    last = JSON.stringify(st);
    if (st.hidden && st.step === 'result' && Number(st.fp) > 0) {
      resultRows = st.rows; summaryFp = Number(st.fp); summaryScale = Number(st.scale); done = true; break;
    }
    await sleep(500);
  }
  check('样例流程在 5 分钟内到达结果页', done, (Date.now() - t0) + ' ms / ' + last);
  if (!done) throw new Error('样例未到达结果页：' + last);

  check('样例结果摘要非零', summaryFp > 0 && summaryScale > 0, `FP=${summaryFp} 调整后=${summaryScale}`);
  check('样例 6 项全部确认', resultRows >= 6, `result rows=${resultRows}`);
  const stored = JSON.parse(await page.ev(`(() => JSON.stringify({role:localStorage.getItem('wl_role_v1'),metrics:localStorage.getItem('wl_onboard_metrics_v1')}))()`));
  role = stored.role ? JSON.parse(stored.role) : null;
  metrics = stored.metrics ? JSON.parse(stored.metrics) : null;
  check('角色持久化为评估师', role && role.id === 'evaluator', JSON.stringify(role));
  const lastMetric = Array.isArray(metrics) ? metrics.at(-1) : metrics;
  check('本地匿名耗时记录成功且 ≤5 分钟', lastMetric && lastMetric.success === true && lastMetric.elapsed_ms <= 300000,
    JSON.stringify(lastMetric));
  check('匿名记录含 6 项且无上传字段', lastMetric && lastMetric.items === 6 && !('token' in lastMetric), JSON.stringify(lastMetric));

  await page.shot(path.join(OUT, 'screenshots', 'onboarding_sample_result_1440.png'), false);

  // 角色弹窗响应式：768 / 375 不溢出，卡片单列
  for (const [w, h, label] of [[768, 900, 'onboarding_768.png'], [375, 812, 'onboarding_375.png']]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, page.S);
    await page.ev(`RoleOnboard.open()`);
    await sleep(250);
    const fit = JSON.parse(await page.ev(`(() => {
      const card=document.querySelector('.rw-card'), c=card.getBoundingClientRect();
      const roles=[...document.querySelectorAll('.rw-role')].map(x=>x.getBoundingClientRect());
      return JSON.stringify({w:innerWidth,h:innerHeight,card:{l:Math.round(c.left),r:Math.round(c.right),w:Math.round(c.width),top:Math.round(c.top),bottom:Math.round(c.bottom)},overflow:card.scrollWidth>card.clientWidth+1,single:roles.length===3&&roles[1].top>roles[0].top});
    })()`));
    check(`${w}px 角色弹窗不溢出且单列`, fit.overflow === false && fit.card.l >= 0 && fit.card.r <= fit.w + 1 && fit.single === true, JSON.stringify(fit));
    await page.shot(path.join(OUT, 'screenshots', label), false);
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, page.S);
  await page.ev(`RoleOnboard.close()`);
} catch (e) {
  check('角色引导套件无异常', false, e.message);
} finally {
  const r = finish({ elapsed_ms: Date.now() - t0, summary_fp: summaryFp, result_rows: resultRows, role, metrics });
  await page.close();
  process.exit(r.pass === r.total ? 0 : 1);
}
