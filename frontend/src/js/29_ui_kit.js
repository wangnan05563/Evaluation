/* T06172 / REQ-002：核心 UI 组件库（按钮 / 输入 / 弹窗 / 抽屉 / 表格 / 图表）。
   零依赖、原生 DOM；颜色/圆角/字号全部走现有主题变量，因此亮/暗/高对比自动跟随。
   使用说明见 docs/ui-kit.md。 */
(function () {
  "use strict";
  var seq = 0;
  function uid(p) { seq += 1; return (p || "uik") + "-" + seq; }
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === "className") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k === "html") el.innerHTML = v;
        else if (k.slice(0, 2) === "on" && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === "dataset") Object.keys(v).forEach(function (d) { el.dataset[d] = v[d]; });
        else el.setAttribute(k, v === true ? "" : String(v));
      });
    }
    (kids || []).forEach(function (kid) {
      if (kid == null) return;
      el.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
    });
    return el;
  }
  function icons(root) {
    try { if (window.lucide && typeof window.lucide.createIcons === "function") window.lucide.createIcons({ root: root || document }); } catch (e) { /* noop */ }
  }
  function icon(name) { return h("i", { "data-lucide": name, "class": "lic", "aria-hidden": "true" }); }
  function setContent(el, content) {
    if (content == null) return;
    if (typeof content === "string") el.innerHTML = content;
    else if (content.nodeType) el.appendChild(content);
    else if (Array.isArray(content)) content.forEach(function (x) { setContent(el, x); });
  }

  function button(o) {
    o = o || {};
    var b = h("button", { type: o.type || "button", className: "uik-btn uik-btn-" + (o.variant || "primary") + " uik-btn-" + (o.size || "md") + (o.block ? " uik-btn-block" : "") });
    if (o.id) b.id = o.id;
    if (o.disabled) b.disabled = true;
    if (o.ariaLabel) b.setAttribute("aria-label", o.ariaLabel);
    if (o.title) b.title = o.title;
    if (o.icon) b.appendChild(icon(o.icon));
    if (o.label) b.appendChild(h("span", { text: o.label }));
    if (o.count != null) b.appendChild(h("span", { className: "uik-btn-count", text: String(o.count) }));
    if (typeof o.onClick === "function") b.addEventListener("click", o.onClick);
    return b;
  }

  function field(o) {
    o = o || {};
    var id = o.id || uid("uik-field");
    var wrap = h("div", { className: "uik-field" + (o.error ? " is-error" : "") + (o.disabled ? " is-disabled" : "") });
    var label = null;
    if (o.label) {
      label = h("label", { className: "uik-label", for: id }, [o.label, o.required ? h("span", { className: "uik-req", text: " *" }) : null]);
      wrap.appendChild(label);
    }
    var input;
    if (o.type === "select") {
      input = h("select", { className: "uik-control", id: id, disabled: o.disabled ? true : null });
      (o.options || []).forEach(function (op) {
        var val = op.value != null ? op.value : op;
        var lab = op.label != null ? op.label : val;
        input.appendChild(h("option", { value: val, text: lab, selected: val === o.value ? true : null }));
      });
    } else if (o.type === "textarea") {
      input = h("textarea", { className: "uik-control", id: id, rows: o.rows || 4, placeholder: o.placeholder || "", disabled: o.disabled ? true : null });
      input.value = o.value || "";
    } else {
      input = h("input", { className: "uik-control", id: id, type: o.type || "text", placeholder: o.placeholder || "", disabled: o.disabled ? true : null });
      input.value = o.value || "";
      if (o.maxLength) input.maxLength = o.maxLength;
    }
    if (o.name) input.name = o.name;
    if (o.ariaLabel) input.setAttribute("aria-label", o.ariaLabel);
    if (o.error) input.setAttribute("aria-invalid", "true");
    var msg = null;
    if (o.hint || o.error) {
      var mid = id + "-msg";
      input.setAttribute("aria-describedby", mid);
      msg = h("div", { className: "uik-msg", id: mid, text: o.error || o.hint });
      if (o.error) msg.classList.add("is-error");
    }
    var row = h("div", { className: "uik-control-row" }, [input, o.suffix || null]);
    wrap.appendChild(row);
    if (msg) wrap.appendChild(msg);
    var api = {
      el: wrap, input: input,
      setError: function (text) {
        wrap.classList.toggle("is-error", !!text);
        input.setAttribute("aria-invalid", text ? "true" : "false");
        if (!msg) { msg = h("div", { className: "uik-msg", id: id + "-msg" }); wrap.appendChild(msg); input.setAttribute("aria-describedby", id + "-msg"); }
        msg.textContent = text || o.hint || "";
        msg.classList.toggle("is-error", !!text);
      },
      value: function () { return input.value; }
    };
    return api;
  }

  function table(o) {
    o = o || {};
    var wrap = h("div", { className: "uik-table-wrap" });
    var tb = h("table", { className: "uik-table" });
    if (o.caption) tb.appendChild(h("caption", { text: o.caption }));
    var cols = o.columns || [];
    var thead = h("thead"), tr = h("tr");
    cols.forEach(function (c) {
      var th = h("th", { text: c.label != null ? c.label : c.key, scope: "col" });
      if (c.align) th.style.textAlign = c.align;
      if (c.width) th.style.width = c.width;
      tr.appendChild(th);
    });
    thead.appendChild(tr); tb.appendChild(thead);
    var tbody = h("tbody");
    var rows = o.rows || [];
    if (!rows.length) {
      tbody.appendChild(h("tr", null, [h("td", { colspan: String(cols.length || 1), className: "uik-table-empty", text: o.empty || "暂无数据" })]));
    } else {
      rows.forEach(function (r, ri) {
        var row = h("tr", { className: "uik-table-row" + (o.onRowClick ? " is-clickable" : "") });
        if (o.onRowClick) {
          row.tabIndex = 0; row.setAttribute("role", "button");
          row.addEventListener("click", function () { o.onRowClick(r, ri); });
          row.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); o.onRowClick(r, ri); }
          });
        }
        cols.forEach(function (c) {
          var td = h("td");
          if (c.align) td.style.textAlign = c.align;
          var val = c.render ? c.render(r, ri) : r[c.key];
          if (val != null && val.nodeType) td.appendChild(val);
          else if (val != null && Array.isArray(val)) val.forEach(function (x) { td.appendChild(x && x.nodeType ? x : document.createTextNode(String(x))); });
          else td.textContent = val == null ? "" : String(val);
          row.appendChild(td);
        });
        tbody.appendChild(row);
      });
    }
    tb.appendChild(tbody); wrap.appendChild(tb);
    if (o.footer) wrap.appendChild(h("div", { className: "uik-table-foot", text: o.footer }));
    return wrap;
  }

  function chart(o) {
    o = o || {};
    var data = o.data || [];
    var max = o.max || Math.max.apply(null, data.map(function (d) { return Number(d.value) || 0; }).concat([1]));
    var wrap = h("figure", { className: "uik-chart" + (o.compact ? " is-compact" : "") });
    var title = o.title || "图表";
    var cap = h("figcaption", { className: "uik-chart-title" }, [title, o.unit ? h("span", { className: "uik-chart-unit", text: " · " + o.unit }) : null]);
    wrap.appendChild(cap);
    var plot = h("div", { className: "uik-chart-plot", role: "img", "aria-label": title + "：" + data.map(function (d) { return d.label + " " + d.value + (o.unit || ""); }).join("，") });
    data.forEach(function (d) {
      var v = Number(d.value) || 0;
      var col = h("div", { className: "uik-bar-col" });
      col.appendChild(h("span", { className: "uik-bar-val", text: String(v) }));
      var track = h("div", { className: "uik-bar-track" });
      var bar = h("div", { className: "uik-bar", "data-value": String(v) });
      bar.style.height = (Math.max(2, Math.round(v / max * 100)) + "%");
      if (d.color) bar.style.background = d.color;
      track.appendChild(bar); col.appendChild(track);
      col.appendChild(h("span", { className: "uik-bar-label", text: d.label }));
      plot.appendChild(col);
    });
    wrap.appendChild(plot);
    if (o.note) wrap.appendChild(h("div", { className: "uik-chart-note", text: o.note }));
    return wrap;
  }

  function progress(o) {
    o = o || {};
    var v = Math.max(0, Math.min(100, Number(o.value) || 0));
    var wrap = h("div", { className: "uik-progress" });
    if (o.label) wrap.appendChild(h("div", { className: "uik-progress-head" }, [h("span", { text: o.label }), h("b", { text: v + "%" })]));
    var track = h("div", { className: "uik-progress-track", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(v), "aria-label": o.label || "进度" });
    var fill = h("div", { className: "uik-progress-fill" }); fill.style.width = v + "%";
    track.appendChild(fill); wrap.appendChild(track);
    return wrap;
  }

  function badge(text, tone) { return h("span", { className: "uik-badge" + (tone ? " uik-badge-" + tone : ""), text: text }); }

  function overlay(kind, o) {
    o = o || {};
    var prev = document.activeElement;
    var titleId = uid("uik-title");
    var root = h("div", { className: "uik-overlay uik-overlay-" + kind });
    var panel = h("div", { className: "uik-panel uik-" + kind, role: "dialog", "aria-modal": "true", "aria-labelledby": titleId });
    var closeBtn = button({ label: "", variant: "ghost", size: "sm", icon: "x", ariaLabel: "关闭" });
    closeBtn.classList.add("uik-close");
    var head = h("div", { className: "uik-panel-head" }, [h("h2", { id: titleId, className: "uik-panel-title", text: o.title || (kind === "modal" ? "弹窗" : "抽屉") }), closeBtn]);
    var body = h("div", { className: "uik-panel-body" });
    setContent(body, o.content);
    var footer = null;
    if (o.actions && o.actions.length) {
      footer = h("div", { className: "uik-panel-foot" });
      o.actions.forEach(function (a) {
        var b = button({ label: a.label, variant: a.variant || "ghost", size: a.size || "md", disabled: a.disabled, icon: a.icon, onClick: function () {
          if (typeof a.onClick === "function") a.onClick(api);
          if (a.close !== false) api.close();
        } });
        footer.appendChild(b);
      });
    }
    panel.appendChild(head); panel.appendChild(body); if (footer) panel.appendChild(footer);
    root.appendChild(panel); document.body.appendChild(root); icons(panel);
    var closed = false;
    function close(reason) {
      if (closed) return; closed = true;
      document.removeEventListener("keydown", onKey, true);
      root.classList.add("is-closing");
      setTimeout(function () { root.remove(); }, 160);
      if (prev && prev.focus) try { prev.focus(); } catch (e) { /* noop */ }
      if (typeof o.onClose === "function") o.onClose(reason || "close");
    }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close("escape"); return; }
      if (e.key !== "Tab") return;
      var list = panel.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
      if (!list.length) return;
      var first = list[0], last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKey, true);
    closeBtn.addEventListener("click", function () { close("close"); });
    root.addEventListener("mousedown", function (e) { if (e.target === root) close("backdrop"); });
    setTimeout(function () {
      var f = panel.querySelector(".uik-panel-body input, .uik-panel-body select, .uik-panel-body textarea, .uik-panel-foot .uik-btn, .uik-close");
      if (f) f.focus();
    }, 30);
    var api = { el: root, panel: panel, body: body, close: close, setContent: function (c) { body.innerHTML = ""; setContent(body, c); } };
    return api;
  }
  function modal(o) { return overlay("modal", o); }
  function drawer(o) { o = o || {}; o.side = o.side || "right"; return overlay("drawer", o); }

  function gallery(host) {
    var root = h("div", { className: "uik-gallery" });
    root.appendChild(h("header", { className: "uik-gallery-head" }, [h("h1", { text: "核心 UI 组件库" }), h("p", { text: "T06172 · 按钮 / 输入 / 弹窗 / 抽屉 / 表格 / 图表 · 亮色 / 暗色 / 高对比通用" })]));
    var sec1 = h("section", { className: "uik-gallery-sec" }, [h("h2", { text: "按钮 Button" })]);
    var row1 = h("div", { className: "uik-row" });
    ["primary", "secondary", "ghost", "danger"].forEach(function (v) { row1.appendChild(button({ label: v, variant: v })); });
    row1.appendChild(button({ label: "禁用", disabled: true }));
    row1.appendChild(button({ label: "带图标", icon: "sparkles", variant: "secondary" }));
    sec1.appendChild(row1);
    var row2 = h("div", { className: "uik-row" });
    ["sm", "md", "lg"].forEach(function (s) { row2.appendChild(button({ label: "尺寸 " + s, size: s, variant: "secondary" })); });
    sec1.appendChild(row2); root.appendChild(sec1);

    var sec2 = h("section", { className: "uik-gallery-sec" }, [h("h2", { text: "输入 Input" })]);
    var grid = h("div", { className: "uik-form-grid" });
    grid.appendChild(field({ label: "项目名称", placeholder: "如：票据系统三期", hint: "必填，最多 80 字", required: true }).el);
    grid.appendChild(field({ label: "评估方法", type: "select", value: "ifpug", options: [{ value: "ifpug", label: "IFPUG" }, { value: "nesma", label: "NESMA" }] }).el);
    grid.appendChild(field({ label: "有错误的字段", value: "abc", error: "只能输入数字" }).el);
    grid.appendChild(field({ label: "备注", type: "textarea", placeholder: "补充说明…" }).el);
    sec2.appendChild(grid); root.appendChild(sec2);

    var sec3 = h("section", { className: "uik-gallery-sec" }, [h("h2", { text: "表格 Table" })]);
    sec3.appendChild(table({
      caption: "示例：功能点明细", columns: [
        { key: "type", label: "类型", width: "80px" },
        { key: "desc", label: "功能描述" },
        { key: "ufp", label: "UFP", align: "right", render: function (r) { return badge(String(r.ufp), "info"); } },
        { key: "status", label: "状态", render: function (r) { return badge(r.status, r.status === "已确认" ? "ok" : "warn"); } }
      ],
      rows: [
        { type: "ILF", desc: "内部文件", ufp: 10, status: "已确认" },
        { type: "EIF", desc: "外部接口", ufp: 7, status: "待复核" },
        { type: "EI", desc: "新增票据", ufp: 4, status: "已确认" }
      ],
      onRowClick: function (row) { window.__uikRow = row; },
      footer: "共 3 条 · 点击行可打开证据"
    }));
    root.appendChild(sec3);

    var sec4 = h("section", { className: "uik-gallery-sec" }, [h("h2", { text: "图表 Chart" })]);
    sec4.appendChild(chart({ title: "各类型 UFP 分布", unit: "UFP", data: [
      { label: "ILF", value: 40 }, { label: "EIF", value: 28 }, { label: "EI", value: 24 }, { label: "EO", value: 16 }, { label: "EQ", value: 12 }
    ], note: "条形高度按最大值归一化，数值标签始终可读。" }));
    root.appendChild(sec4);

    var sec5 = h("section", { className: "uik-gallery-sec" }, [h("h2", { text: "弹窗 / 抽屉 Modal & Drawer" })]);
    var row5 = h("div", { className: "uik-row" });
    row5.appendChild(button({ label: "打开弹窗", icon: "app-window", onClick: function () {
      var m = modal({ title: "确认生成审计包", content: h("p", { text: "将生成包含封面/摘要/方法/明细/追溯/变更/签收的 PDF，预计 12 秒。" }), actions: [
        { label: "取消", variant: "ghost" },
        { label: "开始生成", variant: "primary", icon: "play", onClick: function () { } }
      ] });
      window.__uikLastModal = m;
    } }));
    row5.appendChild(button({ label: "打开抽屉", icon: "panel-right", variant: "secondary", onClick: function () {
      var d = drawer({ title: "证据抽屉", content: h("div", { className: "uik-evidence" }, [
        h("p", { text: "原文：系统应支持票据影像的批量导入与校验。" }),
        h("p", { text: "规则：IFPUG EI，DET=12，FTR=2 → 中。" }),
        h("p", { text: "AI 建议：新增票据导入功能，置信度 0.91。" })
      ]), actions: [{ label: "关闭", variant: "ghost" }] });
      window.__uikLastDrawer = d;
    } }));
    sec5.appendChild(row5); root.appendChild(sec5);

    (host || document.body).appendChild(root); icons(root);
    return root;
  }

  window.UIKIT = {
    version: "1.0.0", button: button, field: field, input: field, table: table, chart: chart,
    modal: modal, drawer: drawer, progress: progress, badge: badge, gallery: gallery, icon: icon,
    refreshIcons: icons
  };
})();
