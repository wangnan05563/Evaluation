// 工作量评估工具桌面壳 preload：保持与 BempDiff 壳一致的隔离模型。
// 前端（frontend/index.html）直连 HTTP API；壳侧能力按需以最小接口暴露。
// T03779：窗口关闭行为（最小化到托盘 / 直接退出 + 记住选择）由主进程持有，
// 配置中心通过 window.weval.windowBehavior 读写，持久化文件名与后端 data/config.json 隔离。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('weval', {
  desktop: true,
  version: process.versions.electron || '',
  windowBehavior: {
    get: () => ipcRenderer.invoke('weval:window-behavior:get'),
    set: (patch) => ipcRenderer.invoke('weval:window-behavior:set', patch)
  }
})
