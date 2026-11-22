/** T06174 候选修复原型：外部 spacer + 行 DOM 节点池复用，验证 10k 滚动能否达到 55fps。 */
import path from 'node:path';
import fs from 'node:fs';
import { openPage, checker, OUT } from './cdp.mjs';

const { check, finish } = checker('proto-10k-rowpool');
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

    // 结构：spacer 负责 440k 滚动高度，sticky 0 高容器把表格固定在视口顶部
    const wrap=document.querySelector('#v-review div[style*="overflow:auto"]');
    const table=wrap.querySelector('table');
    const spacer=document.createElement('div'); spacer.className='p3-spacer';
    const sticky=document.createElement('div'); sticky.className='p3-sticky';
    wrap.insertBefore(spacer, table); wrap.insertBefore(sticky, table); sticky.appendChild(table);
    const css=document.createElement('style');
    css.textContent='#v-review .p3-spacer{height:0} #v-review .p3-sticky{position:sticky;top:0;height:0;z-index:1} #v-review .p3-sticky table{position:absolute;top:0;left:0;width:100%}';
    document.head.appendChild(css);

    const tbody=document.querySelector('#tbody');
    let pool=[], poolItems=[], poolFirst=-1, poolFirstSeq=-1, poolCount=0;
    const tpl=document.createElement('template');
    function makeRow(it,cur,showbSet,htmlFn){
      let html=(htmlFn||rowHtmlFn)(it)||'';
      html=html.replace('class="rowr','class="rowr '+(it.seq===cur?'cur':'')+' '+(showbSet&&showbSet.has(it.seq)?'showb':''));
      tpl.innerHTML=html; return tpl.content.firstElementChild;
    }
    function patchRow(tr,it,cur,showbSet,htmlFn){
      const fresh=makeRow(it,cur,showbSet,htmlFn);
      tr.className=fresh.className; tr.dataset.baseClass=''; tr.dataset.seq=fresh.dataset.seq; tr.innerHTML=fresh.innerHTML;
    }
    function baseClass(tr){ return (tr.dataset.baseClass||tr.className.replace(/\\b(cur|showb)\\b/g,'')).replace(/\\s+/g,' ').trim(); }
    function markClass(tr,it,cur,showbSet){
      if(!tr.dataset.baseClass) tr.dataset.baseClass=baseClass(tr);
      let c=tr.dataset.baseClass;
      if(it.seq===cur) c+=' cur';
      if(showbSet&&showbSet.has(it.seq)) c+=' showb';
      tr.className=c;
    }
    ctRenderVirtual=function(tbody,arr,htmlFn,cur,showbSet){
      const sc=ctScrollParent(tbody), vpH=sc?sc.clientHeight:600, visible=Math.ceil(vpH/CT.rowH);
      let first=Math.max(0,Math.floor((sc?sc.scrollTop:0)/CT.rowH)-8);
      first=Math.min(first,Math.max(0,arr.length-visible));
      const count=Math.min(arr.length-first,visible+17);
      spacer.style.height=(arr.length*CT.rowH)+'px';

      if(!pool.length || pool.length!==count || poolFirstSeq!==(arr[first]&&arr[first].seq) || Math.abs(first-poolFirst)>=count){
        tbody.innerHTML='';
        pool=[]; poolItems=[];
        for(let i=0;i<count;i++){ const it=arr[first+i]; const tr=makeRow(it,cur,showbSet,htmlFn); tbody.appendChild(tr); pool.push(tr); poolItems.push(it); }
      } else {
        const delta=first-poolFirst;
        if(delta>0){
          const start=count-delta;
          for(let i=0;i<delta;i++){
            const tr=pool.shift(); pool.push(tr); tbody.appendChild(tr);
            const it=arr[first+start+i]; poolItems.shift(); poolItems.push(it);
            patchRow(tr,it,cur,showbSet,htmlFn);
          }
        } else if(delta<0){
          for(let i=0;i<-delta;i++){
            const tr=pool.pop(); pool.unshift(tr); tbody.insertBefore(tr,tbody.firstChild);
            const it=arr[first+i]; poolItems.pop(); poolItems.unshift(it);
            patchRow(tr,it,cur,showbSet,htmlFn);
          }
        }
      }
      poolFirst=first; poolFirstSeq=arr[first]&&arr[first].seq; poolCount=count;
      for(let i=0;i<pool.length;i++) markClass(pool[i],poolItems[i],cur,showbSet);
      return {first,count};
    };
    CT_SC=null; CT_VPH=600; render();
    const sc=ctScrollParent(document.querySelector('#tbody'));
    return JSON.stringify({rows:document.querySelectorAll('#tbody tr.rowr').length,scrollHeight:sc.scrollHeight,
      clientHeight:sc.clientHeight,onWin:!!document.querySelector('#tbody tr.rowr')});
  })()`);
  const st = JSON.parse(setup);
  check('行池原型已装载', st.rows > 0 && st.rows <= 120 && st.scrollHeight >= 10000 * 44 - 10, JSON.stringify(st));

  const run = JSON.parse(await page.ev(`(async () => {
    const sc=ctScrollParent(document.querySelector('#tbody')); const duration=10000;
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
  })()`, 30000));
  const fps = run.frames / (run.elapsed / 1000);
  check('行池原型 10 秒滚动 ≥55fps', fps >= 55, `${fps.toFixed(1)}fps / ${run.frames} frames, long=${run.long}, maxRows=${run.maxRows}, last=${run.lastSeq}`);
  check('行池原型可到第 10000 行', run.lastSeq === '10000', `last=${run.lastSeq}, scrollTop=${run.scrollTop}/${run.scrollHeight - run.clientHeight}`);
  check('行池原型无白屏', run.blank === 0, `blank=${run.blank}`);
} catch (e) {
  check('测试执行无异常', false, e.message);
  console.error(e);
} finally { await page.close(); }
const r = finish();
fs.writeFileSync(path.join(OUT, 'results', 'proto-10k-rowpool.json'), JSON.stringify(r, null, 2));
process.exit(r.checks.every(c => c.ok) ? 0 : 1);
