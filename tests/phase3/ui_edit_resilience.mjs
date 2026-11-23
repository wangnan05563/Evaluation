/** T06175 / AC-04 / REQ-004：编辑韧性、1 秒自动保存、20 步撤销/重做。 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openPage, checker, sleep, OUT } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { check, finish } = checker('edit-resilience');
const page = await openPage({ width: 1440, height: 900 });
const values = ['低', '中', '高'];

try {
  await page.nav();
  const setup = JSON.parse(await page.ev(`(async () => {
    CT_SC=null; CT_VPH=600; goPage('work');
    items=Array.from({length:30},(_,i)=>({seq:i+1,system:'系统'+(i%3+1),desc:'功能项 '+(i+1),
      count_item:'计数项 '+(i+1),type:['EI','EO','EQ','ILF','EIF'][i%5],cx:['低','中','高'][i%3],
      reuse:'中',modify:'新增',ok:false,_ai:{type:'EI',reuse:'中',modify:'新增'}}));
    goStep('review');
    await new Promise(r=>setTimeout(r,450)); try{window.WLGuide&&WLGuide.stop()}catch(e){}
    for(let i=0;i<40&&!document.querySelectorAll('#tbody .rowr').length;i++)await new Promise(r=>setTimeout(r,50));
    saveFormState();
    const row=document.querySelector('#tbody .rowr');
    return JSON.stringify({ufp:document.querySelector('#treeUfp').textContent, n:items.length,
      targetSeq:row?+row.dataset.seq:null, selCount:document.querySelectorAll('#tbody select[data-k="cx"]').length,
      saved:!!localStorage.getItem('we_form_state_v1'), undoDisabled:document.querySelector('#undoBtn').disabled});
  })()`));
  check('30 行复核数据已装载', setup.n === 30, `n=${setup.n}`);
  check('复核行可编辑（cx 下拉存在）', setup.selCount > 0, `selects=${setup.selCount}, target=${setup.targetSeq}`);
  check('初始 UFP 已计算', setup.ufp !== '' && setup.ufp !== '0', `ufp=${setup.ufp}`);
  check('初始无撤销栈（按钮禁用）', setup.undoDisabled === true, `disabled=${setup.undoDisabled}`);

  const run = JSON.parse(await page.ev(`(() => {
    const row=document.querySelector('#tbody .rowr'); if(!row)throw new Error('无复核行');
    const seq=+row.dataset.seq, out=[];
    for(let i=0;i<25;i++){
      const v=${JSON.stringify(values)}[i%3];
      const s=document.querySelector('#tbody .rowr select[data-k="cx"]');
      s.value=v; s.dispatchEvent(new Event('change',{bubbles:true}));
      out.push(items.find(x=>x.seq===seq).cx);
    }
    return JSON.stringify({seq,values:out, undo:undoStack.length, redo:redoStack.length,
      btnDisabled:document.querySelector('#undoBtn').disabled, savedCx:JSON.parse(localStorage.getItem('we_form_state_v1')).items.find(x=>x.seq===seq).cx});
  })()`));
  check('25 次编辑均触发撤销入栈', run.undo === 20, `undo=${run.undo}`);
  check('撤销按钮在可撤销时启用', run.btnDisabled === false, `disabled=${run.btnDisabled}`);
  check('每次编辑后自动保存（即时落盘）', run.savedCx === run.values.at(-1), `saved=${run.savedCx} live=${run.values.at(-1)}`);

  const undo = JSON.parse(await page.ev(`(() => {
    const before=document.querySelector('#treeUfp').textContent;
    for(let i=0;i<20;i++) document.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}));
    return JSON.stringify({cx:items.find(x=>x.seq===${run.seq}).cx, undo:undoStack.length, redo:redoStack.length,
      ufp:document.querySelector('#treeUfp').textContent, before});
  })()`));
  check('20 步撤销回到第 5 次编辑后的状态', undo.cx === run.values[4], `cx=${undo.cx} expect=${run.values[4]}`);
  check('20 步撤销后撤销栈耗尽、重做栈 20', undo.undo === 0 && undo.redo === 20, `undo=${undo.undo} redo=${undo.redo}`);
  check('撤销后 UFP 公式结果一致', undo.ufp === undo.before, `before=${undo.before} after=${undo.ufp}`);

  const redo = JSON.parse(await page.ev(`(() => {
    for(let i=0;i<20;i++) document.dispatchEvent(new KeyboardEvent('keydown',{key:'y',ctrlKey:true,bubbles:true}));
    return JSON.stringify({cx:items.find(x=>x.seq===${run.seq}).cx, undo:undoStack.length, redo:redoStack.length,
      ufp:document.querySelector('#treeUfp').textContent});
  })()`));
  check('20 步重做回到最后编辑状态', redo.cx === run.values.at(-1), `cx=${redo.cx} expect=${run.values.at(-1)}`);
  check('重做后撤销栈恢复 20', redo.undo === 20, `undo=${redo.undo}`);

  // 类型变更影响 UFP，撤销后必须重算回原值，证明“撤销不破坏公式”
  const formula = JSON.parse(await page.ev(`(() => {
    const before=document.querySelector('#treeUfp').textContent;
    const row=document.querySelector('#tbody .rowr'), seq=+row.dataset.seq;
    const s=document.querySelector('#tbody .rowr select[data-k="type"]');
    s.value='ILF'; s.dispatchEvent(new Event('change',{bubbles:true}));
    const changed=document.querySelector('#treeUfp').textContent;
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}));
    return JSON.stringify({before,changed,after:document.querySelector('#treeUfp').textContent,type:items.find(x=>x.seq===seq).type});
  })()`));
  check('类型变更会改变 UFP（公式确实参与）', formula.changed !== formula.before, `before=${formula.before} changed=${formula.changed}`);
  check('撤销类型变更后 UFP 恢复', formula.after === formula.before && formula.type !== 'ILF', JSON.stringify(formula));

  const auto = JSON.parse(await page.ev(`(async () => {
    const rows=document.querySelectorAll('#tbody .rowr'); const second=rows[1]||rows[0]; const seq2=+second.dataset.seq;
    const ck=second.querySelector('.ck');
    ck.checked=true; ck.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(r=>setTimeout(r,80));
    let saved=JSON.parse(localStorage.getItem('we_form_state_v1')).items.find(x=>x.seq===seq2).ok;
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}));
    await new Promise(r=>setTimeout(r,80));
    const after=JSON.parse(localStorage.getItem('we_form_state_v1')).items.find(x=>x.seq===seq2).ok;
    return JSON.stringify({seq2,saved,after,ok:items.find(x=>x.seq===seq2).ok});
  })()`));
  check('勾选变更即时自动保存', auto.saved === true, `saved=${auto.saved}`);
  check('撤销勾选后状态与落盘一致', auto.after === false && auto.ok === false, JSON.stringify(auto));

  await sleep(120);
  await page.nav();
  const restored = JSON.parse(await page.ev(`(async () => {
    await new Promise(r=>setTimeout(r,300)); try{window.WLGuide&&WLGuide.stop()}catch(e){}
    return JSON.stringify({n:items.length, cx:items.find(x=>x.seq===${run.seq})?.cx, ok2:items.find(x=>x.seq===${auto.seq2})?.ok,
      step:document.body.dataset.step, hasBtn:!!document.querySelector('#undoBtn'),
      undoDisabled:document.querySelector('#undoBtn').disabled});
  })()`));
  check('刷新/崩溃重开恢复到 30 行与最后编辑值', restored.n === 30 && restored.cx === run.values.at(-1) && restored.ok2 === false, JSON.stringify(restored));
  check('恢复后进入复核页（最后编辑点）', restored.step === 'review', `step=${restored.step}`);
  check('恢复后撤销栈清空且按钮禁用', restored.hasBtn && restored.undoDisabled === true, `disabled=${restored.undoDisabled}`);

  check('无页面异常', page.exceptions.length === 0, page.exceptions.join(' | '));
  fs.mkdirSync(path.join(OUT, 'results'), { recursive: true });
  const r = finish({ edits: 25, undoLimit: 20, restored: true });
  process.exitCode = r.checks.every(c => c.ok) ? 0 : 1;
} catch (e) {
  check('测试执行无异常', false, e.message);
  console.error(e);
  finish({ error: String(e.stack || e) });
  process.exitCode = 1;
} finally {
  await page.close().catch(() => {});
}
