/* T06199：工作组 RBAC / SSO / 团队与权限前端。
 * 单机版完全隐藏；工作组未登录时用全屏门禁锁住 .wrap，登录后按权限显隐导航与卡片。
 * 会话用 HttpOnly Cookie，同源 fetch 自动携带，不在 localStorage 存令牌。
 */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
  const roleLabel = (code, fallback) => tl('rbac.role.' + code, fallback || code);
  const permLabel = (code, fallback) => tl('rbac.perm.' + code, fallback || code);
  const ACTION_FALLBACK = {
    login: '登录', logout: '退出', access: '访问', bootstrap: '初始化管理员',
    user_create: '新增成员', user_update: '变更成员', sso_login: 'SSO 登录',
    sso_provision: 'SSO 开通', sso_config: '保存 SSO 配置'
  };
  const STATUS_FALLBACK = { active: '启用', disabled: '停用' };

  function actionLabel(code) {
    return tl('rbac.action.' + code, ACTION_FALLBACK[code] || code);
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(navigator.language || 'zh-CN', { hour12: false });
  }

  function setMsg(el, text, kind) {
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('ok', kind === 'ok');
    el.classList.toggle('err', kind === 'err');
  }

  async function req(path, payload, method) {
    const opts = { method: method || (payload === undefined ? 'GET' : 'POST'), credentials: 'same-origin', cache: 'no-store' };
    if (payload !== undefined) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(payload);
    }
    let res;
    try { res = await fetch(path, opts); } catch (e) {
      return { status: 0, ok: false, data: { ok: false, code: 'NETWORK', msg: String(e.message || e) } };
    }
    let data = {};
    try { data = await res.json(); } catch (e) { data = { ok: false, code: 'BAD_RESPONSE' }; }
    return { status: res.status, ok: res.ok, data };
  }

  const R = {
    state: null,
    user: null,
    matrixData: null,
    rolesData: [],
    booted: false,

    get mode() { return (this.state && this.state.mode) || document.body.dataset.deployMode || 'standalone'; },
    get workgroup() { return this.mode === 'workgroup'; },
    get permissions() { return (this.user && this.user.permissions) || (this.state && this.state.permissions) || []; },
    get locked() { return document.body.classList.contains('auth-locked'); },
    can(perm) { return !this.workgroup || this.permissions.indexOf(perm) >= 0; },

    async init() {
      if (this.booted) return;
      this.booted = true;
      const r = await req('/api/auth/me');
      if (r.ok && r.data && r.data.mode) this.state = r.data;
      else this.state = { ok: false, mode: 'workgroup', authRequired: true, bootstrapRequired: false, user: null,
                          permissions: [], ssoEnabled: false, providerName: 'SSO', adminFallback: true };
      this.user = this.state.user || null;
      this.applyState();
      this.handleSsoQuery();
    },

    applyState() {
      const workgroup = this.mode === 'workgroup';
      document.body.dataset.deployMode = workgroup ? 'workgroup' : 'standalone';
      const team = $('#mi-team');
      if (team) team.hidden = !workgroup;
      const config = $('#mi-config');
      if (config) config.hidden = workgroup && !this.can('settings.read');
      const flow = $('#mi-flow');
      if (flow) flow.hidden = workgroup ? !this.can('project.read') : false;
      if (!workgroup) {
        this.hideGate();
        document.dispatchEvent(new CustomEvent('we:auth', { detail: this.state }));
        return;
      }
      // 工作组以 RBAC 角色为准，不再叠加首次启动的本地角色引导。
      try { localStorage.setItem('wl_onboard_dismissed_v1', '1'); } catch (e) {}
      const rw = $('#roleWelcome');
      if (rw) { rw.hidden = true; rw.setAttribute('aria-hidden', 'true'); }
      if (typeof RoleOnboard !== 'undefined' && RoleOnboard.close) RoleOnboard.close();
      if (this.user) {
        this.hideGate();
      } else {
        this.showGate(!!this.state.bootstrapRequired);
      }
      document.dispatchEvent(new CustomEvent('we:auth', { detail: this.state }));
    },

    lockApp(locked) {
      const wrap = $('.wrap');
      if (wrap) {
        if (locked) {
          wrap.setAttribute('inert', '');
          wrap.setAttribute('aria-hidden', 'true');
        } else {
          wrap.removeAttribute('inert');
          wrap.removeAttribute('aria-hidden');
        }
      }
      document.body.classList.toggle('auth-locked', !!locked);
    },

    showGate(bootstrap) {
      const gate = $('#authGate');
      if (!gate) return;
      gate.hidden = false;
      gate.setAttribute('aria-hidden', 'false');
      $('#authTitle').textContent = bootstrap ? tl('auth.bootstrap_title', '启用工作组 · 创建管理员') : tl('auth.title', '工作组登录');
      $('#authHint').textContent = bootstrap
        ? tl('auth.bootstrap_hint', '首次启用工作组需要创建一个本机管理员；之后可接入 SSO。')
        : tl('auth.hint', '登录后按角色权限访问估算、项目签收与审计。');
      $('#authSubmit').textContent = bootstrap ? tl('auth.bootstrap_btn', '创建管理员并进入') : tl('auth.login', '登录');
      $('#authDisplayRow').hidden = !bootstrap;
      $('#authSsoBox').hidden = !!bootstrap;
      $('#authSsoBtn').hidden = !!bootstrap;
      $('#authSsoLabel').textContent = this.state.ssoEnabled
        ? tf('auth.sso_provider', { provider: this.state.providerName || 'SSO' })
        : tl('auth.sso_unconfigured', 'SSO 未配置，使用管理员账号');
      $('#authFallbackBox').hidden = true;
      $('#authPassword').setAttribute('autocomplete', bootstrap ? 'new-password' : 'current-password');
      setMsg($('#authMsg'), '');
      this.lockApp(true);
      setTimeout(() => { const u = $('#authUsername'); if (u) u.focus(); }, 60);
    },

    hideGate() {
      const gate = $('#authGate');
      if (gate) {
        gate.hidden = true;
        gate.setAttribute('aria-hidden', 'true');
      }
      this.lockApp(false);
      setMsg($('#authMsg'), '');
    },

    async refresh() {
      const r = await req('/api/auth/me');
      if (r.ok && r.data && r.data.mode) {
        this.state = r.data;
        this.user = r.data.user || null;
        this.applyState();
        return true;
      }
      return false;
    },

    async submit() {
      const btn = $('#authSubmit');
      if (!btn || btn.disabled) return;
      const username = ($('#authUsername').value || '').trim();
      const password = $('#authPassword').value || '';
      const display = ($('#authDisplayName').value || '').trim();
      if (!username) { setMsg($('#authMsg'), tl('auth.username_required', '请输入账号'), 'err'); $('#authUsername').focus(); return; }
      if (password.length < 8) { setMsg($('#authMsg'), tl('auth.password_length', '密码至少 8 位'), 'err'); $('#authPassword').focus(); return; }
      const bootstrap = !!this.state.bootstrapRequired;
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = tl('auth.processing', '处理中…');
      const payload = bootstrap ? { username, password, display_name: display } : { username, password };
      const r = await req(bootstrap ? '/api/auth/bootstrap' : '/api/auth/login', payload);
      btn.disabled = false;
      btn.textContent = old;
      if (!r.ok) {
        setMsg($('#authMsg'), r.data.msg || tl('auth.login_failed', '登录失败，请重试'), 'err');
        return;
      }
      $('#authPassword').value = '';
      await this.refresh();
      setMsg($('#authMsg'), '');
      toast(tl('auth.logged_in', '已登录'));
      if (typeof goPage === 'function') goPage(bootstrap ? 'team' : 'work');
      if (bootstrap) this.teamInit();
    },

    fallback() {
      setMsg($('#authMsg'), tl('auth.fallback_ready', '已切换为管理员账号登录，请输入账号和密码'), 'ok');
      $('#authFallbackBox').hidden = true;
      $('#authUsername').focus();
    },

    async ssoStart() {
      if (!this.workgroup) return;
      const msg = $('#authSsoMsg');
      if (msg) { msg.hidden = false; msg.textContent = tl('auth.sso_connecting', '正在跳转 SSO…'); }
      const r = await req('/api/auth/sso/start?next=' + encodeURIComponent('/'), undefined, 'GET');
      if (r.ok && r.data.authorize_url) {
        location.href = r.data.authorize_url;
        return;
      }
      const text = (r.data.msg || tl('auth.sso_failed', 'SSO 登录失败')) + '；' +
        tl('auth.fallback_hint', '可回退管理员账号登录。');
      if (msg) { msg.hidden = false; msg.textContent = text; }
      $('#authFallbackBox').hidden = false;
      $('#authUsername').focus();
    },

    handleSsoQuery() {
      let q;
      try { q = new URLSearchParams(location.search); } catch (e) { return; }
      const sso = q.get('sso');
      if (!sso || !this.workgroup) return;
      if (sso === 'fallback') {
        const msg = $('#authSsoMsg');
        if (msg) { msg.hidden = false; msg.textContent = tl('auth.sso_failed_fallback', 'SSO 登录失败，已回退到管理员账号。'); }
        const box = $('#authFallbackBox');
        if (box) box.hidden = false;
      } else if (sso === 'ok') {
        toast(tl('auth.sso_ok', 'SSO 登录成功'));
      }
      try {
        q.delete('sso'); q.delete('reason');
        const clean = location.pathname + (q.toString() ? '?' + q.toString() : '') + location.hash;
        history.replaceState(null, '', clean);
      } catch (e) {}
    },

    async logout() {
      await req('/api/auth/logout', {});
      this.user = null;
      this.state = Object.assign({}, this.state, { user: null, permissions: [] });
      this.applyState();
      if (typeof goPage === 'function') goPage('work');
      toast(tl('auth.logged_out', '已退出登录'));
    },

    setCardVisible(sel, visible) {
      const el = $(sel);
      if (el) el.hidden = !visible;
    },

    async teamInit() {
      if (!this.workgroup) { toast(tl('team.standalone', '单机版不启用团队与权限')); return; }
      if (!this.user) { this.showGate(!!this.state.bootstrapRequired); return; }
      this.setCardVisible('#rbacUsersCard', this.can('user.manage'));
      this.setCardVisible('#rbacSsoCard', this.can('settings.write'));
      this.setCardVisible('#rbacAuditCard', this.can('audit.read'));
      this.renderWho();
      setMsg($('#rbacMsg'), '');
      setMsg($('#rbacUserMsg'), '');
      await Promise.all([
        this.loadMatrix(),
        this.can('user.manage') ? this.loadUsers() : Promise.resolve(),
        this.can('settings.write') ? this.loadSso() : Promise.resolve(),
        this.can('audit.read') ? this.loadAudit() : Promise.resolve()
      ]);
      window.lucide && lucide.createIcons();
    },

    renderWho() {
      const u = this.user || {};
      const chips = (u.permissions || []).slice(0, 10).map((p) =>
        '<span>' + esc(permLabel(p, p)) + '</span>').join('');
      const more = (u.permissions || []).length > 10
        ? '<span>+' + ((u.permissions || []).length - 10) + '</span>' : '';
      $('#rbacWho').innerHTML =
        '<b>' + esc(u.display_name || u.username || '—') + '</b>' +
        '<span>@' + esc(u.username || '') + '</span>' +
        '<span class="rbac-role">' + esc(roleLabel(u.role, u.role_label)) + '</span>' +
        '<div class="rbac-perms" aria-label="' + esc(tl('team.who.perms', '当前权限')) + '">' + chips + more + '</div>';
    },

    async loadMatrix() {
      const r = await req('/api/rbac/matrix');
      if (!r.ok) { setMsg($('#rbacMsg'), r.data.msg || tl('team.matrix.fail', '权限矩阵加载失败'), 'err'); return; }
      this.matrixData = r.data;
      this.renderMatrix();
    },

    renderMatrix() {
      const m = this.matrixData || { roles: [], permissions: [] };
      const head = $('#rbacMatrixHead');
      const body = $('#rbacMatrixBody');
      if (!head || !body) return;
      head.innerHTML = '<tr><th scope="col">' + esc(tl('team.matrix.permission', '权限')) + '</th>' +
        m.roles.map((r) => '<th scope="col">' + esc(roleLabel(r.code, r.label)) + '</th>').join('') + '</tr>';
      body.innerHTML = m.permissions.map((p) => '<tr><th scope="row">' + esc(permLabel(p.code, p.label)) + '</th>' +
        m.roles.map((r) => {
          const on = (r.permissions || []).indexOf(p.code) >= 0;
          return '<td class="' + (on ? 'on' : 'off') + '" aria-label="' +
            esc(roleLabel(r.code, r.label) + '：' + permLabel(p.code, p.label) + '，' +
              (on ? tl('team.matrix.allow', '允许') : tl('team.matrix.deny', '不允许'))) + '">' +
            (on ? '✓' : '—') + '</td>';
        }).join('') + '</tr>').join('');
    },

    roleOptions(selected) {
      const roles = this.rolesData.length ? this.rolesData : [
        { code: 'evaluator', label: '评估师' }, { code: 'reviewer', label: '评审人' },
        { code: 'manager', label: '项目经理' }, { code: 'viewer', label: '只读成员' }
      ];
      return roles.map((r) => '<option value="' + esc(r.code) + '"' + (r.code === selected ? ' selected' : '') + '>' +
        esc(roleLabel(r.code, r.label)) + '</option>').join('');
    },

    async loadUsers() {
      const r = await req('/api/rbac/users');
      if (!r.ok) { setMsg($('#rbacUserMsg'), r.data.msg || tl('team.users.fail', '成员加载失败'), 'err'); return; }
      const users = r.data.users || [];
      this.rolesData = r.data.roles || [];
      $('#rbacUserCount').textContent = users.length ? '(' + users.length + ')' : '';
      $('#rbacUserRows').innerHTML = users.map((u) => {
        const status = u.status === 'disabled' ? 'disabled' : 'active';
        return '<tr data-id="' + esc(u.id) + '">' +
          '<td><b>' + esc(u.display_name || u.username) + '</b><small>@' + esc(u.username) +
          (u.sso ? ' · SSO' : '') + '</small></td>' +
          '<td><select class="rbac-role-select" aria-label="' + esc(tl('team.users.change_role', '变更角色')) +
          '" onchange="RbacAuth.changeRole(\'' + esc(u.id) + '\', this.value)">' + this.roleOptions(u.role) + '</select></td>' +
          '<td><span class="rbac-status ' + status + '">' + esc(tl('rbac.status.' + status, STATUS_FALLBACK[status])) + '</span></td>' +
          '<td><small>' + esc(fmtTime(u.last_login_at)) + '</small></td>' +
          '<td><button type="button" class="btn btn-ghost" style="padding:4px 8px;font-size:11px" onclick="RbacAuth.toggleUser(\'' +
          esc(u.id) + '\',\'' + (status === 'active' ? 'disabled' : 'active') + '\')">' +
          esc(status === 'active' ? tl('team.users.disable', '停用') : tl('team.users.enable', '启用')) + '</button></td></tr>';
      }).join('') || '<tr><td colspan="5" class="rbac-empty">' + esc(tl('team.users.empty', '暂无成员')) + '</td></tr>';
    },

    async createUser() {
      const username = ($('#rbacNewUser').value || '').trim();
      const password = $('#rbacNewPass').value || '';
      const display = ($('#rbacNewName').value || '').trim();
      const role = $('#rbacNewRole').value;
      if (!username) { setMsg($('#rbacUserMsg'), tl('team.users.name_required', '请输入账号'), 'err'); $('#rbacNewUser').focus(); return; }
      if (password.length < 8) { setMsg($('#rbacUserMsg'), tl('auth.password_length', '密码至少 8 位'), 'err'); $('#rbacNewPass').focus(); return; }
      const r = await req('/api/rbac/users', { username, password, display_name: display, role });
      if (!r.ok) { setMsg($('#rbacUserMsg'), r.data.msg || tl('team.users.add_fail', '添加失败'), 'err'); return; }
      $('#rbacNewUser').value = ''; $('#rbacNewName').value = ''; $('#rbacNewPass').value = '';
      await this.loadUsers();
      setMsg($('#rbacUserMsg'), tl('team.users.added', '成员已添加'), 'ok');
    },

    async changeRole(id, role) {
      const r = await req('/api/rbac/users/update', { id, role });
      if (!r.ok) {
        setMsg($('#rbacUserMsg'), r.data.msg || tl('team.users.update_fail', '变更失败'), 'err');
        await this.loadUsers();
        setMsg($('#rbacUserMsg'), r.data.msg || tl('team.users.update_fail', '变更失败'), 'err');
        return;
      }
      if (this.user && this.user.id === id) await this.refresh();
      await this.loadUsers();
      setMsg($('#rbacUserMsg'), tl('team.users.updated', '角色已更新'), 'ok');
    },

    async toggleUser(id, status) {
      const r = await req('/api/rbac/users/update', { id, status });
      if (!r.ok) { setMsg($('#rbacUserMsg'), r.data.msg || tl('team.users.update_fail', '变更失败'), 'err'); return; }
      if (this.user && this.user.id === id) await this.refresh();
      await this.loadUsers();
      setMsg($('#rbacUserMsg'), tl('team.users.updated', '状态已更新'), 'ok');
    },

    async loadAudit() {
      const r = await req('/api/rbac/audit?limit=80');
      if (!r.ok) { setMsg($('#rbacMsg'), r.data.msg || tl('team.audit.fail', '审计加载失败'), 'err'); return; }
      const rows = r.data.audit || [];
      $('#rbacAuditCount').textContent = rows.length ? '(' + rows.length + ')' : '';
      $('#rbacAudit').innerHTML = rows.map((a) => {
        const bad = a.result === 'deny' || a.result === 'fail';
        return '<li><time datetime="' + esc(a.at) + '">' + esc(fmtTime(a.at)) + '</time>' +
          '<b>' + esc(a.actor_name || '—') + ' · ' + esc(actionLabel(a.action)) + '</b>' +
          '<span class="rbac-result ' + esc(a.result) + '">' + esc(a.result === 'deny' ? tl('team.audit.deny', '拒绝')
            : a.result === 'fail' ? tl('team.audit.fail_badge', '失败') : tl('team.audit.ok', '通过')) + '</span>' +
          '<span class="rbac-audit-detail">' + esc([a.permission, a.object_type, a.object_id, a.detail].filter(Boolean).join(' · ')) + '</span></li>';
      }).join('') || '<li class="rbac-empty">' + esc(tl('team.audit.empty', '暂无审计记录')) + '</li>';
      // .rbac-audit 是 ol，空态用 li 表达，避免嵌套层级失义
      window.lucide && lucide.createIcons();
    },

    async loadSso() {
      const r = await req('/api/rbac/sso-config');
      if (!r.ok) { setMsg($('#rbacSsoMsg'), r.data.msg || tl('team.sso.fail', 'SSO 配置加载失败'), 'err'); return; }
      const s = r.data.sso || {};
      $('#rbacSsoEnabled').checked = !!s.enabled;
      $('#rbacSsoProvider').value = s.provider_name || '';
      $('#rbacSsoAuthorize').value = s.authorize_url || '';
      $('#rbacSsoToken').value = s.token_url || '';
      $('#rbacSsoUserinfo').value = s.userinfo_url || '';
      $('#rbacSsoClient').value = s.client_id || '';
      $('#rbacSsoSecret').value = '';
      $('#rbacSsoSecret').placeholder = s.client_secret_set
        ? tl('team.sso.secret_set', '已配置，留空不修改') : tl('team.sso.secret_unset', '未配置');
      $('#rbacSsoProvision').checked = s.auto_provision !== false;
      $('#rbacSsoRole').value = s.default_role || 'viewer';
      const badge = $('#rbacSsoBadge');
      badge.textContent = s.enabled ? tl('team.sso.on', '已启用') : tl('team.sso.off', '未启用');
      badge.classList.toggle('on', !!s.enabled);
      setMsg($('#rbacSsoMsg'), '');
    },

    async saveSso() {
      const payload = {
        enabled: $('#rbacSsoEnabled').checked,
        provider_name: ($('#rbacSsoProvider').value || '').trim(),
        authorize_url: ($('#rbacSsoAuthorize').value || '').trim(),
        token_url: ($('#rbacSsoToken').value || '').trim(),
        userinfo_url: ($('#rbacSsoUserinfo').value || '').trim(),
        client_id: ($('#rbacSsoClient').value || '').trim(),
        client_secret: $('#rbacSsoSecret').value || '',
        auto_provision: $('#rbacSsoProvision').checked,
        default_role: $('#rbacSsoRole').value,
        admin_fallback: true
      };
      const r = await req('/api/rbac/sso-config', payload);
      if (!r.ok) { setMsg($('#rbacSsoMsg'), r.data.msg || tl('team.sso.save_fail', '保存失败'), 'err'); return; }
      $('#rbacSsoSecret').value = '';
      const s = r.data.sso || {};
      const badge = $('#rbacSsoBadge');
      badge.textContent = s.enabled ? tl('team.sso.on', '已启用') : tl('team.sso.off', '未启用');
      badge.classList.toggle('on', !!s.enabled);
      setMsg($('#rbacSsoMsg'), tl('team.sso.saved', 'SSO 配置已保存'), 'ok');
      await this.loadSso();
    }
  };

  // 防御性修正：避免任何语法标记进入模板
  window.RbacAuth = R;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => R.init(), { once: true });
  else R.init();
})();
