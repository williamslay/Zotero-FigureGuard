# Zotero FigureGuard

Zotero 10 原生 PDF 阅读器的深色主题会把整页反色：文字变白是对的，彩色图表却跟着变成灰白轮廓。FigureGuard 自动识别页面里的图表区域，把这些区域恢复为 PDF 原始颜色，其余部分保持深色主题。不修改 PDF 文件，不依赖 Reading Mode，不改 Zotero 的排版。

> 版本 0.1.30。插件 ID `figure-color-preservation@local`，兼容 Zotero 7–10（真机验证：Zotero 10.0.8 / Windows）。

## 它做什么

- 在 reader 渲染的每一页上自动检测「图表区域」（矢量路径与 Form XObject 构成的插图），在检测到的矩形上叠加原色画布，白底显示图内内容。
- 检测基于 pdf.js 的 `getOperatorList()`：按绘图指令聚类出路径与 XObject 边界，再过滤满页边框、装饰线、文字下划线等噪声。规则以四篇体系结构论文的 accepted 区域集合为基线逐字节钉死。
- 缩放、翻页、窗口变化后自动重画；多页签切换自动跟随；区域按「条目 + 文档指纹」缓存，重复打开不重新检测。
- 工具栏开关一键启停。

## 安装

1. 下载 `dist/figure-color-preservation-<版本>.xpi`（或本地 `npm run build` 生成）。
2. Zotero → 工具 → 插件 → 齿轮 → Install Plugin From File…，选择 xpi。
3. 打开任意 PDF，深色主题下图表区域即显示原色；工具栏按钮可临时关闭。

`dist/` 未入库，需本地构建：

```bash
npm install
npm run build   # → dist/figure-color-preservation-0.1.30.xpi
```

## 工作原理（简）

- **检测层**（`src/core/detector.js`）：纯函数，输入 pdf.js 操作列表，输出一页的图表矩形集合。已冻结，改动必须过基线测试。
- **缓存层**（`src/core/cache.js`）：区域集合按 `item:<条目ID>|<文档指纹>` 作用域缓存，跨页签互不污染。
- **集成层**（`src/zotero/`）：bootstrap XPI。为每个 reader 会话建立「realm」——即该 reader 自己的 pdf.js 窗口——并校验归属；文档指纹漂移、页签切换（Zotero Notifier `tab` 事件）、realm 被 Zotero 回收重建等场景都有恢复路径。覆盖层画布带来源戳（`fcpRealm` / `fcpDoc`），可诊断「画布画进了别人的页面」这类问题。

## 开发

```bash
npm install
npm test        # 399 个用例 / 66 个 suite（node:test，含 reports/*.json 基线逐字节校验）
npm run build   # → dist/ 下打包 xpi
```

- 检测基线：`reports/*-detection.json`（PipeBWrite 18 区、FluidKV 18 区、Flash 10 区、Borges 9 区），任何检测层改动若移动这些矩形，测试直接失败。
- 开发与验收全过程记录在 [`reports/A3_BUILD_AND_LIMITS.md`](reports/A3_BUILD_AND_LIMITS.md)（按轮次，含每轮真机探针证据与遗留限制）。
- 诊断：Zotero 的 Run JavaScript 里执行 `FigureColorPlugin.probeAll()`，返回各 reader 会话的就绪状态、文档指纹、realm 归属、画布来源戳、身份校验判定（`lastValidation`、`docIdStale`、`lastStaleKey`、`staleKeyPresent`）与警告日志。顶层 `version` 是已安装插件的版本（取自 `manifest.json`），核心构建号见 `coreVersion`。

## 目录

```text
bootstrap.js            XPI 引导（chrome sandbox）
manifest.json           插件清单（版本、兼容性）
src/core/               检测器、区域缓存、绘制辅助（与 Zotero 无关）
src/zotero/             reader 会话、覆盖层、探针、Notifier 接线
scripts/                离线检查与 pdf.js 实验脚本（构建脚本 build.mjs）
tests/js/               node:test 全量用例
tests/*.py              交接包结构检查（Python）
fixture/                PipeBWrite 测试 PDF 的参考数据（PDF/PNG 不入库）
docs/                   初始规范与决策记录（Stage A/B 交接包）
reports/                检测基线、阶段报告、逐轮开发日志
```

## 已知限制

- 检测规则按学术 PDF 的常见图表形态调校（矢量路径、Form XObject、双栏排版）；纯位图扫描件与特殊着色方式未覆盖。
- 图注（caption）与图的分离、并排小图的独立分带等边界情形在 backlog 中，见 `reports/A3_BUILD_AND_LIMITS.md` 各轮「遗留限制」。
- 真机验证环境为 Zotero 10.0.8 / Windows；Zotero 大版本升级后 pdf.js 内部结构可能变化，探针字段是排查入口。
