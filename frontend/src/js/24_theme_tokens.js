/* T06171：三层 Token 主题（raw / semantic / component）前端消费层。
   设计：组件只读 CSS 变量；主题 JSON 由后端校验后下发，前端只做「解析结果 → CSS 变量」映射，
   新增品牌主题不需要改任何组件代码。 */
const THEME_TOKEN_API = (typeof API === "string" ? API : "") + "/api/theme";
let __themeTokenThemes = [];

function themeTokenOptionsHtml() {
  return __themeTokenThemes.map(t => '<option value="' + t.name + '">' + (t.label || t.name) + "</option>").join("");
}

function themeTokenResolve(theme) {
  if (!theme || !theme.resolved || !theme.resolved.semantic) return null;
  const sem = theme.resolved.semantic || {};
  const comp = theme.resolved.component || {};
  const vars = {};
  Object.keys(sem).forEach(k => { vars["--" + k.replace(/^--/, "")] = String(sem[k]); });
  Object.keys(comp).forEach(k => { vars["--c-" + k.replaceAll(".", "-")] = String(comp[k]); });
  const brand = comp["button.primary.background"] || sem.brand;
  if (brand) vars["--brand"] = String(brand);
  const brandFg = comp["button.primary.foreground"];
  if (brandFg) vars["--on-brand"] = String(brandFg);
  return vars;
}

function applyThemeTokens(theme) {
  const vars = themeTokenResolve(theme);
  if (!vars) return false;
  const root = document.documentElement;
  Object.keys(vars).forEach(k => root.style.setProperty(k, vars[k]));
  root.dataset.tokens = theme.name || "custom";
  // T06193：主题主色同步到报告生成读取的 wl_brand，保证 UI 与报告表头同源。
  if (theme.resolved && theme.resolved.semantic && theme.resolved.semantic.brand) {
    localStorage.setItem("wl_brand", String(theme.resolved.semantic.brand));
    if (typeof brandPaint === "function") brandPaint();
  }
  if (typeof refreshCharts === "function" && typeof _charts !== "undefined" && Object.keys(_charts || {}).length) {
    try { refreshCharts(); } catch (e) {}
  }
  return true;
}

function themeTokensClear() {
  const root = document.documentElement;
  const names = [];
  for (const n of root.style) {
    if (n.startsWith("--c-") || ["--brand", "--brand-ink", "--brand-soft", "--on-brand", "--bg", "--card", "--ink", "--ink-2", "--muted", "--line", "--ff", "--fs-xs", "--fs-sm", "--fs-md", "--r-md", "--r-lg", "--shadow", "--motion-fast", "--motion-ease"].includes(n)) names.push(n);
  }
  names.forEach(n => root.style.removeProperty(n));
  delete root.dataset.tokens;
  localStorage.removeItem("wl_brand");
  if (typeof brandPaint === "function") brandPaint();
}

async function themeTokensGet() {
  const r = await (await fetch(THEME_TOKEN_API, { cache: "no-store" })).json();
  return r;
}

async function themeTokensApply(theme) {
  const r = await (await fetch(THEME_TOKEN_API + "/apply", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(theme),
  })).json();
  if (!r.ok) throw new Error((r.errors || ["主题校验失败"]).join("；"));
  applyThemeTokens(r.active);
  return r.active;
}

async function themeTokensValidate(theme) {
  const r = await (await fetch(THEME_TOKEN_API + "/validate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(theme),
  })).json();
  return r;
}

async function themeTokensReset() {
  await fetch(THEME_TOKEN_API + "/reset", { method: "POST" });
  themeTokensClear();
}

