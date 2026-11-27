/** 生产用 Chromium printToPDF 渲染器（T06181）。
 *  输入：本地 HTML；输出：PDF + 同名 .json 元数据。
 *  用法：node scripts/pdf_render.mjs <input.html> <output.pdf> [cdpPort]
 *  环境：CHROME_PATH 可指定 Chrome/Edge；WE_PDF_TIMEOUT_MS 控制总超时。
 *  依赖 Node 内置 fetch/WebSocket，不引入额外 npm 包。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const input = path.resolve(process.argv[2] || '');
const output = path.resolve(process.argv[3] || '');
const port = Number(process.argv[4] || process.env.WE_PDF_CDP_PORT || 9336);
const timeoutMs = Number(process.env.WE_PDF_TIMEOUT_MS || 60000);
if (!input || !fs.existsSync(input)) throw new Error(`审计包 HTML 不存在: ${input}`);
if (!output) throw new Error('缺少输出 PDF 路径');

const CHROME = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));
if (!CHROME) throw new Error('未找到 Chrome/Edge；请设置 CHROME_PATH');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'we_pdf_'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${path.join(tmp, 'chrome')}`, '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-networking', '--mute-audio', 'about:blank',
], { stdio: 'ignore' });
chrome.unref();

let ws = null;
try {
  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { ready = true; break; }
    } catch { /* noop */ }
    await sleep(300);
  }
  if (!ready) throw new Error(`Chromium 未就绪: ${port}`);

  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let id = 0;
  const pend = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id); pend.delete(m.id);
      m.error ? p.no(new Error(JSON.stringify(m.error))) : p.ok(m.result);
    }
  };
  const send = (method, params, sessionId, timeout = 30000) => {
    params = params || {};
    const i = ++id;
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((ok, no) => {
      pend.set(i, { ok, no });
      setTimeout(() => { if (pend.has(i)) { pend.delete(i); no(new Error(`cdp timeout: ${method}`)); } }, timeout);
    });
  };
  const S = (await send('Target.attachToTarget', { targetId: target.id, flatten: true })).sessionId;
  await send('Page.enable', {}, S);
  await send('Runtime.enable', {}, S);
  await send('Emulation.setDeviceMetricsOverride', { width: 794, height: 1123, deviceScaleFactor: 1, mobile: false }, S);
  const url = 'file:///' + input.replaceAll('\\', '/').replace(/^\//, '');
  await send('Page.navigate', { url }, S);
  for (let i = 0; i < 80; i++) {
    const r = await send('Runtime.evaluate', { expression: `document.readyState === 'complete'`, returnByValue: true }, S);
    if (r.result.value) break;
    await sleep(200);
  }
  await send('Runtime.evaluate', { expression: `document.fonts.ready.then(() => true)`, awaitPromise: true, returnByValue: true }, S);
  await sleep(500);

  const t0 = Date.now();
  const r = await send('Page.printToPDF', {
    landscape: false,
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: '<div style="width:100%;font-size:8px;color:#6b7280;text-align:center;font-family:Arial,sans-serif;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    marginTop: 0.55,
    marginBottom: 0.75,
    marginLeft: 0.5,
    marginRight: 0.5,
    generateDocumentOutline: true,
  }, S, timeoutMs);
  const ms = Date.now() - t0;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, Buffer.from(r.data, 'base64'));
  const meta = { input, output, bytes: fs.statSync(output).size, render_ms: ms, engine: 'chromium-printToPDF', chrome: CHROME };
  fs.writeFileSync(output.replace(/\.pdf$/, '.json'), JSON.stringify(meta, null, 2));
  try { await send('Browser.close', {}, undefined, 3000); } catch { /* noop */ }
  console.log(JSON.stringify(meta));
  // Windows 下 Chrome/CDP 的 WebSocket 关闭事件可能延迟；渲染已完成，直接退出，
  // 由 finally 的 detached taskkill 清理浏览器进程，避免 60s 退出等待拖垮生成预算。
  setTimeout(() => process.exit(0), 200);
} finally {
  try { ws && ws.close(); } catch { /* noop */ }
  try {
    if (process.platform === 'win32') {
      const k = spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore', detached: true, windowsHide: true });
      k.unref();
    } else {
      chrome.kill('SIGKILL');
    }
  } catch { /* noop */ }
  // 不在这里删除 Chrome 的临时 profile：Windows 上目录仍被浏览器占用，
  // rmSync 会等待释放并拖慢单次渲染；由后续清理任务处理旧目录。
}
