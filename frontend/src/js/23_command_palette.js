/* T06184 / AC-17：Ctrl/Cmd+K 命令面板
   验收口径：
   - 任意页面按 Ctrl/Cmd+K（两次按键：Ctrl + K）打开；
   - 索引完全本地，搜索走过一次内存过滤，输入到出结果 ≤200ms；
   - 支持「最近使用」和「收藏」（localStorage 持久化）；
   - 结果覆盖页面导航、当前 IFPUG 功能项、PERT 项目与常用操作；
   - 选中功能项后回到审核页并定位到对应行，选中 PERT 项目后直接切换项目。
   实现约束：不引入新依赖、不发网络搜索；项目列表只在后台预取一次，失败静默降级。 */
(() => {
  const MAX_RESULTS = 60, MAX_RECENT = 8, MAX_ITEMS_EMPTY = 12, MAX_FAV = 10;
  const LS_RECENT = 'we_cmd_recent', LS_FAV = 'we_cmd_fav';
  const $ = sel => document.querySelector(sel);
  let el, panel, input, list, latencyEl;
  let isOpen = false, entries = [], visible = [], active = 0, query = '';
  let builtFor = null, projects = [], projectFetching = false;
  let lastFocus = null, chromeLang = '';

  const TEXT = {
    'zh-CN': {
      dialog: '命令面板', placeholder: '搜索页面、功能项或项目…',
      ariaSearch: '搜索页面、功能项或项目', ariaList: '命令与搜索结果',
      fav: '收藏', recent: '最近', pages: '页面', items: '当前功能项',
      projects: 'PERT 项目', actions: '操作', results: '搜索结果',
      empty: '没有匹配结果', emptyHint: '试试页面名、功能项编号、系统名或项目名',
      select: '选择', run: '执行', favorite: '收藏', unfavorite: '取消收藏',
      page: '页面', item: '功能项', project: '项目', action: '操作',
      history: '打开估算历史', noItems: '（尚未识别功能项）', latency: '搜索耗时'
    },
    'en-US': {
      dialog: 'Command palette', placeholder: 'Search pages, function items or projects…',
      ariaSearch: 'Search pages, function items or projects', ariaList: 'Commands and search results',
      fav: 'Favorites', recent: 'Recent', pages: 'Pages', items: 'Current function items',
      projects: 'PERT projects', actions: 'Actions', results: 'Results',
      empty: 'No matching result', emptyHint: 'Try a page name, item number, system or project name',
      select: 'Select', run: 'Run', favorite: 'Favorite', unfavorite: 'Remove favorite',
      page: 'Page', item: 'Item', project: 'Project', action: 'Action',
      history: 'Open estimate history', noItems: '(no function items yet)', latency: 'Search'
    }
  };
  const PAGE_DEFS = [
    ['work', 'IFPUG 估算', 'IFPUG estimate', 'calculator', '上传需求 → 审核功能点 → 生成造价表', 'upload review result function point'],
    ['pert', 'PERT 估算', 'PERT estimate', 'activity', '三点估算：乐观/最可能/悲观', 'pert optimistic likely pessimistic'],
    ['fast', '快速估算', 'Quick estimate', 'zap', 'NESMA 预估/估算法', 'nesma quick ilf eif'],
    ['config', '配置中心', 'Configuration', 'settings', '大模型识别增强与费率规则', 'config llm rules rates'],
    ['help', '帮助文档', 'Help', 'book-open', '评估方法论与计算算法说明', 'help docs guide']
  ];
  const ICONS = { page: 'layout-grid', item: 'list-checks', project: 'folder-open', action: 'command' };

  function lang() {
    const raw = (typeof __I18N_LANG !== 'undefined' && __I18N_LANG) ||
      localStorage.getItem('wl_lang') || document.documentElement.lang || 'zh-CN';
    return String(raw).toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN';
  }
  function s(k) { return TEXT[lang()][k] || TEXT['zh-CN'][k] || k; }
  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function readArr(key) {
    try { const v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; }
    catch { return []; }
  }
  function writeArr(key, arr) { try { localStorage.setItem(key, JSON.stringify(arr.slice(0, 30))); } catch { /* 隐私模式静默降级 */ } }
  function addRecent(id) {
    const arr = readArr(LS_RECENT).filter(x => x !== id);
    arr.unshift(id); writeArr(LS_RECENT, arr);
  }
  function isFav(id) { return readArr(LS_FAV).includes(id); }
  function toggleFav(id) {
    const arr = readArr(LS_FAV);
    const i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1); else arr.unshift(id);
    writeArr(LS_FAV, arr);
    render();
  }

  function buildEntries() {
    const L = lang();
    const out = [];
    const pageLabel = idx => L === 'zh-CN' ? PAGE_DEFS[idx][1] : PAGE_DEFS[idx][2];
    const pageSub = idx => L === 'zh-CN' ? PAGE_DEFS[idx][4] : PAGE_DEFS[idx][5];
    PAGE_DEFS.forEach((p, i) => out.push({
      id: 'page:' + p[0], kind: 'page', label: pageLabel(i), sub: s('page') + ' · ' + pageSub(i),
      icon: p[3], keywords: p[0] + ' ' + p[5] + ' ' + p[1] + ' ' + p[2],
      run: () => goPage(p[0])
    }));
    if (typeof histOpen === 'function') {
      out.push({
        id: 'action:history', kind: 'action', label: s('history'), sub: s('action'),
        icon: 'history', keywords: 'history 历史 估算 reopen',
        run: () => histOpen()
      });
    }
    const arr = (typeof items !== 'undefined' && Array.isArray(items)) ? items : [];
    arr.forEach(it => {
      const seq = Number(it.seq);
      const name = String(it.name || it.desc || ('#' + seq));
      const type = it.type || '?';
      const sys = it.system ? ' · ' + it.system : '';
      out.push({
        id: 'item:' + seq, kind: 'item', label: name,
        sub: s('item') + ' #' + seq + ' · ' + type + sys,
        icon: ICONS.item, keywords: [seq, name, type, it.system, it.sub, it.id].filter(Boolean).join(' '),
        run: () => {
          goPage('work');
          try { curSeq = seq; } catch { /* 非审核页脚本环境 */ }
          if (typeof goStep === 'function') goStep(arr.length ? 'review' : 'upload');
          setTimeout(() => {
            try {
              const body = document.querySelector('#tbody');
              const idx = arr.findIndex(x => x.seq === seq);
              const sc = (body && typeof ctScrollParent === 'function') ? ctScrollParent(body) : null;
              if (sc && idx >= 0 && typeof CT !== 'undefined') sc.scrollTop = Math.max(0, (idx - 4) * CT.rowH);
              if (typeof render === 'function') render();
            } catch { /* 大表重建失败不阻塞定位 */ }
            const row = document.querySelector('#tbody .rowr[data-seq="' + seq + '"]');
            if (!row) return;
            document.querySelectorAll('#tbody .rowr.cur').forEach(x => x.classList.remove('cur'));
            row.classList.add('cur', 'cmdk-hit');
            row.scrollIntoView({ block: 'center', behavior: 'smooth' });
            setTimeout(() => row.classList.remove('cmdk-hit'), 1200);
          }, 80);
        }
      });
    });
    projects.forEach(p => out.push({
      id: 'project:' + p.id, kind: 'project', label: p.name, sub: s('project') + ' · PERT',
      icon: ICONS.project, keywords: 'pert project ' + p.name + ' ' + p.id,
      run: () => {
        goPage('pert');
        let tries = 0;
        const pick = () => {
          const sel = $('#pertProjSel');
          if (!sel) return;
          sel.value = String(p.id);
          if (sel.value !== String(p.id) && tries++ < 12) { setTimeout(pick, 100); return; }
          if (sel.value === String(p.id) && typeof pertPickProj === 'function') pertPickProj();
        };
        // pertInit 会异步重建下拉；等它落定再回填，避免两条加载链互相覆盖
        setTimeout(pick, 300);
      }
    }));
    return out;
  }

  function ensureEntries() {
    const key = lang() + ':' + ((typeof items !== 'undefined' && Array.isArray(items)) ? items.length : 0) + ':' + projects.length;
    if (builtFor !== key) { entries = buildEntries(); builtFor = key; }
  }

  function fetchProjects() {
    if (projectFetching || projects.length) return;
    projectFetching = true;
    try {
      fetch((typeof API !== 'undefined' ? API : '') + '/api/pert/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store'
      })
        .then(r => r.json()).then(j => {
          projects = (j && j.projects || []).map(p => ({ id: p.id, name: p.name || ('#' + p.id) }));
          builtFor = null;   // 索引失效：下次打开/输入重建
        }).catch(() => { /* 项目列表不可用不阻塞页面/功能项搜索 */ })
        .finally(() => { projectFetching = false; });
    } catch { projectFetching = false; }
  }

  function entryMap() {
    const m = new Map();
    ensureEntries();
    entries.forEach(e => m.set(e.id, e));
    return m;
  }

  function scoreOf(e, q) {
    const label = e.label.toLowerCase(), sub = e.sub.toLowerCase(), hay = label + ' ' + sub + ' ' + (e.keywords || '').toLowerCase();
    if (!hay.includes(q)) return -1;
    let sc = 1;
    if (label === q) sc = 8;
    else if (label.startsWith(q)) sc = 7;
    else if (label.includes(q)) sc = 5;
    else if (sub.includes(q)) sc = 3;
    if (e.kind === 'page') sc += 2;
    if (e.kind === 'action') sc += 1;
    return sc;
  }

  function computeVisible() {
    const q = query.trim().toLowerCase();
    ensureEntries();
    if (!q) {
      const m = entryMap();
      const out = [];
      const ids = new Set();
      const push = (e, group) => {
        if (!e || ids.has(e.id) || out.filter(x => x.group).length >= MAX_RESULTS) return;
        ids.add(e.id); out.push({ ...e, group });
      };
      readArr(LS_FAV).slice(0, MAX_FAV).forEach(id => push(m.get(id), s('fav')));
      readArr(LS_RECENT).slice(0, MAX_RECENT).forEach(id => push(m.get(id), s('recent')));
      entries.filter(e => e.kind === 'page' || e.kind === 'action').forEach(e => push(e, s('pages')));
      const itemEntries = entries.filter(e => e.kind === 'item');
      itemEntries.slice(0, MAX_ITEMS_EMPTY).forEach(e => push(e, s('items')));
      entries.filter(e => e.kind === 'project').slice(0, 10).forEach(e => push(e, s('projects')));
      return out;
    }
    const scored = entries.map(e => ({ e, sc: scoreOf(e, q) })).filter(x => x.sc >= 0);
    scored.sort((a, b) => b.sc - a.sc || a.e.label.length - b.e.label.length || a.e.label.localeCompare(b.e.label));
    const out = scored.slice(0, MAX_RESULTS).map(x => ({ ...x.e, group: s('results') }));
    return out;
  }

  function render() {
    if (!list) return;
    const t0 = performance.now();
    visible = computeVisible();
    if (active >= visible.length) active = Math.max(0, visible.length - 1);
    if (visible.length && active < 0) active = 0;
    let html = '', lastGroup = '', opened = false;
    if (!visible.length) {
      html = '<div class="cmdk-empty" role="presentation"><div>' + esc(s('empty')) + '</div><div>' + esc(s('emptyHint')) + '</div></div>';
    } else {
      visible.forEach((e, i) => {
        if (e.group && e.group !== lastGroup) {
          if (opened) html += '</div>';
          html += '<div class="cmdk-group" role="group" aria-label="' + esc(e.group) + '"><div class="cmdk-group-label" aria-hidden="true">' + esc(e.group) + '</div>';
          lastGroup = e.group; opened = true;
        }
        const fav = isFav(e.id);
        html += '<div class="cmdk-item">' +
          '<div id="cmdk-opt-' + i + '" class="cmdk-row" role="option" tabindex="-1" aria-selected="' + (i === active) + '" data-id="' + esc(e.id) + '">' +
          '<i aria-hidden="true" data-lucide="' + esc(e.icon || ICONS.page) + '" class="lic cmdk-ico"></i>' +
          '<span class="cmdk-main"><span class="cmdk-label">' + esc(e.label) + '</span><span class="cmdk-sub">' + esc(e.sub) + '</span></span>' +
          '</div>' +
          '<span class="cmdk-star" aria-hidden="true">' + (fav ? '★' : '☆') + '</span>' +
          '</div>';
      });
      if (opened) html += '</div>';
    }
    list.innerHTML = html;
    if (window.lucide && lucide.createIcons) lucide.createIcons();
    if (visible.length) {
      input.setAttribute('aria-activedescendant', 'cmdk-opt-' + active);
      const row = document.getElementById('cmdk-opt-' + active);
      if (row) row.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
    if (!latencyEl) latencyEl = $('#cmdkLatency');
    if (latencyEl) latencyEl.textContent = Math.round(performance.now() - t0) + ' ms';
  }

  function localizeChrome() {
    if (chromeLang === lang()) return;
    chromeLang = lang();
    if (!el) return;
    const dlg = panel;
    dlg.setAttribute('aria-label', s('dialog'));
    input.placeholder = s('placeholder');
    input.setAttribute('aria-label', s('ariaSearch'));
    list.setAttribute('aria-label', s('ariaList'));
    const foot = document.querySelector('.cmdk-foot');
    if (foot) {
      foot.innerHTML = '<span><span class="cmdk-kbd">↑ ↓</span> ' + esc(s('select')) + '</span>' +
        '<span><span class="cmdk-kbd">Enter</span> ' + esc(s('run')) + '</span>' +
        '<span><span class="cmdk-kbd">Ctrl + Enter</span> ' + esc(s('favorite')) + '</span>' +
        '<span class="cmdk-latency" id="cmdkLatency">0 ms</span>';
      latencyEl = $('#cmdkLatency');
    }
  }

  function open() {
    if (!el || isOpen) return;
    lastFocus = document.activeElement;
    isOpen = true;
    el.hidden = false;
    document.body.classList.add('cmdk-lock');
    const wrap = document.querySelector('.wrap');
    if (wrap) { wrap.setAttribute('aria-hidden', 'true'); wrap.inert = true; }
    localizeChrome();
    input.value = '';
    query = '';
    active = 0;
    fetchProjects();
    builtFor = null;
    render();
    requestAnimationFrame(() => { input.focus(); input.select(); });
  }
  function close() {
    if (!isOpen) return;
    isOpen = false;
    el.hidden = true;
    document.body.classList.remove('cmdk-lock');
    const wrap = document.querySelector('.wrap');
    if (wrap) { wrap.removeAttribute('aria-hidden'); wrap.inert = false; }
    input.value = '';
    query = '';
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch { /* 目标已卸载 */ } }
  }
  function runActive() {
    if (!visible.length) return;
    const e = visible[active];
    if (!e) return;
    addRecent(e.id);
    close();
    setTimeout(() => { try { e.run(); } catch (err) { console.error('[cmdk] run failed', err); } }, 0);
  }
  function move(delta) {
    if (!visible.length) return;
    active = (active + delta + visible.length) % visible.length;
    render();
  }

  function onKeyDown(e) {
    const combo = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K');
    if (combo) { e.preventDefault(); e.stopPropagation(); isOpen ? close() : open(); return; }
    if (!isOpen) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); move(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); move(-1); return; }
    if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      if (e.ctrlKey || e.metaKey) {
        if (visible[active]) { toggleFav(visible[active].id); render(); }
      } else runActive();
    }
  }

  function bind() {
    el = $('#cmdk'); panel = el && el.querySelector('.cmdk-panel');
    input = $('#cmdkInput'); list = $('#cmdkList');
    if (!el || !panel || !input || !list) return;
    input.addEventListener('input', () => { query = input.value; active = 0; render(); });
    list.addEventListener('click', e => {
      const star = e.target.closest('.cmdk-star');
      if (star) {
        const row = star.closest('.cmdk-row');
        if (row) { toggleFav(row.dataset.id); render(); input.focus(); }
        return;
      }
      const row = e.target.closest('.cmdk-row');
      if (!row) return;
      const idx = visible.findIndex(x => x.id === row.dataset.id);
      if (idx < 0) return;
      active = idx; runActive();
    });
    el.addEventListener('mousedown', e => { if (e.target === el) close(); });
    document.addEventListener('keydown', onKeyDown, true);
    window.CMDK = { open, close, get visible() { return visible; }, get latency() { return $('#cmdkLatency')?.textContent || ''; } };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})();
