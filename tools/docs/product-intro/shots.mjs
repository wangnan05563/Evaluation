/** 产品介绍文档配图：驱动真实 UI（隔离实例 + 无头 Chrome/CDP）逐页抓图。
 *  产物落 release/shots/*.png（采集底图，不入库），供 compose_shots.py 拼成文档图版。
 *  用法：node tools/docs/product-intro/shots.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PY = process.env.PYTHON || 'python';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API_PORT = 8032, CDP_PORT = 9334, API = `http://127.0.0.1:${API_PORT}`, CDP = `http://127.0.0.1:${CDP_PORT}`;
const SHOTS = path.join(ROOT, 'release', 'shots');
const DATA = path.join(ROOT, 'release', 'tmp', '_shotdata');
const PROFILE = path.join(ROOT, 'release', 'tmp', '_shotchrome');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const killTree = pid => { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* noop */ } };

for (const d of [SHOTS, DATA, PROFILE]) fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(PROFILE, { recursive: true });

let server = null, chrome = null;
const cleanup = () => { if (server) { killTree(server.pid); server = null; } if (chrome) { killTree(chrome.pid); chrome = null; } };
process.on('exit', cleanup);
['SIGINT', 'SIGTERM'].forEach(s => process.on(s, () => { cleanup(); process.exit(130); }));

