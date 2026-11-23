/* T06182 / REQ-008 / AC-10：大字号投屏演示模式 + 离线脱敏分享包。
   演示只读已确认项；分享包由服务端二次白名单化并做离线自检。 */
(function () {
  var PZ_ID = 'presenter';
  var slides = [];
  var idx = 0;
  var lastFocus = null;
  var bound = false;

  function $(sel) { return document.querySelector(sel); }
  function msg(key, fallback, vars) {
    var s = (typeof t === 'function' ? t(key) : key);
    if (!s || s === key) s = fallback;
    return String(s).replace(/\{([^}]+)\}/g, function (m, k) { return vars && vars[k] != null ? vars[k] : m; });
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function num(v, d) {
    var n = Number(v);
    return isFinite(n) ? n.toFixed(d == null ? 2 : d) : '—';
  }
  function clamp(s, n) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  function confirmed() {
    return (typeof items !== 'undefined' ? items : []).filter(function (x) { return x && x.ok === true; });
  }
  function timingValue() {
    var el = $('#timingSel');
    var v = el ? el.value : '估算中期';
    return v === '交付后及运维' ? '项目交付后及运维阶段' : v;
  }
  function methodValue() {
    var el = $('#methodSel');
    return el ? el.value : '估算功能点';
  }
  function scaleFactor() {
    var v = timingValue();
    return ({ '估算早期': 1.39, '估算中期': 1.21, '估算晚期': 1.10, '项目交付后及运维阶段': 1.00 })[v] || 1.21;
  }
  function calcSummary(ok) {
    var ufpSum = 0, usSum = 0;
    ok.forEach(function (x) {
      try { ufpSum += Number(ufp(x) || 0); usSum += Number(us(x) || 0); } catch (e) { /* 保持可展示 */ }
    });
    var adjusted = Math.round(usSum * scaleFactor() * 100) / 100;
    var mid = adjusted * 10.67 / 8 * 0.8;
    var work = { low: Math.round(mid * 0.8 * 100) / 100, mid: Math.round(mid * 100) / 100, high: Math.round(mid * 1.2 * 100) / 100 };
    var cost = { low: Math.round(work.low / 22 * 2.57 * 100) / 100, mid: Math.round(work.mid / 22 * 2.57 * 100) / 100, high: Math.round(work.high / 22 * 2.57 * 100) / 100 };
    return { ufp: ufpSum, us: Math.round(usSum * 100) / 100, adjusted_fp: adjusted, work: work, cost: cost };
  }
  function summaryFor(ok) {
    var total = (typeof items !== 'undefined' ? items : []);
    if (typeof gSummary !== 'undefined' && gSummary && ok.length === total.length) {
      return gSummary;
    }
    return calcSummary(ok);
  }
  function systemRows(ok) {
    var by = {};
    ok.forEach(function (x) {
      var k = x.system || '未分组';
      try { by[k] = (by[k] || 0) + Number(us(x) || 0); } catch (e) { by[k] = (by[k] || 0); }
    });
    return Object.keys(by).map(function (k) { return { name: k, us: by[k] }; })
      .sort(function (a, b) { return b.us - a.us; });
  }
  function countBy(ok, key) {
    var by = {};
    ok.forEach(function (x) { var k = x[key] || '—'; by[k] = (by[k] || 0) + 1; });
    return Object.keys(by).sort(function (a, b) { return by[b] - by[a]; }).map(function (k) { return { name: k, n: by[k] }; });
  }
  function slideHTML(body, cls) {
    return '<div class="pz-slide ' + (cls || '') + '">' + body + '</div>';
  }
  function buildSlides() {
    var ok = confirmed();
    var total = (typeof items !== 'undefined' ? items.length : 0);
    var s = summaryFor(ok);
    var sys = systemRows(ok);
    var types = countBy(ok, 'type');
    var reuse = countBy(ok, 'reuse');
    var top = ok.slice().sort(function (a, b) { return Number(us(b) || 0) - Number(us(a) || 0); }).slice(0, 8);
    var sysMax = Math.max.apply(null, [1].concat(sys.map(function (x) { return x.us; })));
    var name = (typeof baseName === 'function' ? baseName() : (gSid || '工作量评估'));
    var date = new Date().toLocaleDateString('zh-CN');
    var list = [];

    list.push(slideHTML(
      '<div class="pz-kicker">WORKLOAD EVALUATION · PRESENTATION MODE</div>' +
      '<h1 class="pz-h1">' + esc(name) + '</h1>' +
      '<p class="pz-sub">工作量评估结论 · 对外演示</p>' +
      '<div class="pz-meta"><span>方法 ' + esc(methodValue()) + '</span><span>时机 ' + esc(timingValue()) + '</span>' +
      '<span>已确认 ' + ok.length + ' / ' + total + ' 项</span><span>' + esc(date) + '</span></div>' +
      '<div class="pz-seal">对外演示 · 已隐藏内部备注与未确认数据</div>', 'pz-cover'));

    list.push(slideHTML(
      '<div class="pz-kicker">01 · 结论摘要</div><h2 class="pz-h2">规模、工作量与费用</h2>' +
      '<div class="pz-kpis">' +
      '<div class="pz-kpi"><b>' + num(s.ufp, 0) + '</b><span>未调整功能点 UFP</span></div>' +
      '<div class="pz-kpi"><b>' + num(s.adjusted_fp) + '</b><span>调整后规模 FP</span></div>' +
      '<div class="pz-kpi"><b>' + num(s.work.mid) + '</b><span>基准工作量 人天</span></div>' +
      '<div class="pz-kpi"><b>' + num(s.cost.mid) + '</b><span>费用中值 万元</span></div></div>' +
      '<div class="pz-band"><div><small>工作量低</small><b>' + num(s.work.low) + '</b></div><div class="mid"><small>中值</small><b>' + num(s.work.mid) + '</b></div><div><small>工作量高</small><b>' + num(s.work.high) + '</b></div></div>' +
      '<p class="pz-note">KPI 按已确认项重新计算；未确认项不进入本页。</p>', 'pz-summary'));

    list.push(slideHTML(
      '<div class="pz-kicker">02 · 规模构成</div><h2 class="pz-h2">分系统与类型分布</h2>' +
      '<div class="pz-bars">' + sys.slice(0, 8).map(function (x) {
        return '<div class="pz-bar"><span>' + esc(x.name) + '</span><i style="width:' + Math.max(4, x.us / sysMax * 100) + '%"></i><b>' + num(x.us) + '</b></div>';
      }).join('') + '</div>' +
      '<div class="pz-tags"><span>类型：' + types.map(function (x) { return esc(x.name) + ' ' + x.n; }).join(' · ') + '</span>' +
      '<span>重用：' + reuse.map(function (x) { return esc(x.name) + ' ' + x.n; }).join(' · ') + '</span></div>', 'pz-composition'));

    list.push(slideHTML(
      '<div class="pz-kicker">03 · 重点功能项</div><h2 class="pz-h2">已确认项 · US Top ' + top.length + '</h2>' +
      '<div class="pz-items">' + top.map(function (x) {
        return '<div class="pz-item"><span class="pz-id">' + esc(x.stable_id || ('FP-' + String(x.seq).padStart(3, '0'))) + '</span>' +
          '<span class="pz-desc">' + esc(clamp(x.desc || x.count_item, 48)) + '</span>' +
          '<b>' + num(us(x)) + '</b><small>' + esc(x.system || '未分组') + '</small></div>';
      }).join('') + '</div>', 'pz-items-slide'));

    list.push(slideHTML(
      '<div class="pz-kicker">04 · 方法与口径</div><h2 class="pz-h2">评估口径</h2>' +
      '<div class="pz-method"><div><small>估算方法</small><b>' + esc(methodValue()) + '</b></div>' +
      '<div><small>规模计数时机</small><b>' + esc(timingValue()) + '</b></div>' +
      '<div><small>复杂度口径</small><b>' + esc(typeof cxMode !== 'undefined' ? cxMode : '企业母版') + '</b></div></div>' +
      '<p class="pz-note">US = UFP × 重用系数 × 修改系数；调整后规模 = US × 规模变更因子；费用 = 工作量 / 22 × 2.57 万元。</p>', 'pz-method-slide'));

    list.push(slideHTML(
      '<div class="pz-kicker">05 · 分享边界</div><h2 class="pz-h2">已确认 ' + ok.length + ' 项，隐藏 ' + Math.max(total - ok.length, 0) + ' 项</h2>' +
      '<p class="pz-big-note">本演示仅展示复核确认后的功能项；内部备注、原文证据、AI 置信度与未确认数据不进入投屏。</p>' +
      '<p class="pz-note">如需对外发送，请使用结果页「脱敏分享包（HTML）」：单文件、无外部链接、无远程字体，可在离线环境打开。</p>', 'pz-close'));
    return list;
  }
  function render() {
    var stage = $('#presenterStage');
    if (!stage || !slides.length) return;
    stage.innerHTML = slides[idx];
    var counter = $('#presenterCounter');
    if (counter) counter.textContent = (idx + 1) + ' / ' + slides.length;
    var prev = $('#presenterPrev'), next = $('#presenterNext');
    if (prev) prev.disabled = idx === 0;
    if (next) next.disabled = idx === slides.length - 1;
    $$('.pz-dot').forEach(function (el, i) { el.classList.toggle('active', i === idx); });
  }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function next() { if (idx < slides.length - 1) { idx++; render(); } }
  function prev() { if (idx > 0) { idx--; render(); } }
  function onKey(e) {
    if ($('#presenter').hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); prev(); }
  }
  function open() {
    var ok = confirmed();
    if (!ok.length) { if (typeof toast === 'function') toast(msg('presenter.no_items', '请先在复核页确认功能项，再进入演示模式')); return; }
    slides = buildSlides();
    idx = 0;
    lastFocus = (document.activeElement && document.activeElement.id) ? document.activeElement : $('#presentBtn');
    var el = $('#presenter');
    if (!el) return;
    el.hidden = false;
    el.setAttribute('aria-hidden', 'false');
    document.body.classList.add('pz-open');
    render();
    if (!bound) { document.addEventListener('keydown', onKey); bound = true; }
    var exit = $('#presenterExit'); if (exit) exit.focus();
  }
  function close() {
    var el = $('#presenter');
    if (!el || el.hidden) return;
    el.hidden = true;
    el.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('pz-open');
    if (bound) { document.removeEventListener('keydown', onKey); bound = false; }
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  window.PRESENTER = { open: open, close: close, next: next, prev: prev, count: function () { return slides.length; }, index: function () { return idx; } };

  function cleanPayloadItem(x, i) {
    var out = { ok: true, seq: i + 1 };
    ['stable_id', 'system', 'm1', 'desc', 'count_item', 'type', 'reuse', 'modify', 'det', 'ret', 'ftr'].forEach(function (k) {
      if (x[k] != null && x[k] !== '') out[k] = x[k];
    });
    return out;
  }
  function buildSharePayload() {
    var ok = confirmed();
    return {
      title: (typeof baseName === 'function' ? baseName() : '工作量评估') + ' 脱敏分享包',
      project: { name: typeof baseName === 'function' ? baseName() : '工作量评估', version: '0.1.' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-share' },
      method: methodValue(),
      timing: timingValue(),
      cx_mode: typeof cxMode !== 'undefined' ? cxMode : '企业母版',
      total_items: (typeof items !== 'undefined' ? items.length : 0),
      items: ok.map(cleanPayloadItem),
    };
  }
  async function generate() {
    var ok = confirmed();
    if (!ok.length) { toast(msg('result.share.no_items', '没有已确认功能项可分享，请先在复核页确认')); return; }
    var btn = $('#shareBtn');
    if (btn) { btn.disabled = true; btn.dataset.html = btn.innerHTML; btn.textContent = msg('result.share.busy', '正在生成脱敏分享包…'); }
    try {
      var r = await fetch('/api/share/package', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildSharePayload()) });
      var body = await r.json();
      if (!r.ok || !body.ok) throw new Error(body.msg || '分享包生成失败');
      toast(msg('result.share.done', '脱敏分享包已生成：{n} 项 · {kb} KB', { n: body.items, kb: Math.round((body.size || 0) / 1024) }));
      var a = document.createElement('a');
      a.href = body.download; a.download = body.file; document.body.appendChild(a); a.click(); a.remove();
    } catch (e) {
      toast(msg('result.share.fail', '分享包生成失败：{msg}', { msg: (e && e.message ? e.message : e) }));
    } finally {
      if (btn) { btn.disabled = false; if (btn.dataset.html) btn.innerHTML = btn.dataset.html; }
    }
  }

  window.SHARE = { buildPayload: buildSharePayload, generate: generate, presenter: window.PRESENTER };
  window.presenterOpen = open;
  window.sharePackage = generate;
  window.presenterNext = next;
  window.presenterPrev = prev;
  window.presenterClose = close;
})();

