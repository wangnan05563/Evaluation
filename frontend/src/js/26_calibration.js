/* T06191 / REQ-013 / AC-15：实际人天录入 + MAPE/偏差校准建议。
   只写 projects.actual_days/actual_note；pert_items 的历史三点估算只读，
   校准建议也不自动回写任何估算值。 */
function calibrationEsc(s) {
  return String(s == null ? "" : s).replaceAll(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function calibrationEnsureUI() {
  if (document.getElementById("calibCard")) return document.getElementById("calibCard");
  const host = document.querySelector("#pv-gen .glass.pad") || document.querySelector("#pv-gen");
  if (!host) return null;
  const card = document.createElement("div");
  card.id = "calibCard";
  card.style.marginTop = "16px";
  card.innerHTML =
    '<div class="card-title"><span>实际值校准（MAPE）</span></div>' +
    '<p class="cfg-note" style="margin-top:4px">结项后录入实际人天；系统只计算偏差与建议系数，<b>不会自动修改历史估算</b>。至少 5 个样本才生成建议。</p>' +
    '<div class="cfg-grid" style="grid-template-columns:1fr 1fr;margin-top:10px">' +
    '<div class="cfg-row"><span>当前项目实际人天</span><input id="calibActual" type="number" min="0" step="0.1" placeholder="例如 120.5" style="width:140px"></div>' +
    '<div class="cfg-row"><span>偏差原因</span><input id="calibNote" type="text" maxlength="500" placeholder="例如：需求变更 2 次" style="flex:1;min-width:180px"></div>' +
    '</div>' +
    '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px">' +
    '<button class="btn btn-primary" id="calibSaveBtn">保存实际值</button>' +
    '<button class="btn btn-ghost" id="calibRunBtn">生成校准建议</button>' +
    '<span id="calibMsg" class="cfg-note" style="margin:0"></span></div>' +
    '<div id="calibOut" style="margin-top:12px"></div>';
  host.appendChild(card);
  card.querySelector("#calibSaveBtn").onclick = calibrationSaveActual;
  card.querySelector("#calibRunBtn").onclick = calibrationRun;
  return card;
}

async function calibrationRender() {
  const card = calibrationEnsureUI();
  if (!card || typeof pertPid === "undefined" || !pertPid) return;
  try {
    const r = await pertPost("/api/pert/list", { project_id: pertPid });
    if (!r || !r.ok) return;
    card.querySelector("#calibActual").value = r.project.actual_days == null ? "" : r.project.actual_days;
    card.querySelector("#calibNote").value = r.project.actual_note || "";
    card.querySelector("#calibMsg").textContent = "当前项目：" + r.project.name;
  } catch (e) { /* 校准区不可用不阻塞 PERT 主流程 */ }
}

async function calibrationSaveActual() {
  if (!pertPid) { if (typeof toast === "function") { toast("请先选择 PERT 项目"); } return; }
  const card = calibrationEnsureUI();
  const val = card.querySelector("#calibActual").value;
  const r = await pertPost("/api/pert/actual", {
    project_id: pertPid,
    actual_days: val === "" ? null : Number(val),
    actual_note: card.querySelector("#calibNote").value,
  });
  if (!r.ok) { if (typeof toast === "function") { toast(r.msg || "保存失败"); } return; }
  card.querySelector("#calibMsg").textContent = "已保存：实际 " + (r.actual_days == null ? "未填" : r.actual_days) + " 人天（历史估算未改动）";
  if (typeof toast === "function") toast("实际值已保存");
}

function calibrationRun() {
  const card = calibrationEnsureUI();
  if (!card) return;
  return (async () => {
    const out = card.querySelector("#calibOut");
    out.innerHTML = '<div class="cfg-note">正在计算…</div>';
    const r = await pertPost("/api/pert/calibration", {});
    if (!r.ok) { out.innerHTML = '<div class="cfg-test bad">校准计算失败</div>'; return; }
    const dirText = r.direction === "underestimated" ? "整体低估" : (r.direction === "overestimated" ? "整体高估" : "整体基本准确");
    let html = '<div class="kpis" style="grid-template-columns:repeat(4,1fr)">' +
      '<div class="kpi"><div class="k-top"><span>样本量</span></div><b>' + r.sample_count + '</b></div>' +
      '<div class="kpi"><div class="k-top"><span>MAPE</span></div><b>' + (r.mape == null ? "—" : r.mape + "%") + '</b></div>' +
      '<div class="kpi"><div class="k-top"><span>偏差方向</span></div><b style="font-size:16px">' + dirText + '</b></div>' +
      '<div class="kpi"><div class="k-top"><span>建议系数</span></div><b>' + (r.suggested_factor == null ? "—" : "×" + r.suggested_factor) + '</b></div></div>';
    html += '<div class="cfg-note" style="margin-top:8px">' + calibrationEsc(r.message) + '</div>';
    if (r.projects && r.projects.length) {
      html += '<div style="overflow:auto;margin-top:10px"><table style="width:100%;border-collapse:collapse;font-size:12px">' +
        '<thead><tr><th style="text-align:left;padding:6px;border-bottom:1px solid var(--line)">项目</th>' +
        '<th style="text-align:right;padding:6px;border-bottom:1px solid var(--line)">估算人天</th>' +
        '<th style="text-align:right;padding:6px;border-bottom:1px solid var(--line)">实际人天</th>' +
        '<th style="text-align:right;padding:6px;border-bottom:1px solid var(--line)">偏差</th>' +
        '<th style="text-align:left;padding:6px;border-bottom:1px solid var(--line)">原因</th></tr></thead><tbody>' +
        r.projects.map(p => '<tr><td style="padding:6px;border-bottom:1px solid var(--line)">' + calibrationEsc(p.name) + '</td>' +
          '<td style="padding:6px;text-align:right;border-bottom:1px solid var(--line)">' + p.expected_days + '</td>' +
          '<td style="padding:6px;text-align:right;border-bottom:1px solid var(--line)">' + p.actual_days + '</td>' +
          '<td style="padding:6px;text-align:right;border-bottom:1px solid var(--line);color:' + (p.variance_pct > 0 ? "var(--danger)" : (p.variance_pct < 0 ? "var(--ok)" : "var(--muted)")) + '">' +
          (p.variance_pct > 0 ? "+" : "") + p.variance_pct + '%</td>' +
          '<td style="padding:6px;border-bottom:1px solid var(--line)">' + calibrationEsc(p.note || "—") + '</td></tr>').join("") +
        '</tbody></table></div>';
    }
    out.innerHTML = html;
  })();
}

(function () {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => {
    if (document.body.dataset.page === "pert") calibrationRender();
  }, { once: true });
  else if (document.body.dataset.page === "pert") calibrationRender();
})();
