import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

const APP = 'http://127.0.0.1:8036'
const CDP = 'http://127.0.0.1:9341'
const DATA = 'C:\\Users\\hspcadmin\\AppData\\Local\\Temp\\we_help_e2e'
const DOC = 'E:\\test\\工作量评估\\HUNDSUN票据交易管理平台软件V5.0-铁建财务-票据系统线上审批需求说明文档V1.0.3.docx'
const OUT = path.resolve('C:\\Users\\hspcadmin\\AppData\\Local\\Doubao\\User Data\\Default\\.doubao\\agent_mode\\workspace\\.sessions\\38453923401786370\\agents\\m_0cwexANLqfk\\help_test\\round1')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const check = (n, ok, d = '') => { results.push({ n, ok: !!ok, d: String(d) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' | ' + d : ''}`) }
const read = p => fs.readFileSync(p)
const b64 = p => read(p).toString('base64')
const post = async (p, body) => {
  const r = await fetch(APP + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return r.json()
}
const get = async p => (await fetch(APP + p)).json()

if (!fs.existsSync(DOC)) throw new Error('test document missing: ' + DOC)
if (!fs.existsSync(DATA)) throw new Error('test data dir missing: ' + DATA)
fs.mkdirSync(OUT, { recursive: true })

// Mock update source. The version is mutable so both "new version" and "up to date" can be exercised.
let mockVersion = '0.1.20990101-999'
let mockPkgFail = false
const mockNotes = '帮助页验收更新日志\n- 文档公式与真实成品一致性\n- 更新下载与状态回退验证'
const mockPkg = Buffer.alloc(2 * 1024 * 1024, 0x4d)
const mock = http.createServer((req, res) => {
  if (req.url === '/update.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ version: mockVersion, url: 'http://127.0.0.1:8099/pkg/dummy-setup.exe', notes: mockNotes }))
  } else if (req.url === '/pkg/dummy-setup.exe') {
    if (mockPkgFail) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('mock package failure'); return }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(mockPkg.length) })
    res.end(mockPkg)
  } else {
    res.writeHead(404); res.end('not found')
  }
})
await new Promise((ok, no) => { mock.once('error', no); mock.listen(8099, '127.0.0.1', ok) })
console.log('[mock] 8099 ready')

// Real-document baseline generated through the same API used by the UI.
const docB64 = b64(DOC)
const docName = path.basename(DOC)
const rec0 = await post('/api/recognize', { name: docName, b64: docB64, llm_enabled: false })
const counts = (items = []) => ['ILF', 'EIF', 'EI', 'EO', 'EQ'].reduce((o, k) => (o[k] = items.filter(x => x.type === k).length, o), {})
const c0 = counts(rec0.items)
check('真实需求文档识别 17 项', rec0.ok && rec0.items?.length === 17, `${rec0.items?.length || 0} 项`)
check('真实文档类型分布 EI=11/EQ=6', c0.EI === 11 && c0.EQ === 6, JSON.stringify(c0))
const items = (rec0.items || []).map(x => ({ ...x, cx: '中', ok: true }))
const gen = await post('/api/generate', { items, method: '估算功能点', title: '帮助页验收-真实文档', job: 'help-' + Date.now(), hist_items: items.map(x => ({ ...x })) })
const genPath = gen.ok && gen.sid ? path.join(DATA, 'generated', gen.sid) : ''
check('真实文档成品生成成功', gen.ok && fs.existsSync(genPath), `${gen.sid || ''} ${genPath}`)
if (genPath) check('真实文档成品大小合理', fs.statSync(genPath).size > 10000, fs.statSync(genPath).size)

const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = new WebSocket((await (await fetch(`${CDP}/json/version`)).json()).webSocketDebuggerUrl)
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no })
let id = 0
const pend = new Map()
const errors = []
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.no(new Error(JSON.stringify(m.error))) : p.ok(m.result) }
  else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.exception?.description || 'exception')
  else if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') errors.push(m.params?.args?.map(a => a.value || a.description || '').join(' '))
}
const send = (method, params = {}, sessionId) => {
  const i = ++id
  ws.send(JSON.stringify({ id: i, method, ...(params ? { params } : {}), ...(sessionId ? { sessionId } : {}) }))
  return new Promise((ok, no) => {
    pend.set(i, { ok, no })
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); no(new Error('cdp timeout: ' + method)) } }, 30000)
  })
}
const S = (await send('Target.attachToTarget', { targetId: t.id, flatten: true })).sessionId
await send('Page.enable', {}, S); await send('Runtime.enable', {}, S); await send('DOM.enable', {}, S)
const ev = async x => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, userGesture: true, awaitPromise: true }, S)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval exception')
  return r.result.value
}
const evj = async x => JSON.parse(await ev(`JSON.stringify(${x})`))
const waitFor = async (expr, ms = 15000, label = '') => {
  const end = Date.now() + ms
  while (Date.now() < end) { try { if (await ev(expr)) return true } catch (_) {} await sleep(250) }
  throw new Error('timeout: ' + (label || expr))
}
const click = async sel => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true})()`)
const text = async sel => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent?.replace(/\\s+/g,' ').trim() || ''`)
const vp = async (w, h) => { await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w <= 480 }, S); await sleep(350) }
const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, S); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64')) }
const scrollTo = async sel => { await ev(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({block:'start',behavior:'instant'})`); await sleep(500) }

