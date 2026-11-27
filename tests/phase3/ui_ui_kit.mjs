/** T06172 / REQ-002：核心 UI 组件库（按钮/输入/弹窗/抽屉/表格/图表）UI 验收。 */
import path from 'node:path';
import { openPage, checker, sleep, OUT } from './cdp.mjs';

const { check, finish } = checker('ui-kit');
const page = await openPage({ width: 1440, height: 900 });

function rgb(s) {
  const m = /rgba?\(([^)]+)/.exec(String(s));
  if (!m) return null;
  const p = m[1].split(',').map(x => Number.parseFloat(x));
  return [p[0], p[1], p[2]];
}
function lum(c) {
  const f = x => { x /= 255; return x <= .03928 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4); };
  return .2126 * f(c[0]) + .7152 * f(c[1]) + .0722 * f(c[2]);
}
function contrast(a, b) {
  const A = lum(rgb(a)), B = lum(rgb(b));
  if (A == null || B == null) return 0;
  return (Math.max(A, B) + .05) / (Math.min(A, B) + .05);
}
async function setViewport(w, h = 900) {
  await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, page.S);
  await sleep(250);
}
async function cleanGuide() {
  await sleep(800);
  await page.ev(`(() => {
    try { if (window.WLGuide && WLGuide.stop) WLGuide.stop(); } catch(e) {}
    document.querySelectorAll('.guide-mask,.guide-card,.guide-fab,.guide-glow').forEach(function(e){e.remove();});
  })()`);
  await sleep(120);
}
async function pressEscape() {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }, page.S);
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }, page.S);
}

