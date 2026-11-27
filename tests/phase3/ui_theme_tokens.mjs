/** T06171 / AC-01 / REQ-001：三层 Token 主题导入导出、校验与无组件改动生效。 */
import path from 'node:path';
import { openPage, checker, sleep, OUT, APP } from './cdp.mjs';

const { check, finish } = checker('theme-tokens');
const BASE = APP.replace(/\/$/, '');
const page = await openPage({ width: 1440, height: 900 });

async function getJson(url, opt) {
  const r = await fetch(url, opt);
  return { status: r.status, body: await r.json() };
}
async function postJson(url, body) {
  return getJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

try {
  const list = await getJson(`${BASE}/api/theme`);
  check('主题列表接口可用', list.status === 200 && list.body.ok === true, `status=${list.status}`);
  check('内置主题含 base/lime', (list.body.themes || []).map(t => t.name).sort().join(',') === 'base,lime', JSON.stringify(list.body.themes));

  const limeExport = await getJson(`${BASE}/api/theme/export?name=lime`);
  check('内置主题可导出完整三层 JSON', limeExport.body.ok === true && ['raw', 'semantic', 'component'].every(k => limeExport.body.theme[k]), Object.keys(limeExport.body.theme || {}).join(','));
  const lime = limeExport.body.theme;

  const bad = structuredClone(lime);
  bad.semantic.brand = 'raw.not-exist';
  const badRes = await postJson(`${BASE}/api/theme/validate`, bad);
  check('引用缺失的 raw token 被校验拦截', badRes.body.ok === false && /raw 引用不存在/.test((badRes.body.errors || []).join('')), JSON.stringify(badRes.body.errors));

  const goodRes = await postJson(`${BASE}/api/theme/validate`, lime);
  check('合法主题通过校验并返回解析值', goodRes.body.ok === true && goodRes.body.theme.resolved.semantic.brand.toLowerCase() === '#84cc16', JSON.stringify(goodRes.body.theme?.resolved?.semantic));

  const applied = await postJson(`${BASE}/api/theme/apply`, lime);
  check('主题应用成功并持久化', applied.body.ok === true && applied.body.active.name === 'lime', JSON.stringify(applied.body.active?.name));

  await page.nav();
  await page.ev(`goPage('config')`);
  await sleep(350);
  const panel = JSON.parse(await page.ev(`(() => {
    themeTokenPanel();
    const card=document.querySelector('#themeTokenCard'), sel=document.querySelector('#themeTokenSel');
    return JSON.stringify({card:!!card, options:sel?sel.options.length:0, title:card?card.querySelector('.card-title').textContent:''});
  })()`));
  check('配置中心出现主题 Token 面板', panel.card === true, JSON.stringify(panel));
  check('面板列出内置主题', panel.options === 2, `options=${panel.options}`);

  const vars = JSON.parse(await page.ev(`(() => {
    const cs=getComputedStyle(document.documentElement);
    const el=document.querySelector('.btn-primary');
    return JSON.stringify({brand:cs.getPropertyValue('--brand').trim(), rlg:cs.getPropertyValue('--r-lg').trim(),
      fs:cs.getPropertyValue('--fs-md').trim(), shadow:cs.getPropertyValue('--shadow').trim(),
      comp:cs.getPropertyValue('--c-button-primary-background').trim(),
      button:el?getComputedStyle(el).backgroundColor:null, tokens:document.documentElement.dataset.tokens});
  })()`));
  check('semantic 层生效（颜色/圆角/字号/阴影）', vars.brand.toLowerCase() === '#84cc16' && vars.rlg === '18px' && vars.fs === '14px' && vars.shadow.includes('rgba(77,124,15'), JSON.stringify(vars));
  check('component 层解析为组件变量', vars.comp.toLowerCase() === '#84cc16', `comp=${vars.comp}`);
  check('现有按钮组件无需改代码即用主题色', vars.button === 'rgb(132, 204, 22)', `button=${vars.button}`);
  check('主题标记写入 DOM', vars.tokens === 'lime', `tokens=${vars.tokens}`);
  const chartTheme = JSON.parse(await page.ev(`JSON.stringify(typeof chartTheme==='function'?chartTheme():{brand:null})`));
  check('图表调色板读取同一主题变量', String(chartTheme.brand).toLowerCase() === '#84cc16', JSON.stringify(chartTheme));

  await page.shot(path.join(OUT, 'screenshots', 'theme_tokens_lime_config_1440.png'), false);

  await page.nav();
  await page.ev(`goPage('config')`);
  await sleep(350);
  const reload = JSON.parse(await page.ev(`(() => {
    const cs=getComputedStyle(document.documentElement), el=document.querySelector('.btn-primary');
    return JSON.stringify({brand:cs.getPropertyValue('--brand').trim(), comp:cs.getPropertyValue('--c-button-primary-background').trim(),
      button:el?getComputedStyle(el).backgroundColor:null, tokens:document.documentElement.dataset.tokens,
      card:!!document.querySelector('#themeTokenCard')});
  })()`));
  check('重开/刷新后自动恢复已应用主题', reload.brand.toLowerCase() === '#84cc16' && reload.tokens === 'lime', JSON.stringify(reload));
  check('重开后组件变量与按钮颜色一致', reload.comp.toLowerCase() === '#84cc16' && reload.button === 'rgb(132, 204, 22)', JSON.stringify(reload));
  check('重开后配置面板恢复', reload.card === true, `card=${reload.card}`);

  const custom = {
    name: 'custom-orange', label: '橙光', version: 1,
    raw: { orange600: '#FF6600', orange700: '#B34700', orange50: '#FFF3E8', white: '#FFFFFF', ink: '#202020', muted: '#666666', line: '#F0D9C8' },
    semantic: { brand: 'raw.orange600', 'brand-ink': 'raw.orange700', 'brand-soft': 'raw.orange50',
      bg: 'raw.white', card: 'raw.white', ink: 'raw.ink', 'ink-2': 'raw.ink', muted: 'raw.muted', line: 'raw.line' },
    component: { 'button.primary.background': 'semantic.brand', 'button.primary.foreground': 'raw.ink',
      'badge.brand.background': 'semantic.brand-soft', 'badge.brand.foreground': 'semantic.brand-ink' },
  };
  const importRes = JSON.parse(await page.ev(`(async () => {
    const f=new File([${JSON.stringify(JSON.stringify(custom))}],'theme-custom-orange.json',{type:'application/json'});
    try{const t=await themeTokensImportFile(f); const cs=getComputedStyle(document.documentElement); const el=document.querySelector('.btn-primary');
      return JSON.stringify({ok:true,name:t.name,brand:cs.getPropertyValue('--brand').trim(),button:el?getComputedStyle(el).backgroundColor:null});}
    catch(e){return JSON.stringify({ok:false,error:String(e.message||e)});}
  })()`));
  check('JSON 文件导入后立即生效', importRes.ok === true && importRes.name === 'custom-orange', JSON.stringify(importRes));
  check('导入主题同时驱动语义与组件颜色', importRes.brand.toLowerCase() === '#ff6600' && importRes.button === 'rgb(255, 102, 0)', JSON.stringify(importRes));

  const active = await getJson(`${BASE}/api/theme`);
  check('导入主题已成为服务端生效主题', active.body.ok === true && active.body.active?.name === 'custom-orange', JSON.stringify(active.body.active?.name));
  const exportedActive = await getJson(`${BASE}/api/theme/export`);
  check('可导出当前生效主题', exportedActive.body.ok === true && exportedActive.body.theme?.name === 'custom-orange', JSON.stringify(exportedActive.body.theme?.name));

  const reset = await page.ev(`(async () => { await themeTokensReset(); const cs=getComputedStyle(document.documentElement);
    return JSON.stringify({brand:cs.getPropertyValue('--brand').trim(), tokens:document.documentElement.dataset.tokens||''}); })()`);
  const resetObj = JSON.parse(reset);
  check('重置主题清除内联 Token', resetObj.tokens === '' && resetObj.brand.toLowerCase() === '#2563eb', JSON.stringify(resetObj));
  const afterReset = await getJson(`${BASE}/api/theme`);
  check('重置后服务端无生效自定义主题', afterReset.body.ok === true && afterReset.body.active === null, JSON.stringify(afterReset.body.active));

  check('无页面异常', page.exceptions.length === 0, page.exceptions.join(' | '));
  const r = finish({ themes: ['base', 'lime'], imported: 'custom-orange', layer: 'raw/semantic/component' });
  process.exitCode = r.checks.every(c => c.ok) ? 0 : 1;
} catch (e) {
  check('测试执行无异常', false, e.message);
  console.error(e);
  finish({ error: String(e.stack || e) });
  process.exitCode = 1;
} finally {
  await page.close().catch(() => {});
}
