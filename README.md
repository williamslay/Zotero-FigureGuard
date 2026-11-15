# Zotero FigureGuard

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-0.1.31-blue?style=flat-square">
  <img alt="Zotero 7–10" src="https://img.shields.io/badge/Zotero-7--10-orange?style=flat-square">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square">
  <img alt="CI" src="https://github.com/williamslay/Zotero-FigureGuard/actions/workflows/ci.yml/badge.svg?branch=main">
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
- [CI 与发布](#ci-与发布)
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

1. 到 [Releases](https://github.com/williamslay/Zotero-FigureGuard/releases) 下载 **`.xpi`** 文件：`figure-color-preservation-<版本>.xpi`。不要下页面里的 Source code 压缩包，那个不能直接安装。
2. Zotero → 工具 → 插件 → 齿轮 → Install Plugin From File…，选择该 xpi。
3. 打开任意 PDF：深色主题下图表区域即显示原色，工具栏按钮可临时关闭。

插件 ID 为 `figure-color-preservation@local`，兼容 Zotero 7–10。Release 页面还附带 `SHA256SUMS.txt`，用于校验下载文件。

## 从源码构建

```bash
npm ci
npm run test:ci
npm run build   # → dist/figure-color-preservation-0.1.31.xpi
```

构建需要系统命令 `zip` 与 `unzip`（Linux：`sudo apt install zip unzip`）。`build/`（打包暂存目录）和 `dist/`（xpi 与 `SHA256SUMS.txt`）都是生成产物，不入库。

打包后校验 XPI：

```bash
node scripts/verify-xpi.mjs
```

它检查包内只有 `manifest.json`、`bootstrap.js`、`content/index.js` 三个条目，检查包内 `manifest.json` 的版本与插件 ID，并写出 `dist/SHA256SUMS.txt`。任一检查失败即以非零状态退出。

## 运行测试

测试分两级。

**Level 1 — 公开 CI 测试**（不需要受版权保护的 PDF）

```bash
npm run test:ci
```

只跑不碰真实 PDF 的测试文件（当前 16 个文件、377 个用例），全部实际执行并通过，结果里 `cancelled` 必须为 0。GitHub Actions 的 CI 就是这一级。

**Level 2 — 完整 fixture 回归**（需要真实 PDF）

```bash
npm test              # 等价于 npm run test:fixture
```

检测层的回归基线取自 5 篇论文的 PDF。这些 PDF 受版权保护，不随仓库分发，需要自行放到下列路径（前四行在仓库根目录，最后一行在 `fixture/`）：

```text
Borges_ A Low-Latency Distributed Shared Log on a CXL Memory_SSD Hybrid.pdf
Flash-Level Asynchronous Execution for In-Storage LSM-Tree Operations.pdf
FluidKV_ Seamlessly Bridging the Gap between Indexing Performance and Memory-Footprint on Ultra-Fast Storage.pdf
HiKV - A Hybrid Index Key-Value Store for DRAM-NVM Memory Systems.pdf
fixture/PipeBWrite.pdf
```

完整回归共 23 个文件、459 个用例。缺少这些 PDF 时，`npm test` 会得到 380 通过、79 取消（cancelled）、0 失败：被取消的 79 个用例来自 7 个依赖真实 PDF 的测试文件，它们的 `before` 钩子打不开文件。`npm run test:ci` 会跳过这 7 个文件，所以公开 CI 里不会出现「大量 cancelled 冒充通过」。完整回归只在维护者本地跑，不作为公开 CI 的强制门槛。

## CI 与发布

两条 GitHub Actions 工作流，都不需要额外的 Token 或外部服务器。

- **CI** `.github/workflows/ci.yml`：pull request，以及推送到 `main` 或 `dev` 时触发。执行 `npm ci` → `npm run test:ci` → `npm run build` → XPI 校验，并把 xpi 与 `SHA256SUMS.txt` 存成 Actions Artifact 供下载。权限只有 `contents: read`，不发 Release。测试或构建失败即工作流失败。
- **Release** `.github/workflows/release.yml`：推送 `v*` Tag 时触发。先确认该 Tag 位于 `main` 的历史中，再校验 Tag 与 `package.json`、`package-lock.json`、`manifest.json` 四处版本一致，然后测试、构建、校验 XPI，最后用 `gh release create --verify-tag --generate-notes` 创建 Release 并上传 xpi 与 `SHA256SUMS.txt`。0.1.x 版本标记为 Pre-release。权限为 `contents: write`，用的是自动提供的 `GITHUB_TOKEN`。

版本号手动维护：CI 不会自动 bump，也不会在每次推送 `main` 时发版。发布步骤与失败处理见 [docs/RELEASING.md](./docs/RELEASING.md)。


## 工作原理

分三层。

- **检测层** `src/core/detector.js`：纯函数。输入 pdf.js 的 `getOperatorList()`，输出一页的图表矩形集合。满页边框、装饰线、文字下划线等噪声由阈值规则过滤。
- **缓存层** `src/core/cache.js`：区域集合按 `item:<条目ID>|<文档指纹>` 作用域缓存，跨页签互不污染。
- **集成层** `src/zotero/`：为每个 reader 会话建立一个 realm，也就是该 reader 自己的 pdf.js 窗口，并校验归属。文档指纹漂移、页签切换（Zotero Notifier 的 `tab` 事件）、realm 被 Zotero 回收重建，都有对应的恢复路径。覆盖层画布带来源戳 `fcpRealm` / `fcpDoc`，用来定位「画布画进了别人的页面」这类问题。

## 目录结构

```text
bootstrap.js              XPI 引导入口（chrome sandbox）
manifest.json             插件清单：ID、版本、兼容范围
src/core/                 检测器、区域缓存、几何与绘制辅助，与 Zotero 无关
src/zotero/               reader 会话、覆盖层、缩放、探针、Notifier 接线
scripts/build.mjs         esbuild 打包：src/zotero/main.js → build/content/index.js → dist/*.xpi
scripts/run-tests.mjs     两级测试入口（ci 跳过依赖真实 PDF 的文件）
scripts/verify-xpi.mjs    校验 dist/*.xpi 的包结构与版本，并写出 SHA256SUMS.txt
scripts/survey_pdf.mjs    对任意 PDF 跑一遍检测器并输出区域清单
tests/js/                 node:test 用例
fixture/                  参考数据 fixture-verified.json（PDF/PNG 不入库）
assets/                   README 用图
docs/RELEASING.md         维护者发布说明
.github/workflows/        ci.yml（测试与构建）、release.yml（Tag 触发发布）
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

- `main`：对外发布分支，只包含插件源码、测试与用户文档（`docs/` 里只发布 `RELEASING.md`），版本 Tag 都打在这里。
- `dev`：完整开发分支，额外包含 `docs/`（规范与决策记录）和 `reports/`（逐轮开发日志、检测基线数据）。

## 许可

MIT © williamslay
