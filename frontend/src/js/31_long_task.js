/* ===== T06180：文档识别长任务（进度/剩余时间/取消/断点续跑） ===== */
(function(){
  const LS_KEY="wl_ltask_recog_v1";
  let cur=null;          // {id,title,status,timer,promise}
  const panel=()=>$("#ltaskPanel");
  const banner=()=>$("#ltaskResumeBanner");
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));

  function fmtEta(sec){
    if(sec==null)return "预计剩余计算中…";
    if(sec<=0)return "即将完成";
    if(sec<60)return "预计剩余约 "+Math.max(1,Math.round(sec))+" 秒";
    const m=Math.floor(sec/60),s=Math.round(sec%60);
    return "预计剩余约 "+m+" 分"+(s?(" "+s+" 秒"):"");
  }
  function paint(job,title){
    const box=panel();if(!box)return;
    box.hidden=false;
    const pct=Math.max(0,Math.min(100,+job.pct||0));
    box.classList.toggle("canceled",job.status==="canceled");
    box.classList.toggle("failed",job.status==="failed");
    $("#ltaskTitle").textContent=title||"识别需求文档";
    $("#ltaskPct").textContent=pct+"%";
    $("#ltaskFill").style.width=pct+"%";
    const track=$("#ltaskTrack");
    track.setAttribute("aria-valuenow",String(pct));
    $("#ltaskStage").textContent=job.status==="done"?"识别完成":(job.error?("识别失败："+job.error):(job.stage||"识别中…"));
    $("#ltaskEta").textContent=job.status==="done"?"已完成":(job.status==="canceled"?"已取消":fmtEta(job.eta_s));
    const cancel=$("#ltaskCancel");
    cancel.hidden=job.status!=="running";
    box.dataset.job=job.id||"";
    box.dataset.status=job.status||"";
  }
  function hidePanel(){
    const box=panel();if(box){box.hidden=true;box.classList.remove("canceled","failed");}
  }
  function saveMeta(meta){try{localStorage.setItem(LS_KEY,JSON.stringify(meta));}catch(e){}}
  function readMeta(){try{return JSON.parse(localStorage.getItem(LS_KEY)||"null");}catch(e){return null;}}
  function clearMeta(){try{localStorage.removeItem(LS_KEY);}catch(e){}}
  function showResume(job,title){
    const box=banner();if(!box)return;
    if(!job||job.status==="done"){box.hidden=true;return;}
    box.hidden=false;
    const pct=Math.max(0,Math.min(100,+job.pct||0));
    $("#ltaskResumeStage").textContent="上次停在「"+(job.stage||"准备识别")+"」，已完成 "+pct+"%。";
    box.dataset.job=job.id||"";
    box.dataset.title=title||"识别需求文档";
  }
  function hideResume(){const box=banner();if(box)box.hidden=true;}

  async function getJob(id){
    const r=await fetch(API+"/api/recognize/job?job="+encodeURIComponent(id),{cache:"no-store"});
    const j=await r.json();
    if(!j.ok)throw new Error(j.msg||"任务状态不可用");
    return j.job;
  }

  function finishTask(task){
    task.status="done";
    if(task.timer){clearTimeout(task.timer);task.timer=null;}
    hidePanel();
  }
  function cancelTask(task,status,msg){
    task.status=status;
    if(task.timer){clearTimeout(task.timer);task.timer=null;}
    if(task.reject)task.reject(Object.assign(new Error(msg||"已取消"),{code:status}));
  }

  async function waitJob(task){
    if(task.promise)return task.promise;
    task.promise=new Promise((resolve,reject)=>{
      task.resolve=resolve;task.reject=reject;
      const tick=async()=>{
        if(task.status!=="running")return;
        try{
          const job=await getJob(task.id);
          if(task.status!=="running")return;
          paint(job,task.title);
          if(job.status==="done"){
            finishTask(task);clearMeta();hideResume();
            resolve(job.result);
            return;
          }
          if(job.status==="failed"){
            task.status="failed";clearMeta();
            showResume(job,task.title);
            reject(new Error(job.error||"识别失败"));
            return;
          }
          if(job.status==="canceled"){
            task.status="canceled";saveMeta({id:task.id,title:task.title,stage:job.stage,pct:job.pct});
            showResume(job,task.title);
            reject(Object.assign(new Error("已取消"),{code:"canceled"}));
            return;
          }
        }catch(e){
          if(task.status==="running"){task.lastError=e;/* 瞬时网络错误继续轮询，避免误判失败 */}
        }
        if(task.status==="running")task.timer=setTimeout(tick,400);
      };
      tick();
    });
    return task.promise;
  }

  async function createAndRun(file,params,title){
    hideResume();
    const id="r"+Date.now().toString(36)+Math.random().toString(36).slice(2,7);
    const task={id,title:title||file.name||"识别需求文档",status:"running",timer:null,promise:null};
    cur=task;
    paint({id,status:"running",pct:2,stage:"正在读取文档…",eta_s:null},task.title);
    let b64;
    try{b64=await toB64(file);}catch(e){hidePanel();cur=null;throw e;}
    if(task.status!=="running")throw Object.assign(new Error("已取消"),{code:"canceled"});
    const resp=await fetch(API+"/api/recognize/jobs",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({job:id,name:file.name,b64,params,stage_delay_ms:window.WL_LTASK_TEST_DELAY_MS||0})});
    const res=await resp.json();
    if(!res.ok)throw new Error(res.msg||"任务创建失败");
    if(task.status!=="running"){        // 取消发生在创建请求在途：补发取消并退出
      fetch(API+"/api/recognize/cancel",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({job:id})}).catch(()=>{});
      throw Object.assign(new Error("已取消"),{code:"canceled"});
    }
    saveMeta({id,title:task.title,stage:"准备识别",pct:2});
    paint(res.job,task.title);
    return waitJob(task);
  }

  async function cancelCurrent(){
    const task=cur;if(!task||task.status!=="running")return;
    const box=panel();
    const t0=performance.now();
    task.status="canceled";          // UI 先停：不等待网络，保证 2 秒内可见
    if(box){
      paint({id:task.id,status:"canceled",pct:+($("#ltaskPct").textContent.replace("%",""))||0,stage:"已取消",eta_s:0},task.title);
      box.dataset.cancelMs=String(Math.round(performance.now()-t0));
    }
    if(task.timer){clearTimeout(task.timer);task.timer=null;}
    if(task.reject)task.reject(Object.assign(new Error("已取消"),{code:"canceled"}));
    saveMeta({id:task.id,title:task.title,stage:"已取消",pct:+($("#ltaskPct").textContent.replace("%",""))||0});
    showResume({id:task.id,status:"canceled",stage:"已取消",pct:+($("#ltaskPct").textContent.replace("%",""))||0},task.title);
    try{
      const r=await fetch(API+"/api/recognize/cancel",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({job:task.id})});
      const j=await r.json();
      if(j.ok&&j.job){paint(j.job,task.title);showResume(j.job,task.title);}
    }catch(e){/* 取消请求失败也不让 UI 恢复运行态，刷新后由服务端状态兜底 */}
  }

  async function resumeJob(id,title){
    hideResume();
    const task={id,title:title||"识别需求文档",status:"running",timer:null,promise:null};
    cur=task;
    paint({id,status:"running",pct:2,stage:"正在续跑…",eta_s:null},task.title);
    const r=await fetch(API+"/api/recognize/resume",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({job:id})});
    const j=await r.json();
    if(!j.ok)throw new Error(j.msg||"续跑失败");
    saveMeta({id,title:task.title,stage:"续跑中",pct:+j.job.pct||0});
    paint(j.job,task.title);
    return waitJob(task);
  }

  async function discard(){
    hideResume();hidePanel();clearMeta();cur=null;
  }

  async function restore(){
    const meta=readMeta();if(!meta||!meta.id)return;
    try{
      const job=await getJob(meta.id);
      if(job.status==="done"){
        clearMeta();hidePanel();hideResume();
        if(typeof window.LTASK_ON_RECOGNIZED==="function")window.LTASK_ON_RECOGNIZED(job.result,{restored:true});
        return;
      }
      if(job.status==="running"){
        const task={id:meta.id,title:meta.title||"识别需求文档",status:"running",timer:null,promise:null};
        cur=task;paint(job,task.title);
        waitJob(task).then(res=>{if(typeof window.LTASK_ON_RECOGNIZED==="function")window.LTASK_ON_RECOGNIZED(res,{restored:true});})
          .catch(()=>{});
        return;
      }
      showResume(job,meta.title);
    }catch(e){
      // 任务记录只在进程内保留：服务重启后 404，清掉本地断点避免永远挂横幅
      if(/不存在|不可用/.test(e.message)){clearMeta();hideResume();}
    }
  }

  $("#ltaskCancel")&&$("#ltaskCancel").addEventListener("click",cancelCurrent);
  $("#ltaskResumeBtn")&&$("#ltaskResumeBtn").addEventListener("click",async()=>{
    const box=banner();const id=box&&box.dataset.job;if(!id)return;
    const title=box.dataset.title||"识别需求文档";
    try{
      const res=await resumeJob(id,title);
      if(typeof window.LTASK_ON_RECOGNIZED==="function")window.LTASK_ON_RECOGNIZED(res,{restored:true});
    }catch(e){
      if(e.code!=="canceled")toast(e.message);
    }
  });
  $("#ltaskDiscardBtn")&&$("#ltaskDiscardBtn").addEventListener("click",discard);
  setTimeout(restore,450);

  window.LTASK={createAndRun,cancelCurrent,resumeJob,restore,discard,getJob,showResume,hideResume,
    get current(){return cur;},state:()=>cur?{...cur, timer:undefined}:null};
})();
