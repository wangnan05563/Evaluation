/* ===== T06186：复核效率优化（不改复核逻辑） =====
 * 交互优化：
 * 1) 一键确认“低风险”待复核项（风险评分 <25），中/高风险仍逐条复核；
 * 2) J/K 在未确认队列中切换，Enter 确认当前并自动下一条；A 触发低风险批量；
 * 3) 批量条新增“取消确认（批量驳回）”和低风险计数；
 * 4) 本地记录复核开始/结束/操作次数（匿名，不上传），供 30% 降幅验收。
 */
(function(){
  if(!window.RWB) return;
  const PERF_KEY = 'wl_review_perf_v1';
  let startedAt = 0, startedWall = 0, actions = 0, ops = [];
  let lastReport = null;

  function now(){ return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function report(){
    let arr = [];
    try { arr = JSON.parse(localStorage.getItem(PERF_KEY) || '[]'); } catch(e) { arr = []; }
    return { last: arr.length ? arr[arr.length - 1] : null, history: arr };
  }
  function begin(){
    startedAt = now(); startedWall = Date.now(); actions = 0; ops = [];
    ops.push({ k: 'review_start', t: 0 });
  }
  function finish(){
    if(!startedAt) return null;
    const duration = Math.round(now() - startedAt);
    const rec = { started_at: new Date(startedWall).toISOString(), duration_ms: duration,
      items: items.length, confirmed: items.filter(x => x.ok).length, actions,
      ops: ops.slice(-300) };
    lastReport = rec;
    try {
      const arr = JSON.parse(localStorage.getItem(PERF_KEY) || '[]');
      arr.push(rec);
      localStorage.setItem(PERF_KEY, JSON.stringify(arr.slice(-10)));
    } catch(e) {}
    startedAt = 0;
    return rec;
  }
  function action(kind, data){
    actions++;
    if(ops.length < 300) ops.push(Object.assign({ k: kind, t: Math.round(now() - (startedAt || now())) }, data || {}));
  }
  function lowPending(){
    if(typeof items === 'undefined' || !items) return [];
    return items.filter(it => !it.ok && RWB.level(it) === 'low' && (typeof window.canConfirmItem!=='function'||window.canConfirmItem(it)));
  }
  function updateSmartBtn(){
    const btn = document.getElementById('smartReview');
    const txt = document.getElementById('smartReviewTxt');
    if(!btn || !txt) return;
    const n = lowPending().length;
    const label = (typeof tf === 'function') ? tf('review.batch.smart_n', { n }) : ('确认低风险（' + n + '）');
    if(typeof dynText === 'function') dynText(txt, () => (typeof tf === 'function') ? tf('review.batch.smart_n', { n: lowPending().length }) : ('确认低风险（' + lowPending().length + '）'));
    else txt.textContent = label;
    btn.disabled = n === 0;
  }
  function smartConfirm(){
    const low = lowPending();
    if(!low.length){
      if(typeof toast === 'function') toast((typeof tl === 'function') ? tl('review.smart.none', '没有低风险待复核项；请用 J/K 逐条复核中高风险。') : '没有低风险待复核项；请用 J/K 逐条复核中高风险。');
      return 0;
    }
    if(typeof pushUndo === 'function') pushUndo('智能复核低风险');
    low.forEach(it => { it.ok = true; });
    action('smart_confirm', { n: low.length });
    render();
    if(typeof saveFormState === 'function') saveFormState();
    if(typeof updateUndoUI === 'function') updateUndoUI();
    if(typeof toast === 'function') toast((typeof tf === 'function') ? tf('review.smart.done', { n: low.length }) : ('已确认 ' + low.length + ' 项低风险功能点'));
    updateSmartBtn();
    return low.length;
  }
  function nextPending(dir){
    let arr = (typeof visibleItems === 'function' ? visibleItems() : items.slice()).filter(it => !it.ok);
    if(!arr.length) return null;
    if(RWB.riskSort) arr = RWB.sortRows(arr);
    const cur = (typeof curSeq !== 'undefined') ? curSeq : null;
    let idx = arr.findIndex(it => it.seq === cur);
    if(idx < 0) idx = dir > 0 ? -1 : 0;
    let n = idx + (dir > 0 ? 1 : -1);
    if(n < 0) n = arr.length - 1;
    if(n >= arr.length) n = 0;
    const it = arr[n];
    RWB.select(it.seq);
    action('queue_nav', { seq: it.seq });
    return it.seq;
  }
  function confirmAndNext(){
    const cur = (typeof curSeq !== 'undefined') ? curSeq : null;
    let it = cur != null ? items.find(x => x.seq === cur) : null;
    if(!it){ const seq = nextPending(1); if(seq == null) return; it = items.find(x => x.seq === seq); }
    if(it && !it.ok) RWB.toggleConfirm(it.seq);
    const seq = nextPending(1);
    if(seq == null && typeof toast === 'function') toast((typeof tl === 'function') ? tl('review.smart.all_done', '所有功能点已确认，可生成结果。') : '所有功能点已确认，可生成结果。');
  }

  RWB.smartConfirm = smartConfirm;
  RWB.nextPending = nextPending;
  RWB.confirmAndNext = confirmAndNext;
  RWB.lowPending = lowPending;
  const origOnRender = RWB.onRender;
  RWB.onRender = function(){
    const r = origOnRender.apply(this, arguments);
    updateSmartBtn();
    return r;
  };
  const origGoStep = window.goStep;
  window.goStep = function(s){
    if(s === 'review') begin();
    const r = typeof origGoStep === 'function' ? origGoStep.apply(this, arguments) : null;
    if(s === 'result') finish();
    return r;
  };
  document.addEventListener('keydown', function(e){
    if(e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if(document.body.dataset.page !== 'work' || document.body.dataset.step !== 'review') return;
    const t = e.target;
    if(t && (t.matches && t.matches('input,textarea,select,button,a,[contenteditable="true"]'))) return;
    const cmdk = document.getElementById('cmdk');
    if(cmdk && !cmdk.hidden) return;
    const role = document.getElementById('roleWelcome');
    if(role && !role.hidden) return;
    const presenter = document.getElementById('presenter');
    if(presenter && !presenter.hidden) return;
    const key = String(e.key || '').toLowerCase();
    if(key === 'j' || key === 'k'){ e.preventDefault(); nextPending(key === 'j' ? 1 : -1); return; }
    if(key === 'a'){ e.preventDefault(); smartConfirm(); return; }
    if(key === 'c'){ e.preventDefault(); confirmAndNext(); return; }
    if(key === 'enter'){
      if(t && t.closest && t.closest('#tbody .rowr')){ e.preventDefault(); confirmAndNext(); return; }
      if(typeof curSeq !== 'undefined' && curSeq != null){ e.preventDefault(); confirmAndNext(); }
    }
  });
  window.smartConfirm = smartConfirm;
  window.ReviewPerf = { begin, finish, action, report,
    reset: function(){ try { localStorage.removeItem(PERF_KEY); } catch(e) {} lastReport = null; startedAt = 0; },
    get last(){ return lastReport; } };
  updateSmartBtn();
})();
