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

function migrationBadgeHTML(s) {
  if (!s) return '读取中…';
  if (s.missing_items > 0) return `待迁移 ${s.missing_items} 项`;
  if (s.migration_state === 'rolled_back') return '已回滚';
  return '已完成';
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
    const versions = Object.entries(s.schema_versions || {}).map(([v, n]) => `v${v} ${n}`).join(' / ') || '无';
    info.innerHTML =
      `Schema 目标 <b>v${s.schema_ver}</b> · 当前版本分布 <b>${migrationEsc(versions)}</b> · 迁移状态 <b>${migrationEsc(s.migration_state)}</b><br>` +
      `历史 <b>${s.rows}</b> 条 / 明细 <b>${s.items}</b> 项 · 稳定ID映射 <b>${s.mapped}</b> 条 · 缺稳定ID <b>${s.missing_items}</b> 项（${s.missing_rows} 条）<br>` +
      `备份 <b>${s.backups}</b> 份 · 双读兼容 <b>${s.dual_read ? '开启' : '关闭'}</b>` +
      (s.migrated_at ? ` · 最近迁移 ${migrationEsc(s.migrated_at.replace('T', ' '))}` : '');
    if (run) run.disabled = s.missing_items === 0;
    if (rb) rb.disabled = !s.can_rollback;
    return s;
  } catch (e) {
    badge.textContent = '读取失败';
    info.textContent = '迁移状态读取失败：' + e.message;
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
    migrationMsg(`迁移完成：本次处理 ${r.migrated || 0} 条历史；旧数据已补稳定 ID。`, true);
    await migrationRender();
    if (typeof histOpen === 'function') histOpen();
  } catch (e) {
    migrationMsg('迁移失败：' + e.message + '；未迁移数据保持原样，可回滚后重试。', false);
  } finally {
    if (btn && migrationLast) btn.disabled = migrationLast.missing_items === 0;
  }
}

async function migrationRollback() {
  if (!confirm('回滚会恢复迁移前的旧明细（不再自动迁移），确定继续？')) return;
  const btn = document.getElementById('migrationRollbackBtn');
  if (btn) btn.disabled = true;
  try {
    const r = await migrationApi('/api/history/ids/rollback', 'POST');
    migrationMsg(`已回滚 ${r.restored || 0} 条历史的明细；旧项目数据未丢失。`, true);
    await migrationRender();
    if (typeof histOpen === 'function') histOpen();
  } catch (e) {
    migrationMsg('回滚失败：' + e.message, false);
  } finally {
    if (btn && migrationLast) btn.disabled = !migrationLast.can_rollback;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('migrationCard')) migrationRender();
});
