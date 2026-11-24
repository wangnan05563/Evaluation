/* T06200 / REQ-022 / AC-30：外部集成管理（GitHub Issues / Jira / GitLab Issues）。
 * 仅单向推送需求/任务；配置、字段映射、测试、失败原因与重试都在本卡片完成。 */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
  const FALLBACK = {
    github: {
      title: 'GitHub Issues', base_url: 'https://api.github.com', repo: '', token: '',
      fields: [
        ['base_url', '服务地址', 'https://api.github.com'],
        ['repo', '仓库（owner/repo）', 'owner/repo'],
        ['token', '访问令牌', 'ghp_...']
      ]
    },
    jira: {
      title: 'Jira', base_url: 'https://jira.example.com', project_key: '', issue_type: 'Task',
      email: '', api_token: '',
      fields: [
        ['base_url', '服务地址', 'https://jira.example.com'],
        ['project_key', '项目 Key', 'KEY'],
        ['issue_type', '问题类型', 'Task'],
        ['email', '账号邮箱', 'name@example.com'],
        ['api_token', 'API Token', '...']
      ]
    },
    gitlab: {
      title: 'GitLab Issues', base_url: 'https://gitlab.example.com', project: '', token: '',
      fields: [
        ['base_url', '服务地址', 'https://gitlab.example.com'],
        ['project', '项目路径（group/project）', 'group/project'],
        ['token', '访问令牌', 'glpat-...']
      ]
    }
  };
  const SECRETS = { token: 1, api_token: 1 };
  const STATUS_FALLBACK = { success: '成功', partial: '部分失败', failed: '失败', running: '执行中' };
  const LOCAL_FALLBACK = { title: '标题', body: '描述', priority: '优先级', labels: '标签',
                           acceptance: '验收标准', component: '组件' };

  function msg(text, kind) {
    const el = $('#intMsg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('ok', kind === 'ok');
    el.classList.toggle('err', kind === 'err');
  }

  async function req(path, payload) {
    const opts = { method: payload === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store' };
    if (payload !== undefined) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(payload);
    }
    try {
      const res = await fetch(path, opts);
      let data = {};
      try { data = await res.json(); } catch (e) { data = { ok: false, msg: '响应格式错误' }; }
      return { ok: res.ok && data.ok !== false, status: res.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: { msg: String(e.message || e) } };
    }
  }

  const A = {
    state: { connectors: [], jobs: [], meta: {}, active: 'github' },

    async load() {
      const r = await req('/api/integrations?limit=20');
      if (!r.ok) { msg(r.data.msg || tl('team.int.load_fail', '集成配置加载失败'), 'err'); return; }
      this.state.connectors = r.data.connectors || [];
      this.state.jobs = r.data.jobs || [];
      this.state.meta = r.data;
      if (!this.connector()) this.state.active = (this.state.connectors[0] || {}).kind || 'github';
      this.render();
      msg('');
    },

    connector(kind) {
      const key = kind || this.state.active;
      return this.state.connectors.find((c) => c.kind === key) || null;
    },

    select(kind) {
      this.state.active = kind;
      this.render();
      msg('');
    },

    fieldDef(kind) {
      const found = (this.state.meta.kinds || []).find((k) => k.kind === kind);
      return FALLBACK[kind] || { title: found ? found.name : kind, fields: [] };
    },

    render() {
      const conn = this.connector();
      if (!conn) return;
      const def = this.fieldDef(conn.kind);
      const badge = $('#intBadge');
      if (badge) {
        badge.textContent = conn.enabled ? tl('team.int.on', '已启用') : tl('team.int.off', '未启用');
        badge.classList.toggle('on', !!conn.enabled);
      }
      this.renderSummary();
      this.renderTabs();
      this.renderFields(conn, def);
      this.renderMapping(conn);
      const en = $('#intEnabled');
      if (en) en.checked = !!conn.enabled;
      this.renderJobs();
      window.lucide && lucide.createIcons();
    },

    renderSummary() {
      const box = $('#intSummary');
      if (!box) return;
      box.innerHTML = this.state.connectors.map((c) => {
        const tested = c.last_test_ok == null ? tl('team.int.untested', '未测试')
          : (c.last_test_ok ? tl('team.int.test_ok', '连接正常') : tl('team.int.test_fail', '连接失败'));
        const cfg = c.available ? tl('team.int.configured', '已配置') : tl('team.int.unconfigured', '待配置');
        return '<button type="button" role="listitem" class="int-chip' + (c.kind === this.state.active ? ' active' : '') +
          '" onclick="IntegrationAdmin.select(\'' + esc(c.kind) + '\')">' +
          '<b>' + esc(this.fieldDef(c.kind).title) + '</b>' +
          '<span>' + esc(cfg) + ' · ' + esc(tested) + '</span></button>';
      }).join('');
    },

    renderTabs() {
      const box = $('#intTabs');
      if (!box) return;
      box.innerHTML = this.state.connectors.map((c) => {
        const on = c.kind === this.state.active;
        return '<button type="button" role="tab" aria-selected="' + (on ? 'true' : 'false') +
          '" class="int-tab' + (on ? ' on' : '') + '" onclick="IntegrationAdmin.select(\'' + esc(c.kind) + '\')">' +
          esc(this.fieldDef(c.kind).title) + '</button>';
      }).join('');
    },

    renderFields(conn, def) {
      const box = $('#intFields');
      if (!box) return;
      box.innerHTML = def.fields.map(([key, label, ph]) => {
        const isSecret = SECRETS[key];
        const set = conn.config[key + '_set'];
        const val = isSecret ? '' : (conn.config[key] || '');
        const placeholder = isSecret && set ? tl('team.int.secret_set', '已保存，留空不修改') : ph;
        return '<label class="rbac-field int-field"><span>' + esc(label) + '</span>' +
          '<input data-int-key="' + esc(key) + '" type="' + (isSecret ? 'password' : 'text') +
          '" autocomplete="off" value="' + esc(val) + '" placeholder="' + esc(placeholder) + '"></label>';
      }).join('');
    },

    renderMapping(conn) {
      const fields = this.state.meta.local_fields || ['title', 'body', 'priority', 'labels', 'acceptance', 'component'];
      for (const slot of ['Title', 'Body', 'Priority', 'Labels']) {
        const sel = $('#intMap' + slot);
        if (!sel) continue;
        const current = (conn.mapping || {})[slot.toLowerCase()] || slot.toLowerCase();
        sel.innerHTML = fields.map((f) =>
          '<option value="' + esc(f) + '"' + (f === current ? ' selected' : '') + '>' +
          esc(tl('team.int.field.' + f, LOCAL_FALLBACK[f] || f)) + '</option>').join('');
      }
    },

    collectConfig() {
      const cfg = {};
      document.querySelectorAll('#intFields [data-int-key]').forEach((inp) => {
        const key = inp.dataset.intKey;
        const val = (inp.value || '').trim();
        if (SECRETS[key] && !val) return;       // 留空保持旧密文
        cfg[key] = val;
      });
      return cfg;
    },

    collectMapping() {
      const out = {};
      for (const slot of ['Title', 'Body', 'Priority', 'Labels']) {
        const sel = $('#intMap' + slot);
        out[slot.toLowerCase()] = sel ? sel.value : slot.toLowerCase();
      }
      return out;
    },

    async save(silent) {
      const conn = this.connector();
      if (!conn) return false;
      const btn = $('#intSave');
      if (btn) btn.disabled = true;
      const r = await req('/api/integrations/save', {
        kind: conn.kind, config: this.collectConfig(), mapping: this.collectMapping(),
        enabled: !!($('#intEnabled') || {}).checked
      });
      if (btn) btn.disabled = false;
      if (!r.ok) { msg(r.data.msg || tl('team.int.save_fail', '保存失败'), 'err'); return false; }
      await this.load();
      if (!silent) msg(tl('team.int.saved', '集成配置已保存'), 'ok');
      return true;
    },

    async saveMapping() {
      const conn = this.connector();
      if (!conn) return;
      const r = await req('/api/integrations/mapping', { kind: conn.kind, mapping: this.collectMapping() });
      if (!r.ok) { msg(r.data.msg || tl('team.int.save_fail', '字段映射保存失败'), 'err'); return; }
      await this.load();
      msg(tl('team.int.map.saved', '字段映射已保存'), 'ok');
    },

    async test() {
      const conn = this.connector();
      if (!conn) return;
      const saved = await this.save(true);
      if (!saved) return;
      const btn = $('#intTest');
      if (btn) btn.disabled = true;
      const r = await req('/api/integrations/test', { kind: conn.kind });
      if (btn) btn.disabled = false;
      const text = (r.ok && r.data.ok)
        ? tl('team.int.test.pass', '连接正常：') + (r.data.detail || '')
        : tl('team.int.test.fail', '连接失败：') + (r.data.error || r.data.msg || '—');
      await this.load();
      msg(text, (r.ok && r.data.ok) ? 'ok' : 'err');
    },

    itemsFromUi() {
      const raw = ($('#intItems') && $('#intItems').value || '').trim();
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed) || !parsed.length) throw new Error(tl('team.int.need_items', '需要至少一条需求/任务'));
          return parsed;
        } catch (e) {
          msg(tl('team.int.json_err', 'JSON 不合法：') + (e.message || e), 'err');
          return null;
        }
      }
      const stories = Array.isArray(window.__stories) ? window.__stories : [];
      if (stories.length) {
        return stories.map((s) => ({ title: s.title, body: s.body, labels: ['用户故事'] }));
      }
      msg(tl('team.int.no_story', '请先生成用户故事，或粘贴需求/任务 JSON'), 'err');
      return null;
    },

    async sync() {
      const conn = this.connector();
      if (!conn) return;
      const items = this.itemsFromUi();
      if (!items) return;
      if (!(await this.save(true))) return;
      const btn = $('#intSync');
      if (btn) btn.disabled = true;
      const r = await req('/api/integrations/sync', { kind: conn.kind, items });
      if (btn) btn.disabled = false;
      if (!r.ok) { msg(r.data.msg || tl('team.int.sync_fail', '同步失败'), 'err'); return; }
      const job = r.data.job || {};
      if (job.status === 'success') {
        msg(tf('team.int.sync_ok', { n: job.succeeded }, '已同步 {n} 条'), 'ok');
        toast(tf('team.int.sync_ok', { n: job.succeeded }, '已同步 {n} 条'));
      } else {
        msg((job.error || tl('team.int.sync_fail', '同步失败')) +
            (job.failed ? '（' + job.failed + ' 条失败，可重试）' : ''), 'err');
      }
      await this.loadJobs();
      this.renderJobs();
    },

    async loadJobs() {
      const r = await req('/api/integrations/jobs?limit=20');
      if (r.ok) this.state.jobs = r.data.jobs || [];
    },

    async retry(id) {
      const r = await req('/api/integrations/retry', { job_id: id });
      if (!r.ok) { msg(r.data.msg || tl('team.int.retry_fail', '重试失败'), 'err'); return; }
      const job = r.data.job || {};
      msg(job.status === 'success'
        ? tl('team.int.retry.ok', '重试成功')
        : (job.error || tl('team.int.retry.partial', '重试后仍有失败')), job.status === 'success' ? 'ok' : 'err');
      await this.loadJobs();
      this.renderJobs();
    },

    renderJobs() {
      const box = $('#intJobs');
      if (!box) return;
      const rows = this.state.jobs || [];
      box.innerHTML = rows.map((j) => {
        const st = STATUS_FALLBACK[j.status] || j.status;
        const when = j.created_at ? new Date(j.created_at).toLocaleString(navigator.language || 'zh-CN',
                                                                            { hour12: false }) : '—';
        const errs = (j.errors || []).slice(0, 3).map((e) =>
          '<div class="int-job-err">' + esc((e.title || '#' + e.index) + ' · ' + (e.code || '') + ' · ' + (e.message || '')) + '</div>').join('');
        const retry = j.status === 'failed' || j.status === 'partial'
          ? '<button type="button" class="btn btn-ghost int-retry" onclick="IntegrationAdmin.retry(\'' + esc(j.id) + '\')">' +
            esc(tl('team.int.retry', '重试')) + '</button>' : '';
        return '<li class="int-job ' + esc(j.status) + '"><div class="int-job-head"><b>' + esc(st) + '</b>' +
          '<span>' + esc(when) + '</span><span>' + esc((j.succeeded || 0) + '/' + (j.total || 0)) + '</span>' + retry + '</div>' +
          (j.error ? '<div class="int-job-error">' + esc(j.error) + '</div>' : '') + errs + '</li>';
      }).join('') || '<li class="rbac-empty">' + esc(tl('team.int.jobs.empty', '暂无同步任务')) + '</li>';
      window.lucide && lucide.createIcons();
    }
  };

  // 简版插值：字典缺失时回退中文，不暴露内部 key
  function tf(key, vars, fallback) {
    let s = tl(key, fallback);
    if (s === key) s = fallback;
    return String(s || '').replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null) ? vars[k] : m);
  }

  window.IntegrationAdmin = A;
})();