async function themeTokensExport(name) {
  const url = THEME_TOKEN_API + "/export" + (name ? "?name=" + encodeURIComponent(name) : "");
  const r = await (await fetch(url, { cache: "no-store" })).json();
  if (!r.ok || !r.theme) throw new Error(r.msg || "导出失败");
  const blob = new Blob([JSON.stringify(r.theme, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "theme-" + r.theme.name + ".json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return r.theme;
}

async function themeTokensImportFile(file) {
  const text = await file.text();
  let theme;
  try { theme = JSON.parse(text); } catch (e) { throw new Error("不是合法 JSON 文件"); }
  const v = await themeTokensValidate(theme);
  if (!v.ok) throw new Error((v.errors || ["主题校验失败"]).join("；"));
  return themeTokensApply(theme);
}

function themeTokenPanel() {
  if (document.body.dataset.page !== "config" || document.getElementById("themeTokenCard")) return;
  const title = document.querySelector('[data-i18n="appearance.title"]');
  const card = title && title.closest(".glass.pad");
  if (!card) return;
  const div = document.createElement("div");
  div.className = "glass pad";
  div.id = "themeTokenCard";
  div.style.marginTop = "16px";
  div.innerHTML = '<div class="card-title"><span data-i18n="theme.token.title">主题 Token（raw / semantic / component）</span></div>' +
    '<div class="cfg-row"><span data-i18n="theme.token.builtin">内置品牌主题</span><span style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
    '<select id="themeTokenSel" aria-label="选择主题 Token" data-i18n="aria-label=theme.token.select"></select>' +
    '<button class="btn btn-ghost" id="themeTokenOpenStudio" onclick="themeStudioOpen()" data-i18n="theme.studio.open" title="打开主题工作室">主题工作室</button>' +
    '<button class="btn btn-ghost" id="themeTokenApply" data-i18n="theme.token.apply">应用</button>' +
    '<button class="btn btn-ghost" id="themeTokenExport" data-i18n="theme.token.export">导出 JSON</button>' +
    '<label class="btn btn-ghost" style="margin:0"><span data-i18n="theme.token.import">导入 JSON</span><input type="file" id="themeTokenImport" accept="application/json,.json" hidden></label>' +
    '</span></div><p class="cfg-note" style="margin-top:10px" data-i18n="theme.token.note">主题由三层 Token 描述：raw 原始值 → semantic 语义变量 → component 组件绑定；新增主题只改 JSON，组件代码不动。</p>';
  card.after(div);
  if (typeof applyI18n === "function") applyI18n(div);
  const sel = div.querySelector("#themeTokenSel");
  if (sel) sel.innerHTML = themeTokenOptionsHtml();
  div.querySelector("#themeTokenApply").onclick = async () => {
    try {
      const name = div.querySelector("#themeTokenSel").value;
      const r = await (await fetch(THEME_TOKEN_API + "/export?name=" + encodeURIComponent(name), { cache: "no-store" })).json();
      if (!r.ok) throw new Error(r.msg || "读取主题失败");
      await themeTokensApply(r.theme);
      if (typeof toast === "function") toast("已应用主题：" + (r.theme.label || name));
    } catch (e) { if (typeof toast === "function") toast(String(e.message || e)); }
  };
  div.querySelector("#themeTokenExport").onclick = async () => {
    try { await themeTokensExport(div.querySelector("#themeTokenSel").value); }
    catch (e) { if (typeof toast === "function") toast(String(e.message || e)); }
  };
  div.querySelector("#themeTokenImport").onchange = async (ev) => {
    try { await themeTokensImportFile(ev.target.files[0]); if (typeof toast === "function") toast("主题已导入并生效"); }
    catch (e) { if (typeof toast === "function") toast(String(e.message || e)); }
    ev.target.value = "";
  };
}

async function themeTokensBoot() {
  try {
    const r = await themeTokensGet();
    if (r && r.ok) {
      __themeTokenThemes = r.themes || [];
      themeTokenPanel();
      if (r.themes && r.themes.length) {
        const sel = document.getElementById("themeTokenSel");
        if (sel) sel.innerHTML = themeTokenOptionsHtml();
      }
      if (r.active) applyThemeTokens(r.active);
    }
  } catch (e) { /* 主题服务不可用不阻塞页面 */ }
}
