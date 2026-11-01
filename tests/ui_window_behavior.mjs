/** T03779 配置中心「窗口行为」UI 验证（无头 Chrome + CDP）。
 *  独立运行：node tests/ui_window_behavior.mjs
 *  前置：scripts/server.py 运行在 8032（--serve-frontend）、Chrome 调试端口 9334。
 *  覆盖：桌面壳 bridge 存在时卡片显示与回显、切换关闭动作即时持久化、
 *        记住选择开关（含键盘）、中英文切换、无 bridge（纯浏览器）时卡片隐藏。 */
const CDP = `http://127.0.0.1:${process.env.WE_TEST_CDP || 9334}`
const APP = process.env.WE_TEST_APP || 'http://127.0.0.1:8032/'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const res = []
const check = (n, ok, d = '') => {
  res.push({ n, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`)
}
setTimeout(() => { console.error('[bk] WATCHDOG'); process.exit(3) }, 240000)

// ---- CDP ----
const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = new WebSocket((await (await fetch(`${CDP}/json/version`)).json()).webSocketDebuggerUrl)
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no })
let id = 0
const pend = new Map()
const pageErrors = []
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id); pend.delete(m.id)
    m.error ? p.no(new Error(JSON.stringify(m.error))) : p.ok(m.result)
  } else if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push(m.params?.exceptionDetails?.exception?.description || 'exception')
  }
}
const send = (method, params, sessionId) => {
  const i = ++id
  ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }))
  return new Promise((ok, no) => {
    pend.set(i, { ok, no })
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); no(new Error('cdp timeout: ' + method)) } }, 20000)
  })
}
const S = (await send('Target.attachToTarget', { targetId: t.id, flatten: true })).sessionId
await send('Page.enable', {}, S)
await send('Runtime.enable', {}, S)
const ev = async x => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, userGesture: true }, S)
  if (r.exceptionDetails) throw new Error('eval:' + (r.exceptionDetails.exception?.description || ''))
  return r.result.value
}
const waitReady = async () => {
  for (let i = 0; i < 80; i++) {
    if ((await ev(`typeof applyI18n === 'function' && typeof initWindowBehavior === 'function' && document.readyState !== 'loading'`)) === true) return true
    await sleep(250)
  }
  return false
}

// 桌面壳 bridge 模拟：状态 + 调用记录，set 与真实主进程一样返回合并后的配置
const MOCK = `
try{localStorage.setItem('wl_lang','zh-CN');localStorage.setItem('wl_guide_done_pages_v1',JSON.stringify({work:true,pert:true,config:true,help:true}));}catch(e){}
window.__wbState={close_action:'minimize_to_tray',remember_choice:false};
window.__wbCalls=[];
window.weval={desktop:true,version:'test',windowBehavior:{
  get:()=>Promise.resolve({...window.__wbState}),
  set:(p)=>{window.__wbCalls.push(p);window.__wbState=Object.assign({},window.__wbState,p);return Promise.resolve({...window.__wbState});}
}};
`
const injected = await send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK }, S)
await send('Page.navigate', { url: APP }, S)
check('页面脚本就绪（含窗口行为模块）', await waitReady())
await ev(`goPage('config')`)
await sleep(600)

const shown = JSON.parse(await ev(`JSON.stringify({
  display:document.querySelector('#windowBehaviorCard').style.display,
  min:document.querySelector('input[name="closeAction"][value="minimize_to_tray"]').checked,
  exit:document.querySelector('input[name="closeAction"][value="exit_app"]').checked,
  sw:document.querySelector('#rememberChoiceSwitch').classList.contains('on'),
  aria:document.querySelector('#rememberChoiceSwitch').getAttribute('aria-checked'),
  bridge:!!(window.weval&&window.weval.windowBehavior)
})`))
check('桌面壳存在 bridge 时窗口行为卡片显示', shown.display === 'block' && shown.bridge)
check('卡片回显默认配置（最小化到托盘 + 未记住）', shown.min === true && shown.exit === false && shown.sw === false && shown.aria === 'false', JSON.stringify(shown))

// 切换关闭动作 → 立即持久化
await ev(`(()=>{const r=document.querySelector('input[name="closeAction"][value="exit_app"]');r.checked=true;r.dispatchEvent(new Event('change',{bubbles:true}));})()`)
await sleep(400)
const afterAction = JSON.parse(await ev(`JSON.stringify({calls:window.__wbCalls,state:window.__wbState})`))
check('切换为「直接关闭应用」立即写入壳配置',
  afterAction.calls.some(c => c.close_action === 'exit_app') && afterAction.state.close_action === 'exit_app', JSON.stringify(afterAction))

// 记住选择开关：鼠标与键盘各一次
await ev(`document.querySelector('#rememberChoiceSwitch').click()`)
await sleep(400)
const afterClick = JSON.parse(await ev(`JSON.stringify({calls:window.__wbCalls,state:window.__wbState,aria:document.querySelector('#rememberChoiceSwitch').getAttribute('aria-checked')})`))
check('开启「记住选择」写入 remember_choice=true 且 aria 同步',
  afterClick.state.remember_choice === true && afterClick.aria === 'true' &&
  afterClick.calls.some(c => c.remember_choice === true), JSON.stringify(afterClick))

await ev(`(()=>{const s=document.querySelector('#rememberChoiceSwitch');s.focus();s.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`)
await sleep(400)
const afterKey = JSON.parse(await ev(`JSON.stringify({state:window.__wbState,aria:document.querySelector('#rememberChoiceSwitch').getAttribute('aria-checked')})`))
check('键盘 Enter 可切换记住选择并持久化', afterKey.state.remember_choice === false && afterKey.aria === 'false', JSON.stringify(afterKey))

// 多语言：英文界面下卡片文案可翻译
await ev(`setLang('en-US')`)
await sleep(700)
const enText = JSON.parse(await ev(`JSON.stringify({
  card:document.querySelector('[data-i18n="config.card.window"]').textContent.trim(),
  min:document.querySelector('[data-i18n="config.window.minimize"]').textContent.trim(),
  exitLbl:document.querySelector('[data-i18n="config.window.exit"]').textContent.trim()
})`))
check('英文界面窗口行为卡片文案已翻译',
  enText.card === 'Window Behavior' && enText.min === 'Minimize to tray' && enText.exitLbl === 'Close the app', JSON.stringify(enText))
await ev(`setLang('zh-CN')`)
await sleep(500)

// 纯浏览器（无桌面 bridge）：卡片必须隐藏，不能出现无效设置项
await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected.identifier }, S)
await send('Page.navigate', { url: APP }, S)
check('二次加载就绪（无 bridge）', await waitReady())
await ev(`goPage('config')`)
await sleep(500)
const browserMode = JSON.parse(await ev(`JSON.stringify({
  display:document.querySelector('#windowBehaviorCard').style.display,
  bridge:!!(window.weval&&window.weval.windowBehavior)
})`))
check('纯浏览器环境隐藏窗口行为卡片', browserMode.display === 'none' && browserMode.bridge === false, JSON.stringify(browserMode))
check('页面运行期间无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))

const failed = res.filter(r => !r.ok)
console.log(`\n==== 窗口行为 UI 验证 ==== ${failed.length ? `失败 ${failed.length}/${res.length}` : `全绿 ${res.length}/${res.length}`}`)
try { ws.close() } catch { /* 已断开 */ }
process.exit(failed.length ? 1 : 0)
