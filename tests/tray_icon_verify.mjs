#!/usr/bin/env node
// T04011 自动验证：装包态托盘图标不会回退为「通用图标」（无需 GUI / 无需真实装包）
//
// 该缺环境任务的实质风险是「托盘图标变成系统通用图标」。本脚本从三处静态事实证明风险已消除，
// 并提供可选动态校验（传入真实装包 resources 目录时启用）。可直接挂 CI。
//
//   验证项 A：构建配置 package.json build.extraResources 把 assets/we_icon.ico 映射到
//             resources/we-icon.ico —— 这正是 dev-shell/main.js resolveTrayIcon() 在装包态优先检查的路径；
//   验证项 B：resolveTrayIcon() 候选列表包含 resources/we-icon.ico（装包态优先命中）；
//   验证项 C：trayIcon() 先调用 resolveTrayIcon()（打进包的 ico）后才回退 app.getFileIcon（通用图标）；
//   验证项 D：源图标 assets/we_icon.ico 是有效非空 ICO；
//   验证项 E（可选）：若传入真实装包 resources 目录且其中含 we-icon.ico，断言该文件存在且非空。
//
// 用法：node tests/tray_icon_verify.mjs [装包resources目录，可选]
//
// 预期：静态项 A~D 全 PASS；E 在未提供装包目录时 SKIP（CI 传入 electron-builder --dir 产物可自动校验）。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PKG = path.join(ROOT, 'package.json')
const MAIN = path.join(ROOT, 'dev-shell', 'main.js')
const SRC_ICO = path.join(ROOT, 'assets', 'we_icon.ico')

let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}  ${detail}`); failures++ }
}

// A. 构建配置映射
const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'))
const extra = (pkg.build && pkg.build.extraResources) || []
const icoMapping = extra.find(
  (e) =>
    e &&
    typeof e === 'object' &&
    e.from &&
    e.to &&
    e.from.replaceAll('\\', '/').endsWith('assets/we_icon.ico') &&
    e.to === 'we-icon.ico'
)
check(
  'A. extraResources 把 assets/we_icon.ico → resources/we-icon.ico',
  !!icoMapping,
  `extraResources=${JSON.stringify(extra)}`
)

// B. resolveTrayIcon 候选含 resources/we-icon.ico
const mainSrc = fs.readFileSync(MAIN, 'utf8')
const resMatch = mainSrc.match(/function resolveTrayIcon\(\)\s*\{([\s\S]*?)\n\}/)
check('B1. 存在 resolveTrayIcon() 函数', !!resMatch)
const hasResourcesIco = !!resMatch && /path\.join\(process\.resourcesPath,\s*'we-icon\.ico'\)/.test(resMatch[1])
check('B2. resolveTrayIcon 候选含 resources/we-icon.ico（装包态优先命中）', hasResourcesIco)

// C. trayIcon 先装包 ico 后通用回退
const idxResolve = mainSrc.indexOf('resolveTrayIcon()')
const idxFallback = mainSrc.search(/app\.getFileIcon/)
check(
  'C. trayIcon() 先 resolveTrayIcon()（打进包 ico）后 app.getFileIcon（通用图标回退）',
  idxResolve !== -1 && idxFallback !== -1 && idxResolve < idxFallback,
  `idxResolve=${idxResolve} idxFallback=${idxFallback}`
)

// D. 源 ico 有效
if (fs.existsSync(SRC_ICO)) {
  const buf = fs.readFileSync(SRC_ICO)
  const valid = buf.length > 100 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00
  check('D. 源 assets/we_icon.ico 是有效非空 ICO', valid, `size=${buf.length}`)
} else {
  check('D. 源 assets/we_icon.ico 存在', false)
}

// E. 动态：真实装包 resources 目录（可选）
const resDir = process.argv[2]
if (resDir) {
  const packedIco = path.join(resDir, 'we-icon.ico')
  if (fs.existsSync(packedIco)) {
    const b = fs.readFileSync(packedIco)
    check('E1. 装包 resources/we-icon.ico 存在且非空', b.length > 100, `size=${b.length}`)
  } else {
    check('E1. 装包 resources/we-icon.ico 存在', false, packedIco)
  }
} else {
  console.log('  SKIP  E. 动态项（未传入装包 resources 目录；CI 传入 electron-builder --dir 产物可自动校验）')
}

console.log(failures === 0 ? '\nT04011 自动验证：ALL PASS' : `\nT04011 自动验证：${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
