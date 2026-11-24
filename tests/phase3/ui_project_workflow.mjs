/** T06198 / REQ-020 / AC-23 / AC-24：项目状态机、审计轨迹与签收页 UI 验收。 */
import { openPage, checker, sleep, OUT, APP, loadAxe, axeAudit } from './cdp.mjs';
import path from 'node:path';

const { check, finish } = checker('project-workflow-ui');
const page = await openPage({ width: 1440, height: 900 });

async function wait(fn, ms = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await page.ev(`(${fn})()`);
    if (v) return v;
    await sleep(300);
  }
  return null;
}
async function setViewport(w, h = 900) {
  await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, page.S);
  await sleep(300);
}
async function goFlow() {
  await page.ev(`goPage('flow')`);
  await sleep(500);
  await wait(`() => document.body.dataset.page === 'flow'
    && (!!document.querySelector('.wf-project') || !!document.querySelector('.wf-empty'))`, 30000);
}
async function snapshot(file) {
  await page.shot(path.join(OUT, 'screenshots', file));
}

try {
  // 工作组版：入口可见，签收页可进入
  await page.nav();
  await sleep(500);
  // 干净 profile 首次进入会叠加角色欢迎/菜单引导；先写入已完成标记并重载，
  // 确保后续截图与 axe 测的是签收页本身，而不是引导遮罩。
  await page.ev(`(() => {
    document.querySelector('.guide-mask')?.click();
    localStorage.setItem('wl_role_v1', 'evaluator');
    localStorage.setItem('wl_guide_done_pages_v1', JSON.stringify({work:true,pert:true,fast:true,config:true,help:true,flow:true}));
  })()`);
  await page.nav();
  await sleep(700);
  await page.ev(`saveDeployMode('workgroup')`);
  await wait(`() => document.body.dataset.deployMode === 'workgroup'`, 15000);
  const cfg = JSON.parse(await page.ev(`(async () => {
    const r = await fetch('/api/config');
    return JSON.stringify(await r.json());
  })()`));
  check('切到工作组版成功', cfg.ok && cfg.config?.deployment?.mode === 'workgroup', JSON.stringify(cfg.config?.deployment));
  const boot = JSON.parse(await page.ev(`JSON.stringify({
    deploy: document.body.dataset.deployMode,
    navHidden: document.querySelector('#mi-flow')?.getAttribute('aria-hidden'),
    navDisplay: getComputedStyle(document.querySelector('#mi-flow')).display,
    modeBadge: document.querySelector('#wfModeBadge')?.textContent
  })`));
  check('工作组版导航可见且部署徽标回显',
    boot.deploy === 'workgroup' && boot.navHidden === 'false' && boot.navDisplay !== 'none'
      && boot.modeBadge === '工作组版', JSON.stringify(boot));

  // 单机版：入口隐藏，直接 goPage 被拒绝（走页面真实切换入口）
  await page.ev(`saveDeployMode('standalone')`);
  await wait(`() => document.body.dataset.deployMode === 'standalone'`, 15000);
  await sleep(300);
  const gate = JSON.parse(await page.ev(`JSON.stringify({
    deploy: document.body.dataset.deployMode,
    hidden: document.querySelector('#mi-flow')?.getAttribute('aria-hidden'),
    display: getComputedStyle(document.querySelector('#mi-flow')).display,
    before: document.body.dataset.page
  })`));
  await page.ev(`goPage('flow')`);
  await sleep(400);
  const gateAfter = JSON.parse(await page.ev(`JSON.stringify({
    page: document.body.dataset.page,
    toast: document.querySelector('#toast')?.textContent || ''
  })`));
  check('单机版隐藏项目签收入口', gate.deploy === 'standalone'
    && gate.hidden === 'true' && gate.display === 'none', JSON.stringify(gate));
  check('单机版直接进入签收页被拦截', gateAfter.page !== 'flow',
    `${gate.before} -> ${gateAfter.page} / ${gateAfter.toast}`);

  // 切回工作组版并进入
  await page.ev(`saveDeployMode('workgroup')`);
  await wait(`() => document.body.dataset.deployMode === 'workgroup'`, 15000);
  await goFlow();
  const pageReady = JSON.parse(await page.ev(`JSON.stringify({
    title: document.querySelector('#wfDetailTitle')?.textContent,
    count: document.querySelector('#wfProjectCount')?.textContent,
    rows: document.querySelectorAll('.wf-project').length,
    empty: document.querySelector('.wf-empty')?.textContent || '',
    overflow: (() => { const g=document.querySelector('.wf-grid'); return g ? g.scrollWidth - g.clientWidth : -1; })()
  })`));
  check('工作组版签收页加载项目列表与详情',
    (pageReady.rows >= 1 ? !!pageReady.title : !!pageReady.empty) && pageReady.overflow <= 2,
    JSON.stringify(pageReady));

  // 通过真实后端生成一条专属草稿项目，供 UI 全流程操作（Node 侧调用，页面侧仅做 UI 操作）
  const api = APP.replace(/\/+$/, '');
  const sample = await (await fetch(`${api}/api/onboarding/sample`)).json();
  const rec = await (await fetch(`${api}/api/recognize`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: sample.name, b64: sample.b64, params: {} })
  })).json();
  const title = 'T06198 UI 签收验收 ' + new Date().toTimeString().slice(0, 8).replaceAll(':','');
  const gen = await (await fetch(`${api}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: rec.items, method: '估算功能点', title, job: 't06198_ui',
      hist_items: rec.items.map(x => ({ ...x, cx: '中', ok: true })), source_name: sample.name })
  })).json();
  const created = { ok: gen.ok, pid: gen.version_group, title, items: rec.items.length };
  check('UI 专属草稿项目生成成功', created.ok && !!created.pid && created.items === 6,
    JSON.stringify(created));

  await page.ev(`flowInit(true)`);
  await sleep(800);
  await page.ev(`flowSelect(${JSON.stringify(created.pid)})`);
  const draft = await wait(`() => document.querySelector('#wfDetailTitle')?.textContent === ${JSON.stringify(created.title)}
    && document.querySelector('#wfDetailStatus')?.textContent === '草稿'`, 30000);
  check('新版本在 UI 中显示为草稿并自动选中', !!draft, created.title);
  const draftUi = JSON.parse(await page.ev(`JSON.stringify({
    hash: document.querySelector('#wfHash')?.textContent,
    status: document.querySelector('#wfDetailStatus')?.textContent,
    events: document.querySelectorAll('.wf-event').length,
    eventText: document.querySelector('#wfTimeline')?.textContent,
    submitDisabled: document.querySelector('#wfSubmitBtn')?.disabled,
    signDisabled: document.querySelector('#wfSignBtn')?.disabled,
    actor: document.querySelector('#wfActor')?.value
  })`));
  check('草稿页显示 64 位版本哈希与创建审计轨迹',
    (draftUi.hash || '').length === 64 && draftUi.status === '草稿' && draftUi.events === 1
      && /系统/.test(draftUi.eventText || '') && /首版估算生成/.test(draftUi.eventText || ''),
    `${(draftUi.hash||'').slice(0,16)} events=${draftUi.events}`);
  check('草稿仅允许提交评审，签收按钮禁用',
    draftUi.submitDisabled === false && draftUi.signDisabled === true, JSON.stringify(draftUi));

  // UI 点击走完整状态链：提交 → 驳回 → 修订 → 再提交 → 签收
  await page.ev(`(() => {
    document.querySelector('#wfActor').value='张评估';
    document.querySelector('#wfRole').value='评估师';
    document.querySelector('#wfOpinion').value='提交项目经理评审';
    document.querySelector('#wfSubmitBtn').click();
  })()`);
  const submitted = await wait(`() => document.querySelector('#wfDetailStatus')?.textContent === '评审中'`, 20000);
  check('UI 提交评审后状态变为评审中', !!submitted, await page.ev(`document.querySelector('#wfMsg')?.textContent`));

  await page.ev(`(() => {
    document.querySelector('#wfActor').value='李经理';
    document.querySelector('#wfRole').value='项目经理';
    document.querySelector('#wfOpinion').value='范围说明需补充';
    document.querySelector('#wfRejectBtn').click();
  })()`);
  const rejected = await wait(`() => document.querySelector('#wfDetailStatus')?.textContent === '已驳回'`, 20000);
  check('UI 驳回后状态变为已驳回', !!rejected, await page.ev(`document.querySelector('#wfMsg')?.textContent`));

  await page.ev(`(() => {
    document.querySelector('#wfActor').value='张评估';
    document.querySelector('#wfRole').value='评估师';
    document.querySelector('#wfOpinion').value='';
    document.querySelector('#wfReviseBtn').click();
  })()`);
  const revised = await wait(`() => document.querySelector('#wfDetailStatus')?.textContent === '草稿'`, 20000);
  check('UI 修订后回到草稿', !!revised, await page.ev(`document.querySelector('#wfMsg')?.textContent`));

  await page.ev(`(() => {
    document.querySelector('#wfActor').value='张评估';
    document.querySelector('#wfRole').value='评估师';
    document.querySelector('#wfOpinion').value='已补充范围说明';
    document.querySelector('#wfSubmitBtn').click();
  })()`);
  const resubmitted = await wait(`() => document.querySelector('#wfDetailStatus')?.textContent === '评审中'`, 20000);
  check('UI 再次提交进入评审中', !!resubmitted, await page.ev(`document.querySelector('#wfMsg')?.textContent`));

  await page.ev(`(() => {
    document.querySelector('#wfActor').value='王签收';
    document.querySelector('#wfRole').value='项目经理';
    document.querySelector('#wfOpinion').value='UI 同意签收';
    document.querySelector('#wfSignBtn').click();
  })()`);
  const signed = await wait(`() => document.querySelector('#wfDetailStatus')?.textContent === '已签收'`, 20000);
  check('UI 签收后状态变为已签收', !!signed, await page.ev(`document.querySelector('#wfMsg')?.textContent`));

  const signedUi = JSON.parse(await page.ev(`JSON.stringify({
    events: document.querySelectorAll('.wf-event').length,
    signedVisible: !document.querySelector('#wfSigned')?.hidden,
    signedText: document.querySelector('#wfSigned')?.textContent,
    hash: document.querySelector('#wfHash')?.textContent,
    readonly: document.querySelector('#wfForm')?.classList.contains('wf-readonly'),
    submitDisabled: document.querySelector('#wfSubmitBtn')?.disabled,
    rejectDisabled: document.querySelector('#wfRejectBtn')?.disabled,
    signDisabled: document.querySelector('#wfSignBtn')?.disabled,
    reportDisabled: document.querySelector('#wfReportBtn')?.disabled,
    timelineText: document.querySelector('#wfTimeline')?.textContent,
    overflow: (() => { const d=document.querySelector('.wf-detail'); return d ? d.scrollWidth - d.clientWidth : -1; })()
  })`));
  check('签收后审计轨迹 6 条且含驳回/签收意见',
    signedUi.events === 6 && /范围说明需补充/.test(signedUi.timelineText || '')
      && /UI 同意签收/.test(signedUi.timelineText || '') && /王签收/.test(signedUi.timelineText || ''),
    `events=${signedUi.events}`);
  check('签收卡显示签收人/时间/意见/完整哈希',
    signedUi.signedVisible && /王签收/.test(signedUi.signedText || '')
      && /UI 同意签收/.test(signedUi.signedText || '')
      && (signedUi.hash || '').length === 64
      && (signedUi.signedText || '').includes(signedUi.hash), JSON.stringify({
        visible: signedUi.signedVisible, hash: (signedUi.hash||'').slice(0,16), text: (signedUi.signedText||'').slice(0,100)
      }));
  check('签收后表单只读且仅报告按钮可用',
    signedUi.readonly === true && signedUi.submitDisabled && signedUi.rejectDisabled
      && signedUi.signDisabled && signedUi.reportDisabled === false, JSON.stringify(signedUi).slice(0,180));
  check('1440px 签收详情无横向溢出', signedUi.overflow <= 2, String(signedUi.overflow));

  await snapshot('project_workflow_1440.png');

  // UI 生成签收报告：真实 PDF，等待后端完成后校验提示页数
  await page.ev(`flowReport()`, 180000);
  const reportDone = await wait(`() => {
    const m=document.querySelector('#wfMsg');
    return m && /签收报告已生成/.test(m.textContent||'');
  }`, 180000);
  check('UI 触发生成签收报告并回显页数', !!reportDone,
    await page.ev(`document.querySelector('#wfMsg')?.textContent`));
  await snapshot('project_workflow_report_1440.png');

  // 响应式 1024 / 768：无页面级横向溢出，列表/详情/操作仍可见
  for (const [w, file] of [[1024, 'project_workflow_1024.png'], [768, 'project_workflow_768.png']]) {
    await setViewport(w);
    await goFlow();
    await page.ev(`flowSelect(${JSON.stringify(created.pid)})`);
    await sleep(700);
    const lay = JSON.parse(await page.ev(`JSON.stringify({
      overflow: (() => { const p=document.querySelector('#pg-flow'); return p ? p.scrollWidth - p.clientWidth : -1; })(),
      list: !!document.querySelector('.wf-project'),
      detail: !!document.querySelector('#wfDetailTitle')?.textContent,
      reportBtn: !!document.querySelector('#wfReportBtn'),
      cols: getComputedStyle(document.querySelector('.wf-grid')).gridTemplateColumns
    })`));
    check(`${w}px 签收页无横向溢出且列表/详情可见`,
      lay.overflow <= 2 && lay.list && lay.detail && lay.reportBtn && /px/.test(lay.cols || ''), JSON.stringify(lay));
    await snapshot(file);
  }

  // 回到 1440，跑可访问性
  await setViewport(1440);
  await goFlow();
  await page.ev(`flowSelect(${JSON.stringify(created.pid)})`);
  await sleep(600);
  await loadAxe(page);
  const axe = await axeAudit(page, 'flow-signoff');
  const blockers = axe.violations.filter(v => v.impact === 'critical' || v.impact === 'serious');
  check('项目签收页无 critical/serious 可访问性问题', blockers.length === 0,
    JSON.stringify(blockers.slice(0, 3)));

  const exceptions = page.exceptions;
  check('页面运行无 JS 异常', exceptions.length === 0, JSON.stringify(exceptions.slice(0, 3)));

  finish({
    project_id: created.pid, title: created.title, events: signedUi.events,
    version_hash: signedUi.hash,
    screenshots: ['project_workflow_1440.png', 'project_workflow_report_1440.png',
                 'project_workflow_1024.png', 'project_workflow_768.png'],
    axe
  });
  await page.close();
} catch (e) {
  console.error('SUITE ERROR', e);
  try { finish({ error: String(e) }); } catch {}
  try { await page.close(); } catch {}
  process.exitCode = 1;
}
