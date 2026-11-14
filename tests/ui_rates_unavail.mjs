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
    const kind = (m.params.request.url.match(/\/api\/(rates|rules)(\?|$)/) || [null, 'none'])[1]
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
// setLang/ratesSave 这些是 async 函数：不带 awaitPromise 的 evaluate 会「立刻返回、后台还在跑」，
// 于是断言只能靠固定 sleep 赌它跑完——负载高就赌输（T04084 的第二处偶发红即此：英文态没翻译过来）。
const evA = async x => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, userGesture: true, awaitPromise: true }, S)
  if (r.exceptionDetails) throw new Error('eval:' + (r.exceptionDetails.exception?.description || ''))
  return r.result.value
}
// 导航进行中发命令，CDP 会回 -32000 Inspected target navigated or closed。
// 这是「还没好」而不是「测挂了」，故轮询专用的 evPoll 吞掉异常继续等（T04084）。
// 但只吞导航期的那一类：会话真没了／目标真关了，继续闷头轮询 30s 只会把原因藏起来，
// 所以最后一次错误记在 lastPollErr 里，waitReady 失败时随断言一起打出来。
let lastPollErr = ''
const evPoll = async x => {
  try { return await ev(x) } catch (e) {
    lastPollErr = String(e.message || e).slice(0, 200)
    return false
  }
}

// T04084：Page.reload 之后旧文档尚未销毁，waitReady 可能被旧文档满足（ratesLoad/__I18N 都在），
// 随后 ev(goPage(...)) 落到新文档、页面脚本却还没跑 → ReferenceError: goPage is not defined。
// 治法是「等新文档的代次」而不是「等页面看起来就绪」：每次导航前换一段带新 nonce 的
// document-start 脚本，轮询只认当代 nonce，旧文档天然对不上。
let docGen = ''
let genScriptId = null
const armDoc = async (source) => {
  if (genScriptId) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: genScriptId }, S).catch(() => { /* 旧会话已失效 */ })
  docGen = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const r = await send('Page.addScriptToEvaluateOnNewDocument', { source: `${source}\nwindow.__docGen=${JSON.stringify(docGen)};` }, S)
  genScriptId = r.identifier
}
// 导航命令失败要留证据而不是闷掉：轮 4 现场就是「Page.navigate 没生效 + 轮询全被吞」，
// 结果只看到「未就绪」看不到原因。这里记末次错误，并在末尾随断言详情一起打出来。
// 提交瞬间的 -32000 属同一竞态，重试一次；再失败就交给 waitReady 判红。
let lastNavErr = ''
const nav = async (method, params) => {
  lastNavErr = ''
  for (let i = 0; i < 2; i++) {
    try { await send(method, params, S); return }
    catch (e) { lastNavErr = String(e.message || e).slice(0, 200); await sleep(300) }
  }
}

const waitReady = async () => {
  let renavigated = false
  for (let i = 0; i < 120; i++) {
    // 字典异步加载：未就绪时 tf 回退成裸 key，会让断言误判，故一并等待
    if ((await evPoll(`(()=>{try{
      return window.__docGen===${JSON.stringify(docGen)} && typeof ratesLoad==='function' &&
             document.readyState!=='loading' && !!(__I18N && __I18N['rates.ver_count']);
    }catch(e){return false}})()`)) === true) return true
    // 轮 4 现场：导航根本没生效，标签页还停在 about:blank，光等 30s 只会把原因藏起来。
    // 等了 ~5s 还不在被测地址上，就补发一次导航（只补一次，再不动就判红）。
    if (!renavigated && i >= 20 && (await evPoll(`location.href`)) === 'about:blank') {
      console.log('  … 5s 仍在 about:blank，补发一次 Page.navigate')
      lastNavErr = ''
      try { await send('Page.navigate', { url: APP }, S) } catch (e) { lastNavErr = String(e.message || e).slice(0, 200) }
      renavigated = true
    }
    await sleep(250)
  }
  return false
}
const checkReady = async (label) => {
  const r = await waitReady()
  check(label, r, r ? '' : `导航错误=${lastNavErr || '无'} 末次轮询错误=${lastPollErr || '无'}`)
  return r
}
// 「进配置中心」是竞态的爆点：把它做成断言，回归时会给出具名 FAIL 而不是整挂崩溃。
// 单次判定、不重试——代次门已经保证此刻是新文档且页面脚本跑完，再抖就是真缺陷。
const gotoConfig = async () => {
  try { await ev(`goPage('config')`); return { ok: true, why: '' } }
  catch (e) { return { ok: false, why: e.message.slice(0, 120) } }
}
// 节点缺失（导航没落到配置页 / 卡片尚未挂载）时读 textContent 会抛裸 TypeError 炸掉整挂套件；
// 缺失就当空串，让后面的严格断言红得有信息，而不是崩得无依据。
const ratesState = async () => JSON.parse(await ev(`(()=>{
  const txt = id => { const n = document.getElementById(id); return n ? n.textContent.trim() : '' }
  return JSON.stringify({
    ver: txt('ratesVer'),
    opts: document.querySelectorAll('#ratesSel option').length,
    rulesMeta: txt('rulesMeta'),
    rulesRows: txt('rulesRows'),
    cardVisible: !!(document.getElementById('ratesCard') || {}).offsetParent
  })
})()`))
// 等的是「断言条件成立」，不是固定秒数：取数/语言切换都是异步链，固定 sleep 在负载高时赌输
// （T04084 现场：英文态那句仍在中文）。轮询到点仍不成立就照实用断言，红得有依据。
const waitState = async (pred, tries = 24) => {
  let s = await ratesState()
  for (let i = 0; i < tries && !pred(s); i++) { await sleep(250); s = await ratesState() }
  return s
}

