// 桌面壳（主进程）侧文案表（T03957）
// 关闭决策弹框、托盘菜单与 T01835 任务确认框都是原生 TaskDialog / Tray 菜单，
// 不在渲染进程 DOM 里，因此前端 `data/i18n/*.json` 与 `tests/i18n_check.py` 都覆盖不到它们。
// 这里单列一张中英表，按 `app.getLocale()` 选语言；英文措辞与前端字典里的
// `config.window.*` 保持一致，避免同一概念在弹框和设置卡片里叫法不同。
'use strict'

const ZH = 'zh-CN'
const EN = 'en-US'

const STRINGS = {
  [ZH]: {
    app_name: '工作量评估工具',
    tray_show: '显示主窗口',
    tray_minimize: '最小化到托盘',
    tray_quit: '退出',
    tray_balloon: '已最小化到托盘，点击托盘图标可重新打开。',
    close_title: '关闭窗口',
    close_message: '关闭窗口时要执行什么操作？',
    close_detail: '「最小化到托盘」会让应用继续在后台运行，可从托盘图标恢复；「直接关闭应用」将退出程序。',
    close_minimize: '最小化到托盘',
    close_exit: '直接关闭应用',
    close_remember: '记住此选择，下次不再提示',
    jobs_title: '有正在进行的任务',
    jobs_message: '以下任务仍在进行中，现在关闭将中断它们：',
    jobs_item: '· {name}',
    jobs_item_pct: '（{pct}%）',
    jobs_cancel: '取消关闭',
    jobs_force: '强制关闭'
  },
  [EN]: {
    app_name: 'Workload Estimator',
    tray_show: 'Show main window',
    tray_minimize: 'Minimize to tray',
    tray_quit: 'Quit',
    tray_balloon: 'Minimized to the tray. Click the tray icon to reopen the window.',
    close_title: 'Close Window',
    close_message: 'What should happen when you close the window?',
    close_detail: '"Minimize to tray" keeps the app running in the background, ready to restore from the tray icon. "Close the app" quits the program.',
    close_minimize: 'Minimize to tray',
    close_exit: 'Close the app',
    close_remember: 'Remember this choice and do not ask again',
    jobs_title: 'Tasks are still running',
    jobs_message: 'These tasks are still running. Closing now will interrupt them:',
    jobs_item: '· {name}',
    jobs_item_pct: ' ({pct}%)',
    jobs_cancel: 'Cancel closing',
    jobs_force: 'Force close'
  }
}

// 只内置中英双语：zh* 走中文，其余（含 en、fr、未知、空）一律回落英文
function normalizeLocale(raw) {
  const s = String(raw || '').toLowerCase().replace(/_/g, '-')
  return s.startsWith('zh') ? ZH : EN
}

function interpolate(tpl, vars) {
  if (!vars) return tpl
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])))
}

// 取不到键时返回键名本身（英文界面会显示成 close_tile 这种显眼形态）：
// 关闭决策链不能因为一条缺译文就抛异常，让用户「关不掉窗口」。
function createT(locale) {
  const lang = normalizeLocale(locale)
  const table = STRINGS[lang]
  return {
    lang,
    t(key, vars) {
      return interpolate(Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key, vars)
    }
  }
}

module.exports = { STRINGS, ZH, EN, normalizeLocale, createT }
