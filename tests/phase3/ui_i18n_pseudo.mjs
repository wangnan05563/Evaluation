/** T06178：中英 key 对齐 + 伪本地化压力（+35% 长度）三宽度无破版 + CJK 字体可测量。 */
import path from 'node:path';
import { openPage, checker, OUT } from './cdp.mjs';

const { check, finish } = checker('ui-i18n-pseudo');
const page = await openPage({ width: 1440, height: 900 });
let result;
try {
  await page.nav();
  await page.ev(`localStorage.setItem('wl_guide_done_pages_v1', JSON.stringify({work:true,pert:true,config:true,help:true}));`);

  const dict = JSON.parse(await page.ev(`fetch('/api/i18n?lang=en-US').then(r=>r.json()).then(JSON.stringify)`));
  check('en-US 字典可取', dict.ok === true && Object.keys(dict.strings || {}).length > 500, `keys=${Object.keys(dict.strings || {}).length}`);

  const applied = JSON.parse(await page.ev(`(() => {
    const src = ${JSON.stringify(dict.strings)};
    const accent = {a:'á',b:'ƀ',c:'ç',d:'ð',e:'é',f:'ƒ',g:'ĝ',h:'ĥ',i:'í',j:'ĵ',k:'ķ',l:'ļ',m:'ɱ',n:'ñ',o:'ó',p:'þ',q:' q',r:'ŕ',s:'š',t:'ţ',u:'ú',v:'ṽ',w:'ŵ',x:'ẋ',y:'ý',z:'ž'};
    const pseudo = s => {
      const t = String(s).replace(/[a-zA-Z]/g, ch => accent[ch.toLowerCase()] || ch);
      return t + ' ⟪' + t.slice(0, Math.max(4, Math.round(t.length * 0.35))) + '⟫';
    };
    __I18N = Object.fromEntries(Object.entries(src).map(([k,v]) => [k, pseudo(v)]));
    __I18N_LANG = 'qps';
    applyI18n();
    return JSON.stringify({ n: Object.keys(__I18N).length, title: t('app.title'), h1: document.querySelector('.brand h1').textContent.trim(), lang: document.documentElement.lang });
  })()`));
  check('伪本地化字典覆盖全部 key', applied.n === Object.keys(dict.strings).length, `n=${applied.n}`);
  check('t() 与 DOM 均已切换到伪本地化', applied.title !== dict.strings['app.title'] && applied.h1 !== '工作量评估助手', `title=${applied.title.slice(0, 32)}`);

  const widths = [];
  for (const [w, h] of [[1440, 900], [1024, 900], [768, 900]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, page.S);
    await page.ev(`goPage('work');goStep('upload');applyI18n();`);
    await new Promise(r => setTimeout(r, 400));
    const z = JSON.parse(await page.ev(`(() => {
      const de=document.documentElement;
      const clipped=[...document.querySelectorAll('.nav .lbl,.step span,.brand h1,.btn')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&(r.right>innerWidth+1||r.left<-1);}).length;
      const overflow=[...document.querySelectorAll('.nav .lbl,.step span,.brand h1,.btn')].filter(e=>e.scrollWidth>e.clientWidth+2).length;
      const wide=[...document.querySelectorAll('body *')].map(e=>{const r=e.getBoundingClientRect();return {tag:e.tagName,cls:(e.className&&e.className.baseVal!==undefined?e.className.baseVal:e.className)||'',id:e.id||'',right:Math.round(r.right),left:Math.round(r.left),w:Math.round(r.width),sw:e.scrollWidth,cw:e.clientWidth};}).filter(x=>x.w&&(x.right>innerWidth+1||x.left<-1||x.sw>x.cw+2)).slice(0,12);
      return JSON.stringify({vw:innerWidth, docW:de.scrollWidth, bodyW:document.body.scrollWidth, clipped, overflow, wide, lang:document.documentElement.lang});
    })()`));
    widths.push({ width: w, ...z });
    check(`伪本地化 ${w}px 无横向滚动`, z.docW <= z.vw + 2 && z.bodyW <= z.vw + 2, `vw=${z.vw} doc=${z.docW} body=${z.bodyW} wide=${JSON.stringify(z.wide)}`);
    check(`伪本地化 ${w}px 标签未裁切/溢出`, z.clipped === 0 && z.overflow === 0, `clipped=${z.clipped} overflow=${z.overflow}`);
    await page.shot(path.join(OUT, 'screenshots', `i18n_pseudo_${w}.png`));
  }

  const font = JSON.parse(await page.ev(`(() => {
    const ctx=document.createElement('canvas').getContext('2d');
    ctx.font='16px "Microsoft YaHei", "Noto Sans SC", sans-serif';
    const cjk=ctx.measureText('工作量评估助手').width;
    const latin=ctx.measureText('Workload').width;
    return JSON.stringify({status:document.fonts.status, cjk, latin, family:getComputedStyle(document.body).fontFamily});
  })()`));
  check('CJK 字体已加载且可测量（非豆腐块宽度）', font.status === 'loaded' && font.cjk > 40, JSON.stringify(font));

  await page.ev(`__I18N_LANG='zh-CN'; __I18N=${JSON.stringify({})}; applyI18n(); goPage('work');goStep('upload');`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, page.S);
  result = finish({ widths, applied: { n: applied.n, title: applied.title.slice(0, 40) }, font });
} catch (e) {
  check('测试执行无异常', false, e.message);
  console.error(e);
} finally {
  await page.close();
}
result = result || finish();
process.exit(result.checks.every(c => c.ok) ? 0 : 1);
