/* T06193 主题工作室：实时预览 UI/报告共同品牌效果、WCAG 文字对比度阻断、主题 JSON 导出。
   边界：仅编辑视觉 Token；不改功能配置。保存前必须全部对比度 ≥ 4.5:1。 */
(function () {
  'use strict';

  var TS_MIN = 4.5;
  var tsTheme = null;
  var tsChecks = [];
  var tsBusy = false;
  var tsLastFocus = null;
  var tsLoaded = false;

  var TS_FIELDS = [
    ['tsBrand', 'semantic', 'brand'],
    ['tsBrandInk', 'semantic', 'brand-ink'],
    ['tsBrandSoft', 'semantic', 'brand-soft'],
    ['tsBg', 'semantic', 'bg'],
    ['tsCard', 'semantic', 'card'],
    ['tsInk', 'semantic', 'ink'],
    ['tsInk2', 'semantic', 'ink-2'],
    ['tsMuted', 'semantic', 'muted'],
    ['tsLine', 'semantic', 'line'],
    ['tsButtonFg', 'component', 'button.primary.foreground'],
  ];

  var TS_PAIRS = [
    ['ink_bg', 'theme.contrast.ink_bg', 'semantic', 'ink', 'semantic', 'bg'],
    ['ink2_bg', 'theme.contrast.ink2_bg', 'semantic', 'ink-2', 'semantic', 'bg'],
    ['muted_bg', 'theme.contrast.muted_bg', 'semantic', 'muted', 'semantic', 'bg'],
    ['ink_card', 'theme.contrast.ink_card', 'semantic', 'ink', 'semantic', 'card'],
    ['button', 'theme.contrast.button', 'component', 'button.primary.foreground', 'component', 'button.primary.background'],
    ['badge', 'theme.contrast.badge', 'component', 'badge.brand.foreground', 'component', 'badge.brand.background'],
  ];

  function tsEl(id) { return document.getElementById(id); }
  function tsT(key, fallback) {
    var v = t(key);
    return v === key ? (fallback || key) : v;
  }
  function tsEsc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function tsClone(obj) { return JSON.parse(JSON.stringify(obj)); }

  function tsResolveRef(theme, value, depth) {
    if (depth > 8 || typeof value !== 'string') return value == null ? value : String(value);
    var m = /^\{(raw|semantic)\.([A-Za-z0-9_.-]+)\}$/.exec(value.trim());
    var layer = null, key = null;
    if (m) { layer = m[1]; key = m[2]; }
    else if (/^(raw|semantic)\./.test(value)) { layer = value.split('.', 1)[0]; key = value.slice(layer.length + 1); }
    if (!layer) return value;
    var next = theme[layer] && theme[layer][key];
    if (next === undefined || next === null) return value;
    return tsResolveRef(theme, next, depth + 1);
  }

  function tsResolve(theme) {
    var out = { semantic: {}, component: {} };
    ['semantic', 'component'].forEach(function (layer) {
      Object.keys(theme[layer] || {}).forEach(function (k) {
        out[layer][k] = tsResolveRef(theme, theme[layer][k], 0);
      });
    });
    return out;
  }

  function tsHexRgb(value) {
    var s = String(value || '').trim();
    var m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(s);
    if (!m) return null;
    var h = m[1];
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function tsLum(rgb) {
    function ch(c) {
      var x = c / 255;
      return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * ch(rgb[0]) + 0.7152 * ch(rgb[1]) + 0.0722 * ch(rgb[2]);
  }

  function tsRatio(fg, bg) {
    var a = tsHexRgb(fg), b = tsHexRgb(bg);
    if (!a || !b) return null;
    var la = tsLum(a), lb = tsLum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  function tsBuildChecks(theme) {
    var r = tsResolve(theme);
    return TS_PAIRS.map(function (p) {
      var fg = r[p[2]][p[3]], bg = r[p[4]][p[5]];
      var ratio = tsRatio(fg, bg);
      return {
        key: p[0], label: tsT(p[1]), fg: fg, bg: bg,
        ratio: ratio == null ? null : Number(ratio.toFixed(2)),
        min: TS_MIN,
        ok: ratio != null && ratio >= TS_MIN,
        parse: ratio != null
      };
    });
  }

  function tsApplyVars(theme) {
    var r = tsResolve(theme);
    var el = tsEl('tsPreview');
    if (!el) return;
    var map = {
      '--brand': r.semantic['brand'], '--brand-ink': r.semantic['brand-ink'],
      '--brand-soft': r.semantic['brand-soft'], '--bg': r.semantic['bg'],
      '--card': r.semantic['card'], '--ink': r.semantic['ink'],
      '--ink-2': r.semantic['ink-2'], '--muted': r.semantic['muted'],
      '--line': r.semantic['line'],
      '--c-button-primary-background': r.component['button.primary.background'],
      '--c-button-primary-foreground': r.component['button.primary.foreground'],
      '--on-brand': r.component['button.primary.foreground'] || r.semantic['on-brand'],
      '--c-badge-brand-background': r.component['badge.brand.background'],
      '--c-badge-brand-foreground': r.component['badge.brand.foreground']
    };
    Object.keys(map).forEach(function (k) {
      if (map[k] != null && map[k] !== '') el.style.setProperty(k, String(map[k]));
    });
    el.dataset.tokens = theme.name || 'custom';
  }

  function tsRenderChecks() {
    var tbody = tsEl('tsCheckRows');
    if (!tbody) return;
    tbody.innerHTML = tsChecks.map(function (c) {
      var state = !c.parse ? tsT('theme.contrast.invalid', '颜色无法解析')
        : c.ok ? tsT('theme.contrast.ok', '通过') : tsT('theme.contrast.fail', '不通过');
      return '<tr class="' + (c.ok ? 'ok' : 'bad') + '" data-ts-check="' + tsEsc(c.key) + '">' +
        '<td>' + tsEsc(c.label) + '</td>' +
        '<td><code>' + tsEsc(c.fg || '—') + '</code></td>' +
        '<td><code>' + tsEsc(c.bg || '—') + '</code></td>' +
        '<td class="ts-num">' + (c.ratio == null ? '—' : c.ratio.toFixed(2) + ':1') + '</td>' +
        '<td class="ts-num">' + TS_MIN.toFixed(1) + ':1</td>' +
        '<td><span class="ts-state">' + tsEsc(state) + '</span></td></tr>';
    }).join('');
    var pass = tsChecks.filter(function (c) { return c.ok; }).length;
    var fail = tsChecks.length - pass;
    var sum = tsEl('tsCheckSummary');
    if (sum) {
      sum.textContent = fail ? tf('theme.studio.check_summary_fail', { pass: pass, total: tsChecks.length, fail: fail })
        : tf('theme.studio.check_summary', { pass: pass, total: tsChecks.length });
      sum.className = 'ts-check-summary ' + (fail ? 'bad' : 'ok');
    }
    var hint = tsEl('tsCheckHint');
    if (hint) {
      hint.textContent = fail ? tsT('theme.studio.blocked', '对比度不足：保存已阻断（需 ≥ 4.5:1）。')
        : tsT('theme.studio.ready', '全部对比度通过，可保存。');
      hint.className = 'ts-check-hint ' + (fail ? 'bad' : 'ok');
    }
    var save = tsEl('tsSave');
    if (save) save.disabled = tsBusy || fail > 0 || !tsNameValid();
  }

  function tsRefresh() {
    if (!tsTheme) return;
    tsChecks = tsBuildChecks(tsTheme);
    tsApplyVars(tsTheme);
    tsRenderChecks();
    if (window.lucide) window.lucide.createIcons();
  }

  function tsNameValid() {
    return !!(tsTheme && /^[a-z0-9][a-z0-9-]{1,31}$/.test(String(tsTheme.name || '')));
  }

  function tsSetStatus(text, kind) {
    var el = tsEl('tsStatus');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'ts-status' + (kind ? ' ' + kind : '');
  }

  function tsFill() {
    if (!tsTheme) return;
    var r = tsResolve(tsTheme);
    TS_FIELDS.forEach(function (f) {
      var input = tsEl(f[0]), code = tsEl(f[0] + 'Hex');
      if (!input) return;
      var v = r[f[1]][f[2]] || '';
      if (/^#[0-9a-fA-F]{6}$/.test(v)) input.value = v;
      if (code) code.textContent = v ? String(v).toUpperCase() : '—';
    });
    var name = tsEl('tsName');
    if (name) name.value = tsTheme.name || '';
    var source = tsEl('tsSource');
    if (source) source.textContent = tsTheme.name ? (tsT('theme.studio.source') + ' ' + tsTheme.name) : '';
    tsRefresh();
  }

  function tsClean() {
    if (!tsTheme) return null;
    return {
      name: tsTheme.name,
      label: tsTheme.label || tsTheme.name,
      version: Number(tsTheme.version || 1),
      raw: tsClone(tsTheme.raw || {}),
      semantic: tsClone(tsTheme.semantic || {}),
      component: tsClone(tsTheme.component || {})
    };
  }

  function tsApplyTheme(theme) {
    tsTheme = tsClone(theme);
    if (!tsTheme.raw || !tsTheme.semantic || !tsTheme.component) throw new Error(tsT('theme.studio.load_fail', '主题结构不完整'));
    if (!tsTheme.label) tsTheme.label = tsTheme.name;
    tsFill();
  }

  async function tsFetchTheme(name) {
    var r = await (await fetch(THEME_TOKEN_API + '/export?name=' + encodeURIComponent(name), { cache: 'no-store' })).json();
    if (!r.ok || !r.theme) throw new Error(r.msg || tsT('theme.studio.load_fail', '读取主题失败'));
    return r.theme;
  }

  async function themeStudioLoad(name) {
    if (tsBusy) return;
    tsBusy = true;
    tsSetStatus(tsT('theme.studio.loading', '正在读取主题…'));
    try {
      if (name === '__active') {
        var data = await themeTokensGet();
        if (!data.active) throw new Error(tsT('theme.studio.no_active', '当前没有已应用的自定义主题'));
        tsApplyTheme(data.active);
      } else {
        tsApplyTheme(await tsFetchTheme(name || 'base'));
      }
      tsSetStatus('');
    } catch (e) {
      tsSetStatus(String(e.message || e), 'bad');
    } finally {
      tsBusy = false;
      tsRenderChecks();
    }
  }

  function themeStudioInput(input) {
    if (!tsTheme || !input) return;
    var layer = input.dataset.tsLayer, token = input.dataset.tsToken;
    var v = String(input.value || '').trim();
    if (!layer || !token || !/^#[0-9a-fA-F]{6}$/.test(v)) return;
    if (!tsTheme[layer]) tsTheme[layer] = {};
    tsTheme[layer][token] = v;
    var code = tsEl(input.id + 'Hex');
    if (code) code.textContent = v.toUpperCase();
    // 主色变化时让主按钮背景继续引用 semantic.brand，避免组件绑定被旧值冻结。
    if (token === 'brand') tsTheme.component['button.primary.background'] = 'semantic.brand';
    tsSetStatus('');
    tsRefresh();
  }

  function themeStudioName(value) {
    if (!tsTheme) return;
    var v = String(value || '').trim();
    tsTheme.name = v;
    tsTheme.label = v || tsTheme.label || tsTheme.name;
    tsSetStatus('');
    tsRefresh();
  }

  function themeStudioDownload() {
    if (!tsTheme) return false;
    var data = tsClean();
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'theme-' + (data.name || 'brand') + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    return true;
  }

  function themeStudioExport() {
    if (!tsTheme) return;
    try {
      themeStudioDownload();
      tsSetStatus(tsT('theme.studio.export_ok', '主题 JSON 已导出。'), 'ok');
    } catch (e) { tsSetStatus(tsT('theme.studio.save_fail', '导出失败：{msg}').replace('{msg}', String(e.message || e)), 'bad'); }
  }

  async function themeStudioSave() {
    if (!tsTheme || tsBusy) return;
    tsChecks = tsBuildChecks(tsTheme);
    tsRenderChecks();
    if (!tsNameValid()) { tsSetStatus(tsT('theme.studio.name_bad', '品牌包名称不合法（2–32 位小写字母/数字/连字符）。'), 'bad'); return; }
    if (tsChecks.some(function (c) { return !c.ok; })) {
      tsSetStatus(tsT('theme.studio.blocked', '对比度不足：保存已阻断（需 ≥ 4.5:1）。'), 'bad');
      return;
    }
    tsBusy = true;
    var save = tsEl('tsSave');
    if (save) save.disabled = true;
    try {
      var active = await themeTokensApply(tsClean());
      tsTheme = active;
      if (!tsTheme.label) tsTheme.label = tsTheme.name;
      tsFill();
      tsSetStatus(tf('theme.studio.save_ok', { name: tsTheme.name }), 'ok');
      if (typeof themeTokenPanel === 'function') themeTokenPanel();
    } catch (e) {
      tsSetStatus(tf('theme.studio.save_fail_msg', { msg: String(e.message || e) }), 'bad');
    } finally {
      tsBusy = false;
      tsRenderChecks();
    }
  }

  async function themeStudioReset() {
    if (tsBusy) return;
    tsBusy = true;
    try {
      await themeTokensReset();
      tsApplyTheme(await tsFetchTheme('base'));
      var sel = tsEl('tsTemplate');
      if (sel) sel.value = 'base';
      tsSetStatus(tsT('theme.studio.reset_ok', '已恢复内置主题。'), 'ok');
    } catch (e) {
      tsSetStatus(String(e.message || e), 'bad');
    } finally {
      tsBusy = false;
      tsRenderChecks();
    }
  }

  function tsTemplateOptions(data) {
    var list = (data.themes || []).map(function (x) {
      return '<option value="' + tsEsc(x.name) + '">' + tsEsc(x.label || x.name) + '</option>';
    });
    if (data.active) list.unshift('<option value="__active">' + tsEsc(tsT('theme.studio.current', '当前生效') + ' · ' + (data.active.label || data.active.name)) + '</option>');
    return list.join('');
  }

  async function themeStudioOpen() {
    var overlay = tsEl('themeStudioOverlay');
    if (!overlay) return;
    if (!tsLoaded) return;
    tsLastFocus = document.activeElement;
    overlay.hidden = false;
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('ts-open');
    var data;
    try {
      data = await themeTokensGet();
    } catch (e) {
      tsSetStatus(String(e.message || e), 'bad');
      return;
    }
    var sel = tsEl('tsTemplate');
    if (sel) {
      sel.innerHTML = tsTemplateOptions(data);
      sel.value = data.active ? '__active' : 'base';
    }
    if (data.active) tsApplyTheme(data.active);
    else {
      try { tsApplyTheme(await tsFetchTheme('base')); } catch (e) { tsSetStatus(String(e.message || e), 'bad'); }
    }
    applyI18n(overlay);
    tsRefresh();
    var name = tsEl('tsName');
    if (name) name.focus();
    else { var close = tsEl('tsClose'); if (close) close.focus(); }
  }

  function themeStudioClose() {
    var overlay = tsEl('themeStudioOverlay');
    if (!overlay) return;
    overlay.hidden = true;
    overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('ts-open');
    if (tsLastFocus && typeof tsLastFocus.focus === 'function') tsLastFocus.focus();
  }

  function themeStudioRefresh() {
    var overlay = tsEl('themeStudioOverlay');
    if (!overlay || overlay.hidden) return;
    applyI18n(overlay);
    tsRefresh();
  }

  function themeStudioKeydown(e) {
    var overlay = tsEl('themeStudioOverlay');
    if (!overlay || overlay.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); themeStudioClose(); return; }
    if (e.key !== 'Tab') return;
    var nodes = Array.prototype.slice.call(overlay.querySelectorAll('button, select, input, [tabindex]:not([tabindex="-1"])'))
      .filter(function (el) { return !el.disabled && el.offsetParent !== null; });
    if (!nodes.length) return;
    var first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  window.themeStudioOpen = themeStudioOpen;
  window.themeStudioClose = themeStudioClose;
  window.themeStudioLoad = themeStudioLoad;
  window.themeStudioInput = themeStudioInput;
  window.themeStudioName = themeStudioName;
  window.themeStudioSave = themeStudioSave;
  window.themeStudioExport = themeStudioExport;
  window.themeStudioReset = themeStudioReset;
  window.themeStudioRefresh = themeStudioRefresh;

  window.addEventListener('DOMContentLoaded', function () {
    var overlay = tsEl('themeStudioOverlay');
    if (overlay) {
      overlay.addEventListener('keydown', themeStudioKeydown);
      applyI18n(overlay);
    }
    tsLoaded = true;
  });
})();
