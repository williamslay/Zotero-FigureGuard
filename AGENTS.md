# Zotero Figure Guard — Agent 指南

Zotero Figure Guard 是 Zotero 7–10 的 PDF 阅读器扩展。深色主题下，Zotero 原生 PDF 阅读器把整页反色，彩色图表跟着变成灰白轮廓；本扩展自动检测页面中的图表区域，只把这些区域恢复为 PDF 的原始颜色，其余部分保持深色。它不修改 PDF 文件，不依赖 Reading Mode，不改变 Zotero 的排版。本文件面向在本仓库工作的 AI 编码代理与维护者，记录模块架构、运行时事实、分支模型、版本策略与测试层级。当前已知问题见 [knownissue.md](./knownissue.md)，发布步骤见 [docs/RELEASING.md](./docs/RELEASING.md)。

## 分层与模块

检测逻辑在 `src/core/`（纯函数，不引用 Zotero，可直接在 Node 里测），Zotero 集成层在 `src/zotero/`，引导入口是 `bootstrap.js`，插件 ID 为 `figure-guard@zotero.org`。

引导层：

- `bootstrap.js`（196 行）：chrome sandbox 内的 XPI 引导，负责加载 `content/index.js`、随窗口开关注销。

检测层 `src/core/`：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `detector.js` | 1230 | 输入 pdf.js 的 `getOperatorList()`，输出一页的图表矩形集合。噪声（满页边框、装饰线、文字下划线）由阈值规则过滤 |
| `detector-options.js` | 153 | 检测阈值与开关的单一来源 |
| `captions.js` | 206 | 图注与图形区域的配对 |
| `placements.js` | 381 | XObject / 图片放置到页面的映射 |
| `cache.js` | 180 | 区域集合按 `item:<条目ID>|<文档指纹>` 作用域缓存，跨页签互不污染 |
| `pdf-source.js` | 118 | 文档指纹与文档级取数 |
| `render.js` | 110 | 把区域转成绘制参数 |
| `geom.js` | 138 | 矩形几何工具 |
| `viewport.js` | 83 | 视口与页面几何 |
| `index.js` | 54 | 对外聚合与 `CORE_VERSION` |

集成层 `src/zotero/`：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `main.js` | 1886 | 集成入口：`startup`/`shutdown`、Notifier 接线、`renderToolbar` 处理、工具栏开关、全局 `FigureGuard` API、`probeAll()` |
| `reader-session.js` | 1953 | 单个 reader 的生命周期：realm 解析与归属校验、文档事件、页面事件、稳定重绘检查 |
| `overlay.js` | 855 | 覆盖层 canvas 的挂载、绘制、几何是否过期、是否仍在文档里 |
| `paint-probe.js` | 554 | 绘制侧探针（真机诊断用） |
| `xray.js` | 330 | 操作列表的取证通道 |
| `realm-render.js` | 256 | 在 reader 自己的 realm 里执行渲染 |
| `zoom.js` | 88 | 缩放联动 |

会话侧的时间常量集中在 `src/zotero/reader-session.js:29-75`：`READY_POLL_MS` 250、`READY_TIMEOUT_MS` 20000、`RECOVERY_INTERVAL_MS` 5000、`RECOVERY_MAX_MS` 180000、`RECOVERY_SLOW_INTERVAL_MS` 20000、`DOCUMENT_CHECK_MS` 300、`SETTLED_REPAINT_MS` 350，文档事件名 `DOCUMENT_EVENTS`、页面事件名 `PAGE_RENDERED_EVENT`。改这些值等于改恢复节奏，需真机确认。

## 运行时事实（Zotero 10.0.8，源码级）

这些是排查真机问题时的既定前提，改集成层前先看这一节。

