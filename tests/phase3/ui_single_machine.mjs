/** T06202 / AC-26：单机版不出现协作/工作组能力，且主流程入口完整。 */
import fs from 'node:fs';
import path from 'node:path';
import { openPage, checker, OUT } from './cdp.mjs';

const { check, finish } = checker('ui-single-machine');
const page = await openPage({ width: 1440, height: 900 });
let result;
const FORBID = ['工作组', '团队成员', '邀请成员', '成员管理', '协作空间', 'RBAC', 'SSO', '单点登录'];
try {
  await page.nav();
  await page.ev(`localStorage.setItem('wl_guide_done_pages_v1', JSON.stringify({work:true,pert:true,config:true,help:true}));`);

  const runtime = JSON.parse(await page.ev(`(async () => {
    const labels=[...document.querySelectorAll('.nav .lbl, #mi-work, #mi-pert, #mi-config, #mi-help')].map(e=>e.textContent.trim()).filter(Boolean);
    const forbidden=${JSON.stringify(FORBID)};
    const hit=[];
    for (const p of ['work','pert','config','help']) {
      goPage(p);
      await new Promise(r=>setTimeout(r,200));
      const text=document.body.innerText;
      for (const w of forbidden) if (text.includes(w)) hit.push(p+':'+w);
    }
    goPage('work');goStep('upload');
    await new Promise(r=>setTimeout(r,200));
    const api=await fetch('/api/team',{cache:'no-store'}).then(r=>r.status).catch(()=>-1);
    return JSON.stringify({labels, hit, apiStatus:api,
      upload:{drop:!!document.querySelector('#drop'), file:!!document.querySelector('#file'), start:!!document.querySelector('#startBtn')},
      step:document.body.dataset.step});
  })()`));
  check('导航与四页面均无协作/工作组/SSO 入口', runtime.hit.length === 0, runtime.hit.join(' | ') || `labels=${runtime.labels.join('/')}`);
  check('未注册团队协作 API（/api/team 非 200）', runtime.apiStatus !== 200, `status=${runtime.apiStatus}`);
  check('单机主流程上传入口完整', runtime.upload.drop && runtime.upload.file && runtime.upload.start, JSON.stringify(runtime.upload));

  const sourceHits = [];
  const roots = ['frontend/src', 'scripts', 'dev-shell'];
  const walk = dir => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'release', 'dist'].includes(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(js|mjs|cjs|py|html|css|json)$/.test(ent.name)) {
        const txt = fs.readFileSync(p, 'utf8');
        for (const w of FORBID) if (txt.includes(w)) sourceHits.push(`${p}:${w}`);
      }
    }
  };
  for (const r of roots) if (fs.existsSync(r)) walk(r);
  // 估算因子中的「团队规模」「客户协作」是 RDF/调整系数，不是协作功能，白名单排除
  const realHits = sourceHits.filter(h => !/gb\.team|团队规模|客户协作/.test(h));
  check('源码无协作功能残留（白名单排除估算因子）', realHits.length === 0, realHits.slice(0, 6).join(' | ') || `扫描 ${roots.join(',')}`);

  await page.shot(path.join(OUT, 'screenshots', 'single_machine_upload_1440.png'));
  result = finish({ runtime, sourceHits: { total: sourceHits.length, real: realHits } });
} catch (e) {
  check('测试执行无异常', false, e.message);
  console.error(e);
} finally {
  await page.close();
}
result = result || finish();
process.exit(result.checks.every(c => c.ok) ? 0 : 1);
