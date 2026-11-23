/* T06189 增强项目分类：基线对比、ADD/CHG/DEL/CFP 建议、逐项人工复核、EFP 输出。
   规则：只给建议，不自动确认；导出前必须每行勾选「复核」。 */
(function () {
  'use strict';

  var ENH_CATS = ['ADD', 'CHG', 'DEL', 'CFP', 'UNCHANGED'];
  var enhRows = [];
  var enhData = null;
  var enhImportedBaseline = null;
  var enhBaseTotal = 0;
  var enhBusy = false;
  var enhLastFocus = null;

  function E(id) { return document.getElementById(id); }
  function enhT(key, fallback) {
    var v = t(key);
    return v === key ? fallback : v;
  }
  function enhReason(row) {
    var out = [];
    (row.reason_codes || []).forEach(function (c) {
      out.push(enhT('enh.reason.' + c, c));
    });
    if (row.field_changes && row.field_changes.length) {
      out.push(row.field_changes.map(function (x) { return x.label || x.field; }).join(' / '));
    }
    return out.join('；');
  }
  function enhCatLabel(c) { return enhT('enh.cat.' + String(c || '').toLowerCase(), c); }
  function enhConfLabel(c) { return enhT('enh.conf.' + c, c); }
  function enhAllReviewed() { return !!enhRows.length && enhRows.every(function (r) { return r.reviewed; }); }

  function enhTotals() {
    var rows = enhRows;
    var sum = function (cat, field) {
      return rows.reduce(function (a, r) {
        return a + (r.final === cat ? (r[field] || 0) : 0);
      }, 0);
    };
    var add = sum('ADD', 'current_ufp');
    var chg = sum('CHG', 'current_ufp');
    var chgb = sum('CHG', 'baseline_ufp');
    var del = sum('DEL', 'baseline_ufp');
    var cfp = rows.reduce(function (a, r) {
      if (r.final !== 'CFP') return a;
      return a + (r.current_ufp || r.baseline_ufp || 0);
    }, 0);
    var baseline = rows.reduce(function (a, r) { return a + (r.baseline_ufp || 0); }, 0);
    var current = rows.reduce(function (a, r) { return a + (r.current_ufp || 0); }, 0);
    return {
      add: add, chg: chg, chgBefore: chgb, del: del, cfp: cfp,
      baseline: baseline, current: current,
      efp: add + chg + cfp + del,
      updated: baseline + add + chg - chgb - del
    };
  }

  function enhCounts() {
    var c = { ADD: 0, CHG: 0, DEL: 0, CFP: 0, UNCHANGED: 0 };
    enhRows.forEach(function (r) { if (c[r.final] != null) c[r.final]++; });
    return c;
  }

  function enhStatus(text, kind) {
    var el = E('enhStatus');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'enh-status' + (kind ? ' ' + kind : '');
  }

  function enhRenderSummary() {
    var box = E('enhSummary');
    if (!box) return;
    if (!enhRows.length) { box.innerHTML = ''; return; }
    var c = enhCounts(), tt = enhTotals();
    var kpi = function (cat, value, small, extra) {
      return '<div class="enh-kpi ' + (extra || '') + '"><span>' + enhCatLabel(cat) + '</span><b>' + value + '</b><small>' + small + '</small></div>';
    };
    box.innerHTML =
      kpi('ADD', c.ADD, '+' + tt.add + ' FP') +
      kpi('CHG', c.CHG, '+' + tt.chg + ' / -' + tt.chgBefore + ' FP') +
      kpi('DEL', c.DEL, '-' + tt.del + ' FP') +
      kpi('CFP', c.CFP, '+' + tt.cfp + ' FP') +
      kpi('UNCHANGED', c.UNCHANGED, enhT('enh.kpi.none', '—')) +
      kpi('EFP', tt.efp, enhT('enh.kpi.updated', '更新后 UFP') + ' ' + tt.updated, 'efp');
    if (box.querySelector('.enh-kpi.efp')) {
      box.querySelector('.enh-kpi.efp small').textContent = enhT('enh.kpi.updated', '更新后 UFP') + ' ' + tt.updated;
    }
  }

  function enhRowOptions(row) {
    if (row.source === 'baseline' && !row.current_ufp) return ['DEL', 'UNCHANGED'];
    if (row.source === 'current' && !row.baseline_ufp) return ['ADD', 'UNCHANGED'];
    return ['CHG', 'DEL', 'CFP', 'UNCHANGED'];
  }

  function enhRenderRows() {
    var tbody = E('enhRows');
    if (!tbody) return;
    tbody.innerHTML = enhRows.map(function (r) {
      var opts = enhRowOptions(r);
      var sel = opts.map(function (c) {
        return '<option value="' + c + '"' + (r.final === c ? ' selected' : '') + '>' + enhCatLabel(c) + '</option>';
      }).join('');
      var mismatch = r.final !== r.auto;
      var cls = [mismatch ? 'mismatch' : '', r.reviewed ? 'reviewed' : ''].filter(Boolean).join(' ');
      return '<tr data-enh-row="' + r.id + '"' + (cls ? ' class="' + cls + '"' : '') + '>' +
        '<td><div class="enh-name" title="' + escAttr(r.name + ' · ' + (r.stable_id || '')) + '">' + histEsc(r.name || '—') +
        '<small>' + histEsc(r.stable_id || enhT('enh.no_id', '无稳定 ID')) + '</small></div></td>' +
        '<td>' + histEsc(r.system || '—') + '</td>' +
        '<td><span class="enh-badge ' + r.auto + '" title="' + escAttr(enhReason(r)) + '">' + enhCatLabel(r.auto) + '</span>' +
        (mismatch ? ' <span class="enh-mismatch-mark" title="' + escAttr(enhT('enh.mismatch', '已改判')) + '">↺</span>' : '') + '</td>' +
        '<td><select class="enh-final" data-enh-final="' + r.id + '" aria-label="' + escAttr(enhT('enh.th.final', '最终分类') + ' ' + r.name) + '" onchange="enhSetFinal(\'' + r.id + '\',this.value)">' + sel + '</select></td>' +
        '<td><span class="enh-conf ' + r.confidence + '">' + enhConfLabel(r.confidence) + '</span></td>' +
        '<td class="enh-num">' + (r.baseline_ufp || 0) + '</td>' +
        '<td class="enh-num">' + (r.current_ufp || 0) + '</td>' +
        '<td><input class="enh-review" type="checkbox" data-enh-review="' + r.id + '"' + (r.reviewed ? ' checked' : '') +
        ' aria-label="' + escAttr(enhT('enh.th.review', '复核') + ' ' + r.name) + '" onchange="enhToggleReview(\'' + r.id + '\',this.checked)"></td>' +
        '</tr>';
    }).join('');
  }

  function enhRefreshState() {
    enhRenderSummary();
    var all = enhAllReviewed();
    var progress = E('enhProgress');
    if (progress) {
      progress.textContent = enhRows.length
        ? tf('enh.progress.done', { done: enhRows.filter(function (r) { return r.reviewed; }).length, total: enhRows.length })
        : enhT('enh.progress.none', '尚未复核');
    }
    ['enhCsv', 'enhJson'].forEach(function (id) {
      var b = E(id);
      if (b) b.disabled = !all;
    });
    var acc = E('enhAcceptAll');
    if (acc) acc.disabled = !enhRows.length || all;
    var table = E('enhTableWrap');
    if (table) table.hidden = !enhRows.length;
    var empty = E('enhEmpty');
    if (empty) empty.hidden = !!enhRows.length || !!enhData || enhBusy;
  }

  function enhRender() {
    enhRenderRows();
    enhRefreshState();
    if (window.lucide) window.lucide.createIcons();
  }

  function enhSetFinal(id, value) {
    var row = enhRows.find(function (r) { return r.id === id; });
    if (!row || ENH_CATS.indexOf(value) < 0) return;
    row.final = value;
    row.reviewed = true;
    var tr = document.querySelector('[data-enh-row="' + id + '"]');
    if (tr) {
      tr.classList.toggle('mismatch', row.final !== row.auto);
      tr.classList.add('reviewed');
      var cb = tr.querySelector('[data-enh-review]');
      if (cb) cb.checked = true;
    }
    enhRefreshState();
  }

  function enhToggleReview(id, checked) {
    var row = enhRows.find(function (r) { return r.id === id; });
    if (!row) return;
    row.reviewed = !!checked;
    var tr = document.querySelector('[data-enh-row="' + id + '"]');
    if (tr) tr.classList.toggle('reviewed', row.reviewed);
    enhRefreshState();
  }

  function enhAcceptAll() {
    if (!enhRows.length) return;
    enhRows.forEach(function (r) { r.reviewed = true; });
    enhRenderRows();
    enhRefreshState();
    toast(enhT('enh.toast.accepted', '已标记全部建议为已复核；导出前请确认改判项。'));
  }

  async function enhClassify(baseline, label) {
    if (enhBusy) return;
    if (!Array.isArray(baseline)) {
      enhStatus(enhT('enh.status.no_baseline', '基线不可用。'), 'bad');
      return;
    }
    enhBusy = true;
    enhData = null;
    enhRows = [];
    enhBaseTotal = 0;
    enhStatus(enhT('enh.status.classifying', '正在比较基线并生成建议…'));
    if (E('enhTableWrap')) E('enhTableWrap').hidden = true;
    if (E('enhAcceptAll')) E('enhAcceptAll').disabled = true;
    if (E('enhCsv')) E('enhCsv').disabled = true;
    if (E('enhJson')) E('enhJson').disabled = true;
    try {
      var cur = (items || []).map(function (it) { return Object.assign({}, it); });
      var payload = {
        baseline: baseline,
        current: cur,
        method: (E('methodSel') && E('methodSel').value) || '估算功能点',
        cx_mode: (typeof cxMode === 'string' ? cxMode : '企业母版')
      };
      var r = await fetch(API + '/api/enhancement/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      var j = await r.json();
      if (!j.ok) throw new Error(lm(j));
      enhData = j;
      enhRows = j.rows || [];
      enhBaseTotal = (j.totals && j.totals.baseline_ufp) || 0;
      enhRender();
      enhStatus((label ? label + ' · ' : '') + tf('enh.status.ready', {
        n: enhRows.length, matched: (j.coverage || {}).matched || 0,
        add: (j.suggested_counts || {}).add || 0, chg: (j.suggested_counts || {}).chg || 0,
        del: (j.suggested_counts || {}).del || 0, cfp: (j.suggested_counts || {}).cfp || 0
      }), 'ok');
    } catch (e) {
      enhStatus(enhT('enh.status.fail', '分类失败') + '：' + e.message, 'bad');
      if (E('enhEmpty')) E('enhEmpty').hidden = false;
    } finally {
      enhBusy = false;
      enhRefreshState();
    }
  }

  async function enhFetchJSON(url) {
    var r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  async function enhLoadBaselines() {
    enhStatus(enhT('enh.status.loading', '正在载入基线…'));
    var sel = E('enhBase');
    if (sel) sel.innerHTML = '<option value="">' + enhT('enh.baseline.none', '（无）') + '</option>';
    if (E('enhBaseMeta')) E('enhBaseMeta').textContent = '';
    var j;
    try { j = await enhFetchJSON(API + '/api/history?limit=200'); } catch (e) {
      enhStatus(enhT('enh.status.history_fail', '历史版本不可用') + '：' + e.message, 'bad');
      return;
    }
    var rows = (j.rows || []).filter(function (x) { return x.id; });
    var curId = localStorage.getItem('wl_last_history') || '';
    var options = rows.filter(function (x) { return x.id !== curId; });
    var preferred = null;
    if (curId) {
      try {
        var g = await enhFetchJSON(API + '/api/history/' + curId + '/group');
        var versions = (g.versions || []).slice().sort(function (a, b) { return (a.version_no || 0) - (b.version_no || 0); });
        var c = versions.filter(function (x) { return x.id === curId; })[0];
        var before = versions.filter(function (x) { return !c || (x.version_no || 0) < (c.version_no || 0); });
        if (before.length) preferred = before[before.length - 1].id;
        versions.forEach(function (v) {
          if (v.id === curId) return;
          if (!options.some(function (x) { return x.id === v.id; })) {
            options.push({ id: v.id, title: v.title, version_no: v.version_no, created_at: v.created_at, count: null });
          }
        });
      } catch (e) { /* group 不可用不影响列表 */ }
    }
    options.sort(function (a, b) {
      return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });
    if (sel) {
      sel.innerHTML = '<option value="">' + enhT('enh.baseline.choose', '选择基线版本') + '</option>' +
        options.map(function (x) {
          return '<option value="' + escAttr(x.id) + '">' + histEsc((x.version_no ? 'v' + x.version_no + ' · ' : '') +
            (x.title || '未命名') + (x.count != null ? ' · ' + x.count + ' 项' : '') + ' · ' +
            String(x.created_at || '').replace('T', ' ').slice(0, 16)) + '</option>';
        }).join('');
    }
    if (!options.length) {
      enhStatus(enhT('enh.status.no_baseline', '没有可用的基线版本；请先保存历史或导入基线 JSON。'), 'bad');
      if (E('enhEmpty')) E('enhEmpty').hidden = false;
      return;
    }
    var pick = preferred && options.some(function (x) { return x.id === preferred; }) ? preferred : options[0].id;
    if (sel) sel.value = pick;
    await enhBaseChange();
  }

  async function enhBaseChange() {
    var sel = E('enhBase');
    var id = sel && sel.value;
    if (!id) {
      enhStatus(enhT('enh.status.no_baseline', '请选择基线版本，或导入基线 JSON。'), 'bad');
      return;
    }
    try {
      var j = await enhFetchJSON(API + '/api/history/' + id);
      if (!j.ok || !j.row) throw new Error(lm(j));
      var row = j.row;
      if (E('enhBaseMeta')) E('enhBaseMeta').textContent = (row.title || '') + ' · v' + (row.version_no || 1) + ' · ' + (row.items || []).length + ' 项';
      enhImportedBaseline = null;
      await enhClassify(row.items || [], enhT('enh.baseline.loaded', '已载入基线'));
    } catch (e) {
      enhStatus(enhT('enh.status.base_fail', '载入基线失败') + '：' + e.message, 'bad');
    }
  }

  function enhanceOpen(baselineOverride) {
    var root = E('enhOverlay');
    if (!root) return;
    if ((!items || !items.length) && localStorage.getItem('wl_last_history') && typeof histLoad === 'function') {
      histLoad(localStorage.getItem('wl_last_history')).then(function () {
        enhanceOpen(baselineOverride);
      }).catch(function () {
        toast(enhT('enh.toast.need_items', '请先完成复核并生成结果。'));
      });
      return;
    }
    if (!items || !items.length) {
      toast(enhT('enh.toast.need_items', '请先完成复核并生成结果。'));
      return;
    }
    enhLastFocus = document.activeElement;
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('enh-open');
    if (E('expMenu')) E('expMenu').style.display = 'none';
    enhRows = [];
    enhData = null;
    enhImportedBaseline = null;
    enhBaseTotal = 0;
    if (E('enhSummary')) E('enhSummary').innerHTML = '';
    if (E('enhTableWrap')) E('enhTableWrap').hidden = true;
    if (E('enhEmpty')) E('enhEmpty').hidden = true;
    if (E('enhAcceptAll')) E('enhAcceptAll').disabled = true;
    if (E('enhCsv')) E('enhCsv').disabled = true;
    if (E('enhJson')) E('enhJson').disabled = true;
    if (E('enhProgress')) E('enhProgress').textContent = enhT('enh.progress.none', '尚未复核');
    var sel = E('enhBase');
    if (Array.isArray(baselineOverride)) {
      enhImportedBaseline = baselineOverride;
      if (sel) sel.innerHTML = '<option value="__imported">' + enhT('enh.baseline.imported', '已导入基线') + ' · ' + baselineOverride.length + '</option>';
      if (E('enhBaseMeta')) E('enhBaseMeta').textContent = enhT('enh.baseline.imported_meta', '外部 JSON 基线');
      enhClassify(baselineOverride, enhT('enh.baseline.imported', '已导入基线'));
    } else {
      enhLoadBaselines();
    }
    setTimeout(function () { var b = E('enhClose'); if (b) b.focus(); }, 30);
  }

  function enhImport() {
    var f = E('enhFile');
    if (f) { f.value = ''; f.click(); }
  }

  async function enhFilePick(input) {
    var f = input && input.files && input.files[0];
    if (!f) return;
    try {
      var text = await f.text();
      var j = JSON.parse(text);
      var arr = Array.isArray(j) ? j : (j.items || j.baseline);
      if (!Array.isArray(arr) || !arr.length) throw new Error(enhT('enh.import.invalid', 'JSON 中没有 items/baseline 数组'));
      enhImportedBaseline = arr;
      var sel = E('enhBase');
      if (sel) sel.innerHTML = '<option value="__imported">' + histEsc(f.name) + ' · ' + arr.length + '</option>';
      if (E('enhBaseMeta')) E('enhBaseMeta').textContent = f.name;
      await enhClassify(arr, f.name);
    } catch (e) {
      enhStatus(enhT('enh.status.import_fail', '导入失败') + '：' + e.message, 'bad');
    } finally {
      if (input) input.value = '';
    }
  }

  function enhCsvField(v) {
    var s = String(v == null ? '' : v);
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function enhContrib(row) {
    if (row.final === 'ADD' || row.final === 'CHG') return row.current_ufp || 0;
    if (row.final === 'DEL') return row.baseline_ufp || 0;
    if (row.final === 'CFP') return row.current_ufp || row.baseline_ufp || 0;
    return 0;
  }

  function enhFileName(ext) {
    var base = (typeof baseName === 'function' ? baseName() : '工作量评估') || '工作量评估';
    return base.replace(/[\\/:*?"<>|]/g, '_') + '_EFP.' + ext;
  }

  function enhExportCsv() {
    if (!enhAllReviewed()) { toast(enhT('enh.toast.review_all', '请先逐项勾选复核（或点「全部标记已复核」）。')); return; }
    var tt = enhTotals();
    var lines = [
      ['最终分类', '稳定ID', '功能项', '系统', '类型', '基线UFP', '当前UFP', 'EFP贡献', '置信度', '自动建议', '是否改判', '复核', '依据'].map(enhCsvField).join(',')
    ];
    enhRows.forEach(function (r) {
      lines.push([
        r.final, r.stable_id || '', r.name, r.system, r.type, r.baseline_ufp || 0, r.current_ufp || 0, enhContrib(r),
        r.confidence, r.auto, r.final !== r.auto ? '是' : '否', r.reviewed ? '是' : '否', enhReason(r)
      ].map(enhCsvField).join(','));
    });
    lines.push('');
    lines.push(['合计', 'ADD', tt.add, 'CHG', tt.chg, 'CHGB', tt.chgBefore, 'DEL', tt.del, 'CFP', tt.cfp].map(enhCsvField).join(','));
    lines.push(['合计', 'EFP', tt.efp, '更新后UFP', tt.updated, '基线UFP', tt.baseline, '当前UFP', tt.current].map(enhCsvField).join(','));
    _dl(enhFileName('csv'), '\ufeff' + lines.join('\n'), 'text/csv');
    toast(enhT('enh.toast.exported', 'EFP CSV 已导出。'));
  }

  function enhExportJson() {
    if (!enhAllReviewed()) { toast(enhT('enh.toast.review_all', '请先逐项勾选复核（或点「全部标记已复核」）。')); return; }
    var out = {
      rules_version: enhData && enhData.rules_version,
      method: enhData && enhData.method,
      cx_mode: enhData && enhData.cx_mode,
      formula: enhData && enhData.formula,
      totals: enhTotals(),
      rows: enhRows
    };
    _dl(enhFileName('json'), JSON.stringify(out, null, 2), 'application/json');
    toast(enhT('enh.toast.exported', 'EFP JSON 已导出。'));
  }

  function enhClose() {
    var root = E('enhOverlay');
    if (!root) return;
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('enh-open');
    var f = enhLastFocus && document.body.contains(enhLastFocus) ? enhLastFocus : E('enhBtn');
    if (f && f.focus) setTimeout(function () { f.focus(); }, 20);
  }

  (function enhBindKeys() {
    var root = E('enhOverlay');
    if (!root) return;
    root.addEventListener('keydown', function (e) {
      if (root.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); enhClose(); return; }
      if (e.key !== 'Tab') return;
      var nodes = [].slice.call(root.querySelectorAll('button:not([disabled]), select:not([disabled]), input:not([disabled]), [href]'));
      if (!nodes.length) return;
      var first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  })();

  window.enhanceOpen = enhanceOpen;
  window.enhClose = enhClose;
  window.enhBaseChange = enhBaseChange;
  window.enhSetFinal = enhSetFinal;
  window.enhToggleReview = enhToggleReview;
  window.enhAcceptAll = enhAcceptAll;
  window.enhImport = enhImport;
  window.enhFilePick = enhFilePick;
  window.enhExportCsv = enhExportCsv;
  window.enhExportJson = enhExportJson;
})();
