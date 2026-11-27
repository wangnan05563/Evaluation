/** T06200 / REQ-022 / AC-30：外部集成管理页 UI 验收（真实服务 + 本地三类 Mock 上游）。 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { openPage, checker, sleep, OUT, loadAxe, axeAudit } from './cdp.mjs';

const ROOT = path.resolve('.');
const PY = process.env.PYTHON || String.raw`F:\Program Files\Python3.14\python.exe`;
const { check, finish } = checker('integrations-ui');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'we_int_ui_'));
const data = path.join(temp, 'data');
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'config.json'),
                 JSON.stringify({ deployment: { mode: 'workgroup' } }), 'utf8');

let failRemaining = 0;
const calls = [];

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
function startMock(port) {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (e) { body = { raw }; }
      calls.push({ method: req.method, url: req.url, body });
      const send = (code, obj) => {
        const b = JSON.stringify(obj);
        res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
        res.end(b);
      };
      if (failRemaining > 0) { failRemaining -= 1; send(503, { error: 'mock upstream down' }); return; }
      const p = req.url || '';
      if (req.method === 'POST' && (p.endsWith('/issues') || p.endsWith('/issue'))) {
        send(201, { number: 21, iid: 22, key: 'DEMO-21', html_url: 'https://example/21',
                    web_url: 'https://example/22', self: 'https://example/rest/21' });
      } else if (req.method === 'GET' && p.startsWith('/repos/')) {
        send(200, { full_name: 'owner/repo' });
      } else if (req.method === 'GET' && p === '/rest/api/2/myself') {
        send(200, { displayName: 'Mock Bot' });
      } else if (req.method === 'GET' && p.startsWith('/api/v4/projects/')) {
        send(200, { path_with_namespace: 'group/project' });
      } else {
        send(404, { error: 'not found' });
      }
    });
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
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
async function setField(key, value) {
  return page.ev(`(() => {
    const e=[...document.querySelectorAll('#intFields [data-int-key]')].find(x=>x.dataset.intKey===${JSON.stringify(key)});
    if(!e)return false; e.value=${JSON.stringify(value)};
    e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  })()`);
}
async function configure(kind, values) {
  await page.ev(`IntegrationAdmin.select(${JSON.stringify(kind)})`);
  await sleep(250);
  for (const [k, v] of Object.entries(values)) await setField(k, v);
  const enabled = await page.ev(`(() => { const e=document.querySelector('#intEnabled'); if(!e)return false;
    e.checked=true; e.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
  const saved = await page.ev(`IntegrationAdmin.save()`);
  await waitExpr(`/已保存/.test(document.querySelector('#intMsg')?.textContent||'')`, 20000);
  await page.ev(`IntegrationAdmin.test()`);
  return { enabled, saved };
}
async function apiJson() {
  await page.ev(`(async()=>{ const r=await fetch('/api/integrations'); window.__intData=await r.json(); return true; })()`);
  return JSON.parse(await page.ev(`JSON.stringify(window.__intData)`));
}

let server = null;
let mock = null;
let page = null;
let api = '';
try {
  const port = await freePort();
  const mockPort = await freePort();
  api = `http://127.0.0.1:${port}`;
  server = spawn(PY, ['-u', 'scripts/server.py', String(port), '--serve-frontend'], {
    cwd: ROOT, env: { ...process.env, WE_DATA: data, WE_UPDATE_URL: 'off', WE_LTASK_TEST: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d.toString(); });
  server.stderr.on('data', (d) => { log += d.toString(); });
  mock = await startMock(mockPort);
  if (!await waitHealth(api)) throw new Error('server not healthy: ' + log.slice(-1200));

  page = await openPage({ width: 1440, height: 900 });
  await page.nav(api + '/?welcome=0');
  await waitExpr(`typeof RbacAuth!=='undefined' && RbacAuth.state && RbacAuth.state.mode==='workgroup'`, 20000);
  await page.ev(`(()=>{ document.querySelector('#authUsername').value='root';
    document.querySelector('#authPassword').value='AdminPass123';
    document.querySelector('#authDisplayName').value='系统管理员'; })()`);
  await page.ev(`document.querySelector('#authSubmit').click()`);
  const booted = await waitExpr(`RbacAuth.user && RbacAuth.user.role==='admin' && document.querySelector('#authGate').hidden===true`, 30000);
  check('创建管理员并进入工作组', booted);

  await page.ev(`goPage('team')`);
  const cardReady = await waitExpr(`document.body.dataset.page==='team'
    && document.querySelectorAll('#intTabs .int-tab').length===3
    && document.querySelectorAll('#intSummary .int-chip').length===3
    && document.querySelectorAll('#intFields [data-int-key]').length>=3`, 30000);
  const team0 = JSON.parse(await page.ev(`JSON.stringify({
    card: document.querySelector('#integrationCard')?.hidden,
    tabs: [...document.querySelectorAll('#intTabs .int-tab')].map(e=>e.textContent),
    chips: [...document.querySelectorAll('#intSummary .int-chip b')].map(e=>e.textContent),
    fields: [...document.querySelectorAll('#intFields [data-int-key]')].map(e=>e.dataset.intKey),
    map: [...document.querySelectorAll('#intMapTitle,#intMapBody,#intMapPriority,#intMapLabels')].map(e=>e.value),
    badge: document.querySelector('#intBadge')?.textContent,
    jobs: document.querySelectorAll('#intJobs li').length,
    empty: document.querySelector('#intJobs .rbac-empty')?.textContent
  })`));
  check('团队页管理员可见外部集成卡与 3 个连接器',
    cardReady && team0.card === false && team0.tabs.length === 3
    && /GitHub/.test(team0.tabs.join('')) && /Jira/.test(team0.tabs.join('')) && /GitLab/.test(team0.tabs.join('')),
    JSON.stringify(team0));
  check('初始字段为 GitHub 的 base_url/repo/token', team0.fields.join(',') === 'base_url,repo,token', team0.fields);
  check('字段映射 4 槽位默认映射到同名本地字段',
    JSON.stringify(team0.map) === JSON.stringify(['title', 'body', 'priority', 'labels']), JSON.stringify(team0.map));
  check('未配置时显示未启用且任务空态', /未启用/.test(team0.badge || '')
    && /暂无同步任务/.test(team0.empty || ''), JSON.stringify([team0.badge, team0.empty]));

  const base = `http://127.0.0.1:${mockPort}`;
  const gh = await configure('github', { base_url: base, repo: 'owner/repo', token: 'ghp-ui-secret' });
  await waitExpr(`/连接正常/.test(document.querySelector('#intMsg')?.textContent||'')`, 30000);
  check('UI 保存 GitHub 配置并测试连接成功', gh.enabled && gh.saved
    && /连接正常/.test(await page.ev(`document.querySelector('#intMsg')?.textContent||''`)),
    await page.ev(`document.querySelector('#intMsg')?.textContent||''`));

  const jira = await configure('jira', { base_url: base, project_key: 'DEMO', issue_type: 'Task',
                                          email: 'bot@example.com', api_token: 'jira-ui-secret' });
  await waitExpr(`/连接正常/.test(document.querySelector('#intMsg')?.textContent||'')`, 30000);
  check('UI 保存 Jira 配置并测试连接成功', jira.enabled && jira.saved);
  const gl = await configure('gitlab', { base_url: base, project: 'group/project', token: 'glpat-ui-secret' });
  await waitExpr(`/连接正常/.test(document.querySelector('#intMsg')?.textContent||'')`, 30000);
  check('UI 保存 GitLab 配置并测试连接成功', gl.enabled && gl.saved);

  const after = await apiJson();
  const conns = after.connectors || [];
  check('三个连接器全部可用且已启用',
    conns.length === 3 && conns.every(c => c.available && c.enabled), JSON.stringify(conns.map(c => [c.kind, c.available, c.enabled])));
  check('接口响应不含三组明文令牌', !JSON.stringify(after).includes('ghp-ui-secret')
    && !JSON.stringify(after).includes('jira-ui-secret') && !JSON.stringify(after).includes('glpat-ui-secret'));
  check('密钥仅以 token_set/api_token_set 暴露',
    conns.find(c => c.kind === 'github').config.token_set === true
    && conns.find(c => c.kind === 'jira').config.api_token_set === true
    && !('token' in conns.find(c => c.kind === 'github').config));

  await page.ev(`IntegrationAdmin.select('github')`);
  await sleep(250);
  await page.ev(`(() => { const e=document.querySelector('#intMapTitle'); e.value='component';
    e.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await page.ev(`(() => { const e=document.querySelector('#intMapBody'); e.value='acceptance';
    e.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await page.ev(`IntegrationAdmin.saveMapping()`);
  await waitExpr(`/字段映射已保存/.test(document.querySelector('#intMsg')?.textContent||'')`, 20000);
  const mapped = (await apiJson()).connectors.find(c => c.kind === 'github').mapping;
  check('字段映射可保存并持久化', mapped.title === 'component' && mapped.body === 'acceptance', JSON.stringify(mapped));

  const syncItems = JSON.stringify([{ component: '票据到期提醒', acceptance: '按到期日筛选',
                                      priority: 'P1', labels: ['需求'] }]);
  await page.ev(`(() => { const e=document.querySelector('#intItems'); e.value=${JSON.stringify(syncItems)};
    e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await page.ev(`IntegrationAdmin.sync()`);
  const synced = await waitExpr(`document.querySelectorAll('#intJobs .int-job.success').length>=1
    && /已同步/.test(document.querySelector('#intMsg')?.textContent||'')`, 30000);
  const syncState = JSON.parse(await page.ev(`JSON.stringify({
    msg: document.querySelector('#intMsg')?.textContent,
    jobs: document.querySelectorAll('#intJobs .int-job').length,
    ok: document.querySelectorAll('#intJobs .int-job.success').length,
    title: window.__intData?.jobs?.[0]?.total
  })`));
  check('UI 同步成功并展示任务日志', synced && syncState.ok >= 1, JSON.stringify(syncState));
  const post = calls.findLast(c => c.method === 'POST');
  check('映射后同步载荷标题取 component', post.body.title === '票据到期提醒', JSON.stringify(post.body));

  failRemaining = 99;
  await page.ev(`(() => { const e=document.querySelector('#intItems'); e.value=${JSON.stringify(JSON.stringify([{ component: '会失败', acceptance: 'x' }]))};
    e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await page.ev(`IntegrationAdmin.sync()`);
  const failed = await waitExpr(`document.querySelectorAll('#intJobs .int-job.failed').length>=1
    && /失败/.test(document.querySelector('#intMsg')?.textContent||'')`, 30000);
  const failState = JSON.parse(await page.ev(`JSON.stringify({
    msg: document.querySelector('#intMsg')?.textContent,
    err: document.querySelector('#intJobs .int-job.failed .int-job-error')?.textContent,
    rows: document.querySelectorAll('#intJobs .int-job-err').length,
    id: document.querySelector('#intJobs .int-job.failed button') ? IntegrationAdmin.state.jobs.find(j=>j.status==='failed')?.id : null
  })`));
  check('UI 展示同步失败与逐条错误原因', failed && /失败/.test(failState.msg || '')
    && /503|失败/.test(failState.err || '') && failState.rows >= 1, JSON.stringify(failState));
  failRemaining = 0;
  await page.ev(`IntegrationAdmin.retry(${JSON.stringify(failState.id)})`);
  const retried = await waitExpr(`/重试成功/.test(document.querySelector('#intMsg')?.textContent||'')
    && document.querySelectorAll('#intJobs .int-job.success').length>=2`, 30000);
  check('UI 重试失败任务成功', retried, await page.ev(`document.querySelector('#intMsg')?.textContent||''`));

  const shots = [];
  await viewport(1440, 900);
  await page.ev(`goPage('team')`);
  await sleep(600);
  await page.shot(path.join(OUT, 'screenshots', 'integrations_team_1440.png'));
  shots.push('integrations_team_1440.png');
  await loadAxe(page);
  const axe1 = await axeAudit(page, 'team');
  check('集成团队页 axe 无 serious/critical 违规',
    (axe1.violations || []).filter(v => v.impact === 'critical' || v.impact === 'serious').length === 0,
    JSON.stringify(axe1.violations));

  for (const [w, name] of [[1024, 'integrations_team_1024.png'], [768, 'integrations_team_768.png']]) {
    await viewport(w, 900);
    await sleep(450);
    const overflow = JSON.parse(await page.ev(`JSON.stringify({
      doc: document.documentElement.scrollWidth - window.innerWidth,
      wrap: document.querySelector('.wrap')?.scrollWidth - document.querySelector('.wrap')?.clientWidth,
      card: document.querySelector('#integrationCard')?.scrollWidth - document.querySelector('#integrationCard')?.clientWidth
    })`));
    check(`${w}px 集成卡无横向溢出`, overflow.doc <= 2 && overflow.wrap <= 2 && overflow.card <= 2, JSON.stringify(overflow));
    await page.shot(path.join(OUT, 'screenshots', name));
    shots.push(name);
  }

  await viewport(1440, 900);
  await page.ev(`(async()=>{ const r=await fetch('/api/rbac/users',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:'eval_int_ui',password:'EvalPass123',display_name:'评估师乙',role:'evaluator'})}); return r.status; })()`);
  await page.ev(`RbacAuth.logout()`);
  await waitExpr(`document.querySelector('#authGate').hidden===false`, 15000);
  await page.ev(`(()=>{document.querySelector('#authUsername').value='eval_int_ui';document.querySelector('#authPassword').value='EvalPass123';})()`);
  await page.ev(`document.querySelector('#authSubmit').click()`);
  await waitExpr(`RbacAuth.user && RbacAuth.user.role==='evaluator' && document.querySelector('#authGate').hidden===true`, 30000);
  await page.ev(`goPage('team')`);
  await waitExpr(`document.body.dataset.page==='team' && document.querySelectorAll('#rbacMatrixBody tr').length===13`, 20000);
  const evalView = JSON.parse(await page.ev(`JSON.stringify({
    card: document.querySelector('#integrationCard')?.hidden,
    sso: document.querySelector('#rbacSsoCard')?.hidden
  })`));
  check('评估师团队页隐藏外部集成与 SSO 管理卡', evalView.card === true && evalView.sso === true, JSON.stringify(evalView));

  check('UI 运行无未捕获 JS 异常', page.exceptions.length === 0, JSON.stringify(page.exceptions.slice(0, 5)));
  finish({ screenshots: shots, api });
} catch (e) {
  check('套件执行完成无异常', false, String(e && e.stack || e));
  finish({ error: String(e && e.message || e) });
} finally {
  try { if (page) await page.close(); } catch (e) {}
  try { if (mock) mock.close(); } catch (e) {}
  try { if (server) killTree(server.pid); } catch (e) {}
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch (e) {}
}
