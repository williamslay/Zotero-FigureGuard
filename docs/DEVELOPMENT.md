# 开发与测试指南

本指南面向希望从源码构建、运行测试、排查检测效果或参与开发的贡献者。项目架构与 AI 代理开发契约见 [AGENTS.md](../AGENTS.md)，发布流程见 [RELEASING.md](./RELEASING.md)。

## 目录结构

```text
bootstrap.js                 XPI 引导入口（chrome sandbox）
manifest.json                插件清单：ID、版本、兼容范围、自动更新地址
src/
  core/                      纯 JS 检测层（不依赖 Zotero，可直接在 Node 测试）
    detector.js              pdf.js getOperatorList() → 页面图表矩形集合
    detector-options.js      检测阈值与开关
    captions.js              图注与图形区域配对
    placements.js            XObject / 图片放置到页面的映射
    cache.js                 按 item + 文档指纹作用域缓存
    pdf-source.js            文档指纹与文档级取数
    render.js / viewport.js / geom.js
  zotero/                    Zotero 集成层
    main.js                  startup/shutdown、Notifier、工具栏按钮、FigureGuard API
    reader-session.js        单 reader 会话生命周期、realm 校验、恢复调度
    overlay.js               覆盖层 canvas 挂载、绘制与过期检查
    realm-render.js          在 reader 自身 realm 内执行渲染
    paint-probe.js / xray.js / zoom.js
scripts/
  build.mjs                  esbuild 打包并生成 dist/*.xpi
  verify-xpi.mjs             校验 XPI 4 条目结构与版本，写出 SHA256SUMS.txt
  run-tests.mjs              两级测试调度器
  generate-updates-json.mjs  生成 Zotero 自动更新清单 updates.json
  survey_pdf.mjs             对任意 PDF 离线跑检测并输出区域清单
  probe_pdfjs_ops.mjs        查看指定页面 pdf.js 操作列表
  render_check.mjs           离线渲染与语义色差核对
tests/js/                    node:test 测试套件
fixture/                     参考验证数据 fixture-verified.json（PDF/PNG 不入库）
assets/                      插件图标（figureguard-icon.svg）与示例图
docs/                        维护文档（DEVELOPMENT / KNOWN_ISSUES / RELEASING）
.github/workflows/           ci.yml（CI 测试与构建）、release.yml（Tag 发布）
```

## 工作原理

整体分为三层：

1. **检测层** `src/core/detector.js`：纯函数。输入 pdf.js 的 `getOperatorList()`，输出一页的图表矩形集合。满页边框、装饰线、文字下划线等噪声由阈值规则过滤，等大子图面板会合并为同一区域。
2. **缓存层** `src/core/cache.js`：区域集合按 `item:<条目ID>|<文档指纹>` 作用域缓存，跨标签切换互不污染。
3. **集成层** `src/zotero/`：为每个 reader 会话建立并校验归属的 pdf.js realm，监听文档与页面事件，只在前台标签页优先调度当前可见页的检测与覆盖层重绘。覆盖层 canvas 附带来源戳（`fcpRealm` / `fcpDoc`），用于诊断跨页签错画或画布脱离文档的问题。

## 从源码构建

前置条件：

- Node.js 20+
- 系统命令行工具 `zip` 与 `unzip`（Linux：`sudo apt install zip unzip`）

构建并校验 XPI：

```bash
npm ci
npm run test:ci
npm run build
node scripts/verify-xpi.mjs
```

- `build/`（暂存目录）和 `dist/`（生成的 `zotero-figure-guard-<版本>.xpi` 与 `SHA256SUMS.txt`）均不入库。
- `verify-xpi.mjs` 会校验包内只包含以下 4 个条目，以及 `manifest.json` 中的插件 ID 与版本号，任一不符即以非零状态退出：
  - `manifest.json`
  - `bootstrap.js`
  - `content/index.js`
  - `content/figureguard-icon.svg`

## 运行测试

测试分为两级：

### Level 1 — 公开 CI 测试（无需外部 PDF）

```bash
npm run test:ci
```

只运行不依赖受版权保护 PDF 的测试文件（当前 18 个文件、431 个用例），结果中 `cancelled` 必须为 0。GitHub Actions 的 CI 门禁即运行此级别。

### Level 2 — 完整 Fixture 回归（需要真实 PDF）

```bash
npm test              # 等价于 npm run test:fixture
```

完整回归覆盖 25 个文件、513 个用例。检测层基线依赖 5 篇论文 PDF（受版权保护，不随仓库分发），需手动放置到下列路径（前 4 个位于仓库根目录，最后 1 个位于 `fixture/`）：

```text
Borges_ A Low-Latency Distributed Shared Log on a CXL Memory_SSD Hybrid.pdf
Flash-Level Asynchronous Execution for In-Storage LSM-Tree Operations.pdf
FluidKV_ Seamlessly Bridging the Gap between Indexing Performance and Memory-Footprint on Ultra-Fast Storage.pdf
HiKV - A Hybrid Index Key-Value Store for DRAM-NVM Memory Systems.pdf
fixture/PipeBWrite.pdf
```

缺少这些 PDF 时，`npm test` 会得到 434 通过、79 取消（cancelled）、0 失败（来自 7 个依赖真实 PDF 的测试文件）。因此公开 CI 只强制运行 `npm run test:ci`，完整回归在维护者本地执行。

> 注意：请通过 `npm test` 或 `npm run test:ci` 运行测试，不要直接运行裸 `node --test`。

## 离线探测与真机诊断

### 离线 PDF 排查

```bash
# 对任意 PDF 跑一遍检测器，输出每页矩形清单到 reports/
node scripts/survey_pdf.mjs path/to/paper.pdf

# 查看某页 pdf.js 操作列表与坐标变换
node scripts/probe_pdfjs_ops.mjs path/to/paper.pdf 1

# 离线渲染检查（需完整 fixture）
npm run render
```

### 真机诊断

在 Zotero 中打开 `工具 → 开发者 → Run JavaScript`，执行：

```js
Zotero.getMainWindow().FigureGuard.probeAll();
```

返回内容包括各 reader 会话的就绪状态、文档指纹、realm 归属、工具栏按钮挂载状态（`button`）、覆盖层来源戳、身份校验判定（`lastValidation`、`docIdStale`）以及诊断日志。已安装版本见 `version`，核心版本见 `coreVersion`。

## 分支模型

- `main`：唯一的长期公开分支，所有版本 Tag 均在此分支打出。
- `feature/*`：从 `main` 切出的短期功能分支，通过 PR 合入 `main` 后删除。
- `dev`：当前开发轮次的集成分支，真机验收通过后合回 `main`。
- `internal`：开源整理前的历史归档分支，不参与 CI 构建。
