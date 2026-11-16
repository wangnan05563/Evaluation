# 产品介绍文档生成链

生成 `docs/工作量评估助手-产品介绍.docx`（11 页）。图版已入库，**新克隆一条命令即可重建文档**：

```bash
python tools/docs/product-intro/build.py
```

## 两条链

| 链 | 依赖 | 说明 |
|---|---|---|
| 文档重建（默认） | python-docx | 用 `docs/assets/product-intro/*.png` 生成 docx，不需要浏览器/Excel |
| 图版重出（可选） | node + Chrome + Electron + Excel | 重采界面底图 → 裁拼图版 → 再生成 docx，仅 Windows 本机操作 |

```bash
# 只生成 docx（默认）
python tools/docs/product-intro/build.py

# 生成到别处，不动入库件
python tools/docs/product-intro/build.py --out release/tmp/_verify/intro.docx

# 生成后导出逐页 PNG 目检（需 Word + pymupdf）
python tools/docs/product-intro/build.py --preview

# 重采底图 → 重拼图版 → 重生成
python tools/docs/product-intro/build.py --capture --compose
```

## 文件

| 文件 | 作用 |
|---|---|
| `build.py` | 入口：编排下面各步，`--capture / --compose / --preview` 按需开启 |
| `gen_docx.py` | 正文/样式/图注/分页，按图注插入 `docs/assets/product-intro/*.png` |
| `compose_shots.py` | `release/shots/*.png` 底图 → 文档图版（细边框、①②③ 徽标、标注条、统一宽度） |
| `shots.mjs` | headless Chrome + CDP 驱动真实前端，采集 12 张界面底图（隔离实例、随机口令目录） |
| `electron_shot.mjs` | 开发态 Electron 真窗口截图（含标题栏），Windows PrintWindow |
| `win_shot.py` | `electron_shot.mjs` 调用的窗口抓取（DPI 感知 + PW_RENDERFULLCONTENT） |
| `xlsx_shot.py` | Excel COM 打开成品 xlsx，两 sheet 按矢量导出 PNG |
| `docx_preview.py` | docx → PDF → 逐页 PNG，供翻页目检 |

## 约定

- 采集全程走**隔离实例**（`WE_DATA` 指 `release/tmp/_shotdata`），不读本机配置与真实估算数据。
- 底图 `release/shots/` 与中间件 `release/tmp/_shot_v1.xlsx` 都是本地产物，不入库；入库的只有 `docs/assets/product-intro/` 下的 12 张图版。
- 大模型配置页刻意保持 Key 为空占位，不得为截图填真实密钥。
- 改完文案或图版后重跑 `build.py`，并翻页核对（`--preview`）；页数应与入库版一致（当前 11 页）。