server = spawn(PY, ['-u', 'scripts/server.py', String(API_PORT), '--serve-frontend'],
  { cwd: ROOT, env: { ...process.env, WE_DATA: DATA, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.resume(); server.stderr.resume();
for (let i = 0; i < 60; i++) { try { const r = await fetch(`${API}/health`); if (r.ok) break; } catch { /* 未就绪 */ } await sleep(500); }
if (!(await fetch(`${API}/health`).then(r => r.ok).catch(() => false))) throw new Error('API 未就绪');

chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--force-device-scale-factor=2', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { const r = await fetch(`${CDP}/json/version`); if (r.ok) break; } catch { /* 未就绪 */ } await sleep(400); }

const post = async (p, body) => (await fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();

// ---------- 造数据：识别一次 + 同一需求两版（历史对比 / 版本徽标） ----------
const b64 = fs.readFileSync(path.join(ROOT, 'data/testdocs/t00928_req.docx')).toString('base64');
const rec = await post('/api/recognize', { name: '综合服务平台需求说明书V0.1.docx', b64, job: 'shotrec' });
if (!rec.ok) throw new Error('识别失败: ' + JSON.stringify(rec).slice(0, 300));
const items = rec.items;
console.log(`识别候选 ${items.length} 条`);

const hist1 = items.map(it => ({ ...it, ok: true, cx: '中', reuse: it.reuse || '中', modify: it.modify || '新增' }));
const g1 = await post('/api/generate', { items, method: '估算功能点', title: '综合服务平台需求说明书V0.1', job: 'shotg1', hist_items: hist1, source_name: '综合服务平台需求说明书V0.1.docx' });
if (!g1.ok) throw new Error('生成 v1 失败: ' + JSON.stringify(g1).slice(0, 300));
fs.copyFileSync(path.join(DATA, 'generated', g1.sid), path.join(ROOT, 'release', 'tmp', '_shot_v1.xlsx'));

const hist2 = hist1.map(x => ({ ...x }));
hist2[0].cx = '低';
hist2[0].reuse = '高';
hist2.splice(2, 1);
hist2.push({ ...hist1[0], desc: '新增：可疑交易上报结果回执查询', system: hist1[0].system, cx: '中', reuse: '中', modify: '新增' });
const grp = (await (await fetch(`${API}/api/history/${g1.history_id}/group`)).json()).versions[0].version_group;
const g2 = await post('/api/generate', { items, method: '估算功能点', title: '综合服务平台需求说明书V0.1', job: 'shotg2', hist_items: hist2, reopen_group: grp, source_name: '综合服务平台需求说明书V0.1.docx' });
if (!g2.ok) throw new Error('生成 v2 失败: ' + JSON.stringify(g2).slice(0, 300));
console.log(`历史两版：${g1.history_id} / ${g2.history_id}，成品 ${g1.sid}`);

// ---------- CDP ----------
const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket((await (await fetch(`${CDP}/json/version`)).json()).webSocketDebuggerUrl);
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.no(new Error(JSON.stringify(m.error))) : p.ok(m.result); } };
const send = (m, p, s, tmo = 30000) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p, ...(s ? { sessionId: s } : {}) })); return new Promise((ok, no) => { pend.set(i, { ok, no }); setTimeout(() => { if (pend.has(i)) { pend.delete(i); no(new Error('cdp timeout: ' + m)); } }, tmo); }); };
const S = (await send('Target.attachToTarget', { targetId: t.id, flatten: true })).sessionId;
await send('Page.enable', {}, S); await send('Runtime.enable', {}, S); await send('DOM.enable', {}, S);
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false }, S);
const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, userGesture: true, awaitPromise: true }, S); if (r.exceptionDetails) throw new Error('eval:' + (r.exceptionDetails.exception?.description || '')); return r.result.value; };
const setFiles = async (sel, files) => { const { root } = await send('DOM.getDocument', { depth: 1 }, S); const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: sel }, S); await send('DOM.setFileInputFiles', { nodeId, files }, S); };
const waitFor = async (expr, sec = 30) => { for (let i = 0; i < sec * 5; i++) { try { if (await ev(expr)) return true; } catch { /* 页面未就绪 */ } await sleep(200); } return false; };
const save = async (file, params) => { const r = await send('Page.captureScreenshot', { format: 'png', ...params }, S, 60000); fs.writeFileSync(path.join(SHOTS, file), Buffer.from(r.data, 'base64')); console.log('  →', file); };
const shotView = f => save(f, { captureBeyondViewport: false });
const shotEl = async (f, sel, pad = 0) => {
  const first = await ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return null;el.scrollIntoView({block:'center'});return true;})()`);
  if (!first) throw new Error('未找到元素: ' + sel);
  await sleep(350);
  const b = await ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});const r=el.getBoundingClientRect();
    return {x:r.x+scrollX,y:r.y+scrollY,w:r.width,h:r.height};})()`);
  if (b.w < 40 || b.h < 40) throw new Error(`元素尺寸异常(${b.w}x${b.h})，多半是 display:none 或尚未渲染: ${sel}`);
  await save(f, { clip: { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.w + pad * 2, height: b.h + pad * 2, scale: 1 }, captureBeyondViewport: true });
};
/** 卡片「当前视口内可见部分」：避免 sticky 操作栏在整卡长截图里浮到中间。 */
const shotElVisible = async (f, sel, pad = 0) => {
  const ok = await ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return null;el.scrollIntoView({block:'start'});return true;})()`);
  if (!ok) throw new Error('未找到元素: ' + sel);
  await sleep(450);
  const b = await ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});const r=el.getBoundingClientRect();
    const y=Math.max(0,r.top), y2=Math.min(innerHeight,r.bottom);
    return {x:r.left+scrollX,y:y+scrollY,w:r.width,h:y2-y};})()`);
  await save(f, { clip: { x: Math.max(0, b.x - pad), y: Math.max(0, b.y), width: b.w + pad * 2, height: b.h, scale: 1 }, captureBeyondViewport: true });
};

