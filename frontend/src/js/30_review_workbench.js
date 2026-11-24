/* T06179 / REQ-005 / AC-06：三栏证据复核工作台（左风险大纲 / 中表格 / 右证据抽屉）。
   与 01_core.js 的 items/render 协作，不改复核逻辑；证据为同步渲染，点击行到抽屉可见 <300ms。 */
(function () {
  "use strict";
  var selSeq = null, filter = "", riskSort = false, confSort = true, dupCache = null, dupSig = "";
  var drawer = document.getElementById("evidenceDrawer");
  var scrim = document.getElementById("evidenceScrim");
  var outline = document.getElementById("riskOutline");
  var body = document.getElementById("evidenceBody");

  function esc(s) {
    s = String(s == null ? "" : s);
    if (window.escAttr) return escAttr(s);
    return s.replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; });
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function isAI(it) {
    if (window.isAiOrigin) return window.isAiOrigin(it);
    return !!(it && (it.origin === "ai" || it.origin === "llm" || it.origin === "rule"));
  }
  function confidence(it) {
    if (!it || it.confidence == null || it.confidence === "") return null;
    var n = Number(it.confidence);
    if (!isFinite(n)) return null;
    return clamp(n > 1 ? n / 100 : n, 0, 1);
  }
  function confidenceLevel(it) {
    var c = confidence(it);
    return c == null ? "none" : c < 0.70 ? "low" : c < 0.85 ? "mid" : "high";
  }
  function hasEvidence(it) {
    return !!(it && Array.isArray(it.evidence) && it.evidence.some(function (e) { return e && String(e.quote || "").trim(); }));
  }
  function canConfirm(it) {
    if (typeof window.canConfirmItem === "function") return window.canConfirmItem(it);
    return true;
  }
  function markDecision(it, ok) {
    if (!it) return;
    if (isAI(it) || it.origin === "manual") {
      it.human_decision = ok ? "confirmed" : "unconfirmed";
      it.decision_at = new Date().toISOString();
    }
  }
  function duplicateSet() {
    var sig = items.length + "|" + (items[0] ? items[0].seq : "") + "|" + (items[items.length - 1] ? items[items.length - 1].seq : "");
    if (dupCache && dupSig === sig) return dupCache;
    var cnt = new Map();
    items.forEach(function (it) { var d = String(it.desc || "").trim(); if (d) cnt.set(d, (cnt.get(d) || 0) + 1); });
    dupCache = new Set();
    cnt.forEach(function (n, d) { if (n > 1) dupCache.add(d); });
    dupSig = sig;
    return dupCache;
  }
  function score(it) {
    if (!it) return 0;
    var s = 0;
    if (!String(it.desc || "").trim()) s += 28;
    if (!String(it.count_item || "").trim()) s += 18;
    if (!String(it.system || "").trim()) s += 10;
    if (!it.type) s += 20;
    if (!it.reuse) s += 5;
    if (!it.modify) s += 5;
    if (!it.ok) s += 8;
    if (!it.basis) s += 8;
    var c = confidence(it);
    if (c != null) s += Math.round((1 - c) * 30);      // 低置信度优先进入高风险队列
    if (isAI(it) && !hasEvidence(it)) s += 20;
    if (String(it.desc || "").length > 120) s += 5;
    var d = String(it.desc || "").trim();
    if (d && duplicateSet().has(d)) s += 15;
    if (typeof cxMode !== "undefined" && cxMode === "标准IFPUG") {
      if (it.det === "" || it.det == null) s += 5;
      if ((it.type === "ILF" || it.type === "EIF") && (it.ret === "" || it.ret == null)) s += 5;
      if (["EI", "EO", "EQ"].indexOf(it.type) >= 0 && (it.ftr === "" || it.ftr == null)) s += 5;
    }
    return clamp(Math.round(s), 0, 100);
  }
  function level(it) { var s = score(it); return s >= 50 ? "high" : s >= 25 ? "medium" : "low"; }
  function levelText(l) { return l === "high" ? "高风险" : l === "medium" ? "中风险" : "低风险"; }
  function match(it) {
    if (!filter) return true;
    var lv = level(it);
    if (filter === "pending") return !it.ok;
    if (filter === "done") return !!it.ok;
    return lv === filter;
  }
  function sortRows(arr) { return arr.slice().sort(function (a, b) { return score(b) - score(a); }); }
  function sortByConfidence(arr) {
    var withConf = arr.filter(function (it) { return confidence(it) != null; });
    if (!withConf.length) return arr.slice();
    return arr.slice().sort(function (a, b) {
      var ca = confidence(a), cb = confidence(b);
      if (ca == null && cb != null) return 1;
      if (cb == null && ca != null) return -1;
      if (ca != null && cb != null && ca !== cb) return ca - cb;
      return score(b) - score(a);
    });
  }

  function counts() {
    var c = { high: 0, medium: 0, low: 0, pending: 0, done: 0, lowConf: 0, noEvidence: 0 };
    items.forEach(function (it) {
      c[level(it)]++; it.ok ? c.done++ : c.pending++;
      if (confidenceLevel(it) === "low") c.lowConf++;
      if (isAI(it) && !hasEvidence(it)) c.noEvidence++;
    });
    return c;
  }

  function riskPill(key, label, n) {
    return '<button type="button" class="rwb-risk-pill ' + key + (filter === key ? " on" : "") + '" onclick="RWB.setFilter(\'' + key + '\')" aria-pressed="' + (filter === key) + '">' +
      '<span>' + label + '</span><b>' + n + '</b></button>';
  }

  function renderOutline() {
    if (!outline) return;
    if (!items || !items.length) { outline.innerHTML = '<div class="rwb-empty">暂无待复核功能项</div>'; return; }
    var c = counts();
    var top = items.slice().sort(function (a, b) { return score(b) - score(a); }).slice(0, 5);
    outline.innerHTML =
      '<div class="rwb-risk-pills">' + riskPill("high", "高风险", c.high) + riskPill("medium", "中风险", c.medium) + riskPill("pending", "待复核", c.pending) + '</div>' +
      '<div class="rwb-sort-row"><span>按风险优先</span><button type="button" class="rwb-sort-btn' + (riskSort ? " on" : "") + '" onclick="RWB.toggleSort()" aria-pressed="' + riskSort + '">风险排序 ' + (riskSort ? tl("common.on", "开") : tl("common.off", "关")) + '</button></div>' +
      '<div class="rwb-conf-row"><button type="button" class="rwb-conf-btn' + (confSort ? " on" : "") + '" onclick="RWB.toggleConfSort()" aria-pressed="' + confSort + '">' +
      tl("review.confidence.priority", "低置信优先") + ' ' + (confSort ? tl("common.on", "开") : tl("common.off", "关")) + '<b>' + c.lowConf + '</b></button>' +
      (c.noEvidence ? '<span class="rwb-noev">' + tl("review.evidence.blocked", "无证据") + ' ' + c.noEvidence + '</span>' : '') + '</div>' +
      '<div class="rwb-risk-list-items">' + top.map(function (it) {
        var lv = level(it), s = score(it), cf = confidence(it);
        return '<button type="button" class="rwb-risk-item ' + lv + '" data-seq="' + it.seq + '" onclick="RWB.select(' + it.seq + ')" title="查看证据">' +
          '<span class="rwb-risk-dot" aria-hidden="true"></span><span class="rwb-risk-name">' + esc(it.desc || it.count_item || "（无描述）") + '</span>' +
          (cf != null ? '<span class="rwb-risk-conf ' + confidenceLevel(it) + '">' + Math.round(cf * 100) + '%</span>' : '') +
          '<span class="rwb-risk-score">' + s + '</span></button>';
      }).join("") + '</div>' +
      (filter ? '<button type="button" class="rwb-risk-clear" onclick="RWB.setFilter(\'' + filter + '\')">清除风险筛选</button>' : "");
  }

  function aiSuggestion(it) {
    if (it.aiSuggestion || it.ai_suggestion) {
      return { text: it.aiSuggestion || it.ai_suggestion, confidence: confidence(it) != null ? confidence(it) : Number(it.confidence || 0.8), source: it.aiSource || "AI 模型", model: it.aiModel || "" };
    }
    var text;
    if (it.type === "ILF" || it.type === "EIF") {
      text = "建议核对 RET 与 DET 是否覆盖全部记录/数据项；若为外部维护文件，确认 EIF 而非 ILF。";
    } else if (it.type === "EI") {
      text = "建议确认输入来自系统外或跨边界，FTR 是否准确；纯界面校验不应计为 EI。";
    } else if (it.type === "EO" || it.type === "EQ") {
      text = "建议确认输出含派生计算（EO）还是仅取数展示（EQ），并核对 DET 数量。";
    } else {
      text = "建议先确认功能类别（ILF/EIF/EI/EO/EQ），再核对计数项、重用度与修改类型。";
    }
    if (isAI(it) || it.evidence) {
      var c = confidence(it);
      var ai = it.ai || {};
      return { text: text, confidence: c == null ? 0 : c,
        source: it.origin === "llm" || it.origin === "ai" ? "AI 模型" : (it.origin === "manual" ? "人工录入" : "规则识别"),
        model: ai.model || "", promptVersion: ai.prompt_version || "" };
    }
    var conf = 0.55;
    if (it.desc) conf += 0.1;
    if (it.count_item) conf += 0.06;
    if (it.system) conf += 0.05;
    if (it.type) conf += 0.08;
    if (it.basis) conf += 0.04;
    conf = clamp(conf, 0.35, 0.92);
    return { text: text, confidence: conf, source: "本地规则（占位）", model: "" };
  }

  function kv(k, v) { return '<div class="rwb-kv"><span>' + k + '</span><b>' + esc(v == null || v === "" ? "—" : v) + '</b></div>'; }

  function evidenceCards(it) {
    var evs = Array.isArray(it.evidence) ? it.evidence : [];
    return evs.map(function (ev, idx) {
      var loc = ev.locator || ("证据 " + (idx + 1));
      return '<button type="button" class="rwb-evidence-card" onclick="RWB.showSource(' + it.seq + ',' + idx + ')" title="定位原文：' + esc(loc) + '">' +
        '<span class="rwb-evidence-loc"><i data-lucide="crosshair" aria-hidden="true"></i>' + esc(loc) + '</span>' +
        '<span class="rwb-evidence-quote">' + esc(ev.quote || "") + '</span>' +
        '<span class="rwb-evidence-open">' + tl("review.evidence.locate", "定位") + '</span></button>';
    }).join("");
  }

  function evidenceSection(it) {
    var aiOrigin = isAI(it);
    var evs = Array.isArray(it.evidence) ? it.evidence : [];
    if (!evs.length && !aiOrigin) return "";
    var head = '<section class="rwb-ev-sec" id="rwbSecEvidence"><h3><i data-lucide="quote" aria-hidden="true"></i>' +
      tl("review.evidence.title", "原文证据") + ' <span class="rwb-ev-count">' + evs.length + '</span></h3>';
    if (evs.length) {
      return head + '<div class="rwb-evidence-list">' + evidenceCards(it) + '</div>' +
        '<div id="rwbSourceView" class="rwb-source-view" hidden></div></section>';
    }
    return head +
      '<div class="rwb-noev-box"><p>' + tl("review.evidence.none", "未在原文中定位到证据；该候选不能确认，也不会进入成品表。") + '</p>' +
      '<label class="rwb-add-label" for="rwbAddQuote">' + tl("review.evidence.add", "补充原文摘录") + '</label>' +
      '<textarea id="rwbAddQuote" class="rwb-add-quote" rows="3" placeholder="' + tl("review.evidence.add_ph", "粘贴需求文档中的原文片段…") + '"></textarea>' +
      '<div class="rwb-add-row"><input id="rwbAddLocator" class="rwb-add-locator" value="' + tl("review.evidence.manual", "人工补录") + '" aria-label="证据位置">' +
      '<button type="button" class="btn btn-ghost" onclick="RWB.addEvidence(' + it.seq + ')">' + tl("review.evidence.save", "补充证据") + '</button></div></div></section>';
  }

  function evidenceHTML(it) {
    var s = score(it), lv = level(it), ai = aiSuggestion(it), pct = Math.round(ai.confidence * 100);
    var catClass = (typeof CATCOLOR !== "undefined" && CATCOLOR[it.type]) ? CATCOLOR[it.type] : "";
    var aiItem = isAI(it);
    var blocked = aiItem && !hasEvidence(it);
    var rule = '<div class="rwb-rule-line"><span class="cat ' + catClass + '">' + esc(it.type || "未分类") + '</span>' +
      '<span>复杂度 <b>' + esc(it.cx || "—") + '</b></span><span>UFP <b>' + (window.ufp ? ufp(it) : "—") + '</b></span><span>US <b>' + (window.us ? us(it).toFixed(2) : "—") + '</b></span></div>';
    if (typeof cxMode !== "undefined" && cxMode === "标准IFPUG") {
      rule += '<div class="rwb-kv"><span>DET / RET / FTR</span><b>' + esc(it.det || "—") + ' / ' + esc((it.type === "ILF" || it.type === "EIF") ? (it.ret || "—") : "—") + ' / ' + esc(["EI", "EO", "EQ"].indexOf(it.type) >= 0 ? (it.ftr || "—") : "—") + '</b></div>';
    }
    if (it.basis) rule += '<div class="rwb-basis">' + it.basis + '</div>';
    var note = ai.model ? '模型：' + esc(ai.model) + ' · ' : '';
    if (ai.promptVersion) note += '提示词：' + esc(ai.promptVersion) + ' · ';
    note += aiItem
      ? '证据来自上传文档的真实段落/表格行；低置信度优先复核。'
      : '来源为本机规则占位，T06195 接入模型证据后替换；低置信度优先复核。';
    return '<div class="rwb-ev-title">' + esc(it.desc || it.count_item || "（无描述）") + '</div>' +
      '<div class="rwb-ev-meta"><span class="rwb-risk-chip ' + lv + '">' + levelText(lv) + ' ' + s + '/100</span>' +
      (it.stable_id ? '<span class="rwb-sid">' + esc(it.stable_id) + '</span>' : '') +
      '<span class="rwb-state ' + (it.ok ? "ok" : blocked ? "blocked" : "pending") + '">' + (it.ok ? "已确认" : blocked ? "无证据" : "待复核") + '</span></div>' +
      '<section class="rwb-ev-sec" id="rwbSecRaw"><h3><i data-lucide="file-text" aria-hidden="true"></i>原文</h3>' +
      '<div class="rwb-quote">' + esc(it.desc || "（无描述）") + '</div>' +
      kv("所属模块", it.system) + kv("计数项", it.count_item) +
      '</section>' +
      '<section class="rwb-ev-sec" id="rwbSecRule"><h3><i data-lucide="ruler" aria-hidden="true"></i>规则</h3>' + rule +
      kv("重用度 / 修改类型", (it.reuse || "—") + " / " + (it.modify || "—")) + '</section>' +
      evidenceSection(it) +
      '<section class="rwb-ev-sec" id="rwbSecAi"><h3><i data-lucide="sparkles" aria-hidden="true"></i>AI 建议</h3>' +
      '<div class="rwb-ai-head"><span class="rwb-ai-badge">' + esc(ai.source) + '</span><span class="rwb-conf">置信度 ' + pct + '%</span></div>' +
      '<p class="rwb-ai-text">' + esc(ai.text) + '</p>' +
      '<div class="rwb-ai-note">' + note + '</div></section>';
  }

  function highlightHTML(context, quote) {
    context = String(context || ""), quote = String(quote || "");
    if (!quote) return esc(context);
    var pos = context.indexOf(quote);
    if (pos < 0) return esc(context);
    return esc(context.slice(0, pos)) + '<mark>' + esc(quote) + '</mark>' + esc(context.slice(pos + quote.length));
  }

  function showSource(seq, idx) {
    var it = items.find(function (x) { return x.seq === seq; });
    var ev = it && Array.isArray(it.evidence) ? it.evidence[idx] : null;
    var box = document.getElementById("rwbSourceView");
    if (!ev || !box) return;
    box.hidden = false;
    box.innerHTML = '<div class="rwb-source-head"><b>' + esc(ev.locator || "原文位置") + '</b>' +
      '<button type="button" class="rwb-source-close" onclick="RWB.hideSource()" aria-label="关闭原文定位"><i data-lucide="x" aria-hidden="true"></i></button></div>' +
      '<div class="rwb-source-context">' + highlightHTML(ev.context || ev.quote, ev.quote) + '</div>';
    if (window.lucide) try { lucide.createIcons({ root: box }); } catch (e) { /* noop */ }
    if (box.scrollIntoView) box.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function hideSource() {
    var box = document.getElementById("rwbSourceView");
    if (box) { box.hidden = true; box.innerHTML = ""; }
  }

  function addEvidence(seq) {
    var it = items.find(function (x) { return x.seq === seq; });
    if (!it) return;
    var quoteEl = document.getElementById("rwbAddQuote");
    var locEl = document.getElementById("rwbAddLocator");
    var quote = quoteEl ? String(quoteEl.value || "").trim() : "";
    if (!quote) { toast(tl("review.evidence.need_quote", "请先粘贴原文摘录")); return; }
    it.evidence = [{ kind: "manual", locator: (locEl && locEl.value || "人工补录"), quote: quote,
      context: quote, verified: true }];
    it.can_confirm = true;
    if (it.confidence == null || Number(it.confidence) < 0.5) it.confidence = 0.5;
    if (window.render) render();
    renderEvidence(it);
    toast(tl("review.evidence.added", "已补充原文证据，可继续复核"));
  }

  function renderEvidence(it) {
    if (!body) return;
    if (!it) {
      body.innerHTML = '<div class="rwb-ev-empty"><i data-lucide="panel-right" aria-hidden="true"></i><h3>点击任一行查看证据</h3><p>左侧按风险排序，中间表格点击功能项，这里同步显示原文、规则、AI 建议与置信度。</p></div>';
    } else {
      body.innerHTML = evidenceHTML(it);
      var blocked = isAI(it) && !hasEvidence(it);
      var acts = document.createElement("div"); acts.className = "rwb-ev-actions";
      if (window.UIKIT) {
        acts.appendChild(UIKIT.button({ label: "定位原文", icon: "crosshair", variant: "secondary", size: "sm", disabled: blocked,
          title: blocked ? "无原文证据，无法定位" : "定位到原文证据", onClick: function () { if (!blocked) locate(it.seq); } }));
        acts.appendChild(UIKIT.button({ label: it.ok ? "取消确认" : "标记确认", icon: it.ok ? "rotate-ccw" : "check", variant: "primary", size: "sm", disabled: blocked && !it.ok,
          title: blocked ? "无原文证据，不能确认" : "确认该项", onClick: function () { toggleConfirm(it.seq); } }));
      } else {
        acts.innerHTML = '<button class="btn btn-ghost"' + (blocked ? " disabled" : "") + ' onclick="RWB.locate(' + it.seq + ')">定位原文</button><button class="btn btn-primary"' + (blocked && !it.ok ? " disabled" : "") + ' onclick="RWB.toggleConfirm(' + it.seq + ')">' + (it.ok ? "取消确认" : "标记确认") + '</button>';
      }
      body.appendChild(acts);
    }
    if (window.lucide) try { lucide.createIcons({ root: body }); } catch (e) { /* noop */ }
  }

  function openPanel() {
    if (!drawer) return;
    var narrow = window.matchMedia && matchMedia("(max-width: 1359px)").matches;
    drawer.inert = false;
    drawer.classList.add("open");
    if (narrow && scrim) scrim.hidden = false;
    if (narrow) document.body.classList.add("rwb-drawer-open");
  }
  function closePanel() {
    if (!drawer) return;
    if (window.matchMedia && matchMedia("(max-width: 1359px)").matches) {
      drawer.classList.remove("open"); drawer.inert = true; if (scrim) scrim.hidden = true; document.body.classList.remove("rwb-drawer-open");
    } else {
      drawer.classList.remove("open"); drawer.inert = false; if (scrim) scrim.hidden = true; document.body.classList.remove("rwb-drawer-open");
      selSeq = null; renderEvidence(null); hiRow(null);
    }
  }
  function hiRow(seq) {
    document.querySelectorAll("#tbody .rowr.rwb-sel").forEach(function (r) { r.classList.remove("rwb-sel"); });
    if (seq != null) { var r = document.querySelector('#tbody .rowr[data-seq="' + seq + '"]'); if (r) r.classList.add("rwb-sel"); }
  }
  function select(seq) {
    var t0 = performance.now();
    var it = items.find(function (x) { return x.seq === seq; });
    if (!it) return;
    selSeq = seq; openPanel(); renderEvidence(it); hiRow(seq);
    var row = document.querySelector('#tbody .rowr[data-seq="' + seq + '"]');
    if (row && !row.classList.contains("rwb-sel")) row.classList.add("rwb-sel");
    window.__rwbLastMs = Math.round(performance.now() - t0);
  }
  function locate(seq) {
    var it = items.find(function (x) { return x.seq === seq; });
    if (it && hasEvidence(it)) showSource(seq, 0);
    var row = document.querySelector('#tbody .rowr[data-seq="' + seq + '"]');
    if (!row) { render(); row = document.querySelector('#tbody .rowr[data-seq="' + seq + '"]'); }
    if (!row) return;
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    row.classList.add("rwb-flash");
    setTimeout(function () { row.classList.remove("rwb-flash"); }, 1200);
  }
  function toggleConfirm(seq) {
    var it = items.find(function (x) { return x.seq === seq; });
    if (!it) return;
    if (!it.ok && !canConfirm(it)) {
      toast(tl("review.evidence.no_confirm", "该项没有原文证据，不能确认；请先补充证据。"));
      return;
    }
    if (window.pushUndo) pushUndo("证据抽屉确认");
    it.ok = !it.ok;
    markDecision(it, it.ok);
    if (window.render) render();
    if (window.ReviewPerf) ReviewPerf.action("toggle_confirm", { seq: it.seq, ok: it.ok });
    if (window.toast) toast(it.ok ? "已确认" : "已取消确认");
  }
  function setFilter(k) { filter = filter === k ? "" : k; render(); }
  function toggleSort() { riskSort = !riskSort; render(); }
  function toggleConfSort() { confSort = !confSort; render(); }

  function bindRows() {
    document.querySelectorAll("#tbody .rowr").forEach(function (row) {
      if (row.dataset.rwbBound) return;
      row.dataset.rwbBound = "1"; row.tabIndex = 0;
      row.setAttribute("aria-label", "查看证据：" + (row.querySelector(".desc") ? row.querySelector(".desc").textContent.trim() : "功能项"));
      row.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(+row.dataset.seq); }
      });
    });
  }

  function onRender() {
    dupCache = null;
    renderOutline();
    bindRows();
    if (selSeq != null) {
      var it = items.find(function (x) { return x.seq === selSeq; });
      if (it) { renderEvidence(it); hiRow(selSeq); } else { selSeq = null; renderEvidence(null); }
    } else if (!body.innerHTML.trim()) renderEvidence(null);
  }

  document.addEventListener("click", function (e) {
    var row = e.target.closest ? e.target.closest("#tbody .rowr") : null;
    if (!row) return;
    if (e.target.closest("input,select,button,.toggle,.pick,.ck")) return;
    select(+row.dataset.seq);
  });
  var closeBtn = document.getElementById("rwbEvidenceClose");
  if (closeBtn) closeBtn.addEventListener("click", closePanel);
  if (scrim) scrim.addEventListener("click", closePanel);
  function syncInert() {
    if (!drawer) return;
    var narrow = window.matchMedia && matchMedia("(max-width: 1359px)").matches;
    drawer.inert = narrow && !drawer.classList.contains("open");
  }
  syncInert();
  window.addEventListener("resize", syncInert);

  window.RWB = {
    score: score, level: level, match: match, sortRows: sortRows, sortByConfidence: sortByConfidence, onRender: onRender,
    renderOutline: renderOutline, select: select, locate: locate, toggleConfirm: toggleConfirm,
    setFilter: setFilter, toggleSort: toggleSort, toggleConfSort: toggleConfSort,
    showSource: showSource, hideSource: hideSource, addEvidence: addEvidence,
    confidence: confidence, confidenceLevel: confidenceLevel, hasEvidence: hasEvidence, canConfirm: canConfirm,
    close: closePanel,
    get filter() { return filter; }, get riskSort() { return riskSort; },
    get confSort() { return confSort; }, get selected() { return selSeq; }
  };
})();
