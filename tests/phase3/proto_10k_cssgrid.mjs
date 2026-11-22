/** T06174 候选修复原型：CSS 把 <table> 改为 display:block + 行 grid + 缩小虚拟窗口。 */
import path from 'node:path';
import fs from 'node:fs';
import { openPage, checker, OUT } from './cdp.mjs';

const { check, finish } = checker('proto-10k-cssgrid');
const page = await openPage({ width: 1440, height: 900 });
try {
  await page.nav();
  const setup = await page.ev(`(() => {
    const st=document.createElement('style');
    st.textContent='#v-review div[style*="overflow:auto"]{max-height:calc(100vh - 240px);overflow:auto!important}';
    document.head.appendChild(st);
    goPage('work');
    const types=['ILF','EIF','EI','EO','EQ'];
    items=Array.from({length:10000},(_,i)=>({seq:i+1,system:'系统'+(i%12+1),desc:'功能项 '+(i+1),
      count_item:'计数项 '+(i+1),type:types[i%5],cx:['低','中','高'][i%3],reuse:'中',modify:'新增',ok:true}));
    goStep('review');

    const css=document.createElement('style');
    css.textContent=[
      '#v-review table{display:block;width:100%;table-layout:auto;border-collapse:separate;border-spacing:0}',
      '#v-review thead,#v-review tbody{display:block}',
      '#v-review tr{display:grid;grid-template-columns:34px minmax(240px,1fr) 168px 190px 56px 84px 84px 60px 96px;align-items:start}',
      '#v-review tr.vsp{display:block}',
      '#v-review tr.vsp td{display:block;height:100%;padding:0;border:0}',
      '#v-review th,#v-review td{display:block;min-width:0;border-bottom:1px solid var(--line-2);padding:9px 10px}',
      '#v-review thead th{font-size:12px;color:var(--muted);font-weight:600}',
      '#v-review tr.rowr{min-height:44px}',
      '#v-review td .descline{min-width:0}',
    ].join('');
    document.head.appendChild(css);

    CT.over=3; CT_SC=null; CT_VPH=600; render();
    const sc=ctScrollParent(document.querySelector('#tbody'));
    return JSON.stringify({rows:document.querySelectorAll('#tbody tr.rowr').length,scrollHeight:sc.scrollHeight,
      clientHeight:sc.clientHeight,tableDisplay:getComputedStyle(document.querySelector('#v-review table')).display,
      firstDisplay:getComputedStyle(document.querySelector('#tbody tr.rowr')).display});
  })()`);
  const st = JSON.parse(setup);
  check('CSS 网格原型已装载', st.rows > 0 && st.rows <= 120 && st.scrollHeight >= 10000 * 44 - 10, JSON.stringify(st));

  const run = JSON.parse(await page.ev(`(async () => {
    const sc=ctScrollParent(document.querySelector('#tbody')); const duration=60000;
    return await new Promise(resolve=>{
      const t0=performance.now(); let frames=0,long=0,last=t0,blank=0,maxRows=0;
      function tick(now){
        const p=Math.min(1,(now-t0)/duration);
        sc.scrollTop=Math.round(p*(sc.scrollHeight-sc.clientHeight));
        const rows=document.querySelectorAll('#tbody tr.rowr').length; maxRows=Math.max(maxRows,rows); if(!rows)blank++;
        frames++; if(now-last>20)long++; last=now;
        if(now-t0<duration) requestAnimationFrame(tick);
        else resolve(JSON.stringify({frames,long,blank,maxRows,elapsed:now-t0,scrollTop:sc.scrollTop,
          scrollHeight:sc.scrollHeight,clientHeight:sc.clientHeight,lastSeq:[...document.querySelectorAll('#tbody tr.rowr')].at(-1)?.dataset.seq}));
      }
      requestAnimationFrame(tick);
    });
  })()`, 70000));
  const fps = run.frames / (run.elapsed / 1000);
  check('CSS 网格原型 60 秒滚动 ≥55fps', fps >= 55, `${fps.toFixed(1)}fps / ${run.frames} frames, long=${run.long}, maxRows=${run.maxRows}, last=${run.lastSeq}`);
  check('CSS 网格原型可到第 10000 行', run.lastSeq === '10000', `last=${run.lastSeq}, scrollTop=${run.scrollTop}/${run.scrollHeight - run.clientHeight}`);
  check('CSS 网格原型无白屏', run.blank === 0, `blank=${run.blank}`);
} catch (e) {
  check('测试执行无异常', false, e.message);
  console.error(e);
} finally { await page.close(); }
const r = finish();
fs.writeFileSync(path.join(OUT, 'results', 'proto-10k-cssgrid.json'), JSON.stringify(r, null, 2));
process.exit(r.checks.every(c => c.ok) ? 0 : 1);
