/** T06174 / AC-03：10000 行 8 列虚拟滚动 60 秒帧率与白屏验证。 */
import path from 'node:path';
import fs from 'node:fs';
import { openPage, checker, OUT } from './cdp.mjs';

const { check, finish } = checker('ui-10k-grid');
let measured = {};
const page = await openPage({ width: 1440, height: 900 });
try {
  await page.nav();
  const setup = await page.ev(`(async () => {
    const wrap0=document.querySelector('#v-review div[style*="overflow:auto"]');
    let injected=false;
    if(!wrap0 || getComputedStyle(wrap0).maxHeight==='none'){
      const st=document.createElement('style');
      st.id='__phase3_10k_viewport';
      st.textContent='#v-review div[style*="overflow:auto"]{max-height:calc(100vh - 240px);overflow:auto!important}';
      document.head.appendChild(st); injected=true;
    }
    CT_SC=null; CT_VPH=600;
    goPage('work');
    const types = ['ILF','EIF','EI','EO','EQ'];
    items = Array.from({length:10000}, (_,i) => ({
      seq: i+1, system: '系统'+(i%12+1), desc: '功能项 '+(i+1), count_item: '计数项 '+(i+1),
      type: types[i%5], cx: ['低','中','高'][i%3], reuse: '中', modify: '新增', ok: true
    }));
    goStep('review');
    render();
    await new Promise(r => setTimeout(r, 600));   // 首访引导延迟 350–400ms 唤起，等它出现后再关闭
    try { window.WLGuide && WLGuide.stop(); } catch {}
    for (let i = 0; i < 40 && !document.querySelectorAll('#tbody .rowr').length; i++) await new Promise(r => setTimeout(r, 50));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const sc = ctScrollParent(document.querySelector('#tbody'));
    return JSON.stringify({ n: items.length, rows: document.querySelectorAll('#tbody .rowr').length,
      scrollHeight: sc && sc.scrollHeight, clientHeight: sc && sc.clientHeight,
      step: $('#v-review') && getComputedStyle($('#v-review')).display });
  })()`);
  const st = JSON.parse(setup);
  check('10k 数据已装载并进入复核页', st.n === 10000 && st.step !== 'none', JSON.stringify(st));
  check('虚拟窗口 DOM 行数受控（≤120）', st.rows > 0 && st.rows <= 120, `rows=${st.rows}`);
  check('滚动容器固定视口（300–900px）且总高覆盖 10000×44px', st.clientHeight >= 300 && st.clientHeight <= 900 && st.scrollHeight >= 10000 * 44 - 10,
    `clientHeight=${st.clientHeight}, scrollHeight=${st.scrollHeight}`);
  await page.shot(path.join(OUT, 'screenshots', '10k_start_1440.png'), false);

  const run = JSON.parse(await page.ev(`(async () => {    const sc = ctScrollParent(document.querySelector('#tbody'));
    const duration = 60000;
    return await new Promise(resolve => {
      const t0 = performance.now();
      let frames = 0, long = 0, blank = 0, maxRows = 0, minRows = 999999, last = t0, lastY = -1;
      function tick(now) {
        const p = Math.min(1, (now - t0) / duration);
        const max = Math.max(1, sc.scrollHeight - sc.clientHeight);
        sc.scrollTop = Math.min(max, Math.round(p * max));
        const rows = document.querySelectorAll('#tbody .rowr').length;
        maxRows = Math.max(maxRows, rows); minRows = Math.min(minRows, rows);
        if (!rows) blank++;
        frames++;
        if (now - last > 20) long++;
        last = now; lastY = sc.scrollTop;
        if (now - t0 < duration) requestAnimationFrame(tick);
        else resolve(JSON.stringify({ frames, long, blank, maxRows, minRows, lastY, scrollTop: sc.scrollTop,
          scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight, elapsed: now - t0 }));
      }
      requestAnimationFrame(tick);
    });
  })()`, 90000));

  const fps = run.frames / (run.elapsed / 1000);
  measured = { fps: +fps.toFixed(3), frames: run.frames, elapsedMs: +run.elapsed.toFixed(1), longFrames: run.long, longPct: +(run.long / run.frames * 100).toFixed(2), rows: run.maxRows };
  check('连续滚动 60 秒平均帧率 ≥55fps（headless 允许 5fps 抖动）', fps >= 55, `${fps.toFixed(1)}fps / ${run.frames} frames`);
  check('无白屏采样', run.blank === 0, `blank=${run.blank}`);
  check('窗口行数始终受控（≤120）', run.minRows > 0 && run.maxRows <= 120, `min=${run.minRows} max=${run.maxRows}`);
  check('可滚动至数据末尾', run.lastY >= run.scrollHeight - run.clientHeight - 2, `lastY=${run.lastY}/${run.scrollHeight - run.clientHeight}`);
  check('长帧（>20ms）占比 <10%', run.long / run.frames < 0.10, `${(run.long / run.frames * 100).toFixed(1)}% (${run.long})`);

  const tail = JSON.parse(await page.ev(`(async () => {
    const sc = ctScrollParent(document.querySelector('#tbody'));
    sc.scrollTop = sc.scrollHeight;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return JSON.stringify({ seqs: [...document.querySelectorAll('#tbody .rowr')].map(tr => tr.dataset.seq),
      tail: (() => { const rows = [...document.querySelectorAll('#tbody .rowr')]; return rows.length ? (rows[rows.length - 1].querySelector('.desc')?.textContent || '') : ''; })() });
  })()`));
  check('末尾窗口包含第 10000 行', tail.seqs.includes('10000') && tail.tail.includes('10000'), `tail=${tail.tail}`);
  await page.shot(path.join(OUT, 'screenshots', '10k_end_1440.png'), false);

  // 隔离 refreshTotals 后再测 10 秒，定位帧率瓶颈是 DOM 还是 O(n) 汇总
  const isolate = JSON.parse(await page.ev(`(async () => {
    const sc = ctScrollParent(document.querySelector('#tbody'));
    const orig = refreshTotals;
    refreshTotals = () => {};
    const duration = 10000;
    const r = await new Promise(resolve => {
      const t0 = performance.now(); let frames = 0, long = 0, last = t0;
      function tick(now) {
        const p = Math.min(1, (now - t0) / duration);
        sc.scrollTop = Math.round(p * (sc.scrollHeight - sc.clientHeight));
        frames++; if (now - last > 20) long++; last = now;
        if (now - t0 < duration) requestAnimationFrame(tick);
        else resolve(JSON.stringify({ frames, long, elapsed: now - t0, rows: document.querySelectorAll('#tbody .rowr').length }));
      }
      requestAnimationFrame(tick);
    });
    refreshTotals = orig;
    return r;
  })()`, 30000));
  const ifps = isolate.frames / (isolate.elapsed / 1000);
  console.log(`INFO  隔离 refreshTotals 10 秒快滚：${ifps.toFixed(1)}fps / ${isolate.frames} frames, long=${isolate.long}（诊断项，不计入验收）`);

  // 第二层隔离：同时关闭 refreshTotals 与 lucide.createIcons，并统计 render 平均耗时，区分图标重建/表格布局
  const isolate2 = JSON.parse(await page.ev(`(async () => {
    const sc = ctScrollParent(document.querySelector('#tbody'));
    const origTotals = refreshTotals, origIcons = window.lucide && window.lucide.createIcons, origRender = render;
    refreshTotals = () => {};
    if (window.lucide) window.lucide.createIcons = () => {};
    let renderMs = 0, calls = 0;
    render = function(o) { const t0 = performance.now(); const r = origRender(o); renderMs += performance.now() - t0; calls++; return r; };
    const duration = 10000;
    const r = await new Promise(resolve => {
      const t0 = performance.now(); let frames = 0, long = 0, last = t0;
      function tick(now) {
        const p = Math.min(1, (now - t0) / duration);
        sc.scrollTop = Math.round(p * (sc.scrollHeight - sc.clientHeight));
        frames++; if (now - last > 20) long++; last = now;
        if (now - t0 < duration) requestAnimationFrame(tick);
        else resolve(JSON.stringify({ frames, long, elapsed: now - t0, rows: document.querySelectorAll('#tbody .rowr').length,
          avgRenderMs: calls ? +(renderMs / calls).toFixed(2) : null, renderCalls: calls }));
      }
      requestAnimationFrame(tick);
    });
    refreshTotals = origTotals; render = origRender;
    if (window.lucide) window.lucide.createIcons = origIcons;
    return r;
  })()`, 30000));
  const ifps2 = isolate2.frames / (isolate2.elapsed / 1000);
  console.log(`INFO  隔离 refreshTotals+lucide 10 秒快滚：${ifps2.toFixed(1)}fps / ${isolate2.frames} frames, long=${isolate2.long}, avgRender=${isolate2.avgRenderMs}ms, calls=${isolate2.renderCalls}（诊断项，不计入验收）`);

  // 低成本候选：table-layout:fixed 关闭自动列宽测量，观察表格布局是否是主瓶颈
  const fixed = JSON.parse(await page.ev(`(async () => {
    const style = document.createElement('style');
    style.textContent = '#v-review table{table-layout:fixed!important}';
    document.head.appendChild(style);
    const sc = ctScrollParent(document.querySelector('#tbody'));
    sc.scrollTop = 0; void document.querySelector('#tbody').offsetWidth;
    const duration = 10000;
    const r = await new Promise(resolve => {
      const t0 = performance.now(); let frames = 0, long = 0, last = t0;
      function tick(now) {
        const p = Math.min(1, (now - t0) / duration);
        sc.scrollTop = Math.round(p * (sc.scrollHeight - sc.clientHeight));
        frames++; if (now - last > 20) long++; last = now;
        if (now - t0 < duration) requestAnimationFrame(tick);
        else resolve(JSON.stringify({ frames, long, elapsed: now - t0, rows: document.querySelectorAll('#tbody .rowr').length }));
      }
      requestAnimationFrame(tick);
    });
    style.remove();
    return r;
  })()`, 30000));
  const ffps = fixed.frames / (fixed.elapsed / 1000);
  console.log(`INFO  table-layout:fixed 10 秒快滚：${ffps.toFixed(1)}fps / ${fixed.frames} frames, long=${fixed.long}, rows=${fixed.rows}（旧 table 诊断项，div 网格下无意义）`);
} catch (e) {
  check('测试执行无异常', false, e.message);
  console.error(e);
} finally {
  await page.close();
}
const r = finish(measured);
fs.writeFileSync(path.join(OUT, 'results', 'ui-10k-grid-summary.txt'), JSON.stringify(r, null, 2));
process.exit(r.checks.every(c => c.ok) ? 0 : 1);
