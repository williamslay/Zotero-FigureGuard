# A0 — 结构核查与架构决策

结论：**B 路线（双渲染 + 局部 overlay）成立，手写 PDF parser 备选方案不触发**。pdf.js `getOperatorList()` 在测试 PDF 上保留 Form 的 begin/end、`/BBox` 与 `/Matrix`，JavaScript 可重建页面几何（离线实测）；原色绘制依赖的 `ctx.skipBlender` 条件在 Zotero 8/9/10 源码确认存在，且是 context 级、与整页绘制流程隔离。所有 Zotero 内部路径标记为待 B 实机验证。

标注约定：**[离线实测]** = 本机 Node harness 可复现；**[源码确认]** = 官方仓库指定 tag 的代码行为据；**[待 B 验证]** = 只有真实 Zotero 能证明。

## 1. 运行方式与证据文件

```bash
npm run probe   # scripts/probe_pdfjs_ops.mjs → 打印并落盘 reports/A0-probe-page5.json
```

| 项 | 值 |
|---|---|
| Node.js / npm | v22.23.0 / 10.9.8 |
| pdfjs-dist | 6.5.438（主）与 4.10.38（对照），`pdfjs-dist/legacy/build/pdf.mjs` |
| 测试 PDF | `fixture/PipeBWrite.pdf`（16 页，612×792，全页 rotation 0，无 `/StructTreeRoot`） |
| 探针输出 | `reports/A0-probe-page5.json` |

## 2. operator list 能力核查（离线实测）

对第 5 页运行 `getOperatorList()` 并按 save/restore/transform 累积 CTM：

- 该页 **2 个 `paintFormXObjectBegin`、0 个 `paintImageXObject`**；`paintFormXObjectBegin` 参数携带 `matrix`（`/Matrix`）与 `bbox`（`/BBox`），Form 未被展平。
- 重建 CTM 与 Python oracle 完全一致：`[1.00053, 0, 0, 1.00053, 54, 617.946]`（Figure 2）与 `[0.43729, 0, 0, 0.43729, 317.88, 577.48]`（Figure 3）。
- save/restore 平衡（122/122），栈深归零；嵌套深度最大 1。
- operator 数值编码在 pdfjs-dist **4.10.38 与 6.5.438 上完全相同**：save 10、restore 11、transform 12、paintImageXObject 85、paintImageXObjectRepeat 88、paintFormXObjectBegin 74、paintFormXObjectEnd 75。运行时优先用 pdf.js 导出的 `OPS` 查表；查不到时回退 `MEASURED_OP_CODES`（`src/core/pdf-source.js`），再缺失则失败关闭（不猜测）。

结论：规范 §2 的首选路径（operator list + CTM）成立；§2 的"最小可行替代方案"（打包 JS PDF 对象解析）**不需要实现**。

另两条离线实测事实影响 B 路线实现：

- pdf.js 6.x 的 `PageViewport` 只有 `convertToViewportPoint()`/`convertToPdfPoint()`，规范 §3 B.3 提到的 `convertToViewportRectangle()` **已移除**；`src/core/viewport.js` 的 `toViewportRect()` 基于 `convertToViewportPoint()` 自建（缺方法时回退 `viewport.transform`）。
- `PDFPageProxy.render()` 的 `transform` 参数是**设备空间纯平移**（`outputScale` 不参与），裁剪栅格尺寸 = `scale × devicePixelRatio`；由 A2 的缩放对齐实验证实（见 `reports/A2_RENDER.md` §4）。

## 3. reader 获取 pdfPage / PDF bytes 的方法（源码确认）

依据 `zotero/zotero` 仓库 tag `7.0.24` 与 `10.0.8` 的 `chrome/content/zotero/xpcom/reader.js`，及 `zotero/reader` 仓库分支 `fx115`（Zotero 7）与 `10.0`：

