/** T06353：工作组登录页「本机切回单机版」UI 验证。 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { openPage, sleep } from './cdp.mjs';

const ROOT = path.resolve('.');
const PY = process.env.PYTHON || String.raw`F:\Program Files\Python3.14\python.exe`;
const CDP = process.env.PHASE3_CDP || 'http://127.0.0.1:9340';
const RECOVERY_TOKEN = 'test-local-recovery-token-0123456789';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'we_mode_switch_'));
const data = path.join(temp, 'data');
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ deployment: { mode: 'workgroup' } }), 'utf8');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}
async function waitHealth(api, ms = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(api + '/health', { signal: AbortSignal.timeout(1500) }); if (r.ok) return true; } catch (e) {}
    await sleep(400);
  }
  return false;
}

let server = null;
let page = null;
let outFd = null;
let errFd = null;
try {
  const port = await freePort();
  const api = `http://127.0.0.1:${port}`;
  outFd = fs.openSync(path.join(temp, 'server.out.log'), 'a');
  errFd = fs.openSync(path.join(temp, 'server.err.log'), 'a');
  console.log('DEBUG PY=' + PY + ' exists=' + fs.existsSync(PY) + ' ROOT=' + ROOT);
  server = spawn(PY, ['-u', 'scripts/server.py', String(port), '--serve-frontend'], {
    cwd: ROOT, env: { ...process.env, WE_DATA: data, WE_UPDATE_URL: 'off',
      WE_LOCAL_RECOVERY_TOKEN: RECOVERY_TOKEN }, stdio: ['ignore', outFd, errFd]
  });
  server.on('error', (e) => console.log('SERVER ERROR ' + (e && e.message ? e.message : String(e))));
  if (!await waitHealth(api)) {
    const out = fs.existsSync(path.join(temp, 'server.out.log')) ? fs.readFileSync(path.join(temp, 'server.out.log'), 'utf8') : '';
    const err = fs.existsSync(path.join(temp, 'server.err.log')) ? fs.readFileSync(path.join(temp, 'server.err.log'), 'utf8') : '';
    throw new Error('server not healthy\n' + out + '\n' + err);
  }
  page = await openPage({ cdp: CDP });
  await page.nav(api + '/', 'typeof RbacAuth !== "undefined" && document.readyState !== "loading"');
  await sleep(600);
  const before = JSON.parse(await page.ev(`JSON.stringify({
    mode: document.body.dataset.deployMode,
    gateVisible: document.querySelector('#authGate')?.hidden === false,
    buttonVisible: !!document.querySelector('#authModeStandalone')?.offsetParent,
    buttonText: document.querySelector('#authModeStandalone')?.textContent
  })`));
  console.log('BEFORE ' + JSON.stringify(before));
  if (!(before.mode === 'workgroup' && before.gateVisible && before.buttonVisible)) throw new Error('gate/button not visible');
  await page.ev(`window.weval = { localRecoveryToken: async () => ${JSON.stringify(RECOVERY_TOKEN)} };
    window.confirm = () => false; RbacAuth.switchToStandalone()`);
  await sleep(800);
  const cancelled = JSON.parse(await page.ev(`JSON.stringify({ mode: document.body.dataset.deployMode })`));
  if (cancelled.mode !== 'workgroup') throw new Error('cancel still switched: ' + JSON.stringify(cancelled));
  console.log('CANCEL ' + JSON.stringify(cancelled));
  await page.ev(`window.confirm = () => true; RbacAuth.switchToStandalone()`);
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    const after = JSON.parse(await page.ev(`(async () => JSON.stringify({
      mode: document.body.dataset.deployMode,
      authMode: (await (await fetch('/api/auth/me', { cache: 'no-store' })).json()).mode,
      gateHidden: document.querySelector('#authGate')?.hidden === true
    }))()`));
    if (after.mode === 'standalone' && after.authMode === 'standalone' && after.gateHidden) {
      console.log('AFTER ' + JSON.stringify(after));
      console.log('PASS T06353 mode switch');
      process.exitCode = 0;
      break;
    }
    if (i === 39) throw new Error('mode did not switch: ' + JSON.stringify(after));
  }
} catch (e) {
  console.log('FAIL ' + (e && e.message ? e.message : String(e)));
  process.exitCode = 1;
} finally {
  if (page) await page.close();
  if (server) { try { spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {} }
  await sleep(400);
  for (const fd of [outFd, errFd]) { if (fd !== null) { try { fs.closeSync(fd); } catch (e) {} } }
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch (e) {}
}
