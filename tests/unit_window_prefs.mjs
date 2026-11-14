/** T03779 窗口关闭行为偏好存储单测（不依赖 Electron）。
 *  独立运行：node tests/unit_window_prefs.mjs
 *  覆盖：首次默认值 / 落盘与回读 / 非法值收敛 / 损坏文件降级 / 原子替换无残留 / 记住选择判定。 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const prefs = require('../dev-shell/window-prefs.js')

const res = []
const check = (name, ok, detail = '') => {
  res.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const tmpDir = tag => fs.mkdtempSync(path.join(os.tmpdir(), `we_prefs_${tag}_`))
const rm = dir => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ } }

// 1) 首次运行（无文件）：默认最小化到托盘 + 未记住选择
{
  const dir = tmpDir('default')
  const s = prefs.createStore(dir)
  const v = s.read()
  check('首次运行默认 minimize_to_tray / remember_choice=false',
    v.close_action === 'minimize_to_tray' && v.remember_choice === false, JSON.stringify(v))
  check('未记住选择时需要弹窗', prefs.needsPrompt(v) === true)
  check('读取不产生文件（只读不落盘）', !fs.existsSync(s.file))
  rm(dir)
}

// 2) 写入后持久化，新实例可回读
{
  const dir = tmpDir('persist')
  const s1 = prefs.createStore(dir)
  const next = s1.write({ close_action: 'exit_app', remember_choice: true })
  const s2 = prefs.createStore(dir)
  const back = s2.read()
  check('write 返回值与文件回读一致',
    next.close_action === 'exit_app' && next.remember_choice === true &&
    back.close_action === 'exit_app' && back.remember_choice === true, JSON.stringify(back))
  check('文件为合法 JSON 且含两个字段',
    (() => { try { const j = JSON.parse(fs.readFileSync(s1.file, 'utf8')); return j.close_action === 'exit_app' && j.remember_choice === true } catch { return false } })())
  check('记住选择后不再弹窗', prefs.needsPrompt(back) === false)
  rm(dir)
}

// 3) 非法值收敛到安全默认（枚举外动作→最小化；非布尔真值不当 true）
{
  const dir = tmpDir('invalid')
  const s = prefs.createStore(dir)
  const v = s.write({ close_action: 'reboot_now', remember_choice: 'true' })
  check('非法 close_action 收敛为 minimize_to_tray', v.close_action === 'minimize_to_tray', v.close_action)
  check('非布尔 remember_choice 收敛为 false', v.remember_choice === false, String(v.remember_choice))
  rm(dir)
}

// 4) 损坏文件按首次运行处理（不能因配置损坏导致无法关窗）
{
  const dir = tmpDir('corrupt')
  const file = path.join(dir, prefs.FILE_NAME)
  fs.writeFileSync(file, '{not json', 'utf8')
  const v = prefs.createStore(dir).read()
  check('损坏 JSON 回退默认值', v.close_action === 'minimize_to_tray' && v.remember_choice === false, JSON.stringify(v))
  rm(dir)
}

// 5) 原子替换：连续写入后无 .tmp 残留，文件始终可解析
{
  const dir = tmpDir('atomic')
  const s = prefs.createStore(dir)
  for (let i = 0; i < 30; i++) s.write({ close_action: i % 2 ? 'exit_app' : 'minimize_to_tray', remember_choice: i % 2 === 0 })
  const leftovers = fs.readdirSync(dir).filter(f => f.includes('.tmp'))
  const v = s.read()
  check('30 次写入后无临时文件残留', leftovers.length === 0, leftovers.join(','))
  check('末次写入值正确可解析', v.close_action === 'exit_app' && v.remember_choice === false, JSON.stringify(v))
  rm(dir)
}

// 6) 仅勾选「记住」才产出持久化配置
{
  check('未勾选记住 → 不改配置（null）', prefs.nextPrefsOnChoice('exit_app', false) === null)
  const keep = prefs.nextPrefsOnChoice('exit_app', true)
  check('勾选记住 → 写入动作且 remember_choice=true',
    keep && keep.close_action === 'exit_app' && keep.remember_choice === true, JSON.stringify(keep))
}

const failed = res.filter(r => !r.ok)
const summary = failed.length ? `失败 ${failed.length}/${res.length}` : `全绿 ${res.length}/${res.length}`
console.log(`\n==== 窗口偏好单测 ==== ${summary}`)
process.exitCode = failed.length ? 1 : 0
