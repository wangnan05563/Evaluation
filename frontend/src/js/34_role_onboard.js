/* ===== T06183：首次启动角色化引导（评估师 5 分钟样例） =====
 * 目标：首次启动选择“评估师”后，用内置样例走完「识别 → 全确认 → 生成结果」，
 * 在 5 分钟内拿到一次完整估算结果；不提供高级功能引导。
 * 设计约束：
 * - 覆盖层只在首次启动出现；既有 UI 测试通过 ?welcome=0 跳过，不污染回归。
 * - 样例由 /api/onboarding/sample 内存生成，走正常 /api/recognize 链路，不直填结果。
 * - 角色与首次样例耗时只写 localStorage（本地匿名埋点），不上传。
 */
(function(){
  const ROLE_KEY = 'wl_role_v1';
  const DISMISS_KEY = 'wl_onboard_dismissed_v1';
  const METRIC_KEY = 'wl_onboard_metrics_v1';
  const ROLES = ['evaluator', 'pmo', 'finance'];
  const CTA = {
    evaluator: '用样例 5 分钟跑通',
    pmo: '查看历史估算',
    finance: '打开费率配置',
  };
  const LABEL = { evaluator: '评估师', pmo: '项目经理 / PMO', finance: '财务 / 商务' };
  let current = 'evaluator';
  let running = false;
  let lastFocus = null;
  let startedAt = 0;

  const $rw = () => document.querySelector('#roleWelcome');
  const byId = id => document.getElementById(id);

  function readRole(){
    try{
      const v = JSON.parse(localStorage.getItem(ROLE_KEY) || 'null');
      return v && ROLES.includes(v.id) ? v : null;
    }catch(e){ return null; }
  }
  function saveRole(id){
    try{ localStorage.setItem(ROLE_KEY, JSON.stringify({ id, at: new Date().toISOString() })); }catch(e){}
  }
  function dismissed(){
    try{ return localStorage.getItem(DISMISS_KEY) === '1'; }catch(e){ return false; }
  }
  function message(key, fallback){
    return (typeof tl === 'function' && tl(key, fallback)) || fallback;
  }
  function statusText(key, fallback, vars){
    const has = typeof __I18N !== 'undefined' && __I18N && __I18N[key];
    if(!has) return fallback;
    return typeof tf === 'function' ? tf(key, vars) : __I18N[key];
  }
  function setStatus(key, fallback, vars){
    const el = byId('rwStatus');
    if(!el) return;
    if(typeof dynText === 'function') dynText(el, () => statusText(key, fallback, vars));
    else el.textContent = statusText(key, fallback, vars);
  }
  function setProgress(pct){
    const box = byId('rwProgress');
    if(!box) return;
    box.hidden = pct <= 0;
    const fill = byId('rwBarFill');
    if(fill) fill.style.width = Math.max(0, Math.min(100, Math.round(pct))) + '%';
  }
  function paintCta(){
    const btn = byId('rwGo');
    if(!btn) return;
    const txt = byId('rwGoTxt');
    if(txt){
      if(typeof dynText === 'function') dynText(txt, () => message('onboard.cta.' + current, CTA[current]));
      else txt.textContent = message('onboard.cta.' + current, CTA[current]);
    }
    btn.disabled = running;
    btn.setAttribute('aria-label', message('onboard.cta.' + current, CTA[current]));
    const status = byId('rwStatus');
    if(status && !running && !status.textContent) status.textContent = '';
  }
  function selectRole(id){
    if(!ROLES.includes(id) || running) return;
    current = id;
    const root = $rw();
    if(root){
      root.querySelectorAll('.rw-role').forEach(btn => {
        const on = btn.dataset.role === id;
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    }
    paintCta();
    const status = byId('rwStatus');
    if(status) status.textContent = '';
  }
  function open(force){
    const root = $rw();
    if(!root || running) return;
    const role = readRole();
    if(role) selectRole(role.id);
    lastFocus = document.activeElement;
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('rw-open');
    setProgress(0);
    const focus = root.querySelector('.rw-role.on') || byId('rwX');
    if(focus) setTimeout(() => focus.focus(), 30);
    paintCta();
  }
  function close(){
    const root = $rw();
    if(!root || running) return;
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('rw-open');
    const focus = lastFocus && document.body.contains(lastFocus) ? lastFocus : byId('drop');
    if(focus && focus.focus) setTimeout(() => focus.focus(), 20);
  }
  function later(){
    if(running) return;
    try{ localStorage.setItem(DISMISS_KEY, '1'); }catch(e){}
    close();
  }
  function saveMetric(ok, items, elapsed, error){
    try{
      const arr = JSON.parse(localStorage.getItem(METRIC_KEY) || '[]');
      arr.push({ role: 'evaluator', started_at: new Date(startedAt).toISOString(), result_at: new Date().toISOString(),
        elapsed_ms: elapsed, items: items || 0, success: !!ok, source: 'builtin_sample', error: error || '' });
      localStorage.setItem(METRIC_KEY, JSON.stringify(arr.slice(-5)));
    }catch(e){}
  }
  function waitFor(fn, timeout){
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        try{ if(fn()) return resolve(true); }catch(e){ return reject(e); }
        if(Date.now() - t0 > timeout) return reject(new Error('样例生成超时（5 分钟）'));
        setTimeout(tick, 200);
      };
      tick();
    });
  }

  async function runSample(){
    if(running) return;
    running = true;
    startedAt = Date.now();
    paintCta();
    setProgress(5);
    setStatus('onboard.status.recognizing', '正在识别内置样例…');
    try{
      const sampleResp = await fetch(API + '/api/onboarding/sample', { cache: 'no-store' });
      const sample = await sampleResp.json();
      if(!sample.ok) throw new Error(sample.msg || '样例不可用');
      setProgress(15);
      const bytes = Uint8Array.from(atob(sample.b64), c => c.charCodeAt(0));
      curFile = new File([bytes], sample.name || '评估师样例.docx',
        { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      const rec = await fetch(API + '/api/recognize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: curFile.name, b64: sample.b64, params: { llm_enabled: false } }),
      });
      const res = await rec.json();
      if(!res.ok) throw new Error(res.msg || '样例识别失败');
      if(!res.items || !res.items.length) throw new Error('样例未识别出功能点');
      setProgress(40);
      setStatus('onboard.status.recognized', '已识别样例功能点，正在全部确认…');
      applyRecognitionResult(res, byId('progressMark'));
      items.forEach(it => { it.ok = true; });
      render();
      gSummary = null; gSid = null;
      setProgress(60);
      setStatus('onboard.status.generating', '正在生成完整结果…');
      const go = byId('goRes');
      if(!go || go.disabled) throw new Error('确认状态未就绪，无法生成');
      go.click();
      await waitFor(() => document.body.dataset.step === 'result' && gSummary, 300000);
      setProgress(100);
      setStatus('onboard.status.done', '样例完成：已生成一次完整估算结果。');
      saveRole('evaluator');
      saveMetric(true, items.length, Date.now() - startedAt, '');
      closeAfterResult();
    }catch(err){
      const msg = err && err.message ? err.message : '未知错误';
      setProgress(100);
      setStatus('onboard.status.failed', '样例未完成：' + msg, { msg });
      saveMetric(false, items.length, Date.now() - startedAt, msg);
      running = false;
      paintCta();
      return;
    }
    running = false;
    paintCta();
  }

  function closeAfterResult(){
    running = false;
    const root = $rw();
    if(root){
      root.hidden = true;
      root.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('rw-open');
    }
    if(typeof toast === 'function') toast(message('onboard.toast.done', '样例已完成：已生成一次完整估算结果，可继续导出或换真实文档。'));
    const focus = byId('drop') || byId('startBtn');
    if(focus && focus.focus) setTimeout(() => focus.focus(), 20);
  }

  function finishRole(id){
    if(running) return;
    saveRole(id);
    close();
    if(typeof toast === 'function'){
      toast(message('onboard.toast.' + id, id === 'pmo' ? '已按项目经理角色精简引导，可查看历史估算或上传需求。' : '已按财务/商务角色精简引导，可配置费率或上传需求。'));
    }
    if(id === 'pmo' && typeof histOpen === 'function') histOpen();
    if(id === 'finance' && typeof goPage === 'function') goPage('config');
  }

  function onClick(){
    const root = $rw();
    if(!root) return;
    root.addEventListener('click', e => {
      const role = e.target.closest('.rw-role');
      if(role){ selectRole(role.dataset.role); return; }
      const id = e.target.id;
      if(id === 'rwGo'){
        if(current === 'evaluator') runSample();
        else finishRole(current);
        return;
      }
      if(id === 'rwLater' || id === 'rwX'){ later(); return; }
      if(e.target.closest('[data-rw-close]')) later();
    });
    root.addEventListener('keydown', e => {
      if(e.key === 'Escape' && !running){ e.preventDefault(); later(); return; }
      if(e.key !== 'Tab') return;
      const nodes = [...root.querySelectorAll('button:not([disabled]), [href], input:not([disabled])')]
        .filter(n => n.offsetParent !== null);
      if(!nodes.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
      else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
    });
  }

  function init(){
    const root = $rw();
    if(!root) return;
    const role = readRole();
    if(role) selectRole(role.id);
    paintCta();
    onClick();
    const query = new URLSearchParams(location.search).get('welcome');
    if(query === '0') return;
    if(query === '1'){ setTimeout(() => open(true), 80); return; }
    if(!role && !dismissed()) setTimeout(() => open(), 260);
  }

  window.RoleOnboard = { open, close, select: selectRole, runSample, get selected(){ return current; }, get running(){ return running; } };
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
