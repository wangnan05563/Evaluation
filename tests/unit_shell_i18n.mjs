/** T03957 壳侧文案表单测（不依赖 Electron）。
 *  独立运行：node tests/unit_shell_i18n.mjs
 *  覆盖：中英表键位对齐 / 中文文案逐字未变 / 语言归一与英文回落 / 插值 / 缺键不抛 /
 *        main.js 里每个 tr('key') 调用点都在表内（防「加了调用忘了加译文」）。 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { STRINGS, ZH, EN, normalizeLocale, createT } = require(path.join(ROOT, 'dev-shell', 'i18n-shell.js'))

const res = []
const check = (name, ok, detail = '') => {
  res.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS'  : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// T03779 主进程里原本的中文硬编码逐字表——i18n 化只允许搬位置，不允许改措辞
const ZH_AS_BEFORE = {
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
}

check(`zh 表文案与 T03779 原硬编码逐字一致`,
  Object.entries(ZH_AS_BEFORE).every(([k, v]) => STRINGS[ZH][k] === v),
  Object.entries(ZH_AS_BEFORE).filter(([k, v]) => STRINGS[ZH][k] !== v)
    .map(([k, v]) => `${k}≠${JSON.stringify(v)}(实际 ${JSON.stringify(STRINGS[ZH][k])})`).join(' | '))

const zhKeys = Object.keys(STRINGS[ZH]).sort()
const enKeys = Object.keys(STRINGS[EN]).sort()
check('中英表键位完全对齐（无缺无多）', zhKeys.join() === enKeys.join(),
  `仅 zh: ${zhKeys.filter(k => !enKeys.includes(k))} 仅 en: ${enKeys.filter(k => !zhKeys.includes(k))}`)
check('英文文案无残留中文',
  Object.entries(STRINGS[EN]).every(([, v]) => !/[\u3400-\u9fff\uff00-\uffef]/.test(String(v))),
  Object.entries(STRINGS[EN]).filter(([, v]) => /[\u3400-\u9fff\uff00-\uffef]/.test(String(v))).map(([k]) => k).join(','))
check('插值占位符中英一致',
  Object.keys(STRINGS[ZH]).every(k =>
    (String(STRINGS[ZH][k]).match(/\{\w+\}/g) || []).sort().join() ===
    (String(STRINGS[EN][k]).match(/\{\w+\}/g) || []).sort().join()),
  Object.keys(STRINGS[ZH]).filter(k =>
    (String(STRINGS[ZH][k]).match(/\{\w+\}/g) || []).sort().join() !==
    (String(STRINGS[EN][k]).match(/\{\w+\}/g) || []).sort().join()).join(','))

// 语言归一：zh 系列进中文，其余一律英文（只内置双语，不能因为系统是法语就没有文案）
check('zh-CN/zh/zh_TW/ZH_cn 归一为中文',
  ['zh-CN', 'zh', 'zh_TW', 'ZH_cn'].every(l => normalizeLocale(l) === ZH),
  ['zh-CN', 'zh', 'zh_TW', 'ZH_cn'].map(l => `${l}→${normalizeLocale(l)}`).join(' '))
check('en-US/fr-FR/空/undefined 归一为英文',
  ['en-US', 'fr', '', undefined, null].every(l => normalizeLocale(l) === EN),
  ['en-US', 'fr', '', undefined, null].map(l => `${l}→${normalizeLocale(l)}`).join(' '))

const tEn = createT('en-US')
const tZh = createT('zh-CN')
check('createT("en-US") 取到英文文案', tEn.lang === EN && tEn.t('close_minimize') === 'Minimize to tray', tEn.t('close_minimize'))
check('createT("zh-CN") 取到中文文案', tZh.lang === ZH && tZh.t('close_minimize') === '最小化到托盘', tZh.t('close_minimize'))
check('插值：jobs 条目名与百分比',
  tEn.t('jobs_item', { name: 'bulk_calc' }) + tEn.t('jobs_item_pct', { pct: 42 }) === '· bulk_calc (42%)' &&
  tZh.t('jobs_item', { name: '批量计算' }) + tZh.t('jobs_item_pct', { pct: 42 }) === '· 批量计算（42%）',
  tEn.t('jobs_item', { name: 'bulk_calc' }) + tEn.t('jobs_item_pct', { pct: 42 }))
check('未提供的占位符原样保留（不吞成空串）', tEn.t('jobs_item', {}) === '· {name}', tEn.t('jobs_item', {}))
check('缺键回落键名且不抛（关闭决策链不能因缺译文崩）',
  (() => { try { return tEn.t('no_such_key') === 'no_such_key' } catch { return false } })())

// 静态完整性：main.js 里每个 tr('key') 调用点都必须在表内——这是最容易漏的一类回归
const mainSrc = fs.readFileSync(path.join(ROOT, 'dev-shell', 'main.js'), 'utf8')
const used = [...mainSrc.matchAll(/\btr\(\s*'([\w]+)'/g)].map(m => m[1])
check('main.js 存在 tr() 调用点', used.length >= 12, `发现 ${used.length} 处`)
check('调用点覆盖到弹框/托盘/任务确认三处',
  ['close_title', 'close_minimize', 'close_exit', 'close_remember', 'tray_show', 'tray_quit', 'jobs_force']
    .every(k => used.includes(k)), used.join(','))
const uncovered = [...new Set(used)].filter(k => !Object.prototype.hasOwnProperty.call(STRINGS[ZH], k))
check('每个调用点都有中英译文', uncovered.length === 0, uncovered.join(','))
// 反向：中文文案不得再以字面量出现在 main.js 的界面属性里（title/message/buttons 等）
const leaked = /(?:title|message|detail|checkboxLabel):\s*'[^']*[\u3400-\u9fff]/.test(mainSrc)
check('main.js 界面属性里不再残留中文字面量', !leaked, leaked ? '仍有 title/message 直接写中文' : '')

const failed = res.filter(r => !r.ok)
console.log(`\n==== 壳侧文案表单测 ==== ${failed.length ? `失败 ${failed.length}/${res.length}` : `全绿 ${res.length}/${res.length}`}`)
process.exit(failed.length ? 1 : 0)
