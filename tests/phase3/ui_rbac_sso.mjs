/** T06199 / REQ-021 / AC-25 / AC-28 / AC-29：工作组 RBAC、SSO 回退与团队页 UI 验收。
 *  本套件自起隔离服务（workgroup + 空库），不动 8033 共享实例的数据。
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { openPage, checker, sleep, OUT, loadAxe, axeAudit } from './cdp.mjs';

const ROOT = path.resolve('.');
const PY = process.env.PYTHON || String.raw`F:\Program Files\Python3.14\python.exe`;
const { check, finish } = checker('rbac-sso-ui');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'we_rbac_ui_'));
const data = path.join(temp, 'data');
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
  deployment: { mode: 'workgroup' }, sso: { enabled: false, admin_fallback: true }
}), 'utf8');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}
function killTree(pid) {
  try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
}
async function waitHealth(api, ms = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(api + '/health', { signal: AbortSignal.timeout(1500) }); if (r.ok) return true; } catch (e) {}
    await sleep(400);
  }
  return false;
}
async function setInput(id, value) {
  return page.ev(`(() => {
    const e=document.getElementById(${JSON.stringify(id)});
    if(!e)return false;
    e.value=${JSON.stringify(value)};
    e.dispatchEvent(new Event('input',{bubbles:true}));
    e.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  })()`);
}
async function click(sel) {
  return page.ev(`(() => { const e=document.querySelector(${JSON.stringify(sel)}); if(!e)return false; e.click(); return true; })()`);
}
async function waitExpr(expr, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.ev(expr)) return true;
    await sleep(250);
  }
  return false;
}
async function viewport(w, h = 900) {
  await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, page.S);
  await sleep(350);
}

let server = null;
let page = null;
let api = '';
try {
  const port = await freePort();
  api = `http://127.0.0.1:${port}`;
  server = spawn(PY, ['-u', 'scripts/server.py', String(port), '--serve-frontend'], {
    cwd: ROOT, env: { ...process.env, WE_DATA: data, WE_UPDATE_URL: 'off', WE_LTASK_TEST: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d.toString(); });
  server.stderr.on('data', (d) => { log += d.toString(); });
  const healthy = await waitHealth(api);
  check('隔离工作组服务健康', healthy, api);
  if (!healthy) throw new Error('server not healthy: ' + log.slice(-1200));

  page = await openPage({ width: 1440, height: 900 });
  await page.nav(api + '/?welcome=0');
  await waitExpr(`typeof RbacAuth!=='undefined' && RbacAuth.state && RbacAuth.state.mode==='workgroup'`, 20000);
  await sleep(500);

  const gate0 = JSON.parse(await page.ev(`JSON.stringify({
    mode: document.body.dataset.deployMode,
    gateHidden: document.querySelector('#authGate').hidden,
    locked: document.body.classList.contains('auth-locked'),
    wrapInert: document.querySelector('.wrap')?.hasAttribute('inert'),
    title: document.querySelector('#authTitle')?.textContent,
    bootstrap: !document.querySelector('#authDisplayRow').hidden,
    displayName: !document.querySelector('#authDisplayName').hidden,
    ssoHidden: document.querySelector('#authSsoBtn').hidden,
    teamHidden: document.querySelector('#mi-team').hidden,
    welcomeHidden: document.querySelector('#roleWelcome').hidden
  })`));
  check('工作组空库首屏显示创建管理员门禁', gate0.mode === 'workgroup' && gate0.gateHidden === false
    && gate0.locked && gate0.wrapInert && /创建管理员/.test(gate0.title || '') && gate0.bootstrap,
    JSON.stringify(gate0));
  check('门禁隔离原页面且隐藏角色引导', gate0.welcomeHidden === true && gate0.teamHidden === false, JSON.stringify(gate0));

  await setInput('authUsername', 'root');
  await setInput('authPassword', 'AdminPass123');
  await setInput('authDisplayName', '系统管理员');
  await click('#authSubmit');
  const booted = await waitExpr(`typeof RbacAuth!=='undefined' && RbacAuth.user && RbacAuth.user.role==='admin'
    && document.querySelector('#authGate').hidden && !document.body.classList.contains('auth-locked')`, 30000);
  check('创建管理员后解锁应用', booted, booted ? '' : 'timeout');
  const shell = JSON.parse(await page.ev(`JSON.stringify({
    user: RbacAuth.user?.username, role: RbacAuth.user?.role,
    locked: document.body.classList.contains('auth-locked'),
    wrapInert: document.querySelector('.wrap')?.hasAttribute('inert'),
    teamHidden: document.querySelector('#mi-team').hidden,
    configHidden: document.querySelector('#mi-config').hidden,
    flowHidden: document.querySelector('#mi-flow').hidden
  })`));
  check('管理员会话显示团队/配置/签收入口', shell.user === 'root' && shell.role === 'admin'
    && !shell.locked && !shell.wrapInert && shell.teamHidden === false
    && shell.configHidden === false && shell.flowHidden === false, JSON.stringify(shell));

  await page.ev(`goPage('team')`);
  await waitExpr(`document.body.dataset.page==='team'
    && document.querySelectorAll('#rbacUserRows tr').length>=1
    && document.querySelectorAll('#rbacMatrixBody tr').length===13
    && document.querySelectorAll('#rbacAudit li').length>=1
    && (document.querySelector('#rbacSsoBadge')?.textContent||'').trim().length>0`, 30000);
  const team0 = JSON.parse(await page.ev(`JSON.stringify({
    rows: document.querySelectorAll('#rbacUserRows tr').length,
    matrixRows: document.querySelectorAll('#rbacMatrixBody tr').length,
    matrixCols: document.querySelectorAll('#rbacMatrixHead th').length,
    who: document.querySelector('#rbacWho')?.textContent,
    userCard: document.querySelector('#rbacUsersCard').hidden,
    ssoCard: document.querySelector('#rbacSsoCard').hidden,
    auditCard: document.querySelector('#rbacAuditCard').hidden,
    auditRows: document.querySelectorAll('#rbacAudit li').length,
    ssoBadge: document.querySelector('#rbacSsoBadge')?.textContent
  })`));
  check('团队页显示当前管理员、5 角色×13 权限矩阵与审计', team0.rows === 1 && team0.matrixRows === 13
    && team0.matrixCols === 6 && /root/.test(team0.who || '') && team0.userCard === false
    && team0.ssoCard === false && team0.auditCard === false && team0.auditRows >= 1,
    JSON.stringify(team0));
  check('SSO 未配置在团队页显示未启用', /未启用/.test(team0.ssoBadge || ''), team0.ssoBadge);

  await setInput('rbacNewUser', 'eval1');
  await setInput('rbacNewName', '评估师甲');
  await setInput('rbacNewRole', 'evaluator');
  await setInput('rbacNewPass', 'EvalPass123');
  await click('#rbacAddBtn');
  const added = await waitExpr(`document.querySelectorAll('#rbacUserRows tr').length>=2
    && /成员已添加/.test(document.querySelector('#rbacUserMsg')?.textContent||'')`, 20000);
  check('管理员通过 UI 添加评估师成员', added, await page.ev(`document.querySelector('#rbacUserMsg')?.textContent||''`));

  await page.ev(`RbacAuth.logout()`);
  await waitExpr(`document.querySelector('#authGate').hidden===false
    && RbacAuth.user===null && document.querySelector('#authDisplayRow').hidden===false`, 15000);
  const login0 = JSON.parse(await page.ev(`JSON.stringify({
    gateHidden: document.querySelector('#authGate').hidden,
    title: document.querySelector('#authTitle')?.textContent,
    bootstrap: !document.querySelector('#authDisplayRow').hidden,
    ssoHidden: document.querySelector('#authSsoBtn').hidden,
    ssoLabel: document.querySelector('#authSsoLabel')?.textContent
  })`));
  check('退出后回到账号密码登录门禁', login0.gateHidden === false && !login0.bootstrap
    && /工作组登录/.test(login0.title || '') && login0.ssoHidden === false, JSON.stringify(login0));

  await click('#authSsoBtn');
  const ssoFallback = await waitExpr(`document.querySelector('#authSsoMsg').hidden===false
    && document.querySelector('#authFallbackBox').hidden===false`, 15000);
  const ssoText = await page.ev(`document.querySelector('#authSsoMsg')?.textContent||''`);
  check('SSO 未配置时说明失败并可回退管理员', ssoFallback && /SSO/.test(ssoText), ssoText);
  await click('#authFallback');
  const focused = await page.ev(`document.activeElement && document.activeElement.id==='authUsername'`);
  check('回退按钮把焦点交给管理员账号输入', !!focused);

  await setInput('authUsername', 'eval1');
  await setInput('authPassword', 'EvalPass123');
  await click('#authSubmit');
  const evalIn = await waitExpr(`RbacAuth.user && RbacAuth.user.role==='evaluator'
    && document.querySelector('#authGate').hidden===true`, 30000);
  check('评估师账号登录成功', evalIn);
  const evalShell = JSON.parse(await page.ev(`JSON.stringify({
    role: RbacAuth.user?.role, configHidden: document.querySelector('#mi-config').hidden,
    teamHidden: document.querySelector('#mi-team').hidden, flowHidden: document.querySelector('#mi-flow').hidden,
    canSign: RbacAuth.can('project.sign'), canUsers: RbacAuth.can('user.manage'),
    canSettings: RbacAuth.can('settings.read')
  })`));
  check('评估师看不到配置入口且无签收/管用户权限', evalShell.role === 'evaluator'
    && evalShell.configHidden === true && evalShell.teamHidden === false && evalShell.flowHidden === false
    && evalShell.canSign === false && evalShell.canUsers === false && evalShell.canSettings === false,
    JSON.stringify(evalShell));

  await page.ev(`goPage('team')`);
  await waitExpr(`document.body.dataset.page==='team' && document.querySelectorAll('#rbacMatrixBody tr').length===13`, 20000);
  const evalTeam = JSON.parse(await page.ev(`JSON.stringify({
    userCard: document.querySelector('#rbacUsersCard').hidden,
    ssoCard: document.querySelector('#rbacSsoCard').hidden,
    auditCard: document.querySelector('#rbacAuditCard').hidden,
    matrixRows: document.querySelectorAll('#rbacMatrixBody tr').length,
    who: document.querySelector('#rbacWho')?.textContent
  })`));
  check('评估师团队页只保留本人信息与权限矩阵', evalTeam.userCard === true && evalTeam.ssoCard === true
    && evalTeam.auditCard === true && evalTeam.matrixRows === 13 && /评估师甲/.test(evalTeam.who || ''),
    JSON.stringify(evalTeam));

  await page.ev(`goPage('config')`);
  await sleep(350);
  const configBlocked = JSON.parse(await page.ev(`JSON.stringify({
    page: document.body.dataset.page,
    toast: document.querySelector('#toast')?.textContent || ''
  })`));
  check('评估师直接进入配置中心被拦截', configBlocked.page === 'team' && /无权|权限/.test(configBlocked.toast || ''),
    JSON.stringify(configBlocked));

  await page.ev(`RbacAuth.logout()`);
  await waitExpr(`document.querySelector('#authGate').hidden===false && RbacAuth.user===null`, 15000);
  await setInput('authUsername', 'root');
  await setInput('authPassword', 'AdminPass123');
  await click('#authSubmit');
  await waitExpr(`RbacAuth.user && RbacAuth.user.role==='admin' && document.querySelector('#authGate').hidden===true`, 30000);
  await page.ev(`goPage('team')`);
  await waitExpr(`document.body.dataset.page==='team' && document.querySelectorAll('#rbacUserRows tr').length>=2`, 20000);
  const adminAgain = JSON.parse(await page.ev(`JSON.stringify({
    userCard: document.querySelector('#rbacUsersCard').hidden,
    ssoCard: document.querySelector('#rbacSsoCard').hidden,
    auditCard: document.querySelector('#rbacAuditCard').hidden,
    auditRows: document.querySelectorAll('#rbacAudit li').length,
    provider: document.querySelector('#rbacSsoProvider')?.value,
    secretPlaceholder: document.querySelector('#rbacSsoSecret')?.placeholder
  })`));
  check('管理员重新登录后团队页恢复全部管理卡', adminAgain.userCard === false && adminAgain.ssoCard === false
    && adminAgain.auditCard === false && adminAgain.auditRows >= 2 && adminAgain.secretPlaceholder.includes('未配置'),
    JSON.stringify(adminAgain));
  check('SSO 表单含 OIDC 配置项', adminAgain.provider !== undefined, JSON.stringify(adminAgain));

  const shots = [];
  await viewport(1440, 900);
  await page.ev(`goPage('team')`);
  await sleep(500);
  await page.shot(path.join(OUT, 'screenshots', 'rbac_team_1440.png'));
  shots.push('rbac_team_1440.png');
  await loadAxe(page);
  const axe1 = await axeAudit(page, 'team');
  check('团队页 axe 无 serious/critical 违规',
    (axe1.violations || []).filter(v => v.impact === 'critical' || v.impact === 'serious').length === 0,
    JSON.stringify(axe1.violations));

  for (const [w, name] of [[1024, 'rbac_team_1024.png'], [768, 'rbac_team_768.png']]) {
    await viewport(w, 900);
    await sleep(350);
    const overflow = JSON.parse(await page.ev(`JSON.stringify({
      doc: document.documentElement.scrollWidth - window.innerWidth,
      wrap: document.querySelector('.wrap')?.scrollWidth - document.querySelector('.wrap')?.clientWidth
    })`));
    check(`${w}px 团队页无横向溢出`, overflow.doc <= 2 && overflow.wrap <= 2, JSON.stringify(overflow));
    await page.shot(path.join(OUT, 'screenshots', name));
    shots.push(name);
  }

  await viewport(1440, 900);
  await page.ev(`RbacAuth.logout()`);
  await waitExpr(`document.querySelector('#authGate').hidden===false`, 15000);
  await sleep(500);
  await page.shot(path.join(OUT, 'screenshots', 'rbac_login_1440.png'));
  shots.push('rbac_login_1440.png');
  const axe2 = await axeAudit(page, 'auth-gate');
  check('登录门禁 axe 无 serious/critical 违规',
    (axe2.violations || []).filter(v => v.impact === 'critical' || v.impact === 'serious').length === 0,
    JSON.stringify(axe2.violations));

  check('UI 运行无未捕获 JS 异常', page.exceptions.length === 0, JSON.stringify(page.exceptions.slice(0, 5)));
  finish({ screenshots: shots, api });
} catch (e) {
  check('套件执行完成无异常', false, String(e && e.stack || e));
  finish({ error: String(e && e.message || e) });
} finally {
  try { if (page) await page.close(); } catch (e) {}
  try { if (server) killTree(server.pid); } catch (e) {}
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch (e) {}
}