const init = `try{localStorage.setItem('wl_lang','zh-CN');
  localStorage.setItem('wl_guide_done_pages_v1',JSON.stringify({work:true,pert:true,config:true,help:true}));}catch(e){}
  window.prompt=()=>'探针版本';window.confirm=()=>true;`
// toast 是脚本顶层函数声明，document-start 阶段还不存在，挂钩必须等页面脚本就绪后
const installSpy = () => ev(`(()=>{try{window.__toast=[];const o=toast;
  window.toast=(m)=>{window.__toast.push(String(m));return o(m)};return true}catch(e){return false}})()`)

// 1) 健康基线：费率/规则卡片正常取数
await armDoc(init)
await nav('Page.navigate', { url: APP })
await checkReady('页面脚本就绪（含字典、代次匹配）')
check('toast 探针挂钩成功', await installSpy())
const g1 = await gotoConfig()
check('健康基线进入配置中心（新文档可寻址）', g1.ok, g1.why)
const healthy = await waitState(s => s.opts >= 1 && /v\d+/.test(s.ver))
check('健康态费率卡片显示版本（基线）', healthy.opts >= 1 && /v\d+/.test(healthy.ver), JSON.stringify(healthy))

// 2) 降级：/api/rates 与 /api/rules 返回 503 {ok:false}
const errBaseline = pageErrors.length
await send('Fetch.enable', { patterns: Object.keys(DEGRADED).map(urlPattern => ({ urlPattern, requestStage: 'Request' })) }, S)
await armDoc(init)
await nav('Page.reload', {})
await checkReady('降级后新文档就绪（代次匹配）')
await installSpy()
const g2 = await gotoConfig()
check('降级态进入配置中心（新文档可寻址）', g2.ok, g2.why)
// 轮询只做「等卡片落到终态」，具体文案仍由下面的严格断言判——避免把断言降级成轮询条件
const degraded = await waitState(s => /可用|unavailable/i.test(s.ver) && /可用|unavailable/i.test(s.rulesRows))
check('费率表不可用时卡片给出可读提示', degraded.cardVisible && degraded.ver === '费率表不可用：费率版本表不可用' && degraded.opts === 0, JSON.stringify(degraded))
check('规则表不可用时表格给出可读提示（rulesLoad 已判 ok）',
  degraded.rulesRows.includes('规则表不可用：识别规则表不可用') && !/undefined/.test(degraded.rulesRows), JSON.stringify(degraded.rulesRows))
check('降级态进入配置中心无未捕获异常', pageErrors.length === errBaseline, pageErrors.slice(errBaseline, errBaseline + 2).join(' | '))

// 3) 降级态下点保存/新增/删除：提示原因、不发请求、不抛异常
const errBeforeOp = pageErrors.length
// awaitPromise：等三个 async 按钮函数真的跑完，而不是发出去就往下读 toast
await evA(`(async()=>{await ratesSave();await ratesAdd();await ratesDel();return true})()`)
let afterOps = '{}'
for (let i = 0; i < 24; i++) {
  afterOps = await ev(`JSON.stringify({toast:window.__toast,errs:0})`)
  if ((JSON.parse(afterOps).toast || []).length >= 3) break
  await sleep(250)
}
check('降级态费率按钮给出提示且不抛异常',
  pageErrors.length === errBeforeOp && /不可用/.test(afterOps), afterOps.slice(0, 160))

// 4) 英文态：不可用文案走 i18n 字典（服务端 msgKey 通道）
await evA(`setLang('en-US')`)
await evA(`goPage('config')`)
const enState = await waitState(s => /Rates unavailable/i.test(s.ver))
check('英文界面降级文案已翻译', /Rates unavailable: Rate version table unavailable/.test(enState.ver), JSON.stringify(enState.ver))
check('英文界面降级态仍无未捕获异常', pageErrors.length === errBeforeOp, pageErrors.slice(errBeforeOp, errBeforeOp + 2).join(' | '))

// 5) 解除降级：健康路径恢复（证明修复未改变正常行为）
await send('Fetch.disable', {}, S)
await evA(`setLang('zh-CN')`)
await armDoc(init)
await nav('Page.reload', {})
await checkReady('解除降级后新文档就绪（代次匹配）')
const g5 = await gotoConfig()
check('恢复态进入配置中心（新文档可寻址）', g5.ok, g5.why)
const restored = await waitState(s => s.opts >= 1 && /v\d+/.test(s.ver))
check('解除降级后费率卡片恢复版本显示', restored.opts >= 1 && /v\d+/.test(restored.ver), JSON.stringify(restored.ver))

const failed = res.filter(r => !r.ok)
const summary = failed.length ? `失败 ${failed.length}/${res.length}` : `全绿 ${res.length}/${res.length}`
console.log(`\n==== 配置中心降级态 UI 验证 ==== ${summary}`)
try { ws.close() } catch { /* 已断开 */ }
process.exit(failed.length ? 1 : 0)
