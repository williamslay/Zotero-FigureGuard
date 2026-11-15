# Zotero FigureGuard

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-0.1.31-blue?style=flat-square">
  <img alt="Zotero 7–10" src="https://img.shields.io/badge/Zotero-7--10-orange?style=flat-square">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square">
  <img alt="tests" src="https://img.shields.io/badge/tests-426%20passing-brightgreen?style=flat-square">
</p>

深色主题下，让论文里的图表保持原色。

Zotero 原生 PDF 阅读器的深色主题会把整页反色：文字变白是对的，彩色图表却跟着变成灰白轮廓。FigureGuard 自动检测页面中的图表区域，只把这些区域恢复为 PDF 的原始颜色，其余部分保持深色。不修改 PDF 文件，不依赖 Reading Mode，不改变 Zotero 的排版。

> 状态：预览版 0.1.31。真机验证环境为 Zotero 10.0.8 / Windows。

<p align="center">
  <img src="./assets/example-figure-2.png" width="440" alt="检测出的图表区域按 PDF 原始颜色渲染">
</p>

<p align="center"><sub>pdf.js 渲染的图表区域裁切（3×，PDF 原始颜色），不是 Zotero 界面截图。</sub></p>

## 目录

- [功能](#功能)
- [安装](#安装)
- [从源码构建](#从源码构建)
- [运行测试](#运行测试)
- [工作原理](#工作原理)
- [目录结构](#目录结构)
- [诊断](#诊断)
- [已知限制](#已知限制)
- [分支说明](#分支说明)
- [许可](#许可)

## 功能

- **自动检测图表区域**：识别矢量路径与 Form XObject 构成的插图。等大的子图面板（网格或成行排布）会合并为同一张图。
- **只在图内恢复原色**：检测到的矩形上叠加一层原色画布，白底显示图内内容，正文仍是深色。
- **跟随阅读操作**：缩放、翻页、窗口尺寸变化后自动重画；多页签切换自动跟随。
- **按文档缓存**：区域集合以「条目 + 文档指纹」为键缓存，重复打开不重新检测。
- **工具栏开关**：一键启停。

## 安装

1. 到 [Releases](../../releases) 下载 `figure-color-preservation-<版本>.xpi`。
2. Zotero → 工具 → 插件 → 齿轮 → Install Plugin From File…，选择该 xpi。
3. 打开任意 PDF：深色主题下图表区域即显示原色，工具栏按钮可临时关闭。

插件 ID 为 `figure-color-preservation@local`，兼容 Zotero 7–10。

## 从源码构建

```bash
npm install
npm run build   # → dist/figure-color-preservation-0.1.31.xpi
```

`build/`（打包暂存目录）和 `dist/`（xpi）都是生成产物，不入库。

## 运行测试

```bash
npm test        # 426 个用例 / 74 个 suite（node:test）
```

检测层的回归基线取自 5 篇论文的 PDF。这些 PDF 受版权保护，不随仓库分发，需要自行放到下列路径（前两行在仓库根目录，最后一行在 `fixture/`）：

```text
Borges_ A Low-Latency Distributed Shared Log on a CXL Memory_SSD Hybrid.pdf
Flash-Level Asynchronous Execution for In-Storage LSM-Tree Operations.pdf
FluidKV_ Seamlessly Bridging the Gap between Indexing Performance and Memory-Footprint on Ultra-Fast Storage.pdf
HiKV - A Hybrid Index Key-Value Store for DRAM-NVM Memory Systems.pdf
fixture/PipeBWrite.pdf
```

缺少这些 PDF 时，`npm test` 会得到 347 通过、79 取消（cancelled）、0 失败：被取消的用例全部依赖真实 PDF，它们的 `before` 钩子打不开文件。其余用例不碰 PDF。

## 工作原理

分三层。

- **检测层** `src/core/detector.js`：纯函数。输入 pdf.js 的 `getOperatorList()`，输出一页的图表矩形集合。满页边框、装饰线、文字下划线等噪声由阈值规则过滤。
- **缓存层** `src/core/cache.js`：区域集合按 `item:<条目ID>|<文档指纹>` 作用域缓存，跨页签互不污染。
- **集成层** `src/zotero/`：为每个 reader 会话建立一个 realm，也就是该 reader 自己的 pdf.js 窗口，并校验归属。文档指纹漂移、页签切换（Zotero Notifier 的 `tab` 事件）、realm 被 Zotero 回收重建，都有对应的恢复路径。覆盖层画布带来源戳 `fcpRealm` / `fcpDoc`，用来定位「画布画进了别人的页面」这类问题。

## 目录结构

```text
bootstrap.js            XPI 引导入口（chrome sandbox）
manifest.json           插件清单：ID、版本、兼容范围
src/core/               检测器、区域缓存、几何与绘制辅助，与 Zotero 无关
src/zotero/             reader 会话、覆盖层、缩放、探针、Notifier 接线
scripts/build.mjs       esbuild 打包：src/zotero/main.js → build/content/index.js → dist/*.xpi
scripts/survey_pdf.mjs  对任意 PDF 跑一遍检测器并输出区域清单
tests/js/               node:test 用例
fixture/                参考数据 fixture-verified.json（PDF/PNG 不入库）
assets/                 README 用图
```

## 诊断

在 Zotero 的 工具 → 开发者 → Run JavaScript 中执行：

```js
Zotero.getMainWindow().FigureColorPlugin.probeAll();
```

返回每个 reader 会话的就绪状态、文档指纹、realm 归属、画布来源戳、身份校验判定（`lastValidation`、`docIdStale`）与警告日志。`version` 是已安装插件的版本，核心构建号见 `coreVersion`。

## 已知限制

- 规则按学术 PDF 的常见图表形态调校：矢量路径、Form XObject、双栏排版。纯位图扫描件与特殊着色方式尚未覆盖。
- 图注与图相隔较远的排版、并排小图各自成带等边界情形，仍会漏检或并错。
- 真机验证只在 Zotero 10.0.8 / Windows 完成。Zotero 大版本升级后 pdf.js 的内部结构可能变化，上面「诊断」一节列出的字段是排查入口。
- 0.1.x 阶段：检测规则和对外接口都可能继续调整。

## 分支说明

- `main`：对外发布分支，只包含插件源码、测试与文档。
- `dev`：完整开发分支，额外包含 `docs/`（规范与决策记录）和 `reports/`（逐轮开发日志、检测基线数据）。

## 许可

MIT © williamslay
