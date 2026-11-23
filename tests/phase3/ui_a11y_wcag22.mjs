/** T06173 / AC-02：WCAG 2.2 AA —— axe 0 serious/critical、200% 缩放无横向滚动、键盘语义齐备。 */
import path from 'node:path';
import { openPage, checker, loadAxe, axeAudit, OUT } from './cdp.mjs';

const { check, finish } = checker('ui-a11y-wcag22');
const page = await openPage({ width: 1440, height: 900 });
let result;
try {
  await page.nav();
  await page.ev(`localStorage.setItem('wl_guide_done_pages_v1', JSON.stringify({work:true,pert:true,config:true,help:true}));`);
  const axeLoaded = await loadAxe(page);
  check('axe-core 已注入并可运行', axeLoaded, 'axe-core 4.10.2');

  const pages = [];
  async function audit(label, prep) {
    await page.ev(prep);
    await new Promise(r => setTimeout(r, 500));
    const r = await axeAudit(page, label);
    pages.push(r);
    const blockers = r.violations.filter(v => ['critical', 'serious'].includes(v.impact));
    const all = r.violations.reduce((n, v) => n + v.nodes, 0);
    check(`${label} axe 无 serious/critical 阻断`, blockers.length === 0,
      blockers.length ? blockers.map(v => `${v.id}:${v.nodes}`).join(' | ') : `violations=${all}, passes=${r.passes}`);
    return r;
  }

  await audit('work-upload', `goPage('work');goStep('upload');`);
  await audit('work-review-20', `(() => {
    goPage('work');
    const types=['ILF','EIF','EI','EO','EQ'];
    items=Array.from({length:20},(_,i)=>({seq:i+1,system:'系统'+(i%3+1),desc:'功能项 '+(i+1),count_item:'计数项 '+(i+1),type:types[i%5],cx:['低','中','高'][i%3],reuse:'中',modify:'新增',ok:true}));
    goStep('review');render();
  })()`);
  await audit('config', `goPage('config');`);
  await audit('help', `goPage('help');`);

  await page.ev(`localStorage.setItem('wl_lang','zh-CN');applyI18n&&applyI18n();`);

  // 200% 缩放：1440 物理 / 720 CSS px，等价浏览器 200%
  await page.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 900, deviceScaleFactor: 2, mobile: false }, page.S);
  const zoomPages = [];
  for (const [label, prep] of [
    ['upload', `goPage('work');goStep('upload');`],
    ['review', `(() => { goPage('work'); items=Array.from({length:20},(_,i)=>({seq:i+1,system:'系统'+(i%3+1),desc:'功能项 '+(i+1),count_item:'计数项 '+(i+1),type:['ILF','EIF','EI','EO','EQ'][i%5],cx:'中',reuse:'中',modify:'新增',ok:true})); goStep('review');render(); })()`],
    ['config', `goPage('config');`],
    ['help', `goPage('help');`],
  ]) {
    await page.ev(prep);
    await new Promise(r => setTimeout(r, 400));
    const z = JSON.parse(await page.ev(`(() => {
      const de=document.documentElement, b=document.body;
      const focused=[...document.querySelectorAll('button,input,select,a[href],.step,[role="button"]')].filter(e=>{const r=e.getBoundingClientRect();const c=getComputedStyle(e);return r.width&&r.height&&c.visibility!=='hidden'&&c.display!=='none'&&!e.closest('[inert]')&&r.bottom>0&&r.top<innerHeight;});
      const bad=focused.filter(e=>{const r=e.getBoundingClientRect();return r.left<-1||r.right>innerWidth+1;});
      const clipped=bad.length;
      const clippedEls=bad.map(e=>({tag:e.tagName,id:e.id,cls:String(e.className||'').slice(0,40),right:Math.round(e.getBoundingClientRect().right),left:Math.round(e.getBoundingClientRect().left)}));
      return JSON.stringify({vw:innerWidth, docW:de.scrollWidth, bodyW:b.scrollWidth, visible:focused.length, clipped, clippedEls});
    })()`));
    zoomPages.push({ label, ...z });
    check(`200% 缩放 ${label} 无横向滚动`, z.docW <= z.vw + 2 && z.bodyW <= z.vw + 2, `vw=${z.vw} doc=${z.docW} body=${z.bodyW}`);
    check(`200% 缩放 ${label} 可见控件未被横向裁切`, z.clipped === 0, `visible=${z.visible} clipped=${z.clipped}${z.clippedEls&&z.clippedEls.length?' '+JSON.stringify(z.clippedEls):''}`);
  }
  await page.shot(path.join(OUT, 'screenshots', 'a11y_200pct_help_720.png'));

  // 屏幕阅读器基础：AX 树中可交互控件必须有名称
  const ax = await page.send('Accessibility.getFullAXTree', {}, page.S);
  const empty = ax.nodes.filter(n => {
    const role = n.role?.value;
    if (!['button', 'switch', 'link', 'textbox', 'combobox', 'checkbox'].includes(role)) return false;
    if (n.ignored) return false;
    return !(n.name?.value || '').trim();
  });
  check('AX 树可交互控件均有可读名称（屏幕阅读器）', empty.length === 0,
    empty.length ? empty.slice(0, 6).map(n => n.nodeId).join(',') : `checked=${ax.nodes.length} nodes`);

  // 键盘语义：步骤条/拖放区/开关/排序表头
  const keys = JSON.parse(await page.ev(`(() => {
    const steps=[...document.querySelectorAll('.step')];
    return JSON.stringify({
      steps: steps.length, stepsOk: steps.every(e=>e.getAttribute('role')==='button'&&e.getAttribute('tabindex')==='0'&&e.hasAttribute('onkeydown')),
      drop: (()=>{const e=document.querySelector('#drop');return !!e&&e.getAttribute('role')==='button'&&e.getAttribute('tabindex')==='0'&&!!e.getAttribute('aria-label')})(),
      sw: (()=>{const e=document.querySelector('#llmSwitch');return !!e&&e.getAttribute('role')==='switch'&&e.getAttribute('tabindex')==='0'&&!!e.getAttribute('aria-checked')})()
    });
  })()`));
  check('六步步骤条键盘语义齐备', keys.steps === 6 && keys.stepsOk, JSON.stringify(keys));
  check('上传拖放区键盘语义齐备', keys.drop, 'role=button tabindex=0 aria-label');
  check('大模型开关键盘语义齐备', keys.sw, 'role=switch tabindex=0 aria-checked');

  result = finish({ pages, zoomPages });
} catch (e) {
  check('测试执行无异常', false, e.message);
  console.error(e);
} finally {
  await page.close();
}
result = result || finish();
process.exit(result.checks.every(c => c.ok) ? 0 : 1);