await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try{localStorage.setItem('wl_lang','zh-CN');localStorage.setItem('wl_guide_done_pages_v1',JSON.stringify({work:true,pert:true,fast:true,config:true,help:true}))}catch(e){}`
}, S)
await send('Page.navigate', { url: APP + '/' }, S)
for (let i = 0; i < 80; i++) { try { if (await ev(`document.readyState!=='loading' && typeof goPage==='function' && typeof setLang==='function'`)) break } catch (_) {} await sleep(250) }
await ev("setLang('zh-CN')")
await ev("goPage('help')")
await waitFor(`document.body.dataset.page==='help' && document.querySelector('#verState') && !/正在检测|Checking/.test(document.querySelector('#verState').textContent)`, 20000, '帮助页加载')
await sleep(3200) // let the auto-check toast fade before screenshots
await vp(1440, 900)

const appInfo = await get('/api/app-info')
const state = await evj(`(()=>{
  const q=s=>document.querySelector(s)
  return {
    page:document.body.dataset.page,
    title:q('#pg-help .card-title')?.textContent.replace(/\\s+/g,' ').trim(),
    cards:[...document.querySelectorAll('#pg-help .card-title')].map(x=>x.textContent.replace(/\\s+/g,' ').trim()),
    kbdRows:document.querySelectorAll('#pg-help table tbody tr').length,
    docBlocks:document.querySelectorAll('#pg-help .doc-block').length,
    h3:[...document.querySelectorAll('#pg-help h3')].map(x=>x.textContent.replace(/\\s+/g,' ').trim()),
    h4:[...document.querySelectorAll('#pg-help h4')].map(x=>x.textContent.replace(/\\s+/g,' ').trim()),
    guide:[...document.querySelectorAll('#pg-help button[onclick^="WLGuide.startAndGo"]')].map(x=>({t:x.textContent.trim(),title:x.title})),
    verNow:q('#verNow')?.textContent.trim(),
    verState:q('#verState')?.textContent.trim(),
    verBtn:getComputedStyle(q('#verUpdBtn')).display,
    notes:{show:getComputedStyle(q('#verNotes')).display, text:q('#verNotes')?.textContent.replace(/\\s+/g,' ').trim()},
    fab:{display:getComputedStyle(q('#guide-fab')).display, aria:q('#guide-fab')?.getAttribute('aria-label')},
    grid:getComputedStyle(q('#pg-help .doc-grid')).gridTemplateColumns,
    overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
    raw:[...document.querySelectorAll('#pg-help [data-i18n]')].map(x=>x.textContent.trim()).filter(x=>/^(help|guide|nav)\\./.test(x)),
    docText:q('#pg-help')?.textContent.replace(/\\s+/g,' ').trim(),
    verBox:q('#pg-help .cfg-row')&&(()=>{const r=q('#pg-help .cfg-row').getBoundingClientRect(); return {l:r.left,r:r.right,t:r.top,b:r.bottom,w:r.width}})(),
    checkRect:q('#verChkBtn')&&(()=>{const r=q('#verChkBtn').getBoundingClientRect(); return {l:r.left,r:r.right,t:r.top,b:r.bottom}})(),
    updRect:q('#verUpdBtn')&&(()=>{const r=q('#verUpdBtn').getBoundingClientRect(); return {l:r.left,r:r.right,t:r.top,b:r.bottom}})()
  }
})()`)
check('帮助页已激活', state.page === 'help' && state.title === '快捷键', JSON.stringify({ page: state.page, title: state.title }))
check('帮助页四张主卡齐全', state.cards.length === 4 && state.cards.join('|') === '快捷键|版本与更新|操作引导|帮助文档', state.cards.join('|'))
check('快捷键表 5 行', state.kbdRows === 5, state.kbdRows)
check('帮助文档 6 个模块 / 34 个章节', state.docBlocks === 6 && state.h4.length === 34, `${state.docBlocks}/${state.h4.length}`)
check('六个模块标题完整', state.h3.length === 6 && state.h3.every(Boolean), state.h3.join('|'))
check('帮助页无裸露 i18n key', state.raw.length === 0, state.raw.join(','))
check('帮助页无横向溢出（1440）', state.overflow === 0, state.overflow)
check('1440 文档网格为双列', state.grid.split(' ').filter(Boolean).length === 2, state.grid)
check('版本卡当前版本来自 app-info', state.verNow === (appInfo.version || '') && state.verNow !== '—', `${state.verNow}/${appInfo.version}`)
check('自动检测到 mock 新版本', state.verState.includes('发现新版本') && state.verBtn !== 'none', `${state.verState} / ${state.verBtn}`)
check('更新日志显示且包含验收备注', state.notes.show !== 'none' && state.notes.text.includes('文档公式与真实成品一致性'), state.notes.text)
check('帮助页浮动引导按钮可见且有 aria-label', state.fab.display === 'flex' && state.fab.aria === '操作引导', JSON.stringify(state.fab))
check('版本区按钮在容器内且不互相重叠', state.checkRect.l >= state.verBox.l - 1 && state.checkRect.r <= state.verBox.r + 1 && state.updRect.l >= state.verBox.l - 1 && state.updRect.r <= state.verBox.r + 1 && state.checkRect.r <= state.updRect.l + 1, JSON.stringify({ box: state.verBox, check: state.checkRect, upd: state.updRect }))

// Content correctness: documentation claims, cross-checked with the real generated workbook later.
const dt = state.docText
const includesAll = (list) => list.every(x => dt.includes(x))
check('IFPUG 五类功能点与默认权重文案完整', includesAll(['IFPUG 国际标准功能点估算方法', 'ILF 10、EIF 7、EI 4、EO 5、EQ 4', '母版成品表无复杂度列']))
check('IFPUG 重用/修改/规模变更因子完整', includesAll(['高 1/3、中 2/3、低 1', '新增 1.0、修改 0.8、删除 0.2', '1.39', '1.21', '1.10', '1.00']))
check('预估功能点法权重文案完整', dt.includes('ILF（35）与 EIF（15）'))
check('快速估算两种公式完整', includesAll(['35 × ILF + 15 × EIF', '7 × ILF + 5 × EIF + 4 × EI + 5 × EO + 4 × EQ']))
check('快速估算费率口径完整', dt.includes('174') && dt.includes('1.10') && dt.includes('直接非人力成本'))
check('PERT 预期公式完整', dt.includes('(O + 4M + P) ÷ 6'))
check('PERT 标准差文案完整', dt.includes('标准差 σ = (P − O) ÷ 6') && !dt.includes('方差'))
check('PERT 人月/调节系数/阶段与映射完整', includesAll(['20.83', '客户 0.06', '质量 0.06', '变更 0.05', '进度 0.06', 'R8']))
check('配置中心核心文档完整', includesAll(['data/config.json', '识别规则', '费率与基准', '母版与公式缓存', '应用更新与运维']))
check('通用功能文档完整', includesAll(['GB/T 36964-2018', 'INVEST', 'Markdown / CSV', '暗色', '跟随系统', '不出本机']))
check('帮助页无占位/未翻译内容', !/(TODO|undefined|NaN|help\.[a-z0-9_.]+\s)/i.test(dt), dt.slice(-80))

// Accessibility semantics: headings, names, table headers, keyboard focus and contrast.
const ax = await evj(`(()=>{
  const q=s=>document.querySelector(s), qa=s=>[...document.querySelectorAll(s)]
  const cs=e=>getComputedStyle(e)
  const rgba=s=>{const m=s.match(/rgba?\\(([^)]+)\\)/);if(!m)return {r:0,g:0,b:0,a:1};const p=m[1].split(',').map(Number);return {r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1}}
  const blend=(c,b)=>({r:c.r*c.a+b.r*(1-c.a),g:c.g*c.a+b.g*(1-c.a),b:c.b*c.a+b.b*(1-c.a),a:1})
  const bgOf=el=>{const layers=[];let n=el;while(n&&n!==document.documentElement){const c=rgba(cs(n).backgroundColor);if(c.a>0)layers.push(c);if(c.a===1)break;n=n.parentElement}if(!layers.length||layers[layers.length-1].a<1)layers.push({r:255,g:255,b:255,a:1});let out=layers[layers.length-1];for(let i=layers.length-2;i>=0;i--)out=blend(layers[i],out);return out}
  const lum=c=>{const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b)}
  const contrast=el=>{const bg=bgOf(el);const fg=blend(rgba(cs(el).color),bg);const a=lum(fg),b=lum(bg);return +((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)).toFixed(2)}
  const buttons=qa('#pg-help button, #guide-fab')
  const unnamed=buttons.filter(b=>!((b.getAttribute('aria-label')||b.getAttribute('title')||b.textContent||'').trim()))
  const headings=qa('#pg-help h4')
  const dup=qa('#pg-help .doc-block').flatMap(b=>{const ts=[...b.querySelectorAll('h4')].map(h=>h.textContent.trim());return [...new Set(ts.filter((x,i,a)=>a.indexOf(x)!==i))]})
  const orphan=headings.filter(h=>!h.closest('.doc-block')||!h.closest('.doc-block').querySelector('h3'))
  const emptyBlocks=qa('#pg-help .doc-block').filter(b=>!b.querySelector('p,ul,ol,table'))
  const th=qa('#pg-help table th').map(x=>x.textContent.trim())
  const notFocusable=buttons.filter(b=>b.tabIndex<0||b.disabled)
  const samples=[q('#pg-help .card-title'),q('#pg-help .doc-block p'),q('#verState'),q('#pg-help h4')].filter(Boolean).map(e=>({text:e.textContent.trim().slice(0,24),ratio:contrast(e)}))
  return {buttons:buttons.length,unnamed:unnamed.map(x=>x.id||x.textContent.trim()),h4:headings.length,h3:qa('#pg-help h3').length,dup,orphan:orphan.map(x=>x.textContent.trim()),emptyBlocks:emptyBlocks.length,th,notFocusable:notFocusable.map(x=>x.id||x.textContent.trim()),samples}
})()`)
check('帮助页标题层级与章节归属正确', ax.h3 === 6 && ax.h4 === 34 && ax.orphan.length === 0 && ax.dup.length === 0, JSON.stringify({ h3: ax.h3, h4: ax.h4, orphan: ax.orphan, dup: ax.dup }))
check('帮助页所有章节均有正文内容', ax.emptyBlocks === 0, ax.emptyBlocks)
check('帮助页按钮均有可访问名称', ax.unnamed.length === 0, JSON.stringify(ax.unnamed))
check('快捷键表具备表头语义', ax.th.length > 0 && ax.th.every(Boolean), JSON.stringify(ax.th))
check('帮助页交互控件均可键盘聚焦', ax.buttons > 0 && ax.notFocusable.length === 0, JSON.stringify(ax.notFocusable))
check('关键正文与状态文本对比度 >= 4.5', ax.samples.length >= 3 && ax.samples.every(x => x.ratio >= 4.5), JSON.stringify(ax.samples))

await ev("document.querySelector('#verChkBtn').focus()")
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }, S)
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }, S)
await sleep(150)
const tabbed = await evj(`(()=>{const e=document.activeElement;return {id:e.id,tag:e.tagName,visible:!!(e.offsetWidth||e.offsetHeight)}})()`)
check('版本区键盘 Tab 可正常切换焦点', tabbed.id !== 'verChkBtn' && tabbed.visible, JSON.stringify(tabbed))

await shot('00_help_zh_1440.png')
await scrollTo('#pg-help .doc-grid')
await shot('01_help_docs_1440.png')
await ev(`scrollTo({top:0,behavior:'instant'})`)

// Manual check and toast.
await click('#verChkBtn'); await sleep(1400)
const manualToast = await text('#toast')
check('手动检查更新给出可读提示', manualToast.includes('发现新版本'), manualToast)
check('手动检查后仍为 found 态', (await text('#verState')).includes('发现新版本'))

// Download failure offers retry, then retry succeeds without leaving a stale state.
mockPkgFail = true
await click('#verUpdBtn')
await waitFor(`getComputedStyle(document.querySelector('#verRetryBtn')).display!=='none'`, 15000, 'download failed')
const dlFail = await evj(`({txt:document.querySelector('#verProgTxt').textContent, install:getComputedStyle(document.querySelector('#verInstallBtn')).display, retry:getComputedStyle(document.querySelector('#verRetryBtn')).display})`)
check('下载失败显示重试且不显示安装', dlFail.retry !== 'none' && dlFail.install === 'none', JSON.stringify(dlFail))
check('下载失败给出可读原因', /失败|错误|error/i.test(dlFail.txt), dlFail.txt)
await shot('02_help_update_fail.png')
mockPkgFail = false
await click('#verRetryBtn')
await waitFor(`document.querySelector('#verProgWrap').style.display!=='none'`, 8000, 'retry started')
await waitFor(`document.querySelector('#verProgPct').textContent.includes('100%') && getComputedStyle(document.querySelector('#verInstallBtn')).display!=='none'`, 22000, 'retry complete')
const dl = await evj(`({pct:document.querySelector('#verProgPct').textContent, txt:document.querySelector('#verProgTxt').textContent, bar:document.querySelector('#verProgBar').style.width, install:document.querySelector('#verInstallBtn').style.display, retry:document.querySelector('#verRetryBtn').style.display})`)
check('下载进度到 100% 且进度条充满', dl.pct.includes('100%') && dl.bar === '100%', JSON.stringify(dl))
check('下载完成显示安装按钮且隐藏重试', dl.install !== 'none' && dl.retry === 'none', JSON.stringify(dl))
const dlFile = path.join(DATA, 'downloads', 'update-setup.exe')
check('下载包落盘且大小匹配 mock', fs.existsSync(dlFile) && fs.statSync(dlFile).size === mockPkg.length, fs.existsSync(dlFile) ? fs.statSync(dlFile).size : 'missing')
await shot('02_help_update_progress.png')
const confirmMsg = await ev(`(()=>{window.__helpConfirm='';window.confirm=(m)=>{window.__helpConfirm=m;return false};document.querySelector('#verInstallBtn').click();return window.__helpConfirm})()`)
check('安装按钮弹出确认且不自动安装', confirmMsg.includes('安装') && confirmMsg.includes('配置'), confirmMsg)
const afterCancel = await evj(`({page:document.body.dataset.page, install:getComputedStyle(document.querySelector('#verInstallBtn')).display, txt:document.querySelector('#verProgTxt').textContent})`)
check('取消安装后停留在帮助页且未启动安装', afterCancel.page === 'help' && afterCancel.install !== 'none' && !/安装程序/.test(afterCancel.txt), JSON.stringify(afterCancel))

// Up-to-date state.
mockVersion = appInfo.version
await click('#verChkBtn'); await sleep(1200)
check('无新版本时显示已是最新', (await text('#verState')).includes('已是最新版本'))
check('无新版本时隐藏立即更新', (await ev(`getComputedStyle(document.querySelector('#verUpdBtn')).display`)) !== 'none' ? false : true)
check('无新版本时隐藏更新日志', (await ev(`getComputedStyle(document.querySelector('#verNotes')).display`)) === 'none')

// Failure state: unreachable custom source. Stale notes must not remain visible.
mockVersion = '0.1.20990101-999'
await post('/api/update/config', { update_url: 'http://127.0.0.1:8091/update.json' })
await click('#verChkBtn'); await waitFor(`!document.querySelector('#verState').textContent.includes('检测中')`, 15000, 'failure settled')
const failState = await text('#verState')
check('不可达更新源给出可读失败状态', /检测失败|检查失败|连接失败/.test(failState) && (await ev(`getComputedStyle(document.querySelector('#verUpdBtn')).display`)) === 'none', failState)
check('更新失败后不残留旧更新日志', (await ev(`getComputedStyle(document.querySelector('#verNotes')).display`)) === 'none', await text('#verNotes'))
await shot('03_help_update_error.png')

// off state.
await post('/api/update/config', { update_url: 'off' })
await click('#verChkBtn'); await waitFor(`!document.querySelector('#verState').textContent.includes('检测中')`, 8000, 'off settled')
check('off 更新源显示停用状态', /停用|关闭|已停用/.test(await text('#verState')), await text('#verState'))

// Restore mock source and refresh state.
await post('/api/update/config', { update_url: 'http://127.0.0.1:8099/update.json' })
mockVersion = '0.1.20990101-999'
await send('Page.reload', {}, S)
await waitFor(`document.readyState!=='loading' && typeof goPage==='function'`, 15000, 'reload app')
await ev("goPage('help')")
await waitFor(`document.body.dataset.page==='help'`, 8000, 'reload help')
await waitFor(`document.querySelector('#verState') && !/正在检测/.test(document.querySelector('#verState').textContent)`, 12000, 'reload check')
await sleep(2600)
check('恢复更新源后重新检测到新版本', (await text('#verState')).includes('发现新版本'))

// Responsive widths and content positions.
for (const [w, h, name] of [[1024, 900, '04_help_1024.png'], [768, 900, '05_help_768.png'], [375, 812, '06_help_375.png']]) {
  await vp(w, h)
  const x = await evj(`({overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth, cols:getComputedStyle(document.querySelector('#pg-help .doc-grid')).gridTemplateColumns, card:document.querySelector('#pg-help .doc-grid').getBoundingClientRect().width, vw:innerWidth})`)
  check(`帮助页 ${w}px 无横向溢出`, x.overflow === 0, JSON.stringify(x))
  check(`帮助页 ${w}px 文档网格单列`, x.cols.split(' ').filter(Boolean).length === 1, x.cols)
  await shot(name)
}
await vp(375, 812)
const v375 = await evj(`(()=>{const q=s=>document.querySelector(s);const v=q('#pg-help .cfg-row')?.getBoundingClientRect();const a=q('#verChkBtn')?.getBoundingClientRect();const b=q('#verUpdBtn')?.getBoundingClientRect();const f=q('#guide-fab')?.getBoundingClientRect();return {box:v&&{l:v.left,r:v.right,t:v.top,b:v.bottom},check:a&&{l:a.left,r:a.right,t:a.top,b:a.bottom},upd:b&&{l:b.left,r:b.right,t:b.top,b:b.bottom},fab:f&&{l:f.left,r:f.right,b:f.bottom},vw:innerWidth,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth}})()`)
const overlap = v375.check && v375.upd && !(v375.check.l < v375.upd.r && v375.check.r > v375.upd.l && v375.check.t < v375.upd.b && v375.check.b > v375.upd.t)
const sameRow = v375.check && v375.upd && Math.abs(v375.check.t - v375.upd.t) <= 2
check('375 版本区按钮不越界/不重叠且同一行', v375.check && v375.upd && v375.check.l >= v375.box.l - 1 && v375.check.r <= v375.box.r + 1 && v375.upd.l >= v375.box.l - 1 && v375.upd.r <= v375.box.r + 1 && overlap && sameRow, JSON.stringify(v375))
check('375 引导浮动按钮在视口内', v375.fab && v375.fab.r <= v375.vw && v375.fab.l >= 0 && v375.fab.b <= 812, JSON.stringify(v375.fab))

// Explicit guide tests at desktop and mobile.
const openGuide = async (page, title, count) => {
  await click(page); await waitFor(`!!document.querySelector('.guide-card')`, 8000, 'guide open: ' + title)
  const g = await evj(`({title:document.querySelector('.guide-card h4')?.textContent.trim(),dots:document.querySelectorAll('.guide-card .g-dot').length,desc:document.querySelector('.guide-card .g-desc')?.textContent.replace(/\\s+/g,' ').trim(),page:document.body.dataset.page})`)
  check(`引导「${title}」打开`, g.title.includes(title) && g.dots === count && g.page === page.match(/'(\w+)'/)?.[1], JSON.stringify(g))
  return g
}
await vp(1440, 900); await ev("goPage('help')"); await sleep(400)
await click('#guide-fab'); await waitFor(`!!document.querySelector('.guide-card')`, 8000, 'fab guide')
let g = await evj(`({title:document.querySelector('.guide-card h4')?.textContent.trim(),dots:document.querySelectorAll('.guide-card .g-dot').length,desc:document.querySelector('.guide-card .g-desc')?.textContent.replace(/\\s+/g,' ').trim(),rect:(()=>{const r=document.querySelector('.guide-card').getBoundingClientRect();return {l:r.left,r:r.right,t:r.top,b:r.bottom}})()})`)
check('浮动按钮打开功能总览引导', g.title.includes('IFPUG') && g.dots === 5, JSON.stringify(g))
check('引导卡在 1440 视口内', g.rect.l >= 0 && g.rect.r <= 1440 && g.rect.b <= 900, JSON.stringify(g.rect))
await click('.guide-card button[data-act="next"]'); await sleep(250)
check('引导下一步切换', (await text('.guide-card h4')).includes('PERT'), await text('.guide-card h4'))
await click('.guide-card button[data-act="prev"]'); await sleep(250)
check('引导后退回到首步', (await text('.guide-card h4')).includes('IFPUG'), await text('.guide-card h4'))
await click('.guide-card button[data-act="auto"]'); await sleep(2400)
check('引导自动播放推进', (await text('.guide-card h4')).includes('PERT') || (await text('.guide-card button[data-act="auto"]')).includes('暂停'), await text('.guide-card h4'))
await click('.guide-card button[data-act="skip"]'); await sleep(250)
check('跳过引导关闭浮层', !(await ev(`!!document.querySelector('.guide-card')`)))

// All five help entry buttons navigate and open the relevant guide.
const guideCases = [
  ['IFPUG 估算引导', 'work', '① 上传需求', 4],
  ['PERT 估算引导', 'pert', 'PERT 三点估算', 4],
  ['快速估算引导', 'fast', 'NESMA 快速估算', 3],
  ['配置中心引导', 'config', '配置中心', 1],
  ['功能总览引导', 'help', '① IFPUG 估算', 5]
]
for (const [label, page, title, count] of guideCases) {
  await ev("goPage('help')"); await sleep(450)
  await ev(`(()=>{const b=[...document.querySelectorAll('#pg-help button')].find(x=>x.textContent.trim()===${JSON.stringify(label)});if(!b)return false;b.click();return true})()`)
  await waitFor(`document.body.dataset.page===${JSON.stringify(page)}`, 8000, 'guide nav ' + page)
  await waitFor(`!!document.querySelector('.guide-card')`, 8000, 'guide card ' + page)
  g = await evj(`({title:document.querySelector('.guide-card h4')?.textContent.trim(),dots:document.querySelectorAll('.guide-card .g-dot').length,page:document.body.dataset.page})`)
  check(`帮助页入口「${label}」`, g.title.includes(title) && g.dots === count && g.page === page, JSON.stringify(g))
  if (page === 'pert') {
    const texts = [await text('.guide-card')]
    for (let i = 0; i < count - 1; i++) {
      await click('.guide-card button[data-act="next"]'); await sleep(180)
      texts.push(await text('.guide-card'))
    }
    const pt = texts.join(' ')
    check('PERT 引导使用标准差口径', pt.includes('标准差') && !pt.includes('方差'), texts.map(x => x.slice(0, 60)).join(' / '))
  }
  await click('.guide-card button[data-act="skip"]'); await sleep(250)
}

// Mobile guide card must fit, including box-sizing/padding.
await vp(375, 812); await ev("goPage('help')"); await sleep(500)
await click('#guide-fab'); await waitFor(`!!document.querySelector('.guide-card')`, 8000, 'mobile guide')
const gm = await evj(`(()=>{const r=document.querySelector('.guide-card').getBoundingClientRect();const c=document.querySelector('.guide-card .g-ctrls')?.getBoundingClientRect();return {l:r.left,r:r.right,t:r.top,b:r.bottom,w:r.width,h:r.height,vw:innerWidth,vh:innerHeight,ctrl:c&&{l:c.left,r:c.right,b:c.bottom},overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth}})()`)
check('375 引导卡不越界', gm.l >= 0 && gm.r <= gm.vw + 0.5 && gm.b <= gm.vh + 0.5, JSON.stringify(gm))
check('375 引导操作按钮在卡内', gm.ctrl && gm.ctrl.l >= gm.l && gm.ctrl.r <= gm.r && gm.ctrl.b <= gm.b, JSON.stringify(gm.ctrl))
await shot('07_help_guide_375.png')
await click('.guide-card button[data-act="skip"]'); await sleep(300)

// English UI and guide translation.
await vp(1440, 900); await ev("goPage('help')"); await ev("setLang('en-US')")
await waitFor(`[...document.querySelectorAll('#pg-help .doc-grid *')].every(x=>!/[\\u4e00-\\u9fff]/.test(x.textContent))`, 6000, 'english settled').catch(()=>{})
await sleep(150)
const en = await evj(`(()=>{
  const q=s=>document.querySelector(s)
  return {docText:q('#pg-help .doc-grid')?.textContent.replace(/\\s+/g,' ').trim(),
  h3:[...document.querySelectorAll('#pg-help h3 span[data-i18n]')].map(x=>x.textContent.replace(/\\s+/g,' ').trim()),
  kbd:[...document.querySelectorAll('#pg-help table th')].map(x=>x.textContent.trim()),
  ver:q('#verState')?.textContent.trim(), fab:q('#guide-fab')?.getAttribute('aria-label'),
  guide:[...document.querySelectorAll('#pg-help button[onclick^="WLGuide.startAndGo"]')].map(x=>x.textContent.trim()),
  raw:[...document.querySelectorAll('#pg-help [data-i18n]')].map(x=>x.textContent.trim()).filter(x=>/^(help|guide|nav)\\./.test(x)),
  overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth}
})()`)
check('英文帮助六模块标题', en.h3.join('|') === 'Methodology|Algorithms|Quick Estimate|Three-Point Estimation|Settings and AI Assistance|General Features', en.h3.join('|'))
check('英文快捷键表头', en.kbd.join('|') === 'Key|Action|Scope', en.kbd.join('|'))
check('英文帮助按钮翻译', en.guide.join('|') === 'IFPUG Walkthrough|PERT Walkthrough|Quick estimate guide|Settings Walkthrough|Overview Walkthrough', en.guide.join('|'))
check('英文帮助浮动按钮 aria', en.fab === 'Walkthrough Guide', en.fab)
check('英文帮助正文无中文', !/[\u4e00-\u9fff]/.test(en.docText), en.docText.slice(0, 160))
check('英文帮助无裸 key/溢出', en.raw.length === 0 && en.overflow === 0, JSON.stringify({ raw: en.raw, overflow: en.overflow }))
check('切换英文后 html lang 同步', (await ev('document.documentElement.lang')) === 'en-US', await ev('document.documentElement.lang'))
await shot('08_help_en_1440.png')
await click('#guide-fab'); await waitFor(`!!document.querySelector('.guide-card')`, 8000, 'en guide')
check('英文引导标题与按钮', (await text('.guide-card h4')).includes('IFPUG') && (await text('.guide-card')).includes('Next') && (await text('.guide-card')).includes('Skip'), await text('.guide-card'))
await click('.guide-card button[data-act="skip"]'); await ev("setLang('zh-CN')"); await sleep(700)
check('切回中文后帮助页结构恢复', (await text('#pg-help .card-title')) === '快捷键' && (await ev(`document.querySelectorAll('#pg-help .doc-block').length`)) === 6)

// Final page state and screenshot.
await vp(1440, 900); await ev("goPage('help')"); await sleep(500); await shot('09_help_final_1440.png')

const unexpected = errors.filter(x => !/8091|ERR_|Failed to fetch|net::/.test(x))
check('无未捕获 JS 异常', unexpected.length === 0, unexpected.join(' | '))

const evidence = {
  app: APP, version: appInfo.version, doc: DOC, docName,
  baseline: { count: rec0.items?.length || 0, counts: c0, ufp: (rec0.items || []).reduce((s, x) => s + ({ ILF: 10, EIF: 7, EI: 4, EO: 5, EQ: 4 }[x.type] || 0), 0), workbook: genPath, size: genPath ? fs.statSync(genPath).size : 0 },
  update: { mockVersion, notes: mockNotes, downloaded: dlFile, installConfirm: confirmMsg },
  final: { state: await text('#verState'), page: await ev('document.body.dataset.page'), overflow: await ev('document.documentElement.scrollWidth-document.documentElement.clientWidth') },
  results, errors: unexpected,
  screenshots: fs.readdirSync(OUT).filter(x => x.endsWith('.png'))
}
fs.writeFileSync(path.join(OUT, 'ui_results.json'), JSON.stringify(evidence, null, 2), 'utf8')
console.log(`SUMMARY ${results.filter(x => x.ok).length}/${results.length}`)
mock.close(); ws.close()
setTimeout(() => process.exit(results.every(x => x.ok) ? 0 : 1), 200)

