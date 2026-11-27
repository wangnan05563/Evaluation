/* ===== T06190：Schema 迁移向导 / 双读兼容 / 失败回滚 ===== */
let migrationLast = null;

function migrationEsc(s) {
  return String(s ?? '').replaceAll(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function migrationApi(pathname, method = 'GET') {
  const r = await fetch(API + pathname, { method, cache: 'no-store', headers: { 'Content-Type': 'application/json' } });
  const j = await r.json();
  if (!j.ok) throw new Error(j.msg || ('HTTP ' + r.status));
  return j;
}

function migrationText(key, fallback, vars) {
  const s = (typeof tl === 'function' && typeof __I18N !== 'undefined' && __I18N && __I18N[key]) ? __I18N[key] : fallback;
  return String(s).replaceAll(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null) ? vars[k] : m);
}

function migrationBadgeHTML(s) {
  if (!s) return migrationText('history.migration.badge.loading', '读取中…');
  if (s.missing_items > 0) return migrationText('history.migration.badge.pending', '待迁移 {n} 项', { n: s.missing_items });
  if (s.migration_state === 'rolled_back') return migrationText('history.migration.badge.rolled_back', '已回滚');
  return migrationText('history.migration.badge.done', '已完成');
}

async function migrationRender() {
  const info = document.getElementById('migrationInfo');
  const badge = document.getElementById('migrationBadge');
  const run = document.getElementById('migrationRunBtn');
  const rb = document.getElementById('migrationRollbackBtn');
  if (!info || !badge) return null;
  try {
    const s = await migrationApi('/api/history/ids/status');
    migrationLast = s;
    badge.textContent = migrationBadgeHTML(s);
    badge.style.color = s.missing_items > 0 ? 'var(--danger-ink)' : 'var(--brand)';
    const versions = Object.entries(s.schema_versions || {}).map(([v, n]) => `v${v} ${n}`).join(' / ') || migrationText('history.migration.none', '无');
    info.innerHTML =
      `${migrationText('history.migration.schema_target', 'Schema 目标')} <b>v${s.schema_ver}</b> · ${migrationText('history.migration.current_versions', '当前版本分布')} <b>${migrationEsc(versions)}</b> · ${migrationText('history.migration.state', '迁移状态')} <b>${migrationEsc(s.migration_state)}</b><br>` +
      `${migrationText('history.migration.history', '历史')} <b>${s.rows}</b> ${migrationText('history.migration.records', '条')} / ${migrationText('history.migration.details', '明细')} <b>${s.items}</b> ${migrationText('history.migration.items', '项')} · ${migrationText('history.migration.mapped', '稳定ID映射')} <b>${s.mapped}</b> ${migrationText('history.migration.records', '条')} · ${migrationText('history.migration.missing', '缺稳定ID')} <b>${s.missing_items}</b> ${migrationText('history.migration.items', '项')}（${s.missing_rows} ${migrationText('history.migration.records', '条')}）<br>` +
      `${migrationText('history.migration.backups', '备份')} <b>${s.backups}</b> ${migrationText('history.migration.copies', '份')} · ${migrationText('history.migration.dual_read', '双读兼容')} <b>${s.dual_read ? migrationText('history.migration.on', '开启') : migrationText('history.migration.off', '关闭')}</b>` +
      (s.migrated_at ? ` · ${migrationText('history.migration.last', '最近迁移')} ${migrationEsc(s.migrated_at.replace('T', ' '))}` : '');
    if (run) run.disabled = s.missing_items === 0;
    if (rb) rb.disabled = !s.can_rollback;
    return s;
  } catch (e) {
    badge.textContent = migrationText('history.migration.badge.read_failed', '读取失败');
    info.textContent = migrationText('history.migration.read_failed', '迁移状态读取失败：') + e.message;
    return null;
  }
}

function migrationMsg(text, ok = true) {
  const el = document.getElementById('migrationMsg');
  if (!el) return;
  el.textContent = text;
  el.style.color = ok ? 'var(--brand)' : 'var(--danger-ink)';
}

async function migrationRun() {
  const btn = document.getElementById('migrationRunBtn');
  if (btn) btn.disabled = true;
  try {
    const r = await migrationApi('/api/history/ids/migrate', 'POST');
    migrationMsg(migrationText('history.migration.migrate_ok',
      '迁移完成：本次处理 {n} 条历史；旧数据已补稳定 ID。', { n: r.migrated || 0 }), true);
    await migrationRender();
    if (typeof histOpen === 'function') histOpen();
  } catch (e) {
    migrationMsg(migrationText('history.migration.migrate_fail',
      '迁移失败：{err}；未迁移数据保持原样，可回滚后重试。', { err: e.message }), false);
  } finally {
    if (btn && migrationLast) btn.disabled = migrationLast.missing_items === 0;
  }
}

async function migrationRollback() {
  if (!confirm(migrationText('history.migration.rollback_confirm',
      '回滚会恢复迁移前的旧明细（不再自动迁移），确定继续？'))) return;
  const btn = document.getElementById('migrationRollbackBtn');
  if (btn) btn.disabled = true;
  try {
    const r = await migrationApi('/api/history/ids/rollback', 'POST');
    migrationMsg(migrationText('history.migration.rollback_ok',
      '已回滚 {n} 条历史的明细；旧项目数据未丢失。', { n: r.restored || 0 }), true);
    await migrationRender();
    if (typeof histOpen === 'function') histOpen();
  } catch (e) {
    migrationMsg(migrationText('history.migration.rollback_fail', '回滚失败：{err}', { err: e.message }), false);
  } finally {
    if (btn && migrationLast) btn.disabled = !migrationLast.can_rollback;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('migrationCard')) migrationRender();
});
