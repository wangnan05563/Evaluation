/** T06193 主题工作室 UI：实时预览、对比度阻断、JSON 导出、UI/报告主色同源。 */
import fs from 'node:fs';
import path from 'node:path';
import { openPage, checker, sleep, OUT, loadAxe, axeAudit } from './cdp.mjs';

const { check, finish } = checker('ui-theme-studio');
const page = await openPage({ width: 1440, height: 900 });
const dlDir = path.join(OUT, 'theme-downloads');
fs.rmSync(dlDir, { recursive: true, force: true });
fs.mkdirSync(dlDir, { recursive: true });

async function waitFor(fn, timeout = 10000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true;
    await sleep(150);
  }
  throw new Error(`等待超时: ${label}`);
}
const json = async expr => JSON.parse(await page.ev(expr));

try {
  await page.nav();
  await page.ev(`localStorage.setItem('wl_guide_done_pages_v1', JSON.stringify({work:true,pert:true,config:true,help:true})); try{localStorage.setItem('wl_role_v1',JSON.stringify({id:'evaluator'}));}catch(e){}; window.RoleOnboard&&RoleOnboard.close(); WLGuide&&WLGuide.stop();`);
  await page.ev(`(async () => { await fetch(API+'/api/theme/reset',{method:'POST'}); localStorage.removeItem('wl_brand'); themeTokensClear(); setThemeMode('light'); })()`);
  await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
  await page.ev(`goPage('config'); themeTokenPanel();`);
  await sleep(300);

  const entry = await json(`(() => { const b=document.querySelector('#themeTokenOpenStudio'); return JSON.stringify({exists:!!b,label:b?b.textContent.trim():'',panel:!!document.querySelector('#themeTokenCard')}); })()`);
  check('配置中心主题 Token 面板含主题工作室入口', entry.exists && /主题工作室/.test(entry.label) && entry.panel, JSON.stringify(entry));

  await page.ev(`document.querySelector('#themeTokenOpenStudio').click()`);
  await waitFor(async () => await page.ev(`!document.querySelector('#themeStudioOverlay').hidden`), 5000, '主题工作室打开');
  await waitFor(async () => await page.ev(`document.querySelectorAll('#tsCheckRows tr').length===6`), 5000, '对比度表 6 行');
  await sleep(250);

  const opened = await json(`(() => {
    const o=document.querySelector('#themeStudioOverlay'), p=document.querySelector('#tsPreview');
    return JSON.stringify({
      title:document.querySelector('#tsTitle').textContent,
      templateOptions:document.querySelector('#tsTemplate').options.length,
      name:document.querySelector('#tsName').value,
      rows:document.querySelectorAll('#tsCheckRows tr').length,
      summary:document.querySelector('#tsCheckSummary').textContent,
      saveDisabled:document.querySelector('#tsSave').disabled,
      brand:p.style.getPropertyValue('--brand').trim(),
      bg:p.style.getPropertyValue('--bg').trim(),
      buttonBg:getComputedStyle(document.querySelector('.ts-preview .btn-primary')).backgroundColor,
      buttonFg:getComputedStyle(document.querySelector('.ts-preview .btn-primary')).color,
      reportLine:getComputedStyle(document.querySelector('.ts-report-head')).borderTopColor,
      badgeBg:getComputedStyle(document.querySelector('.ts-badge')).backgroundColor
    });
  })()`);
  check('主题工作室标题与模板列表正确', opened.title === '主题工作室' && opened.templateOptions >= 2 && opened.name === 'base', JSON.stringify(opened));
  check('默认主题 6/6 对比度通过且保存可用', /6\/6/.test(opened.summary) && opened.saveDisabled === false, JSON.stringify(opened));
  check('预览使用默认品牌令牌（UI/报告同源）', opened.brand.toLowerCase() === '#2563eb' && opened.bg.toLowerCase() === '#ffffff' && opened.buttonBg === 'rgb(37, 99, 235)' && opened.reportLine === 'rgb(37, 99, 235)', JSON.stringify(opened));

  // 实时改主色：预览、按钮、报告线、对比度表同时变化。
  await page.ev(`(() => { const i=document.querySelector('#tsBrand'); i.value='#ffff00'; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await sleep(100);
  const live = await json(`(() => {
    const p=document.querySelector('#tsPreview');
    return JSON.stringify({
      brand:p.style.getPropertyValue('--brand').trim(),
      buttonBg:getComputedStyle(document.querySelector('.ts-preview .btn-primary')).backgroundColor,
      reportLine:getComputedStyle(document.querySelector('.ts-report-head')).borderTopColor,
      saveDisabled:document.querySelector('#tsSave').disabled,
      buttonState:document.querySelector('#tsCheckRows tr[data-ts-check="button"] td:last-child').textContent
    });
  })()`);
  check('主色修改实时驱动预览/报告/按钮', live.brand.toLowerCase() === '#ffff00' && live.buttonBg === 'rgb(255, 255, 0)' && live.reportLine === 'rgb(255, 255, 0)', JSON.stringify(live));

  // 白字按钮在黄底上必然 <4.5:1，保存必须阻断。
  await page.ev(`(() => { const i=document.querySelector('#tsButtonFg'); i.value='#ffffff'; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await sleep(100);
  const blocked = await json(`(() => {
    const b=document.querySelector('#tsCheckRows tr[data-ts-check="button"]');
    return JSON.stringify({
      saveDisabled:document.querySelector('#tsSave').disabled,
      state:b.querySelector('td:last-child').textContent,
      ratio:b.children[3].textContent,
      hint:document.querySelector('#tsCheckHint').textContent,
      summary:document.querySelector('#tsCheckSummary').textContent
    });
  })()`);
  check('按钮对比度不足时阻断保存', blocked.saveDisabled === true && /不通过/.test(blocked.state) && /1\.07/.test(blocked.ratio) && /阻断/.test(blocked.hint), JSON.stringify(blocked));

  // 改成黑字：19.56:1，保存恢复可用。
  await page.ev(`(() => { const i=document.querySelector('#tsButtonFg'); i.value='#000000'; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await sleep(100);
  const fixed = await json(`(() => {
    const b=document.querySelector('#tsCheckRows tr[data-ts-check="button"]');
    return JSON.stringify({saveDisabled:document.querySelector('#tsSave').disabled, state:b.querySelector('td:last-child').textContent, ratio:b.children[3].textContent, summary:document.querySelector('#tsCheckSummary').textContent});
  })()`);
  check('修正按钮文字后对比度 19.56:1 且保存恢复', fixed.saveDisabled === false && /通过/.test(fixed.state) && /19\.56/.test(fixed.ratio), JSON.stringify(fixed));

  // 服务端二次校验也必须拒绝低对比，不能只靠前端。
  const serverReject = await json(`(async () => {
    const t=await (await fetch(API+'/api/theme/export?name=base')).json();
    const theme=t.theme; theme.name='low-contrast-studio'; theme.semantic.brand='#FFFF00'; theme.component['button.primary.foreground']='#ffffff';
    const r=await fetch(API+'/api/theme/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(theme)});
    const j=await r.json();
    return JSON.stringify({status:r.status,ok:j.ok,errors:j.errors});
  })()`);
  check('服务端对低对比主题返回 400', serverReject.status === 400 && serverReject.ok === false && /对比度不足/.test((serverReject.errors || []).join('')), JSON.stringify(serverReject));

  // 保存达标主题：全局变量、wl_brand 与报告生成参数必须同源。
  await page.ev(`document.querySelector('#tsSave').click()`);
  await waitFor(async () => /已保存并应用/.test(await page.ev(`document.querySelector('#tsStatus').textContent`)), 10000, '保存主题');
  await sleep(150);
  const applied = await json(`(() => {
    const cs=getComputedStyle(document.documentElement);
    return JSON.stringify({
      rootBrand:cs.getPropertyValue('--brand').trim(),
      tokens:document.documentElement.dataset.tokens,
      wlBrand:localStorage.getItem('wl_brand'),
      payloadBrand:(typeof buildGeneratePayload==='function')?buildGeneratePayload({job:'theme-test'}).brand_color:'',
      activeButton:getComputedStyle(document.querySelector('.btn-primary')).backgroundColor,
      activeButtonFg:getComputedStyle(document.querySelector('.btn-primary')).color
    });
  })()`);
  check('保存后全局主题生效', applied.rootBrand.toLowerCase() === '#ffff00' && applied.tokens === 'base', JSON.stringify(applied));
  check('UI 主色同步到报告生成参数', applied.wlBrand.toLowerCase() === '#ffff00' && applied.payloadBrand.toLowerCase() === '#ffff00', JSON.stringify(applied));
  const activeApi = await json(`(async () => { const j=await (await fetch(API+'/api/theme')).json(); return JSON.stringify({ok:j.ok,name:j.active&&j.active.name,brand:j.active&&j.active.resolved.semantic.brand,contrast:j.active&&j.active.contrast}); })()`);
  check('服务端已持久化达标主题并返回 6 组检查', activeApi.ok === true && activeApi.name === 'base' && activeApi.brand.toLowerCase() === '#ffff00' && activeApi.contrast.length === 6, JSON.stringify(activeApi));

  // 导出 JSON：Chrome 无头下载落盘有 3–8s 延迟，等待文件或导出状态提示。
  await page.ev(`document.querySelector('#tsExport').click()`);
  await waitFor(async () => fs.existsSync(path.join(dlDir, 'theme-base.json')) || /已导出/.test(await page.ev(`document.querySelector('#tsStatus').textContent`)), 20000, '主题 JSON 下载');
  await waitFor(async () => fs.existsSync(path.join(dlDir, 'theme-base.json')), 8000, '主题 JSON 落盘');
  const exported = JSON.parse(fs.readFileSync(path.join(dlDir, 'theme-base.json'), 'utf8'));
  check('导出主题 JSON 三层结构完整', ['raw', 'semantic', 'component'].every(k => exported[k] && Object.keys(exported[k]).length), JSON.stringify(Object.keys(exported)));
  check('导出主题保留实时修改的品牌色与按钮文字', exported.semantic.brand.toLowerCase() === '#ffff00' && exported.component['button.primary.foreground'] === '#000000', JSON.stringify({ brand: exported.semantic.brand, fg: exported.component['button.primary.foreground'] }));

  // 重新导入导出文件，验证可逆。
  const reimport = await json(`(async () => {
    const f=new File([${JSON.stringify(JSON.stringify(exported))}],'theme-base.json',{type:'application/json'});
    try{const t=await themeTokensImportFile(f); return JSON.stringify({ok:true,name:t.name,brand:getComputedStyle(document.documentElement).getPropertyValue('--brand').trim()});}
    catch(e){return JSON.stringify({ok:false,error:String(e.message||e)});}
  })()`);
  check('导出 JSON 可重新导入并生效', reimport.ok === true && reimport.name === 'base' && reimport.brand.toLowerCase() === '#ffff00', JSON.stringify(reimport));

  // 英文态动态标签重绘（含对比度表/摘要）。
  await page.ev(`setLang('en-US')`);
  await sleep(500);
  const en = await json(`(() => {
    const first=document.querySelector('#tsCheckRows tr');
    return JSON.stringify({title:document.querySelector('#tsTitle').textContent, label:document.querySelector('label[for="tsBrand"]').textContent, firstPair:first.children[0].textContent, summary:document.querySelector('#tsCheckSummary').textContent});
  })()`);
  check('英文态主题工作室静态与动态标签均本地化', en.title === 'Theme Studio' && en.label === 'Brand' && /Body \/ page background/.test(en.firstPair) && /6\/6/.test(en.summary), JSON.stringify(en));
  await page.ev(`setLang('zh-CN')`);
  await sleep(400);

  // 对比度通过后保存，关闭再开应恢复；Esc 关闭并归还焦点。
  await page.ev(`themeStudioClose()`);
  await page.ev(`document.querySelector('#themeTokenOpenStudio').focus(); document.querySelector('#themeTokenOpenStudio').click()`);
  await waitFor(async () => await page.ev(`!document.querySelector('#themeStudioOverlay').hidden`), 5000, '二次打开');
  await page.ev(`(() => { const o=document.querySelector('#themeStudioOverlay'); o.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); })()`);
  const esc = await json(`(() => JSON.stringify({hidden:document.querySelector('#themeStudioOverlay').hidden, focus:document.activeElement&&document.activeElement.id}))()`);
  check('Esc 关闭主题工作室并归还焦点', esc.hidden === true && esc.focus === 'themeTokenOpenStudio', JSON.stringify(esc));

  // 1024 / 768 响应式与页面无横向溢出。
  await page.ev(`document.querySelector('#themeTokenOpenStudio').click()`);
  await waitFor(async () => await page.ev(`!document.querySelector('#themeStudioOverlay').hidden`), 5000, '第三次打开');
  for (const [width, height, file] of [[1024, 800, 'theme_studio_1024.png'], [768, 900, 'theme_studio_768.png']]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, page.S);
    await sleep(350);
    const rs = await json(`(() => {
      const d=document.querySelector('.ts-dialog'), p=document.querySelector('#tsPreview');
      return JSON.stringify({inner:window.innerWidth, doc:document.documentElement.scrollWidth, dialog:d&&d.getBoundingClientRect().width, preview:p&&p.getBoundingClientRect().width, overflow:d?d.scrollWidth>d.clientWidth:false});
    })()`);
    check(width + 'px 无页面横向溢出且预览可见', rs.doc <= rs.inner && rs.dialog <= rs.inner && rs.preview > 0, JSON.stringify(rs));
    await page.shot(path.join(OUT, 'screenshots', file), false);
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, page.S);
  await sleep(300);
  await page.shot(path.join(OUT, 'screenshots', 'theme_studio_1440.png'), false);

  // axe 直接在已保存的黄色低饱和品牌上审计，覆盖自定义品牌 + 配置选中态的最差组合。
  const axeState = await json(`(() => { const cs=getComputedStyle(document.documentElement); return JSON.stringify({brand:cs.getPropertyValue('--brand').trim(),brandInk:cs.getPropertyValue('--brand-ink').trim(),tokens:document.documentElement.dataset.tokens||'',wlBrand:localStorage.getItem('wl_brand')}); })()`);
  check('axe 使用已保存的自定义品牌主题', axeState.brand.toLowerCase() === '#ffff00' && axeState.tokens === 'base' && axeState.brandInk.length > 0, JSON.stringify(axeState));

  const axeOk = await loadAxe(page);
  const axe = await axeAudit(page, 'theme-studio');
  const blockers = axe.violations.filter(v => v.impact === 'critical' || v.impact === 'serious');
  check('主题工作室 axe WCAG A/AA 严重阻断为 0', axeOk === true && blockers.length === 0, JSON.stringify(blockers));

  // 重置服务端与本地，避免污染后续套件。
  const reset = await json(`(async () => { await themeTokensReset(); const j=await (await fetch(API+'/api/theme')).json(); return JSON.stringify({brand:getComputedStyle(document.documentElement).getPropertyValue('--brand').trim(),tokens:document.documentElement.dataset.tokens||'',wlBrand:localStorage.getItem('wl_brand'),active:j.active}); })()`);
  check('重置后清理主题与报告品牌色', reset.tokens === '' && reset.wlBrand === null && reset.active === null && reset.brand.toLowerCase() === '#2563eb', JSON.stringify(reset));
  check('无页面异常', page.exceptions.length === 0, page.exceptions.join(' | '));

  const r = finish({ theme: 'base', exported: 'theme-base.json', contrastChecks: '6/6' });
  process.exitCode = r.checks.every(c => c.ok) ? 0 : 1;
} catch (e) {
  check('测试执行无异常', false, e.message);
  console.error(e);
  finish({ error: String(e.stack || e) });
  process.exitCode = 1;
} finally {
  await page.close().catch(() => {});
}