try {
  await page.nav();
  const api = JSON.parse(await page.ev(`JSON.stringify({t:typeof UIKIT, v:UIKIT&&UIKIT.version, fns:UIKIT?Object.keys(UIKIT):[]})`));
  check('UIKIT 全局 API 已加载', api.t === 'object' && api.v === '1.0.0', JSON.stringify(api));
  check('组件 API 覆盖要求', ['button', 'field', 'table', 'chart', 'modal', 'drawer'].every(k => api.fns.includes(k)), api.fns.join(','));

  await page.ev(`(() => {
    document.querySelector('.wrap').style.display='none';
    try { if (window.WLGuide && WLGuide.stop) WLGuide.stop(); } catch(e) {}
    document.querySelectorAll('.guide-mask,.guide-card,.guide-fab,.guide-glow').forEach(function(e){e.remove();});
    if (!window.__gallery) window.__gallery = UIKIT.gallery(document.body);
  })()`);
  await sleep(250);
  const stats = JSON.parse(await page.ev(`(() => {
    const q=s=>document.querySelectorAll(s).length;
    const first=document.querySelector('.uik-field');
    const sel=document.querySelector('.uik-field select');
    const err=document.querySelector('.uik-field.is-error .uik-control');
    return JSON.stringify({
      btn:q('.uik-btn'), primary:q('.uik-btn-primary'), disabled:document.querySelectorAll('.uik-btn:disabled').length,
      sizes:['sm','md','lg'].map(x=>q('.uik-btn-'+x)), fields:q('.uik-field'), selectOpts:sel?sel.options.length:0,
      labelFor:first?first.querySelector('label').htmlFor:null, controlId:first?first.querySelector('.uik-control').id:null,
      errInvalid:err?err.getAttribute('aria-invalid'):null, errDesc:err?err.getAttribute('aria-describedby'):null,
      tableRows:q('.uik-table-row'), chartBars:q('.uik-bar'), chartRole:document.querySelector('.uik-chart-plot').getAttribute('role'),
      chartAria:document.querySelector('.uik-chart-plot').getAttribute('aria-label')
    });
  })()`));
  check('按钮 4 变体 + 3 尺寸 + 禁用态', stats.btn === 11 && stats.primary === 3 && stats.disabled === 1 && stats.sizes.join(',') === '1,9,1', JSON.stringify(stats));
  check('输入/下拉/错误态渲染', stats.fields === 4 && stats.selectOpts === 2 && stats.errInvalid === 'true' && stats.errDesc, JSON.stringify(stats));
  check('label 与控件 id 关联', stats.labelFor && stats.labelFor === stats.controlId, `${stats.labelFor} / ${stats.controlId}`);
  check('表格 3 行 + 图表 5 柱', stats.tableRows === 3 && stats.chartBars === 5, `rows=${stats.tableRows} bars=${stats.chartBars}`);
  check('图表 role=img 且有完整 aria 文本', stats.chartRole === 'img' && /ILF 40UFP/.test(stats.chartAria), stats.chartAria);

  await page.ev(`document.querySelector('.uik-table-row').click()`);
  const row = JSON.parse(await page.ev(`JSON.stringify(window.__uikRow||null)`));
  check('表格点击行回调携带行数据', row && row.desc === '内部文件' && row.ufp === 10, JSON.stringify(row));

  const empty = JSON.parse(await page.ev(`(() => {
    const t=UIKIT.table({columns:[{key:'a',label:'A'}],rows:[],empty:'暂无功能点'});
    document.body.appendChild(t);
    const r={text:t.querySelector('.uik-table-empty').textContent, rows:t.querySelectorAll('.uik-table-row').length};
    t.remove(); return JSON.stringify(r);
  })()`));
  check('表格空态正确', empty.text === '暂无功能点' && empty.rows === 0, JSON.stringify(empty));

  const modalBtn = await page.ev(`(() => {
    const b=[...document.querySelectorAll('.uik-btn')].find(x=>x.textContent.trim()==='打开弹窗');
    b.focus(); b.click(); return true;
  })()`);
  await sleep(260);
  const modal = JSON.parse(await page.ev(`(() => {
    const o=document.querySelector('.uik-overlay'), p=document.querySelector('.uik-modal');
    return JSON.stringify({overlay:!!o, dialog:p?p.getAttribute('role'):null, modal:p?p.getAttribute('aria-modal'):null,
      title:p?p.querySelector('.uik-panel-title').textContent:null, actions:p?p.querySelectorAll('.uik-panel-foot .uik-btn').length:0,
      focusInside:!!(p&&p.contains(document.activeElement)), active:document.activeElement&&document.activeElement.className});
  })()`));
  check('弹窗打开且有 dialog 语义/2 个动作', modalBtn && modal.overlay && modal.dialog === 'dialog' && modal.modal === 'true' && modal.actions === 2, JSON.stringify(modal));
  check('弹窗打开后焦点在弹窗内', modal.focusInside === true, modal.active);
  await pressEscape(); await sleep(300);
  const afterModal = JSON.parse(await page.ev(`JSON.stringify({overlay:!!document.querySelector('.uik-overlay'), focus:document.activeElement&&document.activeElement.textContent.trim()})`));
  check('Esc 关闭弹窗并归还焦点', afterModal.overlay === false && afterModal.focus === '打开弹窗', JSON.stringify(afterModal));

  await page.ev(`(() => { const b=[...document.querySelectorAll('.uik-btn')].find(x=>x.textContent.trim()==='打开抽屉'); b.focus(); b.click(); })()`);
  await sleep(320);
  const drawer = JSON.parse(await page.ev(`(() => {
    const p=document.querySelector('.uik-drawer');
    return JSON.stringify({open:!!p, role:p?p.getAttribute('role'):null, text:p?p.textContent.includes('原文：系统应支持票据影像'):false,
      width:p?p.getBoundingClientRect().width:0, vw:innerWidth, focusInside:!!(p&&p.contains(document.activeElement))});
  })()`));
  check('抽屉打开且含证据内容', drawer.open && drawer.role === 'dialog' && drawer.text && drawer.focusInside, JSON.stringify(drawer));
  check('抽屉不超出视口', drawer.width > 0 && drawer.width <= drawer.vw, `${drawer.width}/${drawer.vw}`);
  await pressEscape(); await sleep(300);
  check('Esc 关闭抽屉', !(await page.ev(`!!document.querySelector('.uik-overlay')`)), '');

  const light = JSON.parse(await page.ev(`(() => {
    const btn=document.querySelector('.uik-btn-primary'), h=document.querySelector('.uik-gallery-head p');
    return JSON.stringify({btnFg:getComputedStyle(btn).color, btnBg:getComputedStyle(btn).backgroundColor,
      textFg:getComputedStyle(h).color, textBg:getComputedStyle(document.body).backgroundColor});
  })()`));
  check('亮色按钮对比度 ≥ 4.5:1', contrast(light.btnFg, light.btnBg) >= 4.5, `${contrast(light.btnFg, light.btnBg).toFixed(2)} ${JSON.stringify(light)}`);
  check('亮色正文对比度 ≥ 4.5:1', contrast(light.textFg, light.textBg) >= 4.5, `${contrast(light.textFg, light.textBg).toFixed(2)}`);

  await page.ev(`document.documentElement.dataset.theme='dark'`); await sleep(300);
  const dark = JSON.parse(await page.ev(`(() => { const b=document.querySelector('.uik-btn-primary'), h=document.querySelector('.uik-gallery-head p');
    return JSON.stringify({bf:getComputedStyle(b).color,bg:getComputedStyle(b).backgroundColor,tf:getComputedStyle(h).color,tbg:getComputedStyle(document.body).backgroundColor});})()`));
  check('暗色按钮对比度 ≥ 4.5:1', contrast(dark.bf, dark.bg) >= 4.5, `${contrast(dark.bf, dark.bg).toFixed(2)}`);
  check('暗色正文对比度 ≥ 4.5:1', contrast(dark.tf, dark.tbg) >= 4.5, `${contrast(dark.tf, dark.tbg).toFixed(2)}`);
  await cleanGuide(); await page.ev('scrollTo(0,0)');
  await page.shot(path.join(OUT, 'screenshots', 'ui_kit_dark_1440.png'), true);

  await page.ev(`document.documentElement.dataset.theme='contrast'`); await sleep(300);
  const hc = JSON.parse(await page.ev(`(() => { const b=document.querySelector('.uik-btn-primary'), h=document.querySelector('.uik-gallery-head p');
    return JSON.stringify({bf:getComputedStyle(b).color,bg:getComputedStyle(b).backgroundColor,tf:getComputedStyle(h).color,tbg:getComputedStyle(document.body).backgroundColor});})()`));
  check('高对比按钮对比度 ≥ 4.5:1', contrast(hc.bf, hc.bg) >= 4.5, `${contrast(hc.bf, hc.bg).toFixed(2)}`);
  check('高对比正文对比度 ≥ 4.5:1', contrast(hc.tf, hc.tbg) >= 4.5, `${contrast(hc.tf, hc.tbg).toFixed(2)}`);

  await page.ev(`document.documentElement.dataset.theme='light'`); await sleep(250);
  await setViewport(1440); await page.ev('scrollTo(0,0)'); check('1440 无横向溢出', await page.ev(`document.documentElement.scrollWidth <= innerWidth + 1`), `sw=${await page.ev('document.documentElement.scrollWidth')}`);
  await page.shot(path.join(OUT, 'screenshots', 'ui_kit_1440.png'), true);
  await setViewport(1024); await page.ev('scrollTo(0,0)'); check('1024 无横向溢出', await page.ev(`document.documentElement.scrollWidth <= innerWidth + 1`), `sw=${await page.ev('document.documentElement.scrollWidth')}`);
  await page.shot(path.join(OUT, 'screenshots', 'ui_kit_1024.png'), false);
  await setViewport(768); await page.ev('scrollTo(0,0)'); check('768 无横向溢出', await page.ev(`document.documentElement.scrollWidth <= innerWidth + 1`), `sw=${await page.ev('document.documentElement.scrollWidth')}`);
  const mobile = JSON.parse(await page.ev(`JSON.stringify({grid:getComputedStyle(document.querySelector('.uik-form-grid')).gridTemplateColumns, table:document.querySelector('.uik-table-wrap').clientWidth, body:innerWidth})`));
  check('768 表单单列且表格内部滚动', mobile.grid.split(' ').length === 1 && mobile.table <= mobile.body, JSON.stringify(mobile));
  await page.shot(path.join(OUT, 'screenshots', 'ui_kit_768.png'), true);

  check('运行期无 JS 异常', page.exceptions.length === 0, page.exceptions.slice(0, 3).join(' | '));

  const result = finish();
  process.exit(result.pass === result.total ? 0 : 1);
} finally {
  await page.close();
}