- `renderToolbar` 交给我们的 `doc` 是 reader iframe 自身的 document（`resource://zotero/reader/reader.html`，位于 `<browser id="reader">` 内），不是主窗口的 chrome document。派发点：zotero/reader `src/common/components/common/custom-sections.js:3-26`。
- 每次派发前该容器先 `replaceChildren`，上一轮追加的节点随之清空；`append()` 必须在事件里同步调用，否则抛 "Append must be called directly and synchronously in the event"（`custom-sections.js:18-24`）。我们的处理器已满足同步（`src/zotero/main.js:862-897`）。
- 该事件由工具栏挂载时的 `useEffect` 触发，依赖 `[replaceChildren, params]`，reader-ui 不传 `params`，因此每个 reader 文档打开只派发一次，翻页不重发（zotero/reader `src/common/components/toolbar.js:272`）。注释 `src/zotero/main.js:1119-1121` 记录了实测：只有被选中的 reader 收到自己的 `renderToolbar`。
- Zotero 自身阅读器工具栏按钮全部只用 `click`（`toolbar.js` 各按钮 `onClick`，86/109/117/125/132/172/181/188/196/207/220/257/265/292），没有 `mousedown`/`pointerdown` 门槛。同文件里唯一的 pointer 逻辑是阅读进度条（`toolbar.js:315-358`），与按钮无关。
- Zotero 在 chrome 层已知跨 iframe 的 pointer 事件会丢：`chrome/content/zotero/xpcom/reader.js` 的 `_handlePointerDown` 记录按下所在窗口，`_handlePointerUp` 在按下与抬起落在不同窗口时手动向原 iframe 补发 `mouseup`/`pointerup`（源码自称 "nonsense work-around"）。补发只在抬起侧。
- Windows 上 tooltip 由系统显示（mozilla-central `layout/xul/nsXULTooltipListener.cpp:554-556`），原生 tooltip 是独立顶层窗口但不捕获鼠标。因此「tooltip 吃掉首次按下」不是可靠解释。
- Notifier 接线见 `src/zotero/main.js:1243`；标签切换产生 `select`、打开产生 `load`，两者都汇入 `wakeTabSessions`（`src/zotero/main.js:1172`）。
- reader 面板隐藏约 60 秒后被 Zotero 卸载，其 realm 与 eventBus 重建；会话对象本身保留，因为 `sessions` 以 reader 对象为键（`src/zotero/main.js:125`、`704-727`）。
- 全局入口是 `Zotero.getMainWindow().FigureGuard`，导出面见 `src/zotero/main.js:1284-1880`（`startup`、`shutdown`、`setEnabled`、`clearCache`、`getSessions`、`getLog`、`runProbe`、`probeAll`、`probePaint`、`maintainButtons`、`wakeTabSessions`、`version`）。
- 全仓库没有 `MutationObserver`，也没有 `setInterval`。一切巡检都挂在已有事件上；新增监听器或定时器要说明理由。

## 会话、按钮与覆盖层的所有权

- `sessions: Map<reader, {session, startPromise, closeWatch}>`（`src/zotero/main.js:125`、`716`）。`ensureSession` 与 `syncOpenReaders` 走同一函数、同一 reader 键，所以单 reader 单会话。
- `session.start()` 不能被工具栏处理器等待，因为 `append` 必须同步返回（`src/zotero/main.js:721-725`）。这就是「图表照常恢复、按钮可能没挂」能同时成立的原因。
- `buttonLinks: Map<session, link>`（`src/zotero/main.js`）。link 记录 `button`、`doc`、`onPointerDown`、`onMouseUp`、`onClick`、`off`，以及 `renderToolbar` 给的 `toolbarDoc`、`append`、`parent`，供补挂时找回原容器。
- 按钮的唯一正常创建路径是 `onRenderToolbar`（`src/zotero/main.js`）；`createButton` 每次都先 `detachButton`。按钮的唯一补挂路径是 `maintainButtons()`（`src/zotero/main.js`），由 `wakeTabSessions` 调用，条件是节点已脱离文档且该 toolbar document 内没有我们的 `.fg-toggle`。
- Zotero 阅读器 `DIV.toolbar` 带有 `-moz-window-dragging: drag`；`.fg-toggle` 必须显式设置 `-moz-window-dragging: no-drag`（样式表与内联样式双写），否则 Windows 会把单击当作标题栏拖拽拦截。
- 覆盖层 canvas 挂在 `pageView.div` 里；阅读器滚动会回收并重建 pageView，canvas 随之离开文档。稳定重绘检查同时看几何是否过期（`geometryStale()`）与 canvas 是否还在文档（`isMounted()`），两者任一成立就重绘，并走 `attachPageNumber()` 把记录重绑到活的 pageView。

## 激活阶梯

工具栏开关的激活顺序是 `pointerdown` → `mouseup` → `click`，绑定在 `renderToolbar` 给的 toolbar document 捕获阶段，一次按下序列只动作一次：`pressActivated` 由 pointerdown 或 mouseup 置位，mouseup 落在按钮外或收尾的 click 到达时复位；键盘 `click`（`detail === 0` 严格相等）不受该标志影响。`hitToggle` 同时支持包围盒命中、已挂载按钮及其子孙的直接目标命中（兼容真机键盘 `(0, 0)` 坐标事件），以及按钮被 React 替换后的 `.fg-toggle` stand-in。

## 分支模型

`main` 是唯一的长期公开分支。功能的走法：

