/* T06192 / REQ-014 / AC-14：PERT 结果的蒙特卡洛概率预测。
   固定种子可复现；只读三点估算，不写历史数据。 */
function mcEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function mcEnsureUI() {
  if (document.getElementById("mcCard")) return document.getElementById("mcCard");
  const host = document.querySelector("#pv-gen .glass.pad") || document.querySelector("#pv-gen");
  if (!host) return null;
  const card = document.createElement("div");
  card.id = "mcCard";
  card.style.marginTop = "16px";
  card.innerHTML =
    '<div class="card-title"><span>蒙特卡洛概率预测</span></div>' +
    '<p class="cfg-note" style="margin-top:4px">按 Beta-PERT 分布模拟总工期，输出 P50/P80/P95、达标概率与敏感性 Top5；<b>固定种子可复现</b>，不修改历史估算。</p>' +
    '<div class="cfg-grid" style="grid-template-columns:repeat(3,minmax(150px,1fr));margin-top:10px">' +
    '<div class="cfg-row"><span>模拟次数</span><input id="mcSims" type="number" min="1000" max="50000" step="1000" value="10000" style="width:110px"></div>' +
    '<div class="cfg-row"><span>随机种子</span><input id="mcSeed" type="number" step="1" value="20261122" style="width:130px"></div>' +
    '<div class="cfg-row"><span>目标人天</span><input id="mcTarget" type="number" min="0" step="1" placeholder="可选，例如 2600" style="width:130px"></div>' +
    '</div>' +
    '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px">' +
    '<button class="btn btn-primary" id="mcRunBtn">运行模拟</button>' +
    '<span id="mcMsg" class="cfg-note" style="margin:0">默认 10,000 次；200 任务应在 2 秒内完成。</span></div>' +
    '<div id="mcOut" style="margin-top:12px"></div>';
  host.appendChild(card);
  card.querySelector("#mcRunBtn").onclick = mcRun;
  return card;
}

async function monteCarloRender() {
  const card = mcEnsureUI();
  if (!card || typeof pertPid === "undefined" || !pertPid) return;
  try {
    const r = await pertPost("/api/pert/list", { project_id: pertPid });
    if (!r || !r.ok) return;
    const target = card.querySelector("#mcTarget");
    if (!target.value && r.summary && r.summary.total_days) target.value = Math.ceil(r.summary.total_days);
    card.querySelector("#mcMsg").textContent = "当前项目：" + r.project.name + "；" + r.items.length + " 个估算条目";
  } catch (e) { /* 蒙特卡洛区不可用不阻塞 PERT 主流程 */ }
}

function mcNum(v, digits) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  return Number(v).toFixed(digits == null ? 1 : digits);
}

