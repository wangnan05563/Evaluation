/* ===== T06198：项目状态机与签收（REQ-020 / AC-23 / AC-24） =====
   工作组版启用；单机版隐藏入口。状态写入服务端 workflow.db，页面只读状态与审计轨迹。 */
(function(){
  const STATUS_LABEL={draft:"flow.status.draft",review:"flow.status.review",rejected:"flow.status.rejected",signed:"flow.status.signed"};
  const ACTION_LABEL={create:"flow.act.create",new_version:"flow.act.new_version",submit_review:"flow.act.submit",
                      reject:"flow.act.reject",revise:"flow.act.revise",withdraw:"flow.act.withdraw",sign:"flow.act.sign"};
  let projects=[], selected=null, detail=null, mode="standalone";

  function $flow(id){return document.getElementById(id);}
  function esc(v){return String(v==null?"":v).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");}
  function statusText(s){return t(STATUS_LABEL[s]||"flow.status.draft");}
  function statusClass(s){return `wf-badge wf-badge-${esc(s||"draft")}`;}
  function fmtTime(v){
    if(!v)return "—";
    const s=String(v).replace("T"," ");
    return s.length>=16?s.slice(0,16):s;
  }

  async function api(path,payload){
    const resp=await fetch(API+path,{method:payload===undefined?"GET":"POST",
      headers:{"Content-Type":"application/json"},body:payload===undefined?undefined:JSON.stringify(payload)});
    const data=await resp.json().catch(()=>({ok:false,msg:"响应不是合法 JSON"}));
    if(!resp.ok||!data.ok)throw new Error(data.msg||`HTTP ${resp.status}`);
    return data;
  }

  function applyDeploymentMode(next){
    mode=next==="workgroup"?"workgroup":"standalone";
    document.body.dataset.deployMode=mode;
    const nav=$flow("mi-flow");
    if(nav)nav.setAttribute("aria-hidden",mode==="standalone"?"true":"false");
    const modeBadge=$flow("wfModeBadge");
    if(modeBadge)modeBadge.textContent=t(mode==="workgroup"?"flow.mode.workgroup":"flow.mode.standalone");
    ["cfgModeStandalone","cfgModeWorkgroup"].forEach(id=>{
      const b=$flow(id);if(!b)return;
      const on=(id==="cfgModeWorkgroup"&&mode==="workgroup")||(id==="cfgModeStandalone"&&mode==="standalone");
      b.classList.toggle("btn-primary",on);b.classList.toggle("btn-ghost",!on);
      b.setAttribute("aria-pressed",on?"true":"false");
    });
    const cfgBadge=$flow("cfgDeployBadge");
    if(cfgBadge)cfgBadge.textContent=t(mode==="workgroup"?"config.deploy.workgroup":"config.deploy.standalone");
    if(mode==="standalone"&&document.body.dataset.page==="flow"){
      document.body.dataset.page="work";
      document.querySelectorAll(".m-item").forEach(b=>b.classList.toggle("on",b.dataset.page==="work"));
    }
  }

  async function flowInit(force){
    if(mode!=="workgroup"){
      try{
        const cfg=await api("/api/config");
        applyDeploymentMode((cfg.config&&cfg.config.deployment&&cfg.config.deployment.mode)||"standalone");
      }catch(e){/* 保持默认单机版 */}
    }
    if(mode!=="workgroup")return;
    const box=$flow("wfProjects");
    if(box&&!projects.length)box.innerHTML=`<div class="wf-empty">${esc(t("common.loading"))}</div>`;
    try{
      const data=await api("/api/workflow/projects");
      projects=data.projects||[];
      renderSummary(data.counts||{});
      flowRenderList();
      const keep=projects.find(p=>p.project_id===selected)||null;
      if(force&&keep)await flowSelect(keep.project_id,true);
      else if(!detail&&projects.length)await flowSelect(projects[0].project_id,true);
    }catch(e){
      if(box)box.innerHTML=`<div class="wf-empty wf-error">${esc(e.message)}</div>`;
    }
  }

  function renderSummary(counts){
    $flow("wfCountDraft").textContent=counts.draft||0;
    $flow("wfCountReview").textContent=counts.review||0;
    $flow("wfCountRejected").textContent=counts.rejected||0;
    $flow("wfCountSigned").textContent=counts.signed||0;
    $flow("wfProjectCount").textContent=tf("flow.list.count",{n:projects.length});
  }

  function flowRenderList(){
    const box=$flow("wfProjects");if(!box)return;
    const q=($flow("wfSearch")&&$flow("wfSearch").value||"").trim().toLowerCase();
    const rows=projects.filter(p=>!q||String(p.title||"").toLowerCase().includes(q));
    if(!rows.length){
      box.innerHTML=`<div class="wf-empty">${esc(projects.length?t("flow.list.no_match"):t("flow.list.empty"))}</div>`;
      return;
    }
    box.innerHTML=rows.map(p=>`
      <button type="button" class="wf-project${p.project_id===selected?" on":""}" data-pid="${esc(p.project_id)}" onclick="flowSelect('${esc(p.project_id)}')">
        <span class="wf-project-main"><b>${esc(p.title)}</b><small>v${esc(p.version_no)} · ${esc(fmtTime(p.updated_at))}</small></span>
        <span class="${statusClass(p.status)}">${esc(statusText(p.status))}</span>
      </button>`).join("");
    window.lucide&&lucide.createIcons();
  }

  async function flowSelect(pid,silent){
    selected=pid;
    flowRenderList();
    const empty=$flow("wfEmpty"),panel=$flow("wfDetail");
    if(empty)empty.hidden=true;if(panel)panel.hidden=false;
    try{
      const data=await api("/api/workflow/project?project_id="+encodeURIComponent(pid));
      detail=data.project;
      renderDetail(detail);
    }catch(e){
      if(!silent)toast(e.message);
      if(panel)panel.innerHTML=`<div class="wf-empty wf-error">${esc(e.message)}</div>`;
    }
  }

  function renderDetail(d){
    $flow("wfDetailTitle").textContent=d.title||"—";
    const st=$flow("wfDetailStatus");st.className=statusClass(d.status);st.textContent=statusText(d.status);
    $flow("wfDetailMeta").innerHTML=
      `<span>v${esc(d.version_no)}</span><span>${esc(t("flow.detail.history"))} ${esc(d.history_id||"—")}</span>`+
      `<span>${esc(t("flow.detail.updated"))} ${esc(fmtTime(d.updated_at))}</span>`+
      `<span>${esc(t("flow.detail.revision"))} ${esc(d.revision||0)}</span>`;
    $flow("wfHash").textContent=d.version_hash||"—";
    const vers=$flow("wfVersions");
    const list=(d.versions||[]).map(v=>`<span class="wf-ver${v.version_no===d.version_no?" on":""}">v${esc(v.version_no)} · ${esc(fmtTime(v.created_at))}</span>`).join("");
    vers.innerHTML=list||`<span class="wf-ver on">v${esc(d.version_no)}</span>`;
    const signed=$flow("wfSigned");
    if(d.status==="signed"&&d.signed_at){
      signed.hidden=false;
      signed.innerHTML=`<div class="wf-signed-title"><i aria-hidden="true" data-lucide="badge-check"></i><b>${esc(t("flow.signed.title"))}</b></div>
        <div class="wf-signed-grid">
          <span>${esc(t("flow.signed.signer"))}<b>${esc(d.signer||"—")}</b></span>
          <span>${esc(t("flow.signed.time"))}<b>${esc(fmtTime(d.signed_at))}</b></span>
          <span class="wide">${esc(t("flow.signed.opinion"))}<b>${esc(d.sign_opinion||"—")}</b></span>
          <span class="wide">${esc(t("flow.signed.hash"))}<code>${esc(d.version_hash||"—")}</code></span>
        </div>`;
    }else signed.hidden=true;
    renderTimeline(d.events||[]);
    setButtons(d.status);
    const actor=$flow("wfActor"),role=$flow("wfRole");
    if(window.RbacAuth&&RbacAuth.workgroup&&RbacAuth.user){
      // 工作组版操作人/角色以登录会话为准，前端只读展示，服务端仍会覆盖请求值。
      if(actor){actor.value=RbacAuth.user.display_name||RbacAuth.user.username||"";actor.readOnly=true;actor.setAttribute("aria-readonly","true");}
      if(role){role.value=RbacAuth.user.role_label||RbacAuth.user.role||"";role.disabled=true;}
    }else{
      if(actor){actor.readOnly=false;actor.removeAttribute("aria-readonly");if(!actor.value.trim())actor.value=d.submitted_by||t("flow.role.evaluator");}
      if(role){role.disabled=false;if(d.status==="review")role.value="项目经理";}
    }
    window.lucide&&lucide.createIcons();
  }

  function renderTimeline(events){
    const box=$flow("wfTimeline");if(!box)return;
    if(!events.length){box.innerHTML=`<div class="wf-empty">${esc(t("flow.timeline.empty"))}</div>`;return;}
    box.innerHTML=events.slice().reverse().map(e=>`
      <div class="wf-event">
        <div class="wf-event-dot wf-event-${esc(e.to_status||"draft")}"></div>
        <div class="wf-event-body">
          <div class="wf-event-head"><b>${esc(t(ACTION_LABEL[e.action]||"flow.act.change"))}</b>
            <span class="wf-event-status">${esc(statusText(e.from_status))} → ${esc(statusText(e.to_status))}</span>
            <time>${esc(fmtTime(e.at))}</time></div>
          <div class="wf-event-meta">${esc(t("flow.event.actor"))}：${esc(e.actor||"—")} · ${esc(t("flow.event.role"))}：${esc(e.role||"—")} · ${esc(t("flow.event.object"))}：${esc(e.object_ref||"—")}</div>
          ${e.opinion?`<div class="wf-event-opinion">“${esc(e.opinion)}”</div>`:""}
        </div>
      </div>`).join("");
  }

  function setButtons(status){
    const map={draft:["submit"],review:["reject","revise","sign"],rejected:["submit","revise"],signed:[]};
    const ok=map[status]||[];
    const wg=window.RbacAuth&&RbacAuth.workgroup;
    const canWrite=!wg||RbacAuth.can("project.write");
    const canSign=!wg||RbacAuth.can("project.sign");
    const set=(id,key)=>$flow(id).disabled=!ok.includes(key)||!canWrite;
    set("wfSubmitBtn","submit");set("wfRejectBtn","reject");set("wfReviseBtn","revise");
    $flow("wfSignBtn").disabled=!ok.includes("sign")||!canSign;
    const form=$flow("wfForm");if(form)form.classList.toggle("wf-readonly",status==="signed"||!canWrite);
    $flow("wfReportBtn").disabled=!detail||!canSign;
  }

  async function flowAct(action){
    if(!detail)return;
    if(window.RbacAuth&&RbacAuth.workgroup){
      const perm=action==="sign"?"project.sign":"project.write";
      if(!RbacAuth.can(perm)){toast(tl("rbac.denied.project_action","当前角色无权执行该状态操作"));return;}
    }
    const actor=($flow("wfActor").value||"").trim(),role=($flow("wfRole").value||"").trim();
    const opinion=($flow("wfOpinion").value||"").trim();
    if(!actor){toast(t("flow.err.actor"));$flow("wfActor").focus();return;}
    if((action==="reject"||action==="sign")&&!opinion){
      toast(t("flow.err.opinion"));$flow("wfOpinion").focus();return;
    }
    const btns=["wfSubmitBtn","wfRejectBtn","wfReviseBtn","wfSignBtn","wfReportBtn"].map($flow).filter(Boolean);
    btns.forEach(b=>b.disabled=true);
    const msg=$flow("wfMsg");if(msg){msg.className="wf-msg";msg.textContent=t("flow.msg.busy");}
    try{
      const data=await api("/api/workflow/transition",{
        project_id:detail.project_id,action,actor,role,opinion
      });
      detail=data.project;
      renderDetail(detail);
      const p=projects.find(x=>x.project_id===detail.project_id);
      if(p){Object.assign(p,{status:detail.status,updated_at:detail.updated_at,version_no:detail.version_no});}
      renderSummary(projects.reduce((a,p)=>{a[p.status]=(a[p.status]||0)+1;return a;},{}));
      flowRenderList();
      if(msg){msg.className="wf-msg ok";msg.textContent=tf("flow.msg.ok",{action:t(ACTION_LABEL[action]||"flow.act.change")});}
      $flow("wfOpinion").value="";
      toast(msg&&msg.textContent);
    }catch(e){
      if(msg){msg.className="wf-msg err";msg.textContent=e.message;}
      toast(e.message);
      setButtons(detail.status);
    }
  }

  async function flowReport(){
    if(!detail)return;
    if(window.RbacAuth&&RbacAuth.workgroup&&!RbacAuth.can("project.sign")){
      toast(tl("rbac.denied.project_action","当前角色无权生成签收报告"));return;
    }
    const btn=$flow("wfReportBtn");if(btn)btn.disabled=true;
    const msg=$flow("wfMsg");if(msg){msg.className="wf-msg";msg.textContent=t("flow.msg.report_busy");}
    try{
      const res=await api("/api/workflow/signoff-package",{project_id:detail.project_id});
      const a=document.createElement("a");
      a.href=API+res.download;a.download=res.file||"audit_package.pdf";
      document.body.appendChild(a);a.click();a.remove();
      if(msg){msg.className="wf-msg ok";msg.textContent=tf("flow.msg.report_ok",{pages:String(res.pages||"—")});}
      toast(msg&&msg.textContent);
    }catch(e){
      if(msg){msg.className="wf-msg err";msg.textContent=e.message;}
      toast(e.message);
    }finally{setButtons(detail.status);}
  }

  async function saveDeployMode(next){
    try{
      const data=await api("/api/config",{deployment:{mode:next}});
      applyDeploymentMode((data.config&&data.config.deployment&&data.config.deployment.mode)||next);
      if(window.RbacAuth&&RbacAuth.refresh)RbacAuth.refresh();
      toast(t(mode==="workgroup"?"config.deploy.on":"config.deploy.off"));
      if(mode==="workgroup"&&document.body.dataset.page==="flow")flowInit(true);
    }catch(e){toast(e.message);}
  }

  async function flowBootDeployment(){
    try{
      // T06199：部署模式属于公开认证状态；工作组未登录时不能去读受保护的 /api/config。
      const data=await api("/api/auth/me");
      applyDeploymentMode(data.mode||"standalone");
    }catch(e){
      try{
        const data=await api("/api/config");
        applyDeploymentMode((data.config&&data.config.deployment&&data.config.deployment.mode)||"standalone");
      }catch(e2){applyDeploymentMode("standalone");}
    }
  }

  window.flowInit=flowInit;
  window.flowSelect=flowSelect;
  window.flowRenderList=flowRenderList;
  window.flowAct=flowAct;
  window.flowReport=flowReport;
  window.saveDeployMode=saveDeployMode;
  window.applyDeploymentMode=applyDeploymentMode;
  document.addEventListener("we:auth",e=>{
    if(e.detail&&e.detail.mode)applyDeploymentMode(e.detail.mode);
  });
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",flowBootDeployment,{once:true});
  else flowBootDeployment();
})();
