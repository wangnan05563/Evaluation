/** T06174 候选修复原型：div 网格 + 行节点池，验证脱离 <table> 布局后 10k 滚动能否达到 55fps。 */
import path from 'node:path';
import fs from 'node:fs';
import { openPage, checker, OUT } from './cdp.mjs';

const { check, finish } = checker('proto-10k-divgrid');
const page = await openPage({ width: 1440, height: 900 });
try {
  await page.nav();
  const setup = await page.ev(`(() => {
    const st=document.createElement('style');
    st.textContent='#v-review div[style*="overflow:auto"]{max-height:calc(100vh - 240px);overflow:auto!important}';
    document.head.appendChild(st);
    CT_SC=null; CT_VPH=600;
    goPage('work');
    const types=['ILF','EIF','EI','EO','EQ'];
    items=Array.from({length:10000},(_,i)=>({seq:i+1,system:'系统'+(i%12+1),desc:'功能项 '+(i+1),
      count_item:'计数项 '+(i+1),type:types[i%5],cx:['低','中','高'][i%3],reuse:'中',modify:'新增',ok:true}));
    goStep('review'); render();

    const wrap=document.querySelector('#v-review div[style*="overflow:auto"]');
    wrap.innerHTML='';
    wrap.insertAdjacentHTML('beforeend',
      '<div class="p3spacer"></div><div class="p3v"><div class="p3rows"></div></div>');
    const spacer=wrap.querySelector('.p3spacer'), vp=wrap.querySelector('.p3v'), rowsBox=wrap.querySelector('.p3rows');
    const css=document.createElement('style');
    css.textContent='#v-review .p3spacer{height:0} #v-review .p3v{position:sticky;top:0;height:0;z-index:1} #v-review .p3rows{position:absolute;top:0;left:0;right:0} #v-review .p3row{display:grid;grid-template-columns:44px 86px minmax(180px,1fr) 110px 64px 56px 56px 56px 90px;align-items:center;height:44px;border-bottom:1px solid #e5e7eb;font:13px/1.4 system-ui,"Microsoft YaHei";padding:0 8px;background:#fff} #v-review .p3row .desc{overflow:hidden;text-overflow:ellipsis;white-space:nowrap} #v-review .p3row .badge{display:inline-block;padding:2px 8px;border-radius:4px;background:#eef2ff;color:#4054b2} #v-review .p3row input{width:14px;height:14px}';
    document.head.appendChild(css);

    const cols=['seq','system','desc','count_item','type','cx','reuse','modify'];
    function rowHtml(it){
      return '<div class="p3row" data-seq="'+it.seq+'">'+
        '<span><input type="checkbox" '+(it.ok?'checked':'')+'></span>'+
        '<span>'+it.system+'</span><span class="desc">'+it.desc+'</span><span>'+it.count_item+'</span>'+
        '<span><b class="badge">'+it.type+'</b></span><span>'+it.cx+'</span><span>'+it.reuse+'</span><span>'+it.modify+'</span><span>已确认</span></div>';
    }
    const tpl=document.createElement('template');
    function make(it){ tpl.innerHTML=rowHtml(it); return tpl.content.firstElementChild; }
    let pool=[], poolItems=[], poolFirst=-1, poolFirstSeq=-1;
    function draw(){
      const vh=wrap.clientHeight, visible=Math.ceil(vh/44);
      let first=Math.max(0,Math.floor(wrap.scrollTop/44)-3);
      first=Math.min(first,Math.max(0,items.length-visible));
      const count=Math.min(items.length-first,visible+5);
      spacer.style.height=(items.length*44)+'px';
      if(!pool.length || pool.length!==count || poolFirstSeq!==items[first].seq || Math.abs(first-poolFirst)>=count){
        rowsBox.innerHTML=''; pool=[]; poolItems=[];
        for(let i=0;i<count;i++){ const it=items[first+i]; const row=make(it); rowsBox.appendChild(row); pool.push(row); poolItems.push(it); }
      } else {
        const delta=first-poolFirst;
        if(delta>0){
          const start=count-delta;
          for(let i=0;i<delta;i++){
            const row=pool.shift(); pool.push(row); rowsBox.appendChild(row);
            const it=items[first+start+i]; poolItems.shift(); poolItems.push(it);
            tpl.innerHTML=rowHtml(it); row.replaceWith(tpl.content.firstElementChild); pool[pool.length-1]=rowsBox.lastElementChild;
            poolItems[poolItems.length-1]=it;
          }
        } else if(delta<0){
          for(let i=0;i<-delta;i++){
            const row=pool.pop(); pool.unshift(row); rowsBox.insertBefore(row,rowsBox.firstChild);
            const it=items[first+i]; poolItems.pop(); poolItems.unshift(it);
            tpl.innerHTML=rowHtml(it); row.replaceWith(tpl.content.firstElementChild); pool[0]=rowsBox.firstElementChild;
            poolItems[0]=it;
          }
        }
      }
      poolFirst=first; poolFirstSeq=items[first].seq;
    }
    wrap.addEventListener('scroll',draw,{passive:true});
    draw();
    return JSON.stringify({rows:rowsBox.children.length,scrollHeight:wrap.scrollHeight,clientHeight:wrap.clientHeight,last:rowsBox.lastElementChild?.dataset.seq});
  })()`);
  const st = JSON.parse(setup);
  check('div 网格原型已装载', st.rows > 0 && st.rows <= 120 && st.scrollHeight >= 10000 * 44 - 10, JSON.stringify(st));

  const run = JSON.parse(await page.ev(`(async () => {
    const wrap=document.querySelector('#v-review div[style*="overflow:auto"]');
    const rowsBox=wrap.querySelector('.p3rows'); const duration=60000;
    return await new Promise(resolve=>{
      const t0=performance.now(); let frames=0,long=0,last=t0,blank=0,maxRows=0;
      function tick(now){
        const p=Math.min(1,(now-t0)/duration);
        wrap.scrollTop=Math.round(p*(wrap.scrollHeight-wrap.clientHeight));
        const rows=rowsBox.children.length; maxRows=Math.max(maxRows,rows); if(!rows)blank++;
        frames++; if(now-last>20)long++; last=now;
        if(now-t0<duration) requestAnimationFrame(tick);
        else resolve(JSON.stringify({frames,long,blank,maxRows,elapsed:now-t0,scrollTop:wrap.scrollTop,
          scrollHeight:wrap.scrollHeight,clientHeight:wrap.clientHeight,lastSeq:rowsBox.lastElementChild?.dataset.seq}));
      }
      requestAnimationFrame(tick);
    });
  })()`, 70000));
  const fps = run.frames / (run.elapsed / 1000);
  check('div 网格原型 60 秒滚动 ≥55fps', fps >= 55, `${fps.toFixed(1)}fps / ${run.frames} frames, long=${run.long}, maxRows=${run.maxRows}, last=${run.lastSeq}`);
  check('div 网格原型可到第 10000 行', run.lastSeq === '10000', `last=${run.lastSeq}, scrollTop=${run.scrollTop}/${run.scrollHeight - run.clientHeight}`);
  check('div 网格原型无白屏', run.blank === 0, `blank=${run.blank}`);
} catch (e) {
  check('测试执行无异常', false, e.message);
  console.error(e);
} finally { await page.close(); }
const r = finish();
fs.writeFileSync(path.join(OUT, 'results', 'proto-10k-divgrid.json'), JSON.stringify(r, null, 2));
process.exit(r.checks.every(c => c.ok) ? 0 : 1);