- reader 的 PDF 数据源是 URL：`zotero://attachment/.../items/{key}/`（reader.js:576–593, 7.0.24）；Zotero 自己读字节的方式是 `Cu.cloneInto(await IOUtils.read(path), this._iframeWindow)`（reader.js:736, 7.0.24）。`OS.File`/`OS.Path` 在 Firefox 115 已移除，插件侧应使用 `IOUtils.read()` → `ArrayBuffer`（`Zotero.File.getBinaryContentsAsync` 返回 binary string，不是 `Uint8Array`，file.js:313, 7.0.24）。
- **插件不需要自己取字节**：pdf.js 对象链可直接到达——`reader._internalReader._primaryView._iframeWindow` 是含 `PDFViewerApplication`、`.pdfViewer`、`.pdfDocument`、`.eventBus`、`#viewerContainer` 的窗口（Zotero 自身即用此链，reader.js:1315–1327, 7.0.24；内层 iframe `src='pdf/web/viewer.html'` 建立处：zotero/reader `src/pdf/pdf-view.js:213`）。渲染过的页有 `pageView.pdfPage`（`PDFPageProxy`），检测与局部裁剪都在其上调用 `getOperatorList()`/`render()`。
- 备用取字节路径（若需独立文档）：`item.getFilePathAsync()`（item.js:2689）+ `IOUtils.read()`。

对 Zotero 6 时代 API 假设的更正（7.0.24 与 10.0.8 均 0 命中，源码确认）：`Zotero.Reader.getByDocID`、`getByURI`、`setPage`、`getFullText`、`innerContextWindow`、`outerContextWindow` 不存在；存在的是 `Zotero.Reader.getByTabID(tabID)`（reader.js:2898/1978）与 `Zotero.Reader.registerEventListener(type, handler, pluginID)`（reader.js:2773/1840）。

## 4. Blender 条件（决定原色绘制能否成立）

版本分界（源码确认）：

| Zotero | 深色机制 | 对插件的含义 |
|---|---|---|
| 7（Firefox 115 ESR，reader 库分支 `fx115`，pinned commit `7f32b0ef`） | CSS only：`setUseDarkMode()` 切 `body.disableDarkMode` + `:root[data-color-scheme=dark]` 规则（fx115 `src/pdf/pdf-view.js:733–741`）；无 `window.theme` | pdf.js 输出本就保持原色；overlay 无害。风险：CSS 规则可能同样作用于 overlay canvas，需实机确认是否要 `filter: none` 豁免 **[待 B 验证]** |
| 8.0.0 / 8.0.4 / 9.0.0 / 10.0.8（Firefox 140 ESR） | `useDarkModeForContent` 移除；`setLightTheme()/setDarkTheme()`（reader.js:1069/1073 @8.0.0，:1227/1231 @10.0.8）→ 库设 `_iframeWindow.theme`（`10.0` `pdf-view.js:572–584`）→ forked pdf.js 每次渲染重着色：`if (window.theme && !this.ctx.skipBlender) this.blender = new Blender(this.ctx, window.theme)`（zotero/pdf.js `src/display/canvas.js:902–903`，master 与 `10.0` 一致） | overlay canvas 必须在 `render()` **之前**设 `ctx.skipBlender = true` 才能保原色；这正是 Zotero 库自身的用法（`_createPageRegionCanvas()`：`ctx.skipBlender = true`，`10.0` `src/pdf/pdf-renderer.js:105`）**[待 B 验证]** |

要点：

- `skipBlender` 是 **context 级**开关，在 `CanvasGraphics` 构造时读取一次，不干扰原页面绘制流程 → 满足规范 §3"更容易隔离风险"的首选条件。
- Zotero 7 时代 pdf.js fork commit（`67a1769b…`，由 `zotero/reader@fx115` 固定）已含同一段 `canvas.js:902` 代码，因此 `ctx.skipBlender = true` 在 Zotero 7 上无害、在 8+ 上必需。
- 主题开关 `reader.lightTheme`/`darkTheme` 在 7.0.24 不存在、8.0.0 存在；具体引入的 7.0.x patch 版本未核实。
- **不采用**全局改写 `window.theme` 的做法（规范要求避免全局 monkey-patch；改写会影响同页其它渲染）。

