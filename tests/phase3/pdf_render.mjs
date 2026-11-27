/** Chromium printToPDF 渲染器：输入 HTML → 输出 PDF，带页脚页码与书签。 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPage } from './cdp.mjs';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const input = path.resolve(process.argv[2] || 'docs/spikes/pdf-engine-20261122/sample-audit.html');
const output = path.resolve(process.argv[3] || 'docs/spikes/pdf-engine-20261122/sample-audit-chromium.pdf');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'we_pdf_'));
const port = 9336;
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${path.join(tmp, 'chrome')}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch { /* noop */ }
    await sleep(300);
  }
  process.env.PHASE3_APP = 'file:///';
  const page = await openPage({ width: 794, height: 1123, cdp: `http://127.0.0.1:${port}` });
  const url = 'file:///' + input.replaceAll('\\', '/').replace(/^\//, '');
  await page.nav(url, `document.readyState === 'complete'`);
  await page.ev(`document.fonts.ready.then(() => true)`);
  await sleep(700);
  const t0 = Date.now();
  const r = await page.send('Page.printToPDF', {
    landscape: false,
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: '<div style="width:100%;font-size:8px;color:#6b7280;text-align:center;font-family:Arial,sans-serif;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    marginTop: 0.65,
    marginBottom: 0.85,
    marginLeft: 0.55,
    marginRight: 0.55,
    generateDocumentOutline: true,
  }, page.S);
  const ms = Date.now() - t0;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, Buffer.from(r.data, 'base64'));
  const meta = { input, output, bytes: fs.statSync(output).size, render_ms: ms, engine: 'chromium-printToPDF' };
  fs.writeFileSync(output.replace(/\.pdf$/, '.json'), JSON.stringify(meta, null, 2));
  await page.shot(output.replace(/\.pdf$/, '-p1.png'));
  console.log(JSON.stringify(meta));
  await page.close();
} finally {
  try { spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* noop */ }
}
