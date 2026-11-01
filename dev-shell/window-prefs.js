// 窗口关闭行为偏好（T03779）：壳进程独占的持久化配置。
// 为什么不复用后端 data/config.json：关闭决策发生在主进程，且用户在 sidecar
// 未就绪/已崩溃时仍必须能关窗，读后端配置会引入额外故障点。
const fs = require('node:fs')
const path = require('node:path')

const CLOSE_ACTIONS = Object.freeze({
  MINIMIZE: 'minimize_to_tray',
  EXIT: 'exit_app'
})
// 首次运行默认最小化到托盘（常见桌面软件习惯），记住选择默认关闭（每次弹窗）
const DEFAULTS = Object.freeze({
  close_action: CLOSE_ACTIONS.MINIMIZE,
  remember_choice: false
})
const FILE_NAME = 'window-prefs.json'

function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    close_action: src.close_action === CLOSE_ACTIONS.EXIT ? CLOSE_ACTIONS.EXIT : CLOSE_ACTIONS.MINIMIZE,
    remember_choice: src.remember_choice === true
  }
}

// 同目录临时文件 + rename 原子替换：并发/断电时磁盘上要么是旧完整文件，
// 要么是新完整文件，不会出现被读到半截 JSON 的情况。
function createStore(dir) {
  const file = path.join(dir, FILE_NAME)
  let cache = null

  function read() {
    if (cache) return { ...cache }
    let parsed = null
    try {
      if (fs.existsSync(file)) parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (_) {
      parsed = null // 损坏文件按首次运行处理，避免配置异常导致无法关窗
    }
    cache = parsed ? normalize(parsed) : { ...DEFAULTS }
    return { ...cache }
  }

  function write(patch) {
    const next = normalize({ ...read(), ...(patch && typeof patch === 'object' ? patch : {}) })
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch (e) {
      try { fs.unlinkSync(tmp) } catch (_) { /* 清理失败不掩盖原始错误 */ }
      throw e
    }
    cache = next
    return { ...next }
  }

  return { file, read, write }
}

function needsPrompt(prefs) {
  return !prefs || prefs.remember_choice !== true
}

// 仅当用户勾选「记住」时才返回要落盘的配置；未勾选返回 null（本次执行但不改配置）
function nextPrefsOnChoice(action, remember) {
  if (!remember) return null
  return normalize({ close_action: action, remember_choice: true })
}

module.exports = {
  CLOSE_ACTIONS,
  DEFAULTS,
  FILE_NAME,
  normalize,
  createStore,
  needsPrompt,
  nextPrefsOnChoice
}