### 路线选择理由

- **B 路线（双渲染 + 局部 overlay）：采用。** 依据：(a) operator list 几何重建离线实测成立（§2），检测在 reader 自己的 `PDFPageProxy` 上运行，无需第二份 pdf.js、无需取字节；(b) Blender 绕过是 context 级、源码确认（§4）；(c) 不触碰原页面绘制流程，失败模式是"overlay 缺失"而非"页面坏掉"，符合 `docs/DECISIONS_AND_RISKS.md` 降级规则。
- **A 路线（对象级拦截）：不采用。** 规范 §3 已警告 Blender 在 `beginDrawing()` 建立，不能假设 Form begin/end 中切换 `ctx.skipBlender` 生效；单次绘制收益小、需要更深的 fork 内 hack。
- 代价：Figure 区域被绘制两次（暗色整页 + 原色局部），性能影响待 B 阶段观察。

## 5. Zotero XPI manifest 约束（源码确认）

依据 zotero.org 官方开发者文档（Zotero 7/9/10 for developers）与 `chrome/content/zotero/xpcom/plugins.js`（tag 7.0.24 与 main 一致）：

- `manifest_version: 2`；必需键是 `applications.zotero`（`id`、`strict_min_version`、`strict_max_version`；基于 `browser_specific_settings.gecko`）。**不得**凭普通 Firefox 扩展假设 `applications.gecko` 可用；`chrome.manifest` 不支持。
- 标记"Zotero 7 或更新"用 `strict_min_version: "6.999"`；`strict_max_version` 用已测试最高 minor 的 `x.x.*` 形式，本项目目标 Zotero 10 → `"10.0.*"`。
- **`experiment` 段不被 Zotero 解析**：`xpcom/plugins.js` 对 "experiment" 0 命中；GitHub 代码搜索 `earlyScript` 0 命中，windingwind/northword/MuiseDestiny/retorquere 系插件 manifest 均无 `"experiment"` 键。它是 scaffold 模板时代元数据，本项目省略。
- `bootstrap.js` 必须位于 **XPI 根**；Zotero 以 `getResourceURI() + 'bootstrap.js'` 经 `Services.scriptloader.loadSubScriptWithOptions`（sandbox，`allowUnsafeURL: true`）加载（plugins.js 120–240）。签名：`startup({ id, version, rootURI }, reason)`、`shutdown()`、`install()`、`uninstall()`；参数对象**没有** `addonData`/`chromeHandle`。另有窗口钩子 `onMainWindowLoad({ window })` / `onMainWindowUnload({ window })`（Zotero 7+）。reason 取值含 `APP_STARTUP`/`APP_SHUTDOWN`/`ADDON_ENABLE`/`ADDON_DISABLE`/`ADDON_INSTALL`/`ADDON_UNINSTALL`/`ADDON_UPGRADE`/`ADDON_DOWNGRADE`。`Zotero`、`Services`、`Cc`、`Ci` 在作用域内可用。
- reader 工具栏注入的官方入口是 **`renderToolbar` 事件**（`Zotero.Reader.registerEventListener("renderToolbar", handler, pluginID)`），handler 收到 `{ type, reader, doc, params, append }`，且 `append()` **必须在事件内同步调用**（zotero/reader `fx115/src/common/components/common/custom-sections.js:3–24`，"Append must be called directly and synchronously in the event"），节点被包进 `<div class="section">`。React 工具栏本身无稳定 DOM id。
- reader 生命周期：Zotero 7+ **没有** `render`/`zoom`/`pagesloaded`/`selected` 这些 `Zotero.Reader` 级事件（Zotero 6 遗留，源码 0 命中）；也没有 `zotero-reader-state-changed`/`zotero-reader-destroyed`。就绪判定用内层 viewer 窗口的 `PDFViewerApplication` 出现 + `eventBus`（`documentinit`/`pagerendered`/`textlayerrendered`）或内层 iframe `load`（`pdf-view.js:212,286`）；销毁走 `ReaderInstance.uninit()` 与 `Zotero.Notifier` 的 close 通知。**[待 B 验证]**

