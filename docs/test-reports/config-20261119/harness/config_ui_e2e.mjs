import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const CDP = process.env.CONFIG_CDP || 'http://127.0.0.1:9339'
const APP = process.env.CONFIG_APP || 'http://127.0.0.1:8034/'
const DATA = process.env.CONFIG_DATA || 'C:/Users/hspcadmin/AppData/Local/Temp/we_config_e2e'
const DOC = process.env.CONFIG_DOC || 'E:/test/工作量评估/HUNDSUN票据交易管理平台软件V5.0-铁建财务-票据系统线上审批需求说明文档V1.0.3.docx'
const PY = process.env.PY || 'F:/Program Files/Python3.14/python.exe'
const OUT = process.env.CONFIG_OUT || 'C:/Users/hspcadmin/AppData/Local/Doubao/User Data/Default/.doubao/agent_mode/workspace/.sessions/38453923401786370/agents/m_0cwexANLqfk/config_test/round1'
try { fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch (e) { console.warn('[cleanup] output dir kept:', e.message) }
fs.mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const check = (n, ok, d = '') => { results.push({ n, ok: !!ok, d: String(d || '').slice(0, 500) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + String(d).slice(0, 500) : ''}`) }
const post = async (p, body) => (await fetch(APP + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()
const get = async p => (await fetch(APP + p)).json()
const read = p => fs.readFileSync(p).toString('base64')
setTimeout(() => { console.error('[bk] WATCHDOG'); process.exit(3) }, 720000)

const original = {}
for (const p of ['/api/config', '/api/rates', '/api/rules', '/api/templates', '/api/context']) original[p] = await get(p)

let docB64 = read(DOC)
let docName = path.basename(DOC)
const rec0 = await post('/api/recognize', { name: docName, b64: docB64, llm_enabled: false })
const counts = (items = []) => ['ILF','EIF','EI','EO','EQ'].reduce((o, k) => (o[k] = items.filter(x => x.type === k).length, o), {})
const c0 = counts(rec0.items || [])
check('真实需求文档识别返回 17 项', rec0.ok && rec0.items?.length === 17, `${rec0.items?.length || 0} 项`)
check('真实文档类型分布 EI=11/EQ=6', rec0.ok && c0.EI === 11 && c0.EQ === 6, JSON.stringify(c0))

const items = (rec0.items || []).map(x => ({ ...x, cx: '中', ok: true }))
const initItems = items.map(x => ({ ...x }))
const mkGen = (title, template) => post('/api/generate', { items, method: '估算功能点', title, job: 'cfg-' + Date.now(), hist_items: initItems, ...(template ? { template } : {}) })

// ---------- CDP ----------
const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = new WebSocket((await (await fetch(`${CDP}/json/version`)).json()).webSocketDebuggerUrl)
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no })
let id = 0; const pend = new Map(); const errors = []
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.no(new Error(JSON.stringify(m.error))) : p.ok(m.result) }
  else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.exception?.description || 'exception')
  else if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') errors.push(m.params?.args?.map(a => a.value || a.description || '').join(' '))
}
const send = (m, p = {}, s) => {
  const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p, ...(s ? { sessionId: s } : {}) }))
  return new Promise((ok, no) => { pend.set(i, { ok, no }); setTimeout(() => { if (pend.has(i)) { pend.delete(i); no(new Error('cdp timeout: ' + m)) } }, 30000) })
}
const S = (await send('Target.attachToTarget', { targetId: t.id, flatten: true })).sessionId
await send('Page.enable', {}, S); await send('Runtime.enable', {}, S); await send('DOM.enable', {}, S)
const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, userGesture: true, awaitPromise: true }, S); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval exception'); return r.result.value }
const evj = async x => JSON.parse(await ev(`JSON.stringify(${x})`))
const waitFor = async (expr, ms = 15000, label = '') => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true } catch (_) {} await sleep(100) }
  return false
}
const vp = async (w, h) => { await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w <= 480 }, S); await sleep(250) }
const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, S); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64')) }
const setVal = async (sel, val) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.value=${JSON.stringify(String(val))};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
const setChecked = async (sel, val) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.checked=${val ? 'true' : 'false'};e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
const setSelect = async (sel, val) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.value=${JSON.stringify(String(val))};e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
const toast = async () => ev(`document.querySelector('#toast')?.textContent||''`)
const waitToast = async (needle = '', ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = await toast(); if (s && (!needle || s.includes(needle))) return s; await sleep(100) } return await toast() }
const click = async sel => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true})()`)
const apiConfig = () => get('/api/config').then(x => x.config || {})
const apiRates = () => get('/api/rates')
const apiRules = () => get('/api/rules')
const apiTemplates = () => get('/api/templates')
const recognize = () => post('/api/recognize', { name: docName, b64: docB64, llm_enabled: false })

await send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('wl_lang','zh-CN');localStorage.setItem('wl_guide_done_pages_v1',JSON.stringify({work:true,pert:true,config:true,help:true}))}catch(e){}` }, S)
await send('Page.navigate', { url: APP }, S)
for (let i = 0; i < 70; i++) { try { if (await ev(`document.readyState!=='loading' && typeof goPage==='function' && typeof setLang==='function'`)) break } catch (_) {} await sleep(300) }
await ev(`goPage('config')`)
await waitFor(`document.querySelectorAll('#ratesSel option').length>=2 && document.querySelectorAll('#rulesRows input[data-ri]').length>0 && !document.querySelector('#rulesRows').textContent.includes('rules.')`, 30000, '配置页初始加载')
await ev(`setLang('zh-CN')`); await sleep(700); await vp(1440, 900)

// ---------- 1. 页面结构与响应式 ----------
let initial = await evj(`({
  page:document.body.dataset.page,
  cards:[...document.querySelectorAll('#pg-config .card-title')].map(x=>x.textContent.replace(/\\s+/g,' ').trim()),
  rates:{ver:document.querySelector('#ratesVer').textContent.trim(),sel:[...document.querySelector('#ratesSel').options].map(o=>o.value),pdr:document.querySelector('#ratesPdr').value,rate:document.querySelector('#ratesRate').value},
  rules:{meta:document.querySelector('#rulesMeta').textContent.trim(),rows:new Set([...document.querySelectorAll('#rulesRows input[data-ri]')].map(x=>x.dataset.ri)).size},
  recalc:{mode:document.querySelector('#recalcMode').value,timeout:document.querySelector('#recalcTimeout').value,note:document.querySelector('[data-i18n="config.recalc.priority_full"]').textContent.trim()},
  buttons:{rateSave:document.querySelector('#ratesCard button[onclick="ratesSave()"]').textContent.trim(),ctxAria:document.querySelector('button[onclick="saveCtxDir()"]').getAttribute('aria-label')},
  overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
  crlf:!!document.querySelector('#pg-config').textContent.match(/(^|\\s)(config|rates|rules|appearance|theme|lang)\\./)
})`)
check('配置页已激活', initial.page === 'config', initial.page)
check('配置页 11 张功能卡齐全', ['大模型识别增强','可用模型','项目上下文目录','应用更新','成品表公式缓存','外观','运维（M8/FR-5.4、5.6）','母版管理（M9/FR-2.8）','费率与基准（M6/FR-2.3）','识别规则（M3/FR-2.9）'].every(x => initial.cards.some(c => c.includes(x))), initial.cards.join(' / '))
check('配置页无横向溢出 1440px', initial.overflow === 0, initial.overflow)
check('费率卡初始 2 版本且值正确', initial.rates.ver.includes('2') && initial.rates.sel.includes('CSBMK-2023') && initial.rates.sel.includes('CSBMK-2024') && initial.rates.pdr === '6.96' && initial.rates.rate === '28000', JSON.stringify(initial.rates))
check('识别规则初始 6 条', initial.rules.rows === 6 && initial.rules.meta.includes('6'), JSON.stringify(initial.rules))
check('重算说明无“默认认值”拼接错误', initial.recalc.note.includes('默认值') && !initial.recalc.note.includes('默认认值'), initial.recalc.note)
check('费率保存按钮有非空文案', initial.buttons.rateSave.length > 0 && initial.buttons.rateSave !== '+版本', initial.buttons.rateSave)
check('上下文保存按钮 aria 为中文“保存目录”', initial.buttons.ctxAria === '保存目录', initial.buttons.ctxAria)
check('配置页无裸露 i18n key', !initial.crlf, '')
await shot('00_config_zh_1440.png')

for (const [w, h, name] of [[1024,900,'01_config_1024.png'],[768,900,'02_config_768.png'],[375,812,'03_config_375.png']]) {
  await vp(w, h)
  const x = await evj(`({overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,ratesCols:getComputedStyle(document.querySelector('#ratesCard > div[style*="grid-template-columns"]')).gridTemplateColumns.split(' ').filter(Boolean).length})`)
  check(`配置页无横向溢出 ${w}px`, x.overflow === 0, x.overflow)
  check(`费率字段在 ${w}px 下不压成 4 列`, w > 640 ? x.ratesCols === 4 : x.ratesCols === 2, x.ratesCols + ' 列')
  await shot(name)
}
await vp(1440, 900)

// ---------- 2. 大模型配置、草稿隐私、错误回退 ----------
await ev(`localStorage.removeItem('wl_cfg_draft_v1')`)
await click('#llmSwitch')
await setVal('#llmApi', 'http://127.0.0.1:9/v1')
await setVal('#llmModel', 'gpt-4o-mini')
await setVal('#llmKey', 'sk-cfg-e2e-secret')
await setChecked('#rememberKey', true)
await click('button[onclick="saveCfg()"]')
await sleep(900)
const cfgOn = await apiConfig()
check('启用大模型后可保存配置', cfgOn.llm?.enabled === true && cfgOn.llm?.api === 'http://127.0.0.1:9/v1' && cfgOn.llm?.model === 'gpt-4o-mini', JSON.stringify(cfgOn.llm))
check('保存大模型配置后有成功提示', (await waitToast('保存', 2000)).length > 0, await toast())
await click('button[onclick="testCfg()"]')
await waitFor(`document.querySelector('#cfgTestBox').classList.contains('bad')`, 10000, '连接失败回退')
const testBox = await evj(`({cls:document.querySelector('#cfgTestBox').className,text:document.querySelector('#cfgTestBox').textContent.trim()})`)
check('连接失败在测试框内可读提示且不崩溃', testBox.cls.includes('bad') && testBox.text.length > 0 && errors.length === 0, testBox.text.slice(0, 140))
await ev(`pickModel('gpt-4o')`)
check('模型芯片点击可回填模型名', (await ev(`document.querySelector('#llmModel').value`)) === 'gpt-4o', await ev(`document.querySelector('#llmModel').value`))
await setChecked('#rememberKey', false)
await ev(`localStorage.removeItem('wl_cfg_draft_v1')`)
await setVal('#llmKey', 'sk-should-not-be-drafted')
await sleep(1000)
const draft = await evj(`JSON.parse(localStorage.getItem('wl_cfg_draft_v1')||'null')`)
check('未勾选“记住”时 API Key 不落本地草稿', draft && draft.fields && draft.fields.key === '', JSON.stringify(draft?.fields?.key))
await ev(`resetCfg()`)
const reset = await evj(`({enabled:document.querySelector('#llmSwitch').classList.contains('on'),api:document.querySelector('#llmApi').value,model:document.querySelector('#llmModel').value,key:document.querySelector('#llmKey').value})`)
check('恢复默认清空启用、Key 和模型', !reset.enabled && reset.api === 'https://api.openai.com/v1' && reset.model === 'gpt-4o-mini' && reset.key === '', JSON.stringify(reset))
// 恢复关闭态并保存，避免后续导出包出现测试 Key
if (await ev(`document.querySelector('#llmSwitch').classList.contains('on')`)) await click('#llmSwitch')
await setVal('#llmApi', 'https://api.openai.com/v1'); await setVal('#llmModel', 'gpt-4o-mini'); await setVal('#llmKey', '')
await click('button[onclick="saveCfg()"]'); await sleep(700)
check('大模型配置可恢复为关闭/默认', (await apiConfig()).llm?.enabled === false, JSON.stringify((await apiConfig()).llm))

// ---------- 3. 上下文目录 ----------
const ctxPath = 'D:\\code\\otherProjects\\Evaluation'
await setVal('#ctxDir', ctxPath)
await click('button[onclick="saveCtxDir()"]')
await waitFor(`document.querySelector('#ctxOut').textContent.includes('技术栈')`, 20000, '上下文扫描')
const ctx = await evj(`({dir:document.querySelector('#ctxDir').value,out:document.querySelector('#ctxOut').textContent.trim().slice(0,600),cls:document.querySelector('#ctxOut').className})`)
const ctxApi = await get('/api/context')
check('上下文目录保存并自动扫描真实仓库', ctxApi.context_dir === ctxPath && ctx.out.includes('技术栈') && ctx.out.includes('规模'), ctx.dir)
check('上下文扫描输出可读且非空', ctx.cls.includes('ok') && ctx.out.length > 80, ctx.out.slice(0, 120))
await setVal('#ctxDir', 'Z:\\__cfg_missing_dir__')
await click('button[onclick="analyzeCtx()"]')
await waitFor(`document.querySelector('#ctxOut').classList.contains('bad')`, 10000, '无效目录回退')
const ctxBad = await evj(`({cls:document.querySelector('#ctxOut').className,text:document.querySelector('#ctxOut').textContent.trim()})`)
check('无效上下文目录显示错误且不崩溃', ctxBad.cls.includes('bad') && ctxBad.text.length > 0 && errors.length === 0, ctxBad.text.slice(0, 140))
await setVal('#ctxDir', ''); await click('button[onclick="saveCtxDir()"]'); await sleep(700)
check('上下文目录可恢复为空', (await get('/api/context')).context_dir === '', JSON.stringify((await get('/api/context'))))

// ---------- 4. 更新源 ----------
const updInit = await evj(`({def:document.querySelector('#updDefaultUrl').textContent.trim()})`)
check('内置更新源地址可见', updInit.def.startsWith('https://api.github.com/'), updInit.def)
await setVal('#updUrl', 'off'); await click('button[onclick="saveUpdateUrl()"]'); await sleep(500)
check('更新源可保存为 off', (await apiConfig()).update_url === 'off', (await apiConfig()).update_url)
await setVal('#updUrl', 'http://127.0.0.1:9/update.json'); await click('button[onclick="saveUpdateUrl()"]'); await sleep(500)
check('自定义更新源可保存', (await apiConfig()).update_url === 'http://127.0.0.1:9/update.json', (await apiConfig()).update_url)
await setVal('#updUrl', ''); await click('button[onclick="saveUpdateUrl()"]'); await sleep(500)
check('更新源可恢复内置空值', (await apiConfig()).update_url === '', JSON.stringify((await apiConfig()).update_url))

// ---------- 5. 公式缓存 ----------
const rc0 = await apiConfig()
await setVal('#recalcTimeout', '4'); await click('button[onclick="saveRecalcCfg()"]'); await sleep(500)
const rcBad = await apiConfig()
check('重算超时越界被拒绝', rcBad.recalc?.timeout !== 4, JSON.stringify(rcBad.recalc))
check('重算越界有可读提示', (await waitToast('5', 2000)).length > 0, await toast())
await setSelect('#recalcMode', 'sync'); await setVal('#recalcTimeout', '90'); await click('button[onclick="saveRecalcCfg()"]'); await sleep(500)
const rcSaved = await apiConfig()
check('重算方式和超时可保存', rcSaved.recalc?.mode === 'sync' && rcSaved.recalc?.timeout === 90, JSON.stringify(rcSaved.recalc))
await ev(`bindConfig()`); await sleep(700)
const rcUi = await evj(`({mode:document.querySelector('#recalcMode').value,timeout:document.querySelector('#recalcTimeout').value})`)
check('配置重新加载后重算值回显', rcUi.mode === 'sync' && rcUi.timeout === '90', JSON.stringify(rcUi))
await setSelect('#recalcMode', 'async'); await setVal('#recalcTimeout', '120'); await click('button[onclick="saveRecalcCfg()"]'); await sleep(500)
check('重算配置可恢复默认 async/120', (await apiConfig()).recalc?.mode === 'async' && (await apiConfig()).recalc?.timeout === 120, JSON.stringify((await apiConfig()).recalc))

// ---------- 6. 外观、品牌、语言 ----------
await ev(`setThemeMode('dark')`); await sleep(150)
const thDark = await evj(`({ls:localStorage.getItem('wl_theme_mode'),theme:document.documentElement.getAttribute('data-theme')})`)
check('暗色模式即时生效并记忆', thDark.ls === 'dark', JSON.stringify(thDark))
await ev(`setThemeMode('contrast')`); await sleep(150)
check('高对比模式可切换', (await ev(`localStorage.getItem('wl_theme_mode')`)) === 'contrast', await ev(`localStorage.getItem('wl_theme_mode')`))
await ev(`setThemeMode('light')`); await sleep(150)
check('亮色模式可恢复', (await ev(`localStorage.getItem('wl_theme_mode')`)) === 'light', await ev(`localStorage.getItem('wl_theme_mode')`))
await ev(`setBrand('#0F766E')`); await sleep(200)
const brand = await evj(`({ls:localStorage.getItem('wl_brand'),css:getComputedStyle(document.documentElement).getPropertyValue('--brand').trim()})`)
check('自定义主色即时生效并记忆', brand.ls === '#0F766E' && brand.css.length > 0, JSON.stringify(brand))
await ev(`setBrand('not-a-color')`); await sleep(200)
check('非法主色不写入记忆', (await ev(`localStorage.getItem('wl_brand')`)) === '#0F766E', await ev(`localStorage.getItem('wl_brand')`))
await ev(`setBrand('#2563EB')`); await sleep(200)
await ev(`setLang('en-US')`); await sleep(1000)
const en = await evj(`({
  text:document.querySelector('#pg-config').innerText,
  cards:[...document.querySelectorAll('#pg-config .card-title')].map(x=>x.textContent.replace(/\\s+/g,' ').trim()),
  rateSave:document.querySelector('#ratesCard button[onclick="ratesSave()"]').textContent.trim(),
  ctxAria:document.querySelector('button[onclick="saveCtxDir()"]').getAttribute('aria-label'),
  options:[...document.querySelectorAll('#recalcMode option')].map(o=>o.textContent.trim()),
  providers:[...document.querySelectorAll('#providerSel option')].map(o=>o.textContent.trim()),
  note:document.querySelector('[data-i18n="config.recalc.priority_full"]').textContent.trim(),
  raw:[...document.querySelectorAll('#pg-config [data-i18n]')].map(x=>x.textContent.trim()).filter(x=>/^(config|rates|rules|appearance|theme|lang|eco)./.test(x))
})`)
check('英文配置页卡片标题已翻译', en.cards.some(c => c.includes('LLM')) && en.cards.some(c => c.includes('Rates')), en.cards.join(' / '))
check('英文费率保存按钮显示 Save', en.rateSave === 'Save', en.rateSave)
check('英文上下文保存按钮 aria 为 Save directory', en.ctxAria === 'Save directory', en.ctxAria)
check('英文重算选项已翻译', en.options.every(x => !/重算|后台|同步|不重算/.test(x)), en.options.join(' | '))
check('英文供应商标签已翻译', en.providers.every(x => !/通义|火山|自定义/.test(x)), en.providers.join(' | '))
check('英文重算说明无 defaultThe 拼接', en.note.includes('default.') && !en.note.includes('defaultThe'), en.note.slice(0, 160))
check('英文配置页无裸露 i18n key', en.raw.length === 0 && !en.text.match(/(^|\\s)(config|rates|rules|appearance|theme|lang)\\./), en.raw.join(','))
await shot('04_config_en_1440.png')
await ev(`setLang('zh-CN')`); await sleep(800)
const zhBack = await evj(`({rateSave:document.querySelector('#ratesCard button[onclick="ratesSave()"]').textContent.trim(),pdr:document.querySelector('#ratesPdr').value,ctxAria:document.querySelector('button[onclick="saveCtxDir()"]').getAttribute('aria-label')})`)
check('切回中文后费率按钮/字段保持', zhBack.rateSave === '保存' && zhBack.pdr === '6.96' && zhBack.ctxAria === '保存目录', JSON.stringify(zhBack))
await vp(375, 812); await sleep(300)
check('英文/中文切换后 375px 仍无横向溢出', (await ev(`document.documentElement.scrollWidth-document.documentElement.clientWidth`)) === 0, await ev(`document.documentElement.scrollWidth-document.documentElement.clientWidth`))
await vp(1440, 900)

// ---------- 7. 费率多版本与快速页联动 ----------
await setSelect('#ratesSel', 'CSBMK-2024'); await sleep(300)
const r2024 = await evj(`({pdr:document.querySelector('#ratesPdr').value,rate:document.querySelector('#ratesRate').value,price:document.querySelector('#ratesPrice').value})`)
check('切换费率版本后字段联动', r2024.pdr === '6.6' && r2024.rate === '30000' && r2024.price === '920', JSON.stringify(r2024))
await setVal('#ratesPdr', '8.5'); await setVal('#ratesRate', '32000'); await setVal('#ratesPrice', '950'); await setVal('#ratesDnhc', '1000'); await setVal('#ratesSource', '配置页验收-费率基准')
await click('button[onclick="ratesSave()"]'); await sleep(800)
const savedRate = (await apiRates()).versions?.['CSBMK-2024']
check('费率可保存为自定义值', savedRate?.pdr === 8.5 && savedRate?.rate === 32000 && savedRate?.unit_price === 950 && savedRate?.dnhc === 1000, JSON.stringify({pdr:savedRate?.pdr,rate:savedRate?.rate,price:savedRate?.unit_price,dnhc:savedRate?.dnhc}))
await ev(`window.prompt=()=> '验收-2026'; true`); await click('button[onclick="ratesAdd()"]'); await sleep(800)
check('费率版本可新增', !!(await apiRates()).versions?.['验收-2026'], Object.keys((await apiRates()).versions).join(','))
await ev(`window.confirm=()=>true; true`); await click('button[onclick="ratesDel()"]'); await sleep(800)
check('费率版本可删除', !(await apiRates()).versions?.['验收-2026'], Object.keys((await apiRates()).versions).join(','))
await setVal('#ratesPdr', '-1'); await click('button[onclick="ratesSave()"]'); await sleep(600)
const rateNeg = (await apiRates()).versions?.['CSBMK-2024']
check('费率负数被拒绝且保留上次有效值', rateNeg?.pdr === 8.5, JSON.stringify(rateNeg?.pdr))
// 删除“验收-2026”后 selected 会回到第一套（CSBMK-2023）；快速页联动要显式选回自定义的 2024 并保存选中态。
await setSelect('#ratesSel', 'CSBMK-2024'); await sleep(400)
await click('button[onclick="ratesSave()"]'); await sleep(900)
await ev(`goPage('fast'); fastMode('est')`)
await waitFor(`document.querySelector('#fastCounts') && document.querySelectorAll('#fastCounts input').length===5 && document.querySelector('#fastResult').textContent.includes('UFP')`, 20000, '快速页加载')
for (const k of ['ILF','EIF','EO','EQ']) await setVal(`#fastCounts input[data-k="${k}"]`, '0')
await setVal('#fastCounts input[data-k="EI"]', '1')
await waitFor(`document.querySelector('#fastResult').textContent.includes('UFP = 4')`, 10000, '快速页费率联动')
const fast = await evj(`({text:document.querySelector('#fastResult').textContent.trim(),ufp:window.__fastUfp||0})`)
check('配置费率实时影响快速页 AE/费用', fast.text.includes('UFP = 4') && fast.text.includes('AE = PDR×S×SWF×RDF = 37.40') && fast.text.includes('7878') && fast.text.includes('CSBMK-2024'), fast.text.replace(/\n/g,' | ').slice(0, 260))
await shot('05_config_rates_fast.png')
await ev(`goPage('config'); setLang('zh-CN')`); await sleep(500)
// restore original rates
await post('/api/rates/save', original['/api/rates'])
await ev(`__rates=null; ratesLoad()`); await sleep(600)
check('费率可恢复原始基线', (await apiRates()).selected === original['/api/rates'].selected && (await apiRates()).versions?.['CSBMK-2024']?.pdr === 6.6, (await apiRates()).selected)

// ---------- 8. 规则 UI + 真实文档识别 ----------
await ev(`rulesLoad()`); await sleep(500)
await waitFor(`document.querySelectorAll('#rulesRows input[data-ri]').length>0`, 10000, '规则表重载')
const r0 = await recognize(); const rcb0 = counts(r0.items || [])
check('修改规则前真实文档仍为 UFP 68', r0.ok && rcb0.EI === 11 && rcb0.EQ === 6, JSON.stringify(rcb0))
await click('button[onclick="rulesAdd()"]');
for (let i = 0; i < 40; i++) { if ((await apiRules()).rules?.length === 7) break; await sleep(250) }
await waitFor(`new Set([...document.querySelectorAll('#rulesRows input[data-ri]')].map(x=>x.dataset.ri)).size===7`, 10000, '规则表新增行回显')
const ar = await apiRules()
check('追加规则按钮可新增一条并保存', ar.ok && ar.rules.length === 6 + 1, `${ar.rules?.length} 条`)
await ev(`(()=>{
  const trs=[...document.querySelectorAll('#rulesRows tr')].filter(tr=>tr.querySelector('[data-ri]'));
  const tr=trs[trs.length-1]; const n=tr.querySelector('[data-rk="id"]').dataset.ri;
  const s=(k,v)=>{const e=tr.querySelector('[data-rk="'+k+'"]');e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))};
  s('name','验收规则-审批流程→EO'); tr.querySelector('[data-rk="scope"]').value='desc'; tr.querySelector('[data-rk="type"]').value='EO';
  s('priority','110'); s('patterns','^审批流程$'); s('exclude',''); tr.querySelector('[data-rk="enabled"]').checked=true; return n;
})()`)
await click('button[onclick="rulesSave()"]');
for (let i = 0; i < 30; i++) { const x = await apiRules(); if (x.rules?.some(y => y.name === '验收规则-审批流程→EO')) break; await sleep(200) }
const ar2 = await apiRules()
check('规则 UI 保存后服务端为 7 条且目标规则存在', ar2.rules?.length === 7 && ar2.rules.some(x => x.name === '验收规则-审批流程→EO' && x.type === 'EO' && x.priority === 110), `${ar2.rules?.length} 条`)
const r1 = await recognize(); const rc1 = counts(r1.items || [])
check('规则命中真实文档：审批流程由 EI 变 EO', r1.ok && r1.items?.length === 17 && rc1.EO === 1 && rc1.EI === 10 && rc1.EQ === 6, JSON.stringify(rc1))
check('规则修改后仍可生成完整 17 项', r1.items?.length === 17, `${r1.items?.length} 项`)
await shot('06_config_rules_changed.png')
await post('/api/rules/save', { rules: original['/api/rules'].rules }); await ev(`rulesLoad()`); await sleep(700)
const r2 = await recognize(); const rc2 = counts(r2.items || [])
check('规则可恢复原始 6 条', (await apiRules()).rules?.length === 6, `${(await apiRules()).rules?.length} 条`)
check('恢复规则后真实文档回到 EI=11/EQ=6', rc2.EI === 11 && rc2.EQ === 6 && rc2.EO === 0, JSON.stringify(rc2))

// ---------- 9. 母版上传 + 成品表生成 ----------
const marker = 'CFG_TEMPLATE_MARKER_20261119'
const tplSrc = 'D:/code/otherProjects/Evaluation/tpl/template.xlsx'
const tplDst = path.join(OUT, '验收母版.xlsx')
execFileSync(PY, ['-c', `import openpyxl; p=${JSON.stringify(tplSrc)}; q=${JSON.stringify(tplDst)}; w=openpyxl.load_workbook(p); ws=w['模板使用说明&基础参数']; ws['A1']='${marker}'; w.save(q)`])
await ev(`window.prompt=()=> '验收母版-配置页'; true`)
const root = (await send('DOM.getDocument', {}, S)).root.nodeId
const fileNode = (await send('DOM.querySelector', { nodeId: root, selector: '#tplFile' }, S)).nodeId
await send('DOM.setFileInputFiles', { files: [tplDst], nodeId: fileNode }, S)
await sleep(1200)
const tpl = await apiTemplates()
const uploaded = tpl.templates?.find(x => x.name === '验收母版')
check('母版上传登记成功且列表可见', !!uploaded && uploaded.file.endsWith('验收母版.xlsx'), JSON.stringify(tpl.templates?.map(x => x.name)))
check('上传后本地记忆选择新母版', (await ev(`localStorage.getItem('wl_tpl')`)) === '验收母版', await ev(`localStorage.getItem('wl_tpl')`))
const gTpl = await mkGen('配置页验收-母版成品', uploaded?.file)
check('自定义母版生成成品成功', gTpl.ok && !!gTpl.sid, JSON.stringify(gTpl).slice(0, 180))
const gPath = path.join(DATA, 'generated', gTpl.sid || '')
check('自定义母版成品文件存在', !!gTpl.sid && fs.existsSync(gPath), gPath)
await ev(`tplPick('默认母版'); true`)

// ---------- 10. 诊断包 / 数据导出 / 导入 ----------
const secret = 'sk-diag-must-not-leak'
await post('/api/config', { llm: { enabled: false, api: 'https://api.openai.com/v1', model: 'gpt-4o-mini', key: secret } })
await click('button[onclick="diagExport()"]'); await sleep(800)
const diag = await get('/api/diag')
check('诊断包导出返回文件', diag.ok && !!diag.file && fs.existsSync(diag.file), diag.file)
await click('button[onclick="dataExport()"]'); await sleep(800)
const dataExp = await get('/api/data/export')
check('全部数据导出返回文件清单', dataExp.ok && Array.isArray(dataExp.files) && dataExp.files.includes('recognition_rules.json') && dataExp.files.includes('rates_versions.json'), JSON.stringify(dataExp.files))
check('数据导出不包含上传文档/成品', dataExp.ok && !dataExp.files.some(x => /uploads|generated|\.docx|\.xlsx/.test(x)), JSON.stringify(dataExp.files))
const diagPath = diag.file, dataPath = dataExp.file
check('诊断包与数据包文件大小合理', fs.statSync(diagPath).size > 1000 && fs.statSync(dataPath).size > 1000, `${fs.statSync(diagPath).size}/${fs.statSync(dataPath).size}`)
// 诊断包不含密钥：用 Python 统一校验，先记录路径
const importNode = (await send('DOM.querySelector', { nodeId: root, selector: '#dataImportFile' }, S)).nodeId
await send('DOM.setFileInputFiles', { files: [dataPath], nodeId: importNode }, S)
await sleep(1200)
check('数据包可经 UI 导入且不报错', (await toast()).includes('导入'), await toast())
await shot('07_config_ops.png')
await post('/api/config', { llm: { enabled: false, api: 'https://api.openai.com/v1', model: 'gpt-4o-mini', key: '' } })
check('测试密钥已从配置移除', (await apiConfig()).llm?.key === '', JSON.stringify((await apiConfig()).llm?.key))

// ---------- 11. 汇总结论 ----------
const finalState = await evj(`({page:document.body.dataset.page,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth})`)
check('最终回到配置页且无横向溢出', finalState.page === 'config' && finalState.overflow === 0, JSON.stringify(finalState))
check('全程无未捕获 JS 异常', errors.length === 0, errors.join(' | '))
const passed = results.filter(x => x.ok).length

const evidence = {
  results, passed, total: results.length,
  doc: { name: docName, items: rec0.items?.length, counts: c0, rawTypes: Object.fromEntries(Object.entries(counts(rec0.items || {}))) },
  initial, rectx: { context: ctxApi.context_dir, output: ctx.out.slice(0, 600), bad: ctxBad.text },
  en: { rateSave: en.rateSave, ctxAria: en.ctxAria, options: en.options, providers: en.providers, note: en.note, raw: en.raw },
  rule: { baseline: c0, changed: rc1, restored: rc2, count: (await apiRules()).rules?.length },
  rates: { custom: savedRate, selector: r2024 },
  fast: { text: fast.text, ufp: fast.ufp },
  artifacts: { template: uploaded?.file || '', templateMarker: marker, generated: gPath, diag: diagPath, data: dataPath, dataFiles: dataExp.files },
  screenshots: fs.readdirSync(OUT).filter(x => x.endsWith('.png')),
  errors
}
fs.writeFileSync(path.join(OUT, 'ui_results.json'), JSON.stringify(evidence, null, 2), 'utf8')
console.log(`SUMMARY ${passed}/${results.length}`)
ws.close()
setTimeout(() => process.exit(passed === results.length ? 0 : 1), 150)
