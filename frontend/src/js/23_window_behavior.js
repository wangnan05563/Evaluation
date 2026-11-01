/* 窗口关闭行为（T03779）：最小化到托盘 / 直接关闭 + 记住选择。
 * 配置由 Electron 主进程持有（userData/window-prefs.json），经 preload 的
 * window.weval.windowBehavior 读写；纯浏览器环境没有该 bridge，卡片保持隐藏。 */
function windowBehaviorBridge(){
  return window.weval && window.weval.windowBehavior ? window.weval.windowBehavior : null;
}
function renderWindowBehavior(prefs){
  const action=(prefs&&prefs.close_action)||"minimize_to_tray";
  document.querySelectorAll('input[name="closeAction"]').forEach(r=>{r.checked=r.value===action;});
  const sw=document.querySelector("#rememberChoiceSwitch");
  if(sw){
    const on=!!(prefs&&prefs.remember_choice);
    sw.classList.toggle("on",on);
    sw.setAttribute("aria-checked",on?"true":"false");
  }
}
async function initWindowBehavior(){
  const card=document.querySelector("#windowBehaviorCard");
  if(!card)return;
  const bridge=windowBehaviorBridge();
  if(!bridge){card.style.display="none";return;}
  card.style.display="block";
  try{
    renderWindowBehavior(await bridge.get());
  }catch(e){
    toast(tf("config.window.load_failed",{msg:e&&e.message?e.message:String(e)}));
  }
}
async function saveWindowBehavior(patch){
  const bridge=windowBehaviorBridge();
  if(!bridge)return;
  try{
    renderWindowBehavior(await bridge.set(patch));
    toast(t("config.window.saved"));
  }catch(e){
    toast(tf("config.window.save_failed",{msg:e&&e.message?e.message:String(e)}));
    try{renderWindowBehavior(await bridge.get());}catch(_){/* 回读失败保持当前显示 */}
  }
}
(function(){
  const card=document.querySelector("#windowBehaviorCard");
  if(!card)return;
  card.addEventListener("change",e=>{
    if(e.target&&e.target.name==="closeAction")saveWindowBehavior({close_action:e.target.value});
  });
  const sw=document.querySelector("#rememberChoiceSwitch");
  if(sw){
    // 全局 .switch 监听已先切换 on/aria，这里只负责状态变化后持久化
    const persist=()=>saveWindowBehavior({remember_choice:sw.classList.contains("on")});
    sw.addEventListener("click",persist);
    sw.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" ")persist();});
  }
  window.addEventListener("DOMContentLoaded",()=>{initWindowBehavior();});
})();