## 6. 版本锚点

| 项 | 值 | 来源 |
|---|---|---|
| Zotero 7 | 2024-08-09 发布，Firefox 115 ESR；核查用 tag `7.0.24` | 官方 dev 文档 |
| Zotero 8 | 2026-01-22，Firefox 140 ESR；tag `8.0.0`/`8.0.4` | 同上 |
| Zotero 9 | 2026-04-10；tag `9.0.0` | 同上 |
| Zotero 10 | 2026-08-17，当前 `10.0.8`（2026-11-06），仍 Firefox 140 ESR | 同上 |
| Zotero 10 对插件 API 的变更 | 集中在 UI 侧（多选 getter、`Zotero.MenuManager`、菜单 DOM 清理），dev 文档未列 `Zotero.Reader` 变更；`open()` 签名在 7.0.24 与 10.0.8 逐字节一致 | 同上 |
| forked pdf.js | zotero/pdf.js，Zotero 10 线为 6.x 系；`canvas.js:902–903`（Blender 条件）在 master 与 `10.0` 一致 | 源码 |
| 参考插件 | windingwind/zotero-pdf-translate（`strict_min_version` 7.9.9 / max 10.9.9）、q77190858/zotero-pdf-background（reader iframe + `getByTabID` + `Zotero.getMainWindows()` 实际用法） | GitHub |

## 7. A0 决策汇总

1. 检测：pdf.js `getOperatorList()` + 自维护 CTM 栈，纯 JS，无 Python、无手写 parser、无 OCR/ML。**[离线实测]**
2. 绘制：B 路线，独立 overlay canvas + `pageView.pdfPage.render()` + `ctx.skipBlender = true`，`transform` 设备空间平移裁切。**[源码确认 + 离线实测，端到端待 B]**
3. 几何：`toViewportRect()`（`convertToViewportPoint` 基底，兼容 4.x/6.x）+ `overlayGeometry()`（CSS 框 / 栅格尺寸，栅格 = `scale × devicePixelRatio`）。**[离线实测，见 A2]**
4. 集成：manifest_version 2 + 根 `bootstrap.js` + `renderToolbar` 事件一个 toggle + `registerEventListener` 生命周期；不注册 chrome overlay、不改 `window.theme`、不取 PDF 字节（复用 reader 的 `PDFPageProxy`）。**[源码确认，装载行为待 B]**
5. 缓存：`document fingerprint + pageIndex`（`src/core/cache.js`，含失效 epoch 防过期任务写入）。**[离线实测（单元）]**

## 8. 待 B 实机验证清单（A0 范围）

| # | 项目 | 最小验证动作 |
|---|---|---|
| 1 | `reader._internalReader._primaryView._iframeWindow` 在用户实际 Zotero 版本可解析 | 打开 PDF 后在 console 执行该链并打印 |
| 2 | Zotero 8/9/10 上 overlay 设 `ctx.skipBlender = true` 后保持原色 | 开 Dark Theme，看 Figure 是否彩色 |
| 3 | Zotero 7 上 CSS 深色是否波及 overlay canvas | Dark Theme 下 overlay 颜色是否被反色 |
| 4 | `renderToolbar` 的 `append()` 能挂出 toggle 按钮且随 reader 重建重现 | 开/关注者工具栏、切换标签页 |
| 5 | `eventBus` 事件名（`documentinit`/`pagerendered`/`scalechanging` 等）在目标 fork 均存在 | 订阅处已有 try/catch，观察 console 警告 |
| 6 | bootstrap 装载（`loadSubScript(rootURI + "content/index.js")`，jar: URI） | 安装 XPI 后看 console 是否有 `[figure-color]` 错误 |
