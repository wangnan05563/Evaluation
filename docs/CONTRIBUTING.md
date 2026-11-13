# 贡献指南（CONTRIBUTING）

> 本仓库为「工作量评估助手」单人维护项目。改动直接提交 `main`，提交信息以任务号开头，便于与任务系统互相溯源。

- 源码仓库：<https://github.com/wangnan05563/Evaluation>
- 问题反馈（Issues）：<https://github.com/wangnan05563/Evaluation/issues>

## 环境准备

- **Python**：3.10+，需 `python-docx`、`openpyxl`（开发 / 构建依赖）。
- **Node.js**：用于运行回归套件（`npm test`）与 Electron 壳。
- **桌面构建**（可选）：需 `dev-shell/node_modules/electron` 与 electron-builder；内网 / 离线构建镜像源集中在 `scripts/publish.config.json` 的 `env` 段（`ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`），不在脚本里硬编码。

本地启动：

```bash
# 方式一：启动脚本（引擎 8020 端口 + 自动打开前端）
scripts\启动服务.bat

# 方式二：手动启动
python scripts/server.py 8020
# 浏览器访问 http://127.0.0.1:8020
```

## 贡献流程

1. 拉取 `main`（本仓库单人维护，改动直接提交 `main`，提交信息以任务号开头，如 `T03631 README 同步…`，便于与任务系统互相溯源）。
2. 按改动类型自测：
   - 改前端：先 `python scripts/build_frontend.py` 重新打包 `frontend/index.html`，再 `npm test`；
   - 改计算口径：必须过金标准 `python scripts/generate_xlsx.py --verify`（US 合计 = `105.07`）；
   - 加界面文案：`data/i18n/zh-CN.json` 与 `en-US.json` **同时**补 key，跑 `python tests/i18n_check.py`（key 对齐 + 服务端 msgKey 覆盖）；
   - 加服务端提示：用 `scripts/server.py` 的 `_m(key, 中文兜底)` 返回 msgKey，前端经 `lm()` 查字典渲染，不要直接硬编码中文给英文态。
3. 交付线：`npm test` **17/17 全绿**（S17 无桌面会话时允许 SKIP）；只跑单套件用 `npm test -- --only=S4`。
4. 不要提交：`data/` 运行时产物（`config.json`、`*.db`、`generated/`、`uploads/`）、`release/`、`logs/`、根目录 `.env`（`.gitignore` 已覆盖；`data/i18n/` 与 `data/testdocs/` 是例外，属源码 / 夹具必须入库）。
5. 发布：本地 `scripts\构建打包.bat` 出包，或 `scripts\一键发布.bat` 构建 + 发布 GitHub Releases（先 `set GH_DRY_RUN=1` 演练一遍）。

## 相关文档

- 完整测试体系（S1–S18）、计算口径、设计细节见仓库 `docs/` 目录下的设计文档。
- 发布到 GitHub Releases 的详细流程（6 步、免安装产物冒烟门、环境变量、幂等）见 README「发布（一键发布到 GitHub Releases）」章节。
- 产品介绍（含界面图与获取方式）见 `docs/工作量评估助手-产品介绍.docx`。
