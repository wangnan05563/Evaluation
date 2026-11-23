/** T06186：100 条复核效率基线 vs 优化路径对比（真实 DOM 交互计时）。
 *  基线：旧路径逐条「打开证据抽屉 → 标记确认」（2 次交互/行）；
 *  优化：低风险一键批量确认 + 仅中高风险逐条复核（ReviewPerf 记录操作/耗时）。
 *  要求：优化总用时较基线下降 ≥30%，且 100 条全部确认、复核逻辑不变。
 */
import { openPage, checker, sleep, OUT } from './cdp.mjs';
import path from 'node:path';

const { check, finish } = checker('ui-review-efficiency');
const page = await openPage({ width: 1440, height: 900 });
let base = {}, opt = {}, reduction = 0, perf = null;

const seed = `
(() => {
  const types=['ILF','EIF','EI','EO','EQ'];
  const mk=(seq, high) => high ? {
    seq, system:'系统B', desc:'重复功能点 '+('长描述'.repeat(45)), count_item:'',
    type:'EI', reuse:'中', modify:'新增', basis:'', ok:false
  } : {
    seq, system:'系统A', desc:'低风险功能点 '+seq, count_item:'计数项 '+seq,
    type:types[seq%5], reuse:'中', modify:'新增', basis:'规则命中', ok:false
  };
  items = [...Array.from({length:80},(_,i)=>mk(i+1,false)), ...Array.from({length:20},(_,i)=>mk(81+i,true))];
  curSeq=null; rejQueue=[]; undoStack.length=0; redoStack.length=0;
  goPage('work'); goStep('review'); render();
  return JSON.stringify({n:items.length, low:RWB.lowPending().length, high:items.filter(x=>RWB.level(x)==='high').length});
})()`;

const reset = `
(() => {
  const types=['ILF','EIF','EI','EO','EQ'];
  const mk=(seq, high) => high ? {
    seq, system:'系统B', desc:'重复功能点 '+('长描述'.repeat(45)), count_item:'',
    type:'EI', reuse:'中', modify:'新增', basis:'', ok:false
  } : {
    seq, system:'系统A', desc:'低风险功能点 '+seq, count_item:'计数项 '+seq,
    type:types[seq%5], reuse:'中', modify:'新增', basis:'规则命中', ok:false
  };
  items = [...Array.from({length:80},(_,i)=>mk(i+1,false)), ...Array.from({length:20},(_,i)=>mk(81+i,true))];
  curSeq=null; rejQueue=[]; undoStack.length=0; redoStack.length=0; render();
  return items.length;
})()`;

