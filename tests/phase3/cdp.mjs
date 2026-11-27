/** 三期验证共用 CDP 客户端：连接隔离实例 8033 + 无头 Chrome 9335。
 *  仅依赖 Node 内置 fetch/WebSocket，不引入 Playwright。
 */
import fs from 'node:fs';
import path from 'node:path';

export const APP = process.env.PHASE3_APP || 'http://127.0.0.1:8033/';
export const CDP = process.env.PHASE3_CDP || 'http://127.0.0.1:9335';
export const OUT = path.resolve('docs/test-reports/phase3-20261122');
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function openPage({ width = 1440, height = 900, cdp = CDP } = {}) {
  const target = await (await fetch(`${cdp}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket((await (await fetch(`${cdp}/json/version`)).json()).webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let id = 0; const pend = new Map(); const exceptions = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id); pend.delete(m.id);
      m.error ? p.no(new Error(JSON.stringify(m.error))) : p.ok(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      exceptions.push(m.params?.exceptionDetails?.exception?.description || 'exception');
    }
  };
  const send = (method, params, sessionId, timeout = 30000) => {
    params = params || {};
    const i = ++id;
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((ok, no) => {
      pend.set(i, { ok, no });
      setTimeout(() => { if (pend.has(i)) { pend.delete(i); no(new Error(`cdp timeout: ${method}`)); } }, timeout);
    });
  };
  const S = (await send('Target.attachToTarget', { targetId: target.id, flatten: true })).sessionId;
  await send('Page.enable', {}, S);
  await send('Runtime.enable', {}, S);
  await send('DOM.enable', {}, S);
  await send('Accessibility.enable', {}, S);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, S);

  const ev = async (expression, timeout = 30000) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, S, timeout);
    if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  };
  const nav = async (url = APP, ready = `typeof goPage === 'function'`) => {
    // T06183：既有回归默认跳过首次启动角色引导；角色引导套件显式传 ?welcome=1。
    let targetUrl = url;
    try {
      const u = new URL(url);
      if (u.origin === new URL(APP).origin && !u.searchParams.has('welcome')) {
        u.searchParams.set('welcome', '0');
        targetUrl = u.toString();
      }
    } catch (e) { /* 非绝对 URL 保持原样 */ }
    await send('Page.navigate', { url: targetUrl }, S);
    for (let i = 0; i < 80; i++) {
      if (await ev(`document.readyState !== 'loading' && (${ready})`)) return;
      await sleep(250);
    }
    throw new Error(`页面未就绪: ${targetUrl}`);
  };
  const shot = async (file, fullPage = true) => {
    const data = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage }, S);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(data.data, 'base64'));
    return file;
  };
  const close = async () => { try { await send('Target.closeTarget', { targetId: target.id }); } catch { /* noop */ } try { ws.close(); } catch { /* noop */ } };
  return { send, ev, nav, shot, close, exceptions, S, target };
}

export function checker(name) {
  const checks = [];
  const check = (title, ok, detail = '') => {
    checks.push({ title, ok: !!ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${title}${detail ? '  — ' + detail : ''}`);
  };
  const finish = (extra = {}) => {
    fs.mkdirSync(path.join(OUT, 'results'), { recursive: true });
    const result = { suite: name, at: new Date().toISOString(), checks, pass: checks.filter(c => c.ok).length, total: checks.length, ...extra };
    fs.writeFileSync(path.join(OUT, 'results', `${name}.json`), JSON.stringify(result, null, 2));
    console.log(`\n${name}: ${result.pass}/${result.total} checks passed`);
    if (result.pass !== result.total) process.exitCode = 1;
    return result;
  };
  return { check, finish, checks };
}

export async function loadAxe(page) {
  const src = fs.readFileSync(path.resolve('tests/phase3/vendor/axe.min.js'), 'utf8');
  await page.ev(`(() => { ${src}; return typeof axe !== 'undefined'; })()`);
  return page.ev(`typeof axe !== 'undefined' && typeof axe.run === 'function'`);
}

export async function axeAudit(page, label) {
  // 只跑 WCAG A/AA；blockers 定义为 critical/serious（axe 的 impact 分级）
  const raw = await page.ev(`(async () => {
    const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa'] } });
    return JSON.stringify({ violations: r.violations.map(v => ({ id:v.id, impact:v.impact, help:v.help, nodes:v.nodes.length, targets:v.nodes.slice(0,3).map(n=>n.target) })), passes: r.passes.length, incomplete: r.incomplete.length });
  })()`);
  return { label, ...JSON.parse(raw) };
}