function mcRun() {
  const card = mcEnsureUI();
  if (!card) return;
  return (async () => {
    if (typeof pertPid === "undefined" || !pertPid) { if (typeof toast === "function") toast("请先选择 PERT 项目"); return; }
    const out = card.querySelector("#mcOut");
    const msg = card.querySelector("#mcMsg");
    out.innerHTML = '<div class="cfg-note">正在模拟…</div>';
    const body = {
      project_id: pertPid,
      simulations: Number(card.querySelector("#mcSims").value) || 10000,
      seed: Number(card.querySelector("#mcSeed").value) || 20261122,
      target_days: card.querySelector("#mcTarget").value === "" ? null : Number(card.querySelector("#mcTarget").value),
    };
    const r = await pertPost("/api/pert/montecarlo", body);
    if (!r.ok) {
      out.innerHTML = '<div class="cfg-test bad">' + mcEsc(r.msg || "模拟失败") + '</div>';
      return;
    }
    msg.textContent = "固定种子 " + r.seed + "；" + r.tasks + " 任务 / " + r.simulations + " 次模拟，耗时 " + r.duration_ms + "ms";
    let html = '<div class="kpis" style="grid-template-columns:repeat(4,1fr)">' +
      '<div class="kpi"><div class="k-top"><span>P50</span></div><b>' + mcNum(r.p50) + ' 人天</b></div>' +
      '<div class="kpi"><div class="k-top"><span>P80</span></div><b>' + mcNum(r.p80) + ' 人天</b></div>' +
      '<div class="kpi"><div class="k-top"><span>P95</span></div><b>' + mcNum(r.p95) + ' 人天</b></div>' +
      '<div class="kpi"><div class="k-top"><span>达标概率</span></div><b>' + (r.probability_pct == null ? "—" : mcNum(r.probability_pct) + "%") + '</b></div></div>';
    html += '<div class="cfg-note" style="margin-top:8px">均值 ' + mcNum(r.mean) + ' 人天，标准差 ' + mcNum(r.std_dev, 1) +
      (r.target_days == null ? "；未设置目标人天，达标概率不计算" : "；目标 " + mcNum(r.target_days, 0) + " 人天") + '</div>';
    if (r.sensitivity && r.sensitivity.length) {
      html += '<div class="card-title" style="margin-top:14px"><span>敏感性 Top5（方差贡献）</span></div>' +
        '<div style="overflow:auto;margin-top:8px"><table style="width:100%;border-collapse:collapse;font-size:12px">' +
        '<thead><tr><th style="text-align:left;padding:6px;border-bottom:1px solid var(--line)">任务</th>' +
        '<th style="text-align:right;padding:6px;border-bottom:1px solid var(--line)">期望人天</th>' +
        '<th style="text-align:right;padding:6px;border-bottom:1px solid var(--line)">方差贡献</th>' +
        '<th style="text-align:right;padding:6px;border-bottom:1px solid var(--line)">占比</th></tr></thead><tbody>' +
        r.sensitivity.map(s => '<tr><td style="padding:6px;border-bottom:1px solid var(--line)">' + mcEsc(s.label) + '</td>' +
          '<td style="padding:6px;text-align:right;border-bottom:1px solid var(--line)">' + mcNum(s.expected_days) + '</td>' +
          '<td style="padding:6px;text-align:right;border-bottom:1px solid var(--line)">' + mcNum(s.variance_days) + '</td>' +
          '<td style="padding:6px;text-align:right;border-bottom:1px solid var(--line)">' + mcNum(s.share_pct) + '%</td></tr>').join("") +
        '</tbody></table></div>';
    }
    if (r.scenarios && r.scenarios.length) {
      html += '<div class="card-title" style="margin-top:14px"><span>情景对比（比例系数）</span></div>' +
        '<div style="overflow:auto;margin-top:8px"><table style="width:100%;border-collapse:collapse;font-size:12px">' +
        '<thead><tr><th style="text-align:left;padding:6px;border-bottom:1px solid var(--line)">情景</th>' +
        '<th style="text-align:right;padding:6px;border-bottom:1px solid var(--line)">系数</th>' +
        '<th style="text-align:right;padding:6px;border-bottom:1px solid var(--line)">P50</th>' +
        '<th style="text-align:right;padding:6px;border-bottom:1px solid var(--line)">P80</th>' +
        '<th style="text-align:right;padding:6px;border-bottom:1px solid var(--line)">P95</th>' +
        '<th style="text-align:right;padding:6px;border-bottom:1px solid var(--line)">达标概率</th></tr></thead><tbody>' +
        r.scenarios.map(s => '<tr><td style="padding:6px;border-bottom:1px solid var(--line)">' + mcEsc(s.name) + '</td>' +
          '<td style="padding:6px;text-align:right;border-bottom:1px solid var(--line)">×' + mcNum(s.factor, 2) + '</td>' +
          '<td style="padding:6px;text-align:right;border-bottom:1px solid var(--line)">' + mcNum(s.p50) + '</td>' +
          '<td style="padding:6px;text-align:right;border-bottom:1px solid var(--line)">' + mcNum(s.p80) + '</td>' +
          '<td style="padding:6px;text-align:right;border-bottom:1px solid var(--line)">' + mcNum(s.p95) + '</td>' +
          '<td style="padding:6px;text-align:right;border-bottom:1px solid var(--line)">' + (s.probability_pct == null ? "—" : mcNum(s.probability_pct) + "%") + '</td></tr>').join("") +
        '</tbody></table></div>';
    }
    out.innerHTML = html;
  })();
}

(function () {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => {
    if (document.body.dataset.page === "pert") monteCarloRender();
  }, { once: true });
  else if (document.body.dataset.page === "pert") monteCarloRender();
})();
