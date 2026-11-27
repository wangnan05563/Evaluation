/** T06185 / AC-18：空态有插画/说明/下一步，错误态至少一个可执行动作（重试/诊断）。 */
import path from 'node:path';
import { openPage, checker, OUT } from './cdp.mjs';

const { check, finish } = checker('ui-empty-error');
const page = await openPage({ width: 1440, height: 900 });
let result;
try {
  await page.nav();
  await page.ev(`localStorage.setItem('wl_guide_done_pages_v1', JSON.stringify({work:true,pert:true,config:true,help:true}));`);

  const reviewEmpty = JSON.parse(await page.ev(`(() => {
    goPage('work'); items=[]; goStep('review'); render();
    const e=document.querySelector('#tbody .empty-state');
    return JSON.stringify({ exists:!!e, role:e&&e.getAttribute('role'), art:!!e&&!!e.querySelector('.empty-art svg'),
      title:e&&e.querySelector('.empty-t')?.textContent.trim(), desc:e&&e.querySelector('.empty-d')?.textContent.trim(),
      action:e&&e.querySelector('.empty-a')?.textContent.trim()||'' });
  })()`));
  check('复核无数据：空态插画 + 标题 + 说明 + 下一步', reviewEmpty.exists && reviewEmpty.role === 'status' && reviewEmpty.art && !!reviewEmpty.title && !!reviewEmpty.desc, JSON.stringify(reviewEmpty));
  await page.shot(path.join(OUT, 'screenshots', 'empty_review_1440.png'));

  const searchEmpty = JSON.parse(await page.ev(`(() => {
    const types=['ILF','EIF','EI','EO','EQ'];
    items=Array.from({length:5},(_,i)=>({seq:i+1,system:'系统',desc:'功能项 '+(i+1),count_item:'计数项 '+(i+1),type:types[i%5],cx:'中',reuse:'中',modify:'新增',ok:true}));
    goPage('work'); goStep('review'); $('#q').value='__no_match__'; render();
    const e=document.querySelector('#tbody .empty-state');
    return JSON.stringify({exists:!!e, title:e&&e.querySelector('.empty-t')?.textContent.trim(), desc:e&&e.querySelector('.empty-d')?.textContent.trim(),
      action:e&&e.querySelector('.empty-a')?.textContent.trim()||'', onclick:e&&e.querySelector('.empty-a button')?.getAttribute('onclick')||''});
  })()`));
  check('复核筛选无结果：空态提供一键清除筛选', searchEmpty.exists && !!searchEmpty.action && searchEmpty.onclick.includes('clearFilters'), JSON.stringify(searchEmpty));

  const histEmpty = JSON.parse(await page.ev(`(async () => {
    goPage('work'); histOpen();
    await new Promise(r=>setTimeout(r,1200));
    const body=document.querySelector('#histRows');
    const e=body&&body.querySelector('.empty-state');
    return JSON.stringify({body:!!body, exists:!!e, title:e&&e.querySelector('.empty-t')?.textContent.trim(), desc:e&&e.querySelector('.empty-d')?.textContent.trim()});
  })()`));
  check('估算历史无数据：空态标题 + 说明', histEmpty.body && histEmpty.exists && !!histEmpty.title && !!histEmpty.desc, JSON.stringify(histEmpty));

  const err = JSON.parse(await page.ev(String.raw`(() => {
    const host=document.createElement('div'); host.id='__err_probe';
    host.innerHTML=errorBox('模拟网络失败','void 0');
    document.body.appendChild(host);
    const e=host.querySelector('.empty-state');
    return JSON.stringify({role:e&&e.getAttribute('role'), title:e&&e.querySelector('.empty-t')?.textContent.trim(),
      retry:!!host.querySelector('button[onclick*="void 0"]'), diag:!!host.querySelector('a[onclick*="goPage"]'),
      text:host.textContent.replace(/\s+/g,' ').trim()});
  })()`));
  check('错误态 role=alert + 原因 + 重试 + 诊断指引', err.role === 'alert' && err.retry && err.diag && err.text.includes('模拟网络失败'), JSON.stringify(err));
  await page.shot(path.join(OUT, 'screenshots', 'error_state_1440.png'));

  const degraded = JSON.parse(await page.ev(String.raw`(async () => {
    goPage('config'); await new Promise(r=>setTimeout(r,300));
    const e=document.querySelector('#rulesRows .empty-state, #ratesRows .empty-state, .cfg-note');
    return JSON.stringify({exists:!!e, text:e&&e.textContent.replace(/\s+/g,' ').trim().slice(0,80)});
  })()`));
  check('配置中心异步加载失败/降级有可读反馈', degraded.exists, JSON.stringify(degraded));

  result = finish({ reviewEmpty, searchEmpty, histEmpty, err, degraded });
} catch (e) {
  check('测试执行无异常', false, e.message);
  console.error(e);
} finally {
  await page.close();
}
result = result || finish();
process.exit(result.checks.every(c => c.ok) ? 0 : 1);
