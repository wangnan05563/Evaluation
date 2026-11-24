/* T06196 / REQ-019 / AC-20：离线 AI 质量评测与提交前自检 UI。 */
(function(){
  const TYPES=["ILF","EIF","EI","EO","EQ"];
  let lastRun=null, lastPrecheck=null, loading=false;

  const pct=v=>`${(Number(v||0)*100).toFixed(1)}%`;
  const num=v=>Number(v||0).toLocaleString();

  function badge(kind,key){
    const el=document.querySelector("#evalBadge");
    if(!el)return;
    el.className="eval-badge "+kind;
    el.textContent=t(key);
  }

  function saveSummary(run){
    lastRun=run;
    window.lastEvalRun=run;
    try{
      localStorage.setItem("wl_eval_latest",JSON.stringify({
        run_id:run.run_id,created_at:run.created_at,
        dataset:{samples:(run.dataset||{}).samples,groups:(run.dataset||{}).groups,version:(run.dataset||{}).version},
        metrics:run.metrics,gate:run.gate,
        counts:run.counts,self_check:run.self_check
      }));
    }catch(e){}
  }

  function renderDataset(ds){
    if(!ds)return;
    const el=$("#evalSampleBig"); if(el)el.textContent=ds.samples??"—";
    const g=$("#evalGroups"); if(g)g.textContent=tf("config.eval.group_count",{n:ds.groups??0});
    const meta=$("#evalDatasetMeta");
    if(meta){
      meta.textContent=tf("config.eval.dataset_meta",{version:ds.version||"—",hash:ds.sha256||"—"});
    }
  }

  function renderSelf(sc,counts){
    const el=$("#evalSelf"); if(!el)return;
    const items=[
      ["config.eval.self.duplicate",sc.duplicate_count||0,"dup"],
      ["config.eval.self.missing",(sc.missing||[]).length,"miss"],
      ["config.eval.self.extra",(sc.extra||[]).length,"extra"],
      ["config.eval.self.wrong",(sc.wrong_types||[]).length,"wrong"],
      ["config.eval.self.invalid",(sc.invalid||[]).length,"invalid"],
      ["config.eval.self.evidence",(sc.evidence&&sc.evidence.missing||[]).length,"ev"]
    ];
    let html=items.map(([k,n])=>`<span class="eval-chip ${n?"warn":"ok"}"><b>${num(n)}</b> ${t(k)}</span>`).join("");
    const wrong=(sc.wrong_types||[]).slice(0,6);
    if(wrong.length){
      html+=`<div class="eval-wrong"><b>${t("config.eval.self.wrong_list")}</b>`+
        wrong.map(w=>`<span>${escAttr(w.name)} <em>${escAttr(w.gold)}→${escAttr(w.predicted)}</em></span>`).join("")+
        `</div>`;
    }
    el.innerHTML=html;
  }

  function renderMatrix(run){
    const box=$("#evalMatrixWrap"); if(!box)return;
    const m=(run.confusion&&run.confusion.matrix)||{};
    let h=`<table class="eval-matrix" aria-label="${escAttr(t("config.eval.matrix.aria"))}"><tr><th>${escAttr(t("config.eval.matrix.diag"))}</th>`+
      TYPES.map(x=>`<th>${x}</th>`).join("")+`</tr>`;
    TYPES.forEach(g=>{
      h+=`<tr><th>${g}</th>`;
      TYPES.forEach(p=>{
        const n=Number((m[g]||{})[p]||0);
        const cls=n===0?"zero":(g===p?"diag":"off");
        h+=`<td class="${cls}">${n||"—"}</td>`;
      });
      h+=`</tr>`;
    });
    h+=`</table>`;
    box.innerHTML=h;
    box.hidden=false;
    const note=$("#evalMatrixNote");
    if(note)note.textContent=t("config.eval.matrix.note");
  }

  function render(run){
    if(!run)return;
    saveSummary(run);
    const m=run.metrics||{},g=run.gate||{};
    badge(g.passed?"pass":"fail",g.passed?"config.eval.pass":"config.eval.fail");
    renderDataset(run.dataset||{});
    $("#evalPrecision").textContent=pct(m.precision);
    $("#evalRecall").textContent=pct(m.recall);
    $("#evalF1").textContent=pct(m.f1);
    $("#evalSampleBig").textContent=num((run.dataset||{}).samples||0);
    $("#evalRunMeta").textContent=tf("config.eval.run_meta",{id:run.run_id||"—",ms:run.duration_ms||0});
    $("#evalThreshold").textContent=tf("config.eval.threshold",{v:pct(m.threshold||0.85)});
    renderSelf(run.self_check||{},run.counts||{});
    renderMatrix(run);
    const runHint=$("#evalRunHint");
    if(runHint)runHint.textContent=g.passed?t("config.eval.hint_pass"):t("config.eval.hint_fail");
  }

  function renderPrecheck(p){
    const el=$("#evalPrecheck"); if(!el)return;
    if(!p||!p.precheck){el.innerHTML=`<span class="eval-muted">${t("config.eval.precheck.none")}</span>`;return;}
    lastPrecheck=p;window.lastEvalPrecheck=p;
    const q=p.precheck;
    const state=q.ok?"ok":"warn";
    const miss=Array.isArray(q.missing)?q.missing.length:(q.missing_count??q.missing??0);
    const invalid=Array.isArray(q.invalid)?q.invalid.length:(q.invalid_count??q.invalid??0);
    const ev=Array.isArray(q.evidence_missing)?q.evidence_missing.length:(q.evidence_missing_count??q.evidence_missing??0);
    const parts=[
      `${t("config.eval.self.duplicate")} ${num(q.duplicate_count||0)}`,
      `${t("config.eval.self.missing")} ${num(miss)}`,
      `${t("config.eval.self.invalid")} ${num(invalid)}`,
      `${t("config.eval.self.evidence")} ${num(ev)}`
    ].join(" · ");
    el.innerHTML=`<span class="eval-precheck ${state}"><b>${t(q.ok?"config.eval.precheck.ok":"config.eval.precheck.warn")}</b>`+
      `<span>${parts}</span><small>${escAttr(p.run_id||"")}</small></span>`;
  }

  async function loadLatest(){
    try{
      const r=await fetch(API+"/api/eval/latest",{cache:"no-store"});
      const j=await r.json();
      if(!j.ok)throw new Error(j.msg||"latest failed");
      renderDataset(j.dataset||{});
      if(j.latest){render(j.latest);}else{
        badge("idle","config.eval.not_run");
        $("#evalRunMeta").textContent="";
        const hint=$("#evalRunHint");if(hint)hint.textContent=t("config.eval.hint_empty");
      }
      renderPrecheck(j.precheck||null);
    }catch(e){
      badge("idle","config.eval.not_run");
      const hint=$("#evalRunHint");if(hint)hint.textContent=t("config.eval.load_fail");
    }
  }

  async function runEval(){
    if(loading)return;
    loading=true;
    const btn=$("#evalRunBtn");
    if(btn){btn.disabled=true;btn.dataset.old=btn.innerHTML;btn.innerHTML=`<span class="eval-spin" aria-hidden="true"></span>${t("config.eval.running")}`;}
    badge("idle","config.eval.running");
    const hint=$("#evalRunHint");if(hint)hint.textContent=t("config.eval.running_hint");
    try{
      const r=await fetch(API+"/api/eval/run",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
      const j=await r.json();
      if(!j.ok)throw new Error(j.msg||t("config.eval.run_fail"));
      render(j);
      toast(tf(j.gate&&j.gate.passed?"config.eval.run_ok":"config.eval.run_fail",{p:pct((j.metrics||{}).precision),r:pct((j.metrics||{}).recall)}));
    }catch(e){
      badge("fail","config.eval.fail");
      if(hint)hint.textContent=t("config.eval.run_fail");
      toast(e.message||t("config.eval.run_fail"));
    }finally{
      loading=false;
      if(btn){btn.disabled=false;if(btn.dataset.old)btn.innerHTML=btn.dataset.old;delete btn.dataset.old;}
    }
  }

  async function qualityPrecheck(items,extra){
    try{
      const r=await fetch(API+"/api/eval/precheck",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({items:items||[],stage:"generate",...(extra||{})})});
      const j=await r.json();
      if(j.ok){renderPrecheck(j);return j;}
    }catch(e){}
    return null;
  }

  function init(){
    const page=document.querySelector("#pg-config");
    if(!page)return;
    loadLatest();
  }

  window.evalInit=init;
  window.evalRun=runEval;
  window.evalRender=render;
  window.evalRenderDataset=renderDataset;
  window.evalRenderPrecheck=renderPrecheck;
  window.qualityPrecheck=qualityPrecheck;
})();