try {
  await page.nav();
  await page.ev(`localStorage.setItem('wl_guide_done_pages_v1', JSON.stringify({work:true,pert:true,config:true,help:true})); try{localStorage.setItem('wl_role_v1',JSON.stringify({id:'evaluator'}));}catch(e){}; window.RoleOnboard&&RoleOnboard.close(); WLGuide&&WLGuide.stop();`);
  const s = JSON.parse(await page.ev(seed));
  check('基线数据 100 条（80 低风险 / 20 高风险）', s.n === 100 && s.low === 80 && s.high === 20, JSON.stringify(s));
  await sleep(250);
  const ui = JSON.parse(await page.ev(`(() => JSON.stringify({
    smart: !!document.querySelector('#smartReview'),
    smartText: (document.querySelector('#smartReviewTxt')||{}).textContent||'',
    smartDisabled: !!(document.querySelector('#smartReview')||{}).disabled,
    unconfirm: !!document.querySelector('#batchUnconfirm'),
    hint: (document.querySelector('.rwb-kbd-hint')||{}).textContent||''
  }))()`));
  check('批量条提供低风险一键确认', ui.smart && /80/.test(ui.smartText) && ui.smartDisabled === false, JSON.stringify(ui));
  check('批量条提供批量取消确认（驳回）', ui.unconfirm === true);
  check('复核页显示键盘路径提示', /J/.test(ui.hint) && /C/.test(ui.hint) && /Enter/.test(ui.hint), ui.hint);

  const kb = JSON.parse(await page.ev(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'a', bubbles:true}));
    const afterA={ok:items.filter(x=>x.ok).length, low:RWB.lowPending().length};
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'j', bubbles:true}));
    const selectedAfterJ=RWB.selected;
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'c', bubbles:true}));
    const afterC={ok:items.filter(x=>x.ok).length, selected:RWB.selected};
    return JSON.stringify({afterA, selectedAfterJ, afterC, drawerOpen:!!document.querySelector('#evidenceDrawer').classList.contains('open')});
  })()`));
  check('快捷键 A 一键确认 80 条低风险', kb.afterA.ok === 80 && kb.afterA.low === 0, JSON.stringify(kb));
  check('快捷键 J 跳到下一条高风险', kb.selectedAfterJ === 81, JSON.stringify(kb));
  check('快捷键 C 确认当前并自动下一条', kb.afterC.ok === 81 && kb.afterC.selected === 82 && kb.drawerOpen === true, JSON.stringify(kb));

  const batch = JSON.parse(await page.ev(`(() => {
    const old=window.confirm; window.confirm=()=>true;
    batchUnconfirm();
    const off=items.filter(x=>!x.ok).length;
    batchConfirm();
    const on=items.filter(x=>x.ok).length;
    window.confirm=old;
    return JSON.stringify({off,on});
  })()`));
  check('批量取消确认/批量确认往返生效', batch.off === 100 && batch.on === 100, JSON.stringify(batch));
  await page.ev(reset);
  await sleep(200);
  await page.ev(reset);
  await sleep(200);

  // 基线：旧路径逐条「打开证据抽屉 + 勾选确认」，100 行 × 2 次交互
  base = JSON.parse(await page.ev(`(() => {
    const t0=performance.now();
    for(let i=1;i<=100;i++){
      RWB.select(i);
      const ck=document.querySelector('#tbody .rowr[data-seq="'+i+'"] .ck');
      if(ck) ck.click();
    }
    return JSON.stringify({ms:Math.round((performance.now()-t0)*10)/10, ok:items.filter(x=>x.ok).length, selected: RWB.selected});
  })()`));
  check('基线 100 条全部确认', base.ok === 100, JSON.stringify(base));

  await page.ev(reset);
  await sleep(200);
  // 优化：一键低风险 + 仅 20 条高风险逐条复核
  opt = JSON.parse(await page.ev(`(() => {
    ReviewPerf.begin();
    const t0=performance.now();
    const low=RWB.smartConfirm();
    const high=items.filter(x=>!x.ok);
    for(const it of high){ RWB.select(it.seq); const ck=document.querySelector('#tbody .rowr[data-seq="'+it.seq+'"] .ck'); if(ck) ck.click(); }
    const rec=ReviewPerf.finish();
    return JSON.stringify({ms:Math.round((performance.now()-t0)*10)/10, low, high:high.length, ok:items.filter(x=>x.ok).length, perf:rec});
  })()`));
  check('优化路径只自动确认 80 条低风险', opt.low === 80 && opt.high === 20, JSON.stringify(opt));
  check('优化路径 100 条全部确认', opt.ok === 100, JSON.stringify(opt));
  reduction = base.ms > 0 ? (base.ms - opt.ms) / base.ms : 0;
  check('复核总用时较基线下降≥30%', reduction >= 0.30,
    `baseline=${base.ms}ms optimized=${opt.ms}ms reduction=${(reduction*100).toFixed(1)}% (${((1-reduction)*100).toFixed(1)}% of baseline)`);
  check('ReviewPerf 记录操作与耗时', !!(opt.perf && opt.perf.duration_ms >= 0), JSON.stringify(opt.perf));
  perf = opt.perf;
  await page.shot(path.join(OUT, 'screenshots', 'review_efficiency_1440.png'), false);
} catch (e) {
  check('复核效率套件无异常', false, e.message);
} finally {
  const r = finish({ baseline_ms: base.ms, optimized_ms: opt.ms, reduction_pct: Math.round(reduction*1000)/10,
    baseline_ok: base.ok, optimized_ok: opt.ok, optimized_low: opt.low, perf });
  await page.close();
  process.exit(r.pass === r.total ? 0 : 1);
}

