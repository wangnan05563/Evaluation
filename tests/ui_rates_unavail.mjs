/** T03956 配置中心降级态 UI 验证（无头 Chrome + CDP）。
 *  独立运行：node tests/ui_rates_unavail.mjs
 *  前置：scripts/server.py 运行在 8032（--serve-frontend）、Chrome 调试端口 9334。
 *  做法：用 CDP Fetch 域把 /api/rates、/api/rules 换成后端真实降级响应（503 {ok:false,msgKey}），
 *        等价于「费率表文件缺失/损坏」的新机器现场——不改动被测服务的数据，且能顺带验证恢复路径。
 *  覆盖：健康态正常渲染 → 降级态卡片可读提示且不抛未捕获异常 → 按钮点击安全 → 英文态文案走 i18n → 解除降级后恢复。 */
const CDP = `http://127.0.0.1:${process.env.WE_TEST_CDP || 9334}`
const APP = process.env.WE_TEST_APP || 'http://127.0.0.1:8032/'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const res = []
const check = (n, ok, d = '') => {
  res.push({ n, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`)
}
setTimeout(() => { console.error('[bk] WATCHDOG'); process.exit(3) }, 240000)

// 后端降级响应（与 scripts/server.py 的 _m('rates.srv_unavail') / rules 不可用分支同构）
const DEGRADED = {
  '*/api/rates': { code: 503, body: { ok: false, msg: '费率版本表不可用', msgKey: 'rates.srv_unavail' } },
  '*/api/rules': { code: 503, body: { ok: false, msg: '识别规则表不可用', msgKey: 'rules.srv_unavail' } }
}

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
  } else if (m.method === 'Fetch.requestPaused') {
    const kind = (m.params.request.url.match(/\/api\/(rates|rules)(\?|$)/) || [, 'none'])[1]
    const rule = DEGRADED[`*/api/${kind}`]
    const body = rule ? JSON.stringify(rule.body) : '{}'
    send('Fetch.fulfillRequest', {
      requestId: m.params.requestId, responseCode: rule ? rule.code : 500,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(body, 'utf8').toString('base64')
    }, S).catch(() => { /* 会话已结束 */ })
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
    // 字典异步加载：未就绪时 tf 回退成裸 key，会让断言误判，故一并等待
    if ((await ev(`(()=>{try{
      return typeof ratesLoad==='function' && document.readyState!=='loading' &&
             !!(__I18N && __I18N['rates.ver_count']);
    }catch(e){return false}})()`)) === true) return true
    await sleep(250)
  }
  return false
}
const ratesState = async () => JSON.parse(await ev(`JSON.stringify({
  ver:document.getElementById('ratesVer').textContent.trim(),
  opts:document.querySelectorAll('#ratesSel option').length,
  rulesMeta:document.getElementById('rulesMeta').textContent.trim(),
  rulesRows:document.getElementById('rulesRows').textContent.trim(),
  cardVisible:!!document.getElementById('ratesCard').offsetParent
})`))

const init = `try{localStorage.setItem('wl_lang','zh-CN');
  localStorage.setItem('wl_guide_done_pages_v1',JSON.stringify({work:true,pert:true,config:true,help:true}));}catch(e){}
  window.prompt=()=>'探针版本';window.confirm=()=>true;`
// toast 是脚本顶层函数声明，document-start 阶段还不存在，挂钩必须等页面脚本就绪后
const installSpy = () => ev(`(()=>{try{window.__toast=[];const o=toast;
  window.toast=(m)=>{window.__toast.push(String(m));return o(m)};return true}catch(e){return false}})()`)
await send('Page.addScriptToEvaluateOnNewDocument', { source: init }, S)

// 1) 健康基线：费率/规则卡片正常取数
await send('Page.navigate', { url: APP }, S)
check('页面脚本就绪（含字典）', await waitReady())
check('toast 探针挂钩成功', await installSpy())
await ev(`goPage('config')`)
await sleep(1200)
const healthy = await ratesState()
check('健康态费率卡片显示版本（基线）', healthy.opts >= 1 && /v\d+/.test(healthy.ver), JSON.stringify(healthy))

// 2) 降级：/api/rates 与 /api/rules 返回 503 {ok:false}
const errBaseline = pageErrors.length
await send('Fetch.enable', { patterns: Object.keys(DEGRADED).map(urlPattern => ({ urlPattern, requestStage: 'Request' })) }, S)
await send('Page.reload', {}, S)
check('降级后页面重新就绪', await waitReady())
await installSpy()
await ev(`goPage('config')`)
await sleep(1500)
const degraded = await ratesState()
check('费率表不可用时卡片给出可读提示', degraded.cardVisible && degraded.ver === '费率表不可用：费率版本表不可用' && degraded.opts === 0, JSON.stringify(degraded))
check('规则表不可用时表格给出可读提示（rulesLoad 已判 ok）',
  degraded.rulesRows.includes('规则表不可用：识别规则表不可用') && !/undefined/.test(degraded.rulesRows), JSON.stringify(degraded.rulesRows))
check('降级态进入配置中心无未捕获异常', pageErrors.length === errBaseline, pageErrors.slice(errBaseline, errBaseline + 2).join(' | '))

// 3) 降级态下点保存/新增/删除：提示原因、不发请求、不抛异常
const errBeforeOp = pageErrors.length
await ev(`(async()=>{await ratesSave();await ratesAdd();await ratesDel();})()`)
await sleep(600)
const afterOps = await ev(`JSON.stringify({toast:window.__toast,errs:0})`)
check('降级态费率按钮给出提示且不抛异常',
  pageErrors.length === errBeforeOp && /不可用/.test(afterOps), afterOps.slice(0, 160))

// 4) 英文态：不可用文案走 i18n 字典（服务端 msgKey 通道）
await ev(`setLang('en-US')`)
await sleep(1500)
await ev(`goPage('config')`)
await sleep(900)
const enState = await ratesState()
check('英文界面降级文案已翻译', /Rates unavailable: Rate version table unavailable/.test(enState.ver), JSON.stringify(enState.ver))
check('英文界面降级态仍无未捕获异常', pageErrors.length === errBeforeOp, pageErrors.slice(errBeforeOp, errBeforeOp + 2).join(' | '))

// 5) 解除降级：健康路径恢复（证明修复未改变正常行为）
await send('Fetch.disable', {}, S)
await ev(`setLang('zh-CN')`)
await send('Page.reload', {}, S)
check('解除降级后页面重新就绪', await waitReady())
await ev(`goPage('config')`)
await sleep(1200)
const restored = await ratesState()
check('解除降级后费率卡片恢复版本显示', restored.opts >= 1 && /v\d+/.test(restored.ver), JSON.stringify(restored.ver))

const failed = res.filter(r => !r.ok)
console.log(`\n==== 配置中心降级态 UI 验证 ==== ${failed.length ? `失败 ${failed.length}/${res.length}` : `全绿 ${res.length}/${res.length}`}`)
try { ws.close() } catch { /* 已断开 */ }
process.exit(failed.length ? 1 : 0)
