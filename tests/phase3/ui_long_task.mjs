/**
 * T06180 长任务进度管理 UI 实测（AC-07）
 * 覆盖：进度/剩余时间可见、取消 ≤2s、刷新后断点续跑、续跑完成进入复核页。
 * 运行：node tests/phase3/ui_long_task.mjs（由 run_phase3.mjs 拉起隔离实例）
 */
import fs from 'node:fs';
import path from 'node:path';

const CDP = process.env.PHASE3_CDP || 'http://127.0.0.1:9335';
const APP = process.env.PHASE3_APP || 'http://127.0.0.1:8033/';
const DOCX = path.resolve('data', 'testdocs', 't00928_req.docx');
const OUT = path.resolve('docs', 'test-reports', 'phase3-20261122', 'screenshots');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

fs.mkdirSync(OUT, { recursive: true });
const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket((await (await fetch(`${CDP}/json/version`)).json()).webSocketDebuggerUrl);
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
let id = 0; const pend = new Map(); const errors = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.no(new Error(JSON.stringify(m.error))) : p.ok(m.result); }
  else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.exception?.description || 'exception');
};
const send = (method, params, sid) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) })); return new Promise((ok, no) => { pend.set(i, { ok, no }); setTimeout(() => { if (pend.has(i)) { pend.delete(i); no(new Error('cdp timeout: ' + method)); } }, 20000); }); };
const S = (await send('Target.attachToTarget', { targetId: t.id, flatten: true })).sessionId;
await send('Page.enable', {}, S); await send('Runtime.enable', {}, S); await send('DOM.enable', {}, S);
const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, userGesture: true }, S); if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || '')); return r.result.value; };
const shot = async n => { const r = await send('Page.captureScreenshot', { format: 'png' }, S); fs.writeFileSync(path.join(OUT, n), Buffer.from(r.data, 'base64')); };
const setFiles = async (sel, files) => { const { root } = await send('DOM.getDocument', { depth: 1 }, S); const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: sel }, S); await send('DOM.setFileInputFiles', { nodeId, files }, S); };
const waitFor = async (fn, timeout = 60000, label = '') => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await fn()) return true; await sleep(120); } console.log('  !! timeout ' + label); return false; };
const boot = async () => {
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('wl_guide_done_pages_v1',JSON.stringify({work:true,pert:true,config:true,help:true}));}catch(e){}` }, S);
  await send('Page.navigate', { url: APP }, S);
  await waitFor(async () => (await ev(`typeof goPage === 'function' && document.readyState !== 'loading'`)) === true, 30000, '页面就绪');
};

await boot();
await ev(`localStorage.removeItem('we_form_state_v1'); localStorage.removeItem('wl_ltask_recog_v1'); goPage('work'); goStep('upload');`);
await setFiles('#file', [DOCX]);
await sleep(500);
check('S0 上传后开始识别按钮可用', (await ev(`document.querySelector('#startBtn').disabled`)) === false);

await ev(`window.WL_LTASK_TEST_DELAY_MS=1200; document.querySelector('#startBtn').click();`);
const panelOn = await waitFor(async () => (await ev(`!document.querySelector('#ltaskPanel').hidden`)) === true, 10000, '长任务面板');
await waitFor(async () => /解析|提取|扫描|匹配|识别/.test(await ev(`document.querySelector('#ltaskStage').textContent`)), 8000, '真实阶段');
const run = JSON.parse(await ev(`(()=>{const p=document.querySelector('#ltaskPanel');return JSON.stringify({status:p.dataset.status,pct:document.querySelector('#ltaskPct').textContent,stage:document.querySelector('#ltaskStage').textContent,eta:document.querySelector('#ltaskEta').textContent,job:p.dataset.job,cancelHidden:document.querySelector('#ltaskCancel').hidden})})()`));
check('S1 识别请求进入长任务面板', panelOn && run.status === 'running', JSON.stringify(run));
check('S1 面板显示真实阶段与百分比', /解析|识别|准备/.test(run.stage) && /%$/.test(run.pct), `${run.pct} ${run.stage}`);
check('S1 面板显示剩余时间估算', /预计剩余|即将完成/.test(run.eta) && /\d|即将/.test(run.eta), run.eta);
check('S1 运行中取消按钮可见', run.cancelHidden === false);
await shot('long_task_running_1440.png');

const jobId = await ev(`document.querySelector('#ltaskPanel').dataset.job || ''`);
check('S1 任务句柄已写入 localStorage', (await ev(`JSON.parse(localStorage.getItem('wl_ltask_recog_v1')||'{}').id || ''`)) === jobId, jobId);
const t0 = Date.now();
await ev(`document.querySelector('#ltaskCancel').click();`);
const canceled = await waitFor(async () => (await ev(`document.querySelector('#ltaskPanel').dataset.status`)) === 'canceled', 5000, '取消生效');
const cancelMs = await ev(`+ (document.querySelector('#ltaskPanel').dataset.cancelMs || 0)`);
const wallMs = Date.now() - t0;
check('S2 点击取消后 UI 立即停止（≤2s）', canceled && cancelMs < 2000 && wallMs < 2000, `panel ${cancelMs}ms / wall ${wallMs}ms`);
check('S2 取消后展示已取消与续跑入口', (await ev(`!document.querySelector('#ltaskResumeBanner').hidden`)) === true && /已取消|停在/.test(await ev(`document.querySelector('#ltaskResumeStage').textContent`)));
const beforeReload = JSON.parse(await ev(`(()=>{const p=document.querySelector('#ltaskPanel');return JSON.stringify({pct:p.querySelector('#ltaskPct').textContent,stage:document.querySelector('#ltaskStage').textContent})})()`));
check('S2 取消断点保留完成百分比', /%$/.test(beforeReload.pct), JSON.stringify(beforeReload));
await shot('long_task_canceled_1440.png');

await boot();
await ev(`goPage('work'); goStep('upload');`);
const banner = await waitFor(async () => (await ev(`!document.querySelector('#ltaskResumeBanner').hidden`)) === true, 10000, '续跑横幅');
const resumeText = await ev(`document.querySelector('#ltaskResumeStage').textContent`);
check('S3 刷新/重开后识别断点横幅出现', banner, resumeText);
check('S3 横幅标明上次停点', /上次停在/.test(resumeText), resumeText);
await ev(`document.querySelector('#ltaskResumeBtn').click();`);
const resumed = await waitFor(async () => (await ev(`!document.querySelector('#ltaskPanel').hidden`)) === true, 10000, '续跑面板');
check('S3 点击继续后面板重新运行', resumed && (await ev(`document.querySelector('#ltaskPanel').dataset.status`)) === 'running');
for (let i = 0; i < 8; i++) {
  await sleep(1000);
  console.log('  resume poll', i, await ev(`JSON.stringify({status:document.querySelector('#ltaskPanel').dataset.status,stage:document.querySelector('#ltaskStage').textContent,pct:document.querySelector('#ltaskPct').textContent,eta:document.querySelector('#ltaskEta').textContent,banner:!document.querySelector('#ltaskResumeBanner').hidden})`));
}
const reachedReview = await waitFor(async () => (await ev(`document.body.dataset.step`)) === 'review', 90000, '续跑完成进入复核页');
const rows = await ev(`document.querySelectorAll('#tbody .rowr').length`);
check('S3 续跑完成后进入复核页并带回功能点', reachedReview && rows > 0, `rows=${rows}`);
check('S3 完成后任务面板收起', (await ev(`document.querySelector('#ltaskPanel').hidden`)) === true);
check('S3 完成后本地断点清除', (await ev(`localStorage.getItem('wl_ltask_recog_v1') === null`)) === true);
await shot('long_task_resume_result_1440.png');

check('全程无页面异常', errors.length === 0, errors.slice(0, 2).join(' | '));
const report = {
  suite: 'long-task', generated_at: new Date().toISOString(),
  checks: results, metrics: {
    job: jobId, cancel_ui_ms: cancelMs, cancel_wall_ms: wallMs,
    breakpoint_pct: beforeReload.pct, resume_rows: rows, eta_before: run.eta,
    canceled_stage: beforeReload.stage, resume_ok: reachedReview,
  },
};
fs.writeFileSync(path.join('docs', 'test-reports', 'phase3-20261122', 'results', 'ui-long-task.json'),
  JSON.stringify(report, null, 2));
console.log('\n==== 汇总 ====');
const bad = results.filter(r => !r.ok);
console.log(`共 ${results.length} 项，通过 ${results.length - bad.length}，失败 ${bad.length}`);
bad.forEach(b => console.log('  FAIL: ' + b.n));
await send('Target.closeTarget', { targetId: t.id }).catch(() => {});
process.exit(bad.length ? 1 : 0);
