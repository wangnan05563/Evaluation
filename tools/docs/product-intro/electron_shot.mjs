/** 桌面版截图：以开发态 Electron 壳启动真实窗口（本地引擎 sidecar + 前端），
 *  经 CDP 截取窗口内容。仅截「上传需求」首屏，不进入配置/历史（避免拍到本机数据）。
 *  用法：node tools/docs/product-intro/electron_shot.mjs（需先 node shots.mjs 造好底图目录）
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXE = path.join(ROOT, 'dev-shell', 'node_modules', 'electron', 'dist', 'electron.exe');
const CDP_PORT = 9444;
const OUT = path.join(ROOT, 'build', 'shots', '10_desktop.png');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const killTree = pid => { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* noop */ } };

if (!fs.existsSync(EXE)) throw new Error('未找到 electron.exe: ' + EXE);

const env = { ...process.env, WE_PYTHON: process.env.PYTHON || 'python' };
delete env.ELECTRON_RUN_AS_NODE;   // 本机会话全局置 1，electron 会被当成 node 跑
const proc = spawn(EXE, ['--disable-gpu', `--remote-debugging-port=${CDP_PORT}`, '.'], { cwd: path.join(ROOT, 'dev-shell'), stdio: 'ignore', env });
let done = false;
const finish = (code) => { if (done) return; done = true; killTree(proc.pid); process.exit(code); };
setTimeout(() => { console.error('超时'); finish(3); }, 180000);

let page = null;
for (let i = 0; i < 90; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    page = list.find(p => p.type === 'page' && /127\.0\.0\.1:8020/.test(p.url || ''));
    if (page) break;
  } catch { /* 未就绪 */ }
  await sleep(1000);
}
if (!page) { console.error('未拿到 Electron 页面目标:', JSON.stringify(await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => ({ json: async () => [] }))).json(), null, 0)); finish(4); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.no(new Error(JSON.stringify(m.error))) : p.ok(m.result); } };
const send = (m, p, s) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p, ...(s ? { sessionId: s } : {}) })); return new Promise((ok, no) => { pend.set(i, { ok, no }); setTimeout(() => { if (pend.has(i)) { pend.delete(i); no(new Error('cdp timeout: ' + m)); } }, 30000); }); };
const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true }); return r.result.value; };

await send('Page.enable', {}, undefined);
for (let i = 0; i < 60; i++) {
  if (await ev(`typeof goPage==='function'&&document.readyState==='complete'`)) break;
  await sleep(500);
}
await ev(`try{localStorage.setItem('wl_guide_done_pages_v1',JSON.stringify({work:true,pert:true,config:true,help:true}))}catch(e){}`);
await ev(`goPage('work');goStep('upload');window.scrollTo(0,0)`);
await sleep(5200);   // 等「已恢复上次未完成的录入」toast 自动消失

// 优先抓真实窗口（含标题栏/边框，能看出是桌面版）；失败再退回页面级截图。
// 注意：窗口一旦大于屏幕，PrintWindow 取到的离屏区域是空白的，所以不放大窗口。
const PY = process.env.PYTHON || 'python';
const native = spawnSync(PY, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'win_shot.py'), String(proc.pid), OUT], { encoding: 'utf8' });
if (native.status === 0) {
  console.log('→ 窗口截图', OUT, fs.statSync(OUT).size, 'bytes');
} else {
  console.log('窗口截图失败，退回页面截图:', (native.stdout || '') + (native.stderr || ''));
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('→ 页面截图', OUT, fs.statSync(OUT).size, 'bytes');
}
finish(0);