await send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('wl_guide_done_pages_v1',JSON.stringify({work:true,pert:true,config:true,help:true}))}catch(e){}try{localStorage.removeItem('we_form_state_v1');localStorage.removeItem('wl_last_history')}catch(e){}` }, S);
await send('Page.navigate', { url: API + '/' }, S);
if (!(await waitFor(`typeof goPage==='function'&&document.readyState!=='loading'`, 40))) throw new Error('前端未就绪');
await sleep(800);

// 1) 上传页（三步流程之①）
await ev(`goPage('work');goStep('upload');`);
await sleep(400);
await shotView('flow_upload.png');

// 2) 进入审核页
await setFiles('#file', [path.join(ROOT, 'data/testdocs/t00928_req.docx')]);
await ev(`document.querySelector('#startBtn').click();`);
if (!(await waitFor(`document.body.dataset.step==='review'`))) throw new Error('未进入复核页');
await waitFor(`document.querySelectorAll('#tbody tr').length>0`, 20);
await sleep(600);
// 保留 2 条待确认，其余确认：页面同时呈现「已确认 / 待确认」两种状态
await ev(`items.forEach((it,i)=>{it.ok=i<items.length-2;});render();`);
await sleep(400);
await shotView('01_overview.png');
await shotElVisible('03_review_table.png', '#v-review .av > .glass.pad:last-child', 6);
await shotEl('03_review_dock.png', '#v-review .dockbar', 0);

// 3) 全部确认 → 生成结果页（三步流程之③）
await ev(`(()=>{const c=document.querySelector('#ckAll');c.checked=true;c.dispatchEvent(new Event('change'));})()`);
await sleep(300);
await ev(`document.querySelector('#goRes').click();`);
if (!(await waitFor(`document.body.dataset.step==='result'`))) throw new Error('未进入结果页');
await waitFor(`document.querySelectorAll('#chartGrid canvas').length>=4`, 30);
await sleep(1200);
await ev(`window.scrollTo(0,0)`);
await sleep(300);
await shotView('flow_result.png');

// 界面生成会多出一条名为夹具文件名的历史记录：删掉，只保留同一需求的两版演示数据
await ev(`histOpen()`);
await waitFor(`document.querySelectorAll('#histRows tr[data-hid]').length>=3`, 20);
const dupId = await ev(`(()=>{const tr=[...document.querySelectorAll('#histRows tr[data-hid]')].find(t=>t.textContent.includes('t00928_req'));return tr?tr.dataset.hid:null;})()`);
if (dupId) { const del = await post('/api/history/' + dupId, {}); console.log('  删除界面生成的重复历史:', dupId, del.ok); }
await ev(`histClose()`);

// 4) 用户故事（结果页导出区）：histClose 后视图已离开结果页，先切回；结果页会重建 items，故补齐 ok
await ev(`goPage('work');goStep('result')`);
await sleep(700);
await ev(`items.forEach(it=>it.ok=true);storyGen();`);
const storyOk = await waitFor(`(()=>{const b=document.querySelector('#storyBox');const ta=b&&b.querySelector('textarea');
  return !!ta&&b.getBoundingClientRect().width>200&&ta.value.length>200;})()`, 20);
if (!storyOk) throw new Error('用户故事未生成（#storyBox 仍为空）');
await sleep(500);
await shotEl('09_story.png', '#storyBox', 8);

// 5) 快速估算页
await ev(`goPage('fast')`);
await sleep(800);
await ev(`(()=>{const box=document.querySelector('#fastCounts');const v={ILF:12,EIF:5,EI:30,EO:12,EQ:8};
  box.querySelectorAll('input').forEach(i=>{i.value=v[i.dataset.k]??0;i.dispatchEvent(new Event('input'));});})()`);
await sleep(800);
await shotEl('04_fast.png', '#pg-fast .cfg-grid', 8);

// 6) PERT：新建项目 + 录入阶段明细（步骤2）与汇总（步骤3）
await ev(`goPage('pert')`);
await sleep(800);
await ev(`(()=>{document.querySelector('#pertName').value='综合服务平台—票据模块';document.querySelector('#pertEst').value='王南';})()`);
await ev(`pertNew()`);
await waitFor(`document.body.dataset.pertstep==='edit'`, 20);
const pertRows = [
  ['需求分析', '反洗钱业务规则梳理与需求确认', 4, 6, 9],
  ['系统设计', '可疑交易模型库与上报流程设计', 5, 8, 12],
  ['开发', '大额/可疑交易识别与报送功能开发', 12, 18, 26],
  ['开发', '客户风险等级调整与回溯开发', 8, 12, 18],
  ['开发', '报文生成与接口联调', 6, 10, 15],
  ['实施', '数据迁移与存量客户风险重评', 5, 8, 14],
  ['实施', 'UAT 测试与缺陷修复', 6, 9, 13],
  ['公共及远程', '环境部署与运维脚本', 3, 5, 8],
  ['现场维护', '上线支持与培训', 3, 4, 7],
];
for (const [ph, d, o, m, p] of pertRows) {
  const r = await ev(`(async()=>{document.querySelector('#pertPhase').value=${JSON.stringify(ph)};
    document.querySelector('#pertD').value=${JSON.stringify(d)};
    document.querySelector('#pertO').value=${o};document.querySelector('#pertM').value=${m};document.querySelector('#pertP').value=${p};
    await pertAdd();return document.querySelectorAll('#pertTbody tr').length;})()`);
  if (!r) throw new Error('PERT 录入失败: ' + d);
}
await sleep(400);
await shotEl('pert_edit.png', '#pv-edit .glass.pad', 8);
await ev(`pertStep('gen')`);
await sleep(500);
await shotEl('pert_gen.png', '#pv-gen .glass.pad', 8);

// 7) 配置中心：大模型识别增强
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 2, mobile: false }, S);
await ev(`goPage('config')`);
await sleep(1500);
await waitFor(`document.querySelectorAll('#providerSel option').length>0`, 15);
await sleep(400);
await ev(`(()=>{const sw=document.querySelector('#llmSwitch');sw.classList.add('on');sw.setAttribute('aria-checked','true');})()`);
await shotEl('06_config_llm.png', '#pg-config .cfg-grid > .glass.pad:first-child', 8);
const lbl = await ev(`(()=>{const l=document.querySelector('#llmKey').closest('.fill').querySelector('label');const r=l.getBoundingClientRect();const p=l.parentElement.getBoundingClientRect();return {lw:Math.round(r.width),lh:Math.round(r.height),pw:Math.round(p.width),text:l.textContent.trim()};})()`);
console.log('  config 记住 label 尺寸:', JSON.stringify(lbl));
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false }, S);

// 8) 历史列表 + 两版 diff
await ev(`goPage('work')`);
await sleep(400);
await ev(`histOpen()`);
await waitFor(`document.querySelectorAll('#histRows tr[data-hid]').length>=2`, 20);
await sleep(400);
await shotEl('12_hist_list.png', '#v-history > .glass.pad', 8);
await ev(`(()=>{const a=${JSON.stringify(g1.history_id)},b=${JSON.stringify(g2.history_id)};
  diffSel=[a,b];
  document.querySelector('#histRows tr[data-hid="'+a+'"] .hdif').checked=true;
  document.querySelector('#histRows tr[data-hid="'+b+'"] .hdif').checked=true;
  document.querySelector('#hdifBtn').disabled=false;})()`);
await ev(`histDiff()`);
await waitFor(`!!document.querySelector('#histDiff table')`, 30);
await sleep(500);
await ev(`document.querySelector('#histDiff').scrollIntoView({block:'center'})`);
await sleep(300);
await shotEl('08_hist_diff.png', '#histDiff', 8);

// 9) 英文 + 深色主题（结果页）
await ev(`histClose();goStep('result')`);
await waitFor(`document.querySelectorAll('#chartGrid canvas').length>=4`, 20);
await ev(`setThemeMode('dark')`);
await ev(`setLang('en-US')`);
await sleep(4000);   // 等「语言已切换」toast 自动消失，避免压在图表上
await ev(`window.scrollTo(0,0)`);
await sleep(400);
await shotView('11_en_dark.png');

console.log(JSON.stringify({ ok: true, sid: g1.sid, shots: fs.readdirSync(SHOTS) }));
await send('Target.closeTarget', { targetId: t.id }).catch(() => {});
cleanup();
process.exit(0);
