/* ===== T06181：结果页导出「七部分审计包」 =====
   生成在服务端本地完成（HTML → Chromium 两遍渲染 → PDF + PyMuPDF 内部链接），
   前端只负责组织当前结果快照、显示生成中状态并触发下载。 */
(function(){
  function ymdLocal(){
    const d=new Date();
    const p=n=>String(n).padStart(2,"0");
    return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}`;
  }

  function buildPayload(){
    const timing=$("#timingSel");
    const method=$("#methodSel");
    const rm=window.lastRecogMeta||null;
    const lm=(rm&&rm.llm)||{}, ev=(rm&&rm.evidence)||{};
    const aiItems=(items||[]).map((it,i)=>{
      const ai=it.ai||{};
      let conf=it.confidence;
      let confText="—";
      if(conf!=null&&conf!==""){const n=Number(conf);if(Number.isFinite(n))confText=Math.round((n>1?n/100:n)*100)+"%";}
      return {stable_id:it.stable_id||`FP-${String(i+1).padStart(3,"0")}`,
        model:ai.model||lm.model||"本地规则",
        prompt_version:ai.prompt_version||lm.prompt_version||"rules-evidence-v1",
        created_at:ai.created_at||lm.created_at||ev.created_at||"—",
        confidence:confText,
        decision:it.human_decision||(it.ok?"confirmed":"pending"),
        decision_at:it.decision_at||"—"};
    });
    return {
      project:{
        name:(typeof baseName==="function"?baseName():gSid||"工作量评估").replace(/\.xlsx$/i,""),
        client:"内部",
        version:`0.1.${ymdLocal()}-audit`,
        classification:"内部",
        owner:"评估师",
        reviewer:"审核人",
        date:new Date().toLocaleDateString("zh-CN"),
        source:gSid?`结果页正式结果 · ${gSid}`:"当前确认功能点快照"
      },
      method:(method&&method.value)||"估算功能点",
      timing:(timing&&timing.value)||"估算中期",
      cx_mode:(typeof cxMode!=="undefined"?cxMode:"企业母版"),
      items:(items||[]).map((it,i)=>({
        seq:it.seq||i+1, system:it.system||"", m1:it.m1||"", desc:it.desc||it.count_item||"",
        count_item:it.count_item||"", type:it.type, reuse:it.reuse||"中", modify:it.modify||"新增",
        stable_id:it.stable_id||`FP-${String(i+1).padStart(3,"0")}`,
        det:it.det, ret:it.ret, ftr:it.ftr, cx:it.cx, basis:it.basis, req:it.req, ac:it.ac,
        origin:it.origin, confidence:it.confidence, evidence:it.evidence,
        can_confirm:it.can_confirm, ai:it.ai, human_decision:it.human_decision, decision_at:it.decision_at
      })),
      changes:[{type:"首版",detail:"由结果页当前确认清单生成七部分审计包",before:"—",after:"首版"}],
      ai:{enabled:!!lm.enabled, model:lm.model||"本地规则",
          prompt_version:lm.prompt_version||"rules-evidence-v1",
          created_at:lm.created_at||ev.created_at||new Date().toISOString(),
          rules_version:(rm&&rm.rules&&rm.rules.rules_version)||"rules-v1",
          evidence:ev,
          adjustments:"无（结果页数值未经二次人工调整）",
          items:aiItems},
      signoff:{roles:[
        {role:"项目经理",name:"—",status:"待签收",time:"—"},
        {role:"产品经理",name:"—",status:"待签收",time:"—"},
        {role:"财务审核",name:"—",status:"待签收",time:"—"}
      ],opinions:["请核对估算明细与追溯矩阵后签收。"]}
    };
  }

  async function auditPackage(){
    if(!items||!items.length){toast(t("result.export.audit_no_items"));return;}
    if(!gSummary){toast(t("result.export.no_summary"));return;}
    const btn=$("#auditBtn");
    const label=btn&&btn.querySelector("span");
    const old=label?label.textContent:"";
    if(btn)btn.disabled=true;
    if(label)label.textContent=t("result.export.audit_busy");
    const started=performance.now();
    try{
      const resp=await fetch(API+"/api/audit/package",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify(buildPayload())});
      const res=await resp.json().catch(()=>({ok:false,msg:"响应不是合法 JSON"}));
      if(!resp.ok||!res.ok){
        const detail=res.msg||(res.result&&res.result.error)||`HTTP ${resp.status}`;
        throw new Error(detail);
      }
      const seconds=((res.elapsed_ms||(performance.now()-started))/1000).toFixed(1);
      const done=t("result.export.audit_done").replace("{pages}",String(res.pages||"—")).replace("{seconds}",seconds);
      const a=document.createElement("a");
      a.href=API+res.download;
      a.download=res.file||"audit_package.pdf";
      document.body.appendChild(a);a.click();a.remove();
      toast(done);
      const menu=$("#expMenu");if(menu)menu.style.display="none";
    }catch(err){
      toast(t("result.export.audit_fail").replace("{msg}",err.message||String(err)));
    }finally{
      if(btn)btn.disabled=false;
      if(label)label.textContent=old||t("result.export.audit");
    }
  }

  window.AUDIT={buildPayload,generate:auditPackage};
  window.auditPackage=auditPackage;
})();
