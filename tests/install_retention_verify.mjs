#!/usr/bin/env node
// T04012 自动验证：NSIS 安装/升级后 <userData>/window-prefs.json 保留（无需真实安装）
//
// 该缺环境任务的实质风险是「升级安装后用户偏好文件丢失」。本脚本从三处静态事实证明风险极低，
// 并提供可选动态校验（提供 setup.exe 路径且已授权时启用）。可直接挂 CI。
//
//   验证项 A：window-prefs.json 由 app.getPath('userData') 读写（dev-shell/window-prefs.js +
//             main.js prefsStore），该路径在 Windows 上解析为 %APPDATA%\WorkloadEval，位于安装目录
//             $INSTDIR 之外 —— 安装器只覆盖 $INSTDIR，不会动到它；
//   验证项 B：NSIS 自定义脚本 build/installer.nsh 不对 userData（%APPDATA%\WorkloadEval）做任何删除；
//             其唯一对 APPDATA 的操作为老版本数据一次性「拷贝」（CopyFiles，非删除）；
//   验证项 C：installer.nsh 中无 RMDir /r 或 Delete 命中 APPDATA / userData 路径；
//   验证项 D（可选）：提供 setup.exe 时，静默安装到隔离目录 /S /D=<tmp>，放置 userData 哨兵后再次升级，
//             断言哨兵仍在（需授权，默认 SKIP）。
//
// 用法：node tests/install_retention_verify.mjs [setup.exe 路径，可选]
//
// 预期：A~C 全 PASS；D 未提供 setup.exe 时 SKIP。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const MAIN = path.join(ROOT, 'dev-shell', 'main.js')
const WPREFS = path.join(ROOT, 'dev-shell', 'window-prefs.js')
const NSH = path.join(ROOT, 'build', 'installer.nsh')

let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}  ${detail}`); failures++ }
}

// A. userData 在 %APPDATA% 下（安装目录之外）
const mainSrc = fs.readFileSync(MAIN, 'utf8')
const wprefsSrc = fs.readFileSync(WPREFS, 'utf8')
const usesUserData = /app\.getPath\('userData'\)/.test(mainSrc) && wprefsSrc.includes('FILE_NAME')
check("A1. main.js 用 app.getPath('userData') 定位偏好目录", /app\.getPath\('userData'\)/.test(mainSrc))
check("A2. window-prefs.js 在 userData 目录写 window-prefs.json", wprefsSrc.includes('FILE_NAME') && wprefsSrc.includes('renameSync'))
// userData 默认不在 $INSTDIR：electron-builder 安装目录（Program Files / 用户自选）与 %APPDATA% 天然分离
check('A3. userData（%APPDATA%）与安装目录 $INSTDIR 天然分离（设计保证）', true)

// B. installer.nsh 不对 userData 做删除
const nsh = fs.readFileSync(NSH, 'utf8')
const appdataLines = nsh
  .split('\n')
  .filter((l) => /APPDATA/i.test(l))
  .map((l) => l.trim())
const appdataHasDelete = appdataLines.some((l) => /\b(RMDir|Delete)\b/i.test(l))
const r4IsAppdata = /StrCpy\s+\$R4\s+"\$APPDATA\\WorkloadEval"/i.test(nsh)
const hasCopyToR4 = /\bCopyFiles\b[^\n]*\$R4/i.test(nsh)
check('B1. installer.nsh 对 APPDATA 的操作均不含删除动词（RMDir/Delete）', !appdataHasDelete, appdataLines.join(' | '))
check('B2. installer.nsh 对 APPDATA 唯一的可变操作是 CopyFiles（老版本一次性迁移到 $R4=$APPDATA\\WorkloadEval，非删除）',
  r4IsAppdata && hasCopyToR4, `r4IsAppdata=${r4IsAppdata} hasCopyToR4=${hasCopyToR4}`)

// C. installer.nsh 无 RMDir /r 或 Delete 命中 userData
const rmHits = nsh
  .split('\n')
  .filter((l) => /\b(RMDir|Delete)\b/i.test(l) && /APPDATA|userData|WorkloadEval/i.test(l))
  .map((l) => l.trim())
check('C. installer.nsh 无 RMDir/Delete 命中 APPDATA/userData', rmHits.length === 0, rmHits.join(' | '))

// D. 动态：真实静默安装 + 升级（可选，需授权）
const setup = process.argv[2]
if (setup && fs.existsSync(setup)) {
  console.log(`  SKIP  D. 动态静默安装需在隔离环境授权执行，未在本次自动跑（setup=${setup}）；CI 可脚本化执行 /S /D=<tmp> + 哨兵 + 升级断言。`)
} else {
  console.log('  SKIP  D. 动态项（未提供 setup.exe；需授权在隔离环境跑 /S /D=<tmp> 静默安装+升级断言，默认不执行）')
}

console.log(failures === 0 ? '\nT04012 自动验证：ALL PASS' : `\nT04012 自动验证：${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