1. 从最新的 `main` 切出 `feature/<主题>` 分支。
2. 开发、推送，向 `main` 开 pull request。PR 触发 CI 门禁。
3. 合并。合并提交在 `main` 上再跑一次 CI，然后删掉 feature 分支。
4. 装上这次合并产出的 CI Artifact，在真机 Zotero 上验收该功能。

`internal` 分支保存开源改造前的完整历史，额外包含内部设计文档与逐轮开发日志，不参与 CI 构建。

`dev` 分支保存当前开发轮次的改动，从 `main` 切出，推送不触发 CI，轮次验收后合并回 `main` 再打 tag。

## 版本策略

版本号跟着功能走，不跟着构建走：

- 合并功能不消耗版本号，测试构建也不需要单独的版本号。每次 PR 与每次合并到 `main` 都会存一个以运行号加短 SHA 命名的 Artifact，例如 `zotero-figure-guard-run12-1a2b3c4`，直接装它试功能。
- 一组已合并的功能在真机验收通过后，才切一个版本：新功能升 minor（`v0.6.0`），已发布版本上的修补升 patch（`v0.6.1`）。
- 一个 Tag 对应一个版本。已发布的 Tag 不移动、不复用。推送到 `v*` Tag 就是正式发布。
- 版本号手动维护：CI 不会自动 bump，也不会在每次推送 `main` 时发版。
- 版本号一致性由 Release 工作流强制：Tag、`package.json`、`package-lock.json`、`manifest.json` 四处必须相同。

两条 GitHub Actions 工作流，都不需要额外的 Token 或外部服务器：

- **CI** `.github/workflows/ci.yml`：pull request 与推送到 `main` 时触发（另有 `workflow_dispatch`）。执行 `npm ci` → `npm run test:ci` → `npm run build` → XPI 校验，并把 xpi 与 `SHA256SUMS.txt` 存成 Actions Artifact 供下载。权限只有 `contents: read`，不发 Release，没有 `continue-on-error`。测试或构建失败即工作流失败。
- **Release** `.github/workflows/release.yml`：推送 `v*` Tag 时触发。先确认该 Tag 存在且位于 `main` 的历史中，再校验四处版本一致，然后测试、构建、校验 XPI，最后用 `gh release create --verify-tag --generate-notes` 创建 Release 并上传 xpi 与 `SHA256SUMS.txt`。权限为 `contents: write`，用的是自动提供的 `GITHUB_TOKEN`。

## 两级测试

- `npm run test:ci` — 公开 CI 级，不需要受版权保护的 PDF。只跑不碰真实 PDF 的测试文件（当前 18 个文件、431 个用例），全部实际执行并通过，结果里 `cancelled` 必须为 0。GitHub Actions 的 CI 就是这一级。
- `npm test`（等价于 `npm run test:fixture`）— 维护者本地的完整回归级，当前 25 个文件、513 个用例。检测层的回归基线取自 5 篇论文的 PDF，这些 PDF 受版权保护、不随仓库分发，需要自行放到 README「运行测试」一节列出的路径。缺少这些 PDF 时，依赖真实 PDF 的 79 个用例会取消（cancelled）而不是通过，所以完整回归只在维护者本地跑，不作为公开 CI 的强制门槛。

规范命令是 `npm test`；直接跑裸 `node --test` 会有一次伪失败。检测基线（已接受区域数）：PipeBWrite 18、FluidKV 18、Flash 10、Borges 9，另有 HiKV fixture。改 `src/core/` 任何阈值都要跑 `npm test` 并核对这组数字。

## 构建契约

- XPI 只有四个条目：`manifest.json`、`bootstrap.js`、`content/index.js`、`content/figureguard-icon.svg`。`content/index.js` 是 `src/zotero/main.js` 的 esbuild 包。
- XPI 不是字节可重现的（zip 时间戳），校验看条目集合与版本，不看哈希相等。
- 打包后必须跑 `node scripts/verify-xpi.mjs --expect-version <版本>`；它同时写 `dist/SHA256SUMS.txt`。
- 维护者直接从工作区的 `dist/` 安装 XPI 做真机验收，不下载 GitHub Artifact。

## 工程约束

- 检测算法只在有测量证据时改，不做「看起来更好」的调参。
- 不新增定时器、不新增事件监听器、不用「清空缓存」掩盖问题；需要时说明为什么已有事件不够。
- 不加针对单篇论文的特例规则。
- `TOGGLE_CSS` 是模板字符串，注释里不能出现反引号。
- 临时诊断代码（计数器、`span.fg-count`、多余的目标绑定）在真机结论确定后要删除，不留成永久负担。
