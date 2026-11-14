# A3 — 插件源码、构建与限制

结论：**Built / Not integration-tested**。Zotero 7–10 legacy-bootstrap XPI 由 `npm run build` 可复现产出（3 个 archive 条目、字节数稳定），core 测试保持 89/89；本环境无 Zotero 二进制，所有运行时行为未在本机执行，集成验证归 B 阶段。

## 1. 构建方式与环境

```bash
npm run build   # esbuild 打包 + zip → dist/figure-color-preservation-0.1.0.xpi
```

| 项 | 值 |
|---|---|
| Node.js / npm | v22.23.0 / 10.9.8 |
| esbuild | 0.28.2（本地依赖），`--bundle --format=iife --global-name=FigureColorPlugin --target=firefox115` |
| 打包 | 系统 `zip`（`/usr/bin/zip`），从 `build/` 内执行，条目位于 archive 根 |
| 产物 | `dist/figure-color-preservation-0.1.0.xpi`（20 030 B） |
| 复现性 | 审阅修复后连续构建条目与长度一致（368 / 4 862 / 74 041 B）；`manifest.json` 与 `package.json` 版本不一致时构建直接失败（负例实测） |

注：esbuild 0.28.2 不接受 `"firefox-115"` 写法（`Invalid version: "-115"`），实际使用 `"firefox115"`。

## 2. XPI 内容

```text
manifest.json      368 B   manifest_version 2；applications.zotero：
                           id figure-color-preservation@local
                           strict_min_version 6.999（= Zotero 7 起）
                           strict_max_version 10.0.*（= 已核查最高版本 Zotero 10）
                           无 experiment 段（Zotero 不解析）、无 applications.gecko
bootstrap.js      4 862 B  XPI 根；startup({id,version,rootURI}, reason)/shutdown/install/uninstall；
                           Services.scriptloader.loadSubScript(rootURI + "content/index.js")
                           → globalThis.FigureColorPlugin.startup(...)；全部 try/catch 守护
content/index.js  74 041 B esbuild IIFE bundle = src/zotero/* + src/core/*；
                           0 个 require(；不含 pdfjs-dist、不含 @napi-rs/canvas
```

装载链：`Zotero → bootstrap.js startup → loadSubScript → FigureColorPlugin.startup → Zotero.Reader.registerEventListener("renderToolbar") → 每个 reader 一个 ReaderSession → pageView.div 内 overlay canvas（renderRegion + ctx.skipBlender）`。

## 3. 源码分层

```text
src/core/*       检测/几何/渲染/缓存（A1/A2 已验收，lane C 零改动）
src/zotero/main.js            bundle 入口、renderToolbar 一个「原色」toggle、session 表、共享 RegionCache
src/zotero/reader-session.js  内层 pdf.js 窗口解析、就绪轮询（250 ms×20 s）、eventBus 订阅、pagerendered 懒挂载、文档切换清理
src/zotero/overlay.js         纯 DOM：每区域一个 canvas（absolute, pointer-events:none, z-index 3），renderRegion 绘制，renderTask 取消
src/zotero/zoom.js            scalechanging/rotationchanging 订阅，150 ms debounce → 重定位/重栅格化
scripts/build.mjs             build/ 与 dist/ 重建、esbuild、zip、unzip -l 校验（条目数必须为 3）
```

`src/zotero` 不 `import` pdfjs-dist：检测与绘制都用 reader 自己的 `PDFPageProxy`。OPS 取内层窗口导出，缺失时 core 回退 `MEASURED_OP_CODES`。

## 4. 构建期验证（本机全部通过）

| 检查 | 结果 |
|---|---|
| `node --check bootstrap.js` 与 4 个 `src/zotero/*.js` | 通过 |
| 逐文件 esbuild bundle | 0 error / 0 warning |
| `npm run build` | exit 0；`unzip -l` 恰含 manifest.json、bootstrap.js、content/index.js |
| `npm test` | 89 tests / 89 pass / 0 fail（core 未受影响） |
| `grep -rn "pdfjs-dist\|@napi-rs" src/zotero src/core/index.js` | 0 命中；bundle 内 0 `require(` |
| bundle `vm` 冒烟（stub Zotero） | 全局 `FigureColorPlugin` 就绪；`renderToolbar` 注册；`append()` 同步挂出按钮（文本「原色」）；toggle/`setEnabled` 传导到 session；`shutdown()` 后 session 数为 0 |
| 独立代码审阅（3🔴 4🟡 3🔵）全部修复并重建 | documentId 时序（就绪后重解析 + eventBus 补绑）；toggle-off 与在途 detect 竞态（detect→paint 间复查 enabled/overlay 归属）；`nsIObserverService` 注册/注销参数序（`{observe}` 对象 + `(observer, topic, null)`）；工具栏按钮按 reader 复替换不堆积；失败后 `clear()` 复位 `painted` 可重检测；`destroy()` 唤醒挂起的就绪等待；取消渲染不再误标 `fcp-error`；`unload` 监听随 closeSession 移除；build 强校验 manifest 与 package 版本一致（负例实测：manifest 改 `0.9.9` → 构建失败） |
| 竞态/观察者专项冒烟（vm + 源码导入） | stale paint 中止（替换/停用两变体）、观察者注册与注销对象序、3 次工具栏渲染仅留 1 按钮、close 移除 `unload`+`zotero-reader-state` 两类监听、`documentId` 仅在文档出现后解析 |

## 5. 未验证与猜测点（全部 fail-soft，B 阶段观察）

本机无 Zotero，以下为装载后行为，标记 **Built / Not integration-tested**：

1. `Zotero.initializedPromise`（回退 `Zotero.Startup.initializedPromise`）——仅门控窗口观察者与已打开 reader 的收养。
2. 观察者服务形状：`Services.observers.addObserver` 与 `Services.obs.addObserver` 双探测；失效后果仅为窗口关闭时不清理 session（`renderToolbar` 路径不受影响）。
3. `Zotero.Reader._readers`——内部字段，仅用于收养插件启动前已打开的 reader。
4. `zotero-reader-state` DOM 事件名——纯附加信号，主信号是标准 `unload`。
5. `pdfViewer._pages`/`pagesCount` 回退分支——对照 pdfjs-dist 6.5.438 源码核实，未在 Zotero fork 内实测。
6. `ctx.skipBlender = true` 的实际保色效果（Zotero 8–10 必需、7 无害）——A0 §4 源码确认，端到端待 B。

## 6. 已知限制（非缺陷）

| # | 限制 | 依据/影响 |
|---|---|---|
| 1 | 直接矢量路径图（无 XObject）不覆盖：fixture 第 7 页 Figure 5 | A1 已记录的 false negative；规范 §2.5 允许 |
| 2 | `/Figure` 结构标签与 Image XObject 两条检测路径未经真实文档检验 | fixture 无 StructTree、第 5 页 0 Image |
| 3 | Zotero 7 的 CSS 深色可能同样作用于 overlay canvas | 需实机确认是否 `filter: none` 豁免（A0 §8.3） |
| 4 | 诊断字段限制：绑定图注但未入选中的 placement 无 reject 记录 | A1 §6，B 阶段可补 `dropped-row` |
| 5 | 无设置面板、无遥测、无网络；调试为 console.warn 一次性输出（`[figure-color]` 前缀） | 规范 §4 边界 |
| 6 | bundle 未压缩（74.0 KB 未 minify），换取可读性 | 需要时可加 `--minify` |
| 7 | Figure 区域被绘制两次（暗色整页 + 原色局部），性能未测 | B 阶段观察滚动/缩放流畅度 |

## 7. B 阶段最小验证动作

1. 安装 `dist/figure-color-preservation-0.1.0.xpi`（`工具 → 安装插件…`），重启后 console 无 `[figure-color]` 报错。
2. 按 `docs/STAGE_B_USER_CHECKLIST.md` 执行；关键三查：Figure 2/3 原色、正文与图注仍暗色、缩放 100/150/200 % 不漂移。
3. 失败时回传 A0 §8 清单项 1 的 Run JavaScript 一行结果与 `[figure-color]` 日志原文。

## 8. 实机安装第 1 轮：0.1.0 安装失败与修复

- 现象（用户 Windows 实机）：`The add-on "C:\Users\WilliamsLay\Downloads\figure-color-preservation-0.1.0.xpi" could not be installed. It may be incompatible with this version of Zotero.`
- 根因（源码级）：Zotero 在 `app/scripts/fetch_xulrunner` 中给 `Extension.parseManifest` 插入硬校验，要求 `applications.zotero` 同时提供 `id`、`update_url`、`strict_max_version`，缺任一项即 `manifestError`。manifest 解析异常在 `XPIInstall` 的 `loadManifestFromWebManifest` 中转成 `[ERROR_CORRUPT_FILE, e]`，最终触发 `addon-install-failed` 弹窗，所以弹窗显示文件路径而不是插件名。该校验在 tag 7.0.0 至 10.0.8 均存在。
- 顺带核实：`applications.zotero` 是必需块（`browser_specific_settings` 仅 `.gecko` 会被复制成 `applications`，`.zotero` 无效）；`strict_min_version` 不允许 `*`，`6.999` 合法；`strict_max_version` 允许 `*`；release 版 Zotero 的 `strictCompatibility=true`，故 `10.0.*` 在 Zotero 11 会被拒；本地安装不要求签名（`xpinstall.signatures.required=false`）；`bootstrap.js` 生命周期由 Zotero 在 `chrome/content/zotero/xpcom/plugins.js` 自行实现，7–10 均支持。
- 修复：manifest 增加 `update_url`，`strict_max_version` 放宽至 `10.9.9`，版本升到 0.1.1。`npm run build` 通过（`dist/figure-color-preservation-0.1.1.xpi`，20059 字节，仍仅含 manifest.json、bootstrap.js、content/index.js），`npm test` 89/89 通过。
- 结论：修复已在实机验证——用户确认 0.1.1 **安装成功**。此前全部 runtime 项仍为 NOT TESTED，待执行 `docs/STAGE_B_USER_CHECKLIST.md`。

## 9. 实机第 2 轮：按钮出现但画面无变化；Run JavaScript 取不到插件句柄

- 现象：「原色」按钮出现在阅读器工具栏（证明 `renderToolbar` 注册、`ensureSession`、`append()` 同步挂载在实机可用）。点击后画面无变化。诊断脚本返回 `{"plugin":false,...,"innerWin":true,"pdfDoc":true,"pageViews":16}`。
- `plugin:false` 是**假阴性**：源码核实 Run JavaScript 用 `win.eval`（`runJS.js:20–25`，间接 eval，代码在主窗口 realm 执行，`globalThis` 即主窗口）；而 Zotero 用 `loadSubScriptWithOptions` 把 bootstrap.js 装进自建沙箱（`xpcom/plugins.js:124–186`），`loadSubScript` 默认目标是脚本调用者的全局（`mozJSSubScriptLoader.cpp:321–330`），所以 esbuild 的 `globalName` 赋值落在 bootstrap 沙箱里，主窗口与 Run JavaScript 都看不到。`innerWin:true/pdfDoc:true/pageViews:16` 说明内层窗口链与 pdf.js 对象在主窗口 realm 可达。
- 画面无变化的候选原因（当时无法用句柄区分）：检测 0 区域、overlay 未挂载、绘制失败、或点击前已把开关关掉（唯一可见反馈是按钮不透明度降到 0.45）。
- 修复（0.1.2）：启动时把插件句柄发布到主窗口（bootstrap.js `figureColorPublish()`，main.js 在 Zotero 就绪后再次发布），Run JavaScript 用 `Zotero.getMainWindow().FigureColorPlugin` 取。构建 20 539 B、`node --check` 通过、`npm test` 89/89。
- 附带核实：`[figure-color]` 的 `console.warn` 只出现在 工具 → 开发者 → Error Console；帮助 → 调试日志 只渲染 `Zotero.debug` 与未捕获错误。清单已改正菜单路径与脚本写法（顶层禁 `return`）。
- 状态：按钮挂载 **PASS（实机）**；保色、检测区域、缩放对齐仍 NOT TESTED，待 0.1.2 句柄诊断。

## 10. 第 3–6 轮：真机 realm 排查（v0.1.3 → v0.1.6）

### 第 3 轮（v0.1.3）：ESM 泄漏导致插件完全不启动
- 加 `export let lastDiagnostics` 后，`dist` 里是 **ESM**：Firefox 的 `loadSubScript` 不认 `export`，
  `content/index.js` 直接语法错误 → 全局 `FigureColorPlugin` 不存在 → 工具栏、开关全无。
- 已加构建守卫：bundle 输出禁止 `^export `，格式必须是 `iife`。
- 诊断脚本自身也有两个坑：`工具 → 开发者 → 执行 JavaScript` 用 `win.eval`，顶层 `return` 报
  `SyntaxError: illegal return statement`；`Zotero.getMainWindow()` 在 `Zotero` 上而非 `Zotero_Tabs`。

### 第 4 轮（v0.1.4）：realm 证据
用户 Run JavaScript 实测（主窗口 realm）：

```
plugin:false            ← 主窗口看不到 sandbox 全局（假阴性）
toolbars:0              ← 与「原色」按钮已存在矛盾：主窗口够不到 reader iframe
iframeCount:2, viewerFrames:0, pdfViewerApp:"undefined"
ctor:"ReaderTab", hasInternalReader:true, hasIframeWin:true, eventBusOn:"function"
```

- `Zotero.getMainWindow().FigureColorPlugin` 可读到句柄（`plugin:true`）→ 句柄已显式挂到主窗口。
- 结论：主窗口 realm 的 iframe/PDFViewerApplication 视图与插件 sandbox realm 不一致；
  **不能**用主窗口读数否定插件内部视图，也不能反之。

### 第 5 轮（v0.1.5）：重试 + 兜底
- `waitUntilReady` 轮询（80 ms → 后改 200 ms，上限 20 s），每轮重新解析 inner window。
- 新增 iframe 扫描兜底（按 `viewer.html`/`reader.html` 匹配，不依赖跨 realm 的 `PDFViewerApplication`）。
- 新增 realm 桥：`win.FigureColorResolveViewer = win.eval(...)` 在**主窗口 realm**求值
  `reader._internalReader._primaryView._iframeWindow ?? reader._iframeWindow`，sandbox 侧只做调用。
- 用户实测仍为 `ready:false, innerWin:false, docId:null, overlays:0`；错误控制台按 `figure` 过滤为 0 条。

### 第 6 轮（v0.1.6）：真正找到的两个缺陷
1. **`start()` 首轮解析失败就返回**，根本没进入轮询：`reader-opened` 触发时 pdf.js iframe 常常还没挂上，
   于是只试一次就放弃（v0.1.4/v0.1.5 都是这样，第 5 轮的轮询代码在这条路径上从未执行）。
   修法：`start()` 直接把解析交给 `waitUntilReady()`，由其每 200 ms 重试，最多 20 s。
2. **sandbox 侧日志不可见**：`[figure-color]` 只在浏览器控制台打印，sandbox realm 里看不到。
   修法：`warnOnce` 同时写入 `Zotero.debug`（帮助 → 调试日志 → 查看输出日志）与环形缓冲 `getWarnLog()`。
3. 新增 sandbox 侧探针 `FigureColorPlugin.runProbe()`：返回当前 reader、session 状态（含轮询次数）、
   四条解析通道各自看到的类型、realm 桥结果、`setTimeout` 是否可用、以及日志尾巴。

### 版本对应
| 版本 | 状态 | 内容 |
| --- | --- | --- |
| 0.1.2 | 已安装，实机 PASS | 工具栏 `renderToolbar` 挂载 |
| 0.1.3 | 未安装（无效构建） | ESM 泄漏 |
| 0.1.4 | 已安装，无着色 | session 类重构 + realm 桥 |
| 0.1.5 | 已安装，无着色 | 轮询 + iframe 扫描 + realm 桥 |
| 0.1.6 | 待实机 | `start()` 真正轮询 + Zotero.debug 日志 + `runProbe()` |

### 当前实机结论（不变）
保色 / 正文深色 / 缩放对齐 / 开关行为仍为 **BLOCKED（待实机）**，根因是 inner window 解析在真机上未成功。
`runProbe()` 的输出即可判定：`chain.k3` 为 `"object"` 而 `session.innerWin:false` → 解析逻辑问题；
`chain.k3` 为 `"undefined"` → realm 桥是唯一可用通道；`log` 非空 → 直接给出失败点。

## 11. 第 7 轮（v0.1.7）：找到并修掉真正的渲染阻塞

v0.1.6 的 `runProbe()` 在真机上给出决定性证据：

```
session: ready:true, attempts:4, innerWin:true, eventBus:true,
         docId:"fcp:3e708112d99924cf…", overlays:16, enabled:true
log: "page-paint: Accessing TypedArray data over Xrays is slow, and forbidden
      in order to encourage performant code. To copy TypedArrays across origin
      boundaries, consider using Components.utils.cloneInto()."
```

结论：inner window 已在第 4 次轮询时解析成功，16 页 overlay 全部挂上，失败点不是 realm 解析，
而是**跨 realm 读取 pdf.js 数据**。Firefox 禁止通过 Xray 包装读取 TypedArray 元素，
插件在 sandbox 里索引 pdf.js 返回的数组时抛错，被 `track()` 归到 `page-paint` 站点吞掉，
于是每页都挂上了 canvas 却一张也没画出来。

修复（`src/zotero/xray.js` 新增）：

- `localNumbers(value)`：把任意 array-like（普通数组、`Float64Array`、`Uint8ClampedArray`、Xray 包装）
  复制成本 realm 的普通 `number[]`；顺序为 `Components.utils.cloneInto()` → `Array.from` → 手工索引，
  分别在 try/catch 中尝试，失败返回 `null`。判断 array-like 只看 `length`/`Symbol.iterator`，
  保证在任何元素访问之前先选好复制策略。
- `localPDFPage(pdfPage)`：只暴露 core 检测路径真正使用的成员——`view`、`getViewport()`、
  `getOperatorList()`、`getTextContent()`、`render()`（直通）。操作表重发为本地的 `{ops, args}`，
  嵌套数值数组本地化，图像字典按引用透传，避免逐元素复制大缓冲区。
- `localViewport(viewport)`：本地描述符 `{scale,width,height,rotation,offsetX,offsetY,transform}`
  加 `convertToViewportPoint()`（结果同样本地化）。
- 检测调用点 `src/zotero/overlay.js` 的 `detect()` 传入 `localPDFPage(pdfPage)`；
  `paintRegions()` 改用 `localViewport(pageView.viewport)`，因为 `toViewportRect()` 要索引
  `convertToViewportPoint()` 的返回值。渲染路径 `renderRegion()` 仍使用原始 `pdfPage`：
  它只把对象送进 reader realm，属于安全方向。
- `warnOnce` 的环形日志现在附带首个堆栈帧（`key: message @ frame`），下次失败可直接定位。

余留风险（未改）：若 Zotero 的 pdf.js 分支让 `convertToViewportPoint()` 返回 TypedArray，
`toViewportRect()` 仍会抛错，此时日志站点会变成 `overlay-geometry`。

测试：`npm test` 109 通过（新增 `tests/js/xray.test.mjs` 17 条、`tests/js/overlay.test.mjs` 3 条）。
构建：`dist/figure-color-preservation-0.1.7.xpi`（23 166 B，bundle 内无顶层 `export`）。

版本表补充：

| 版本 | 状态 | 内容 |
| --- | --- | --- |
| 0.1.6 | 已安装，无着色 | `start()` 真正轮询；inner window 解析成功；暴露 Xray TypedArray 错误 |
| 0.1.7 | 待实机 | pdf.js 边界本地化（Xray 安全）+ 日志带堆栈帧 |

## 12. 第 8–9 轮（v0.1.8 → v0.1.9）：白块无像素证据 + 三个 reader 全部 ready-timeout

### 第 8 轮（v0.1.8）：为白块加像素探针
v0.1.7 实机反馈：区域**已检测、已绘制**，但每个覆盖层是一块**纯白方块**，图内没有原色。
纯白意味着 canvas 只有背景填充、没有 pdf.js 光栅，候选原因有三：render task 被拒绝、
内容因变换或 devicePixelRatio 偏移到画布之外、光栅存在但被层叠/暗色 blender 影响。

新增 `src/zotero/paint-probe.js`：`probeOverlay(overlay)` 只输出可 JSON 化的纯数据——
CSS 盒、buffer 尺寸、`nonWhite`（有墨像素比例）、`mean`（平均色）、5×5 平均 RGB 网格、
页面自身 canvas 的 `nonWhite`（对照）、`devicePixelRatio` 与 `visualViewport.scale`；
超过 4 MP 的画布取居中 2000 px 样本，区域条目最多 8 个。像素经 `xray.js` 的 `localNumbers`
复制进 sandbox，因此探针不读跨 realm 元素。`main.js` 暴露 `probePaint(pageNumber)`。

### 实机 v0.1.8：探针取错 session，白块反而消失
```
{at:"…", ready:false, innerWin:true, overlays:0, currentPage:null, target:null,
 log:["inner-window-missing:item:483: No pdf.js viewer window…@ resolveInnerWindow:1842",
      "no-event-bus:item:483 / item:485 / item:481 @ bindEvents:2029",
      "ready-timeout:item:483 / item:485 / item:481 @ waitUntilReady:2090"]}
```
两点结论：

1. 三个 reader（`item:481`/`483`/`485`，即 Zotero 启动时恢复的标签）全部 `ready-timeout`，
   即 20 s 内没等到 pdf.js 窗口；`waitUntilReady()` 放弃后 `start()` 返回 false，
   session **永久失效**，之后再也不会重试，所以用户这次**没有看到白块**（什么都没画）。
2. 探针报的是"第一个存活 session"，而沙箱读不到 `Zotero_Tabs.selectedID`，
   于是报的是那个后台未加载的 reader（`overlays:0`），可见 reader 的像素证据仍然没拿到。

### 第 9 轮（v0.1.9）：三项修复
1. **逐 session 探针**（不依赖标签解析）：`main.js` 新增 `probeAll()`，对每个未销毁的
   `ReaderSession` 输出 `{key, ready, attempts, innerWin, eventBus, docId, overlays, enabled,
   currentPage, target}`，读取 `currentPageNumber` 失败时记 `currentPageError`，
   探针失败时记 `targetError`；条目上限 `MAX_PROBE_SESSIONS = 8`，超出记 `truncated:true`；
   顶层 `active` 为旧单 session 查找命中的 key，`count` 为存活 reader 总数，`log` 为告警环形缓冲。
2. **慢恢复重试**：`reader-session.js` 新增 `RECOVERY_INTERVAL_MS = 5000`、`RECOVERY_MAX_MS = 180000`
   （= 36 次）。`start()` 以超时 / 缺 inner window / 缺 event bus 收尾时启动重试：
   每 5 s 一次，解析 inner window、重绑 event bus，pdf.js 文档出现即 `ready = true`、
   同步 `documentId`、重绘已挂 overlay 并通知监听器（同时刷新 `lastDiagnostics`），
   日志站点 `recovered:<tag>`。超时后静默停止；同一 session 同时只有一个重试定时器；
   `destroy()` 取消重试。修复的正是"启动时恢复的标签永远画不出图"。
3. **绘制失败不再留白块 + 记录原因**：`PageOverlay` 新增 `lastPaintError`
   （`geometry: …` 或 `render: …`，只由当前绘制轮次写入，缩放取消旧轮次不会污染状态）；
   render 失败的 canvas 打 `fcp-error` 并置 `visibility:hidden`，成功轮次恢复 `visible`；
   `probeOverlay` 输出 `paintError` 与逐区域 `errClass`。

### 下次实机判定矩阵
| `probeAll` 证据 | 结论 | 下一步 |
| --- | --- | --- |
| 该 reader `overlays:0` 且 `ready:false`，`log` 有 `recovered:<tag>` | 恢复重试已生效，稍等即出图 | 复测视觉项 |
| `target.paintError` 非空、`errClass:true`、`nonWhite:0` | pdf.js render task 被拒绝（白块 = 只有背景填充） | 按错误文本改渲染参数 |
| `paintError` 为 `render: Rendering cancelled…` | 绘制被 pdf.js 渲染队列取消（连续 `page-paint` 互相取消），不是画不出来 | 同区域重绘时不取消上一轮 |
| `paintError:null`、`nonWhite:0` | pdf.js 画了空内容：变换或区域越界 | 校正 `overlayGeometry` 的 deviceScale 偏移 |
| 彩色只集中在 5×5 网格某条边/角 | 变换或 devicePixelRatio（Windows 125–150 % 缩放）偏移 | 按网格方向修正平移量 |
| `nonWhite` 高且 `mean` 为原色 | 层叠或暗色 blender 覆盖了光栅 | 调整 z 序 / 去掉背景填充 |

### 离线排除：分数 devicePixelRatio 不是白块原因
用真实 pdf.js + `@napi-rs/canvas` 跑 `fixture/PipeBWrite.pdf` 第 5 页 Figure 2，
在 display scale 1 / 1.25 / 1.3 / 1.75 与 dpr 1 / 1.25 / 1.5 / 2 的 16 种组合下，
`renderRegion()` 的裁片 `nonWhite` 均为 0.87–0.89，墨迹外接盒铺满整块画布；
新增的回归测试再用整页渲染做 ±1 px 对齐搜索，最佳偏移恒为 `0,0`，
裁片与整页对应窗口的有墨比例差 ≤ 0.02。
结论：**Windows 125 % / 150 % 缩放下 `overlayGeometry` 的平移与缓冲尺寸正确**，
真机白块不是 deviceScale 位移造成的，最可能是 pdf.js render task 被拒绝（画布只剩背景白填充）。
v0.1.9 的 `paintError` / `errClass` 正是为这一判定准备的。

测试：`npm test` 135 通过（新增恢复重试 5 条、`probeAll` 6 条、绘制失败与探针字段 4 条、分数 dpr 对齐 1 条）。
构建：`dist/figure-color-preservation-0.1.9.xpi`（26 322 B，bundle 内无顶层 `export`，
含 `probeAll`/`localViewport`/`lastPaintError`）。

### 版本表补充
| 版本 | 状态 | 内容 |
| --- | --- | --- |
| 0.1.7 | 已安装：区域已检测已绘制，但为纯白块 | Xray 本地化修复生效 |
| 0.1.8 | 已安装：本次未画（三个 reader ready-timeout） | `probeOverlay` 像素探针 + `probePaint()` |
| 0.1.9 | 待实机 | `probeAll()` 逐 session + 慢恢复重试 + 失败绘制隐藏并记录原因 |

### 第 10 轮（v0.1.10）：probeAll 实机证据 → realm 解析层修复

实机 v0.1.9 `probeAll()`（打开 PipeBWrite.pdf 后）：
`{ready:false, attempts:79, innerWin:true, eventBus:false, docId:null, overlays:0, currentPage:null, target:null}`，
log 顺序 `inner-window-missing` → `no-event-bus` → `ready-timeout`，无 `recovered:`。
判定：realm 取到但其中读不到 `PDFViewerApplication`（bus/pdfViewer 均 null）；
79 次尝试 ≈ 20 s readiness 轮询 + 36 次 recovery 全部耗尽，180 s 预算后 v0.1.9 永久静默放弃。
候选根因：(a) iframe 扫描「单 frame 兜底」在 pdf.js 导航前 latch 到 about:blank 死 realm；
(b) latch 到外层 reader.html realm；(c) sandbox→iframe 跨 realm 读 expando 被遮蔽。
待 `runProbe().chain`（k1/k2/k3/bridgeWin）区分。

修复（@fixer，143 测试通过，`dist/figure-color-preservation-0.1.10.xpi` 26 945 B）：
1. `resolveInnerWindow()` 删除单 frame 兜底：仅带 `PDFViewerApplication` 标记、src 精确 `viewer.html`、
   或 `reader|viewer.html` 命中的 frame 才 latch；否则返回 null 继续轮询/走桥。
2. recovery 不再永久放弃：快轮 36×5 s 耗尽后降为 20 s 慢心跳无限继续（`RECOVERY_SLOW_INTERVAL_MS`），
   切入时记一次性 `recovery-slow:<tag>`；`recoveryPass()` 每轮重解析 realm，
   realm 变化则 `releaseRealm()`（解绑旧 bus + 销毁旧 zoom watcher）后换 realm 重绑。
3. `probeAll` 每 session 新增 `realm:{pva, frames, href}`（href 截断 120），跨 realm 读抛错记 `realmError`，
   纯 JSON，无需截图即可判读。

已知代价：永不加载的 reader 保留一个 20 s 定时器直至关标签（`destroy()`）；
realm 切换会重建 zoom watcher（实践中发生在 overlay 创建前，影响有限）；
单 iframe 且 src 缺失、标记又被完全遮蔽的 reader 由「接错」变「暂不接管」（继续轮询）。

下次实机（v0.1.10）判定：
| `probeAll` 证据 | 结论 | 下一步 |
| --- | --- | --- |
| `realm.pva:"object"` + `eventBus:true` + `recovered:` | (a)/(b) 死 realm 换掉，恢复生效 | 复测视觉/像素项 |
| `realm.href` 含 `reader.html`（非 `web/viewer.html`） | (b) 外层 realm，latch 源仍是桥 | 桥返回值按 href 复核 |
| `realm.href` 为 `web/viewer.html` 且 `pva:"undefined"` | (c) 跨 realm expando 遮蔽 | 改走主窗口 realm 桥做 bus 代理 |
| `realm:null` + log `recovery-slow` | 现不再放弃，慢心跳等待文档 | 稍后复跑 probeAll |

### 第 11 轮（v0.1.11）：根因确认为跨 realm expando 盲区

实机 v0.1.10 `probeAll()`：`innerWin:true`、`realm:{pva:"undefined", frames:0, href:"resource://zotero/reader/pdf/web/viewer.html"}`、
`eventBus:false`；`chain:{k1..k3:"object", frames:1, bridgeWin:"null"}`。
主窗口 realm ground truth（Run JavaScript 直读同一 iframe window）：
`{href:viewer.html, pva:"object", pages:16, doc:true}` + `src:0`。

判定：inner window 即真 pdf.js viewer realm，文档已加载（16 页）；
`PDFViewerApplication` 是 window 上的 JS 赋值全局，bootstrap sandbox 的 wrapper 看不见它，
`wrappedJSObject` 在该 wrapper 上不存在（非标准 Xray）→ 修复路线为 `Components.utils.unwrap`，
全 miss 时 `route:null` 并保持慢心跳。
`bridgeWin:"null"` 为桥内 `c === r` 跨 realm 身份比较恒 false 所致（仅影响探针，已加兜底）。
用户 Zotero 无 `Zotero.Reader.getOpenReaders()` → 桥与 chainProbe 加 `_readers` 兜底。

环境事实：用户 Zotero 版本 **10.0.8**（Windows）。属 Zotero 8+ 世代：暗色为渲染期 Blender
（`window.theme && !ctx.skipBlender`，A0 源码确认覆盖 10.0.8），非 7 的 CSS-only；
manifest `strict_max_version 10.9.9` 覆盖。

修复（@fixer，182 测试通过，`dist/figure-color-preservation-0.1.11.xpi` 27 729 B）：
1. `reader-session.js` 新增 `unwrapViewerApplication(innerWin)`：按 `direct`（直读）→ `wrapped`
   （`wrappedJSObject`）→ `cu-unwrap`（`Components.utils.unwrap`）三路线取 `PDFViewerApplication`，
   每条各自 try/catch（抛错算 miss），返回 `{app, route}`，全 miss 返回 `route:null` 且不抛错；
   命中的路线按 window 记入 WeakMap（`realmRoutes`），后续只读该路线，缓存路线失效则重扫并改记新路线。
2. 所有 viewer 内部读取改走该 helper：`resolvePDFViewer`、`resolveEventBus`、`resolveOPS`
   （第三兜底）、`resolveInnerWindow` 的 iframe 标记；iframe 优先级不变（标记 > 精确 `viewer.html` > 前缀）。
   `resolveDocumentId` 无 `PDFViewerApplication` 读取，未改。
3. realm 桥（`VIEWER_BRIDGE_SRC`，改为导出常量便于测试）：`getOpenReaders()` 缺失时用 `_readers`
   （对象 / Map / 数组三种形态归一，即 `openReaderRecords()`）；`c === r` 跨 realm 恒 false，
   故列表内「恰好一个 reader 带 iframe window」时返回该 window。`installViewerBridge` 仍用 `win.eval`。
4. 探针扩展（纯 JSON）：`probeAll` 的 `realm` 增 `route` 与 `wrappedPva`；`chainProbe` 增
   `readersSrc`（`getOpenReaders`/`_readers`/`none`）、`readers`（列表长度）、`bridgeRoute`。
   v0.1.7 的 `xray.js` `localNumbers` 本地化未动。

已知代价：`wrappedJSObject` 在用户 wrapper 上不存在，该路线预期恒 miss（仅作廉价第二猜）；
sandbox 若无 `Components` 则第三路线也 miss，此时 `route:null` 且 20 s 慢心跳继续；
缓存只存路线名不存 app 对象，故每次读取仍走一次真实属性读（新鲜度优先）。

下次实机（v0.1.11）判定：
| `probeAll` 证据 | 结论 | 下一步 |
| --- | --- | --- |
| `realm.route:"cu-unwrap"` + `eventBus:true` + `recovered:` | unwrap 路线生效 | 复测视觉/像素项 |
| `realm.route:"wrapped"` | 该 wrapper 确为 Xray，`wrappedJSObject` 可用 | 同上 |
| `realm.route:null` 且 `realm.pva:"undefined"` | sandbox 三条路线皆不可见 | 改由主窗口 realm 桥代理 bus |
| `chain.bridgeRoute:"direct"`（或任一非 null） | 桥已可用 | 桥通道升为主通道 |
| `chain.readersSrc:"_readers"` | 确认无 `getOpenReaders` | 列表归一即为长期实现 |

### 第 12 轮（v0.1.12）：oracle 评审批次——桥的 generator 真 bug + 第四路线 `bridge`

oracle 复评 v0.1.11 realm 层后的批次修复。范围只含 realm 访问层 + 探针 + 测试，core/paint/overlay 未动：

1. 真 bug（潜伏）：`VIEWER_BRIDGE_SRC` 中 `R.getOpenReaders()` 在 Zotero 7 是 generator，无 `length`，
   索引循环执行零次 → 桥恒 null。修法：`getOpenReaders()` 结果过 `Array.from`
   （数组 / generator / 任意迭代器通吃；`_readers` 的 Map 值同）。
2. `getOpenReaders()` 存在但抛时，原实现整个桥落外层 catch 返回 null。现该分支单独 try，
   失败 fallthrough 到 `_readers` 归一，与 `openReaderRecords()`（reader-session.js）一致。
3. 唯一候选兜底边角：两 reader 仅一个已挂 iframe 时可能 latch 错 reader。现于兜底前先试
   `rec.tabID === r.tabID`（浅属性，跨 realm 可读概率高）：tabID 命中即以该 reader 为准，
   该 reader 未挂 iframe 则返回 null，而不是拿另一个 reader 的 frame 去猜。
4. 一次性告警键 `unwrap-${route}` 原不带 reader tag，多 reader 时互相吞诊断。现按既有 `site:tag`
   风格带上 tag（`unwrap-direct:<tag>`）：tag 由 `unwrapViewerApplication` / `readViewerRoute` 接收，
   `resolvePDFViewer`、`resolveEventBus`、`resolveOPS` 逐层透传（session 传 `this.tag`，探针传 session key）。
5. `forgetViewerRoute` 仅测试引用：保留，JSDoc 标注 test-only（缓存是 WeakMap，生产无需清理）。
6. 探针判定盲区：`Components.utils.unwrap` **不存在**时无 throw 无 log，`route:null` 与
   「unwrap 返回 nullish」不可分。`probeAll` 的 `realm` 增 `hasCuUnwrap`
   （`typeof globalThis.Components?.utils?.unwrap`，读本 realm 全局，纯 JSON，常量成本）。
7. 第四路线 `bridge`（关键兜底，让 `route:null` 也不死）：`VIEWER_ROUTES` 末位取
   `Services.wm.getMostRecentWindow("navigator:browser").FigureColorResolveViewer(win, true)`，
   即让主窗口 realm 直接读 `PDFViewerApplication` 并把普通 JS 对象交回（app 是普通对象，
   进沙箱为普通 CCW，不受 window-Xray 影响，后续 `.pdfViewer` / `.eventBus` 读取可用）。
   配套：`VIEWER_BRIDGE_SRC` 增加第二参数 `wantApp`，并按 realm window 的 frame 身份匹配（`f === r`）；
   `resolveInnerWindow` 把「仅桥可见」的 iframe 标记排在精确 `viewer.html` src 之后
   （桥只认「那一个带 frame 的 reader」，多 iframe 窗口下会把同一个 app 给不带它的 frame）。

路线序最终形态：`direct` → `wrapped` → `cu-unwrap` → `bridge`，四条全 miss 才 `route:null`；
`realmRoutes` 缓存、`probeAll` 的 `realm.route`、`chainProbe` 的 `bridgeRoute` 值域同步为这四值 + null。

已知代价：`bridge` 路线每次读取付一次 `Services.wm` 查询 + 列表扫描（缓存只存路线名，新鲜度优先）；
多 reader 且跨 realm 身份不可比且 tabID 不可读时桥无法判定归属，该路线退化为 miss；
`wantApp` 让同一个桥函数服务两个调用方（`resolveInnerWindow` 一参取 window，`unwrapViewerApplication` 二参取 app）。

修复（@fixer，198 测试通过，`dist/figure-color-preservation-0.1.12.xpi` 28 053 B）：
改动 `src/zotero/reader-session.js`、`src/zotero/main.js`、`tests/js/unwrap-viewer.test.mjs`、
`tests/js/viewer-bridge.test.mjs`、`tests/js/probe-all.test.mjs`（realm 键新增 `hasCuUnwrap`）。

下次实机（v0.1.12）判定：
| `probeAll` 证据 | 结论 | 下一步 |
| --- | --- | --- |
| `realm.route:"direct"` | 沙箱直读可见（主窗口 realm，或 wrapper 已 waive Xray） | 复测视觉/像素项 |
| `realm.route:"wrapped"` | 该 wrapper 确为 Xray，`wrappedJSObject` 可用 | 同上 |
| `realm.route:"cu-unwrap"` | `Components.utils.unwrap` 路线生效 | 同上 |
| `realm.route:"bridge"` | 仅主窗口 realm 可见，第四路线救回 bus | 桥通道升为主通道，评估精简前三条 |
| `realm.route:null` + `realm.hasCuUnwrap:"undefined"` | 沙箱没有 unwrap 可用，与 realm 无关 | 只走桥，或改主窗口 realm 代理 bus |
| `realm.route:null` + `realm.hasCuUnwrap:"function"` | unwrap 存在但返回 nullish（realm 无 app，或多 reader 下桥歧义） | 结合 `chain.bridgeRoute` 与 `chain.readers` 数量判定 |

### 第 13 轮（v0.1.13）：paint 层——渲染参数必须是 realm 对象（pdf.mjs:15882 `canvasContext is undefined`）

实机证据（v0.1.12，Zotero 10.0.8 Windows）：realm 层已正常（`route:"wrapped"`、`eventBus:true`、
`ready:true`、`overlays:16`、`currentPage:5`）；overlay 画布已挂载（`painted:true`）但渲染失败：
`paintError = "render: can't access property \"canvas\", canvasContext is undefined"`，
抛点在 `resource://zotero/reader/pdf/build/pdf.mjs:15882`（pdf.js 读 `canvasContext.canvas`）；
region `errClass:true, nonWhite:0, mean:null`，画布 visibility hidden；page 画布 `nonWhite:1`；
`devicePixelRatio:1.7647`（bufWidth 1475 / cssWidth 835，几何正常，非缩放 bug）。

根因：render 参数对象 `{canvasContext, viewport, transform, ...renderOptions}` 是 sandbox 普通对象，
pdf.js 在 reader realm 里解构时读不到具名属性。与第 11/12 轮的 window expando 盲区同族、方向相反：
那次是 realm 对象在 sandbox 里读不到，这次是 sandbox 对象在 realm 里读不到。
画布本身早已是 realm 元素（`syncCanvases` 走 `innerDoc.createElement`，实机 style/classList 写入均生效），
故选路线 A：可见画布直接作渲染目标（pdf.js 只碰 canvas/context/params，零拷贝）；
路线 B（隐藏 realm 画布渲染 + drawImage 回拷）不采用。

修复（@fixer，205 测试通过，`dist/figure-color-preservation-0.1.13.xpi` 28 401 B）：

1. `src/core/render.js`：`renderRegion` 增可选 `paramsFactory`（缺省 → sandbox `{}`，离线测试行为不变）。
   `getViewport` 的 options 与 render 的 params 都经工厂造，属性由 sandbox 逐个写入 realm 原生对象
   ——sandbox→realm 原生对象的属性写入方向已被实机（canvas.style）证明可用。
2. `src/zotero/overlay.js`：新增 `realmParamsFactory(innerWin)`（`new innerWin.Object()`，取不到则回落 sandbox `{}`），
   构造时定格为 `this.paramsFactory` 传给 renderRegion。`paintRegions` 由并行 `Promise.all` 改为逐 region
   顺序 `await`：pdf.js 同页 render task 未结算不发下一区域（避开 v0.1.9 "Rendering cancelled" 陷阱），
   最小改动无队列；cancel() 后 generation 变化即 break，剩余区域交给新 pass。
   `lastPaintError` / `fcp-error` / visibility 语义不变。
3. `src/zotero/paint-probe.js` 防冻结：新增 `MAX_SCAN_PIXELS = 250_000`，probeOverlay 按
   （page 画布 + 保留 region）数量切分预算，samplePixels 用 stride 扫描（采样盒仍一次 getImageData 读回，
   只有分析循环按步长走），输出 `stride` / `scannedPixels` 字段（page 与 regions 均带）。
   实机 page 画布 3738×4844（约 18 MP）此前全量 getImageData 卡死 UI；现在采样盒 ≤ 4 M 像素读回、
   整次 probe 分析 ≤ 25 万像素。`xray.js localNumbers` 像素拷贝机制未动，无回归。
4. 测试：205 通过（新增 7 个：realm `createElement` 建画布、viewport options 与 params 为 realm 对象、
   无 `Object` 时回落 sandbox、逐 region await（首个 task 最后结算仍不交错）、stride 上限 × 2、预算内 stride 1）。
5. 版本 0.1.13（package.json + manifest.json）。

已知风险（仅标记，本回合不做对策）：
`context.skipBlender = true` 是 sandbox 写在 realm context 上的 expando，若 Zotero 10.0.8 的 Blender
原生读取该属性，可能仍看不到 → 暗色模式可能再次反色；`transform` 仍是 sandbox 普通数组
`number[]`，pdf.js 在 realm 里按下标读，若同族盲区波及下标读取则几何会错位。

下次实机（v0.1.13）判定：
| probePaint / probe 证据 | 结论 | 下一步 |
| --- | --- | --- |
| `paintError:null` + region `nonWhite>0` | 渲染成功，原色已落画布 | 复测视觉项 |
| `paintError` 仍为 `canvasContext is undefined` | 工厂未命中或 params 仍不可见 | 查 `realmParamsFactory` 是否走了回落；必要时 context 也走桥 |
| `paintError` 含 `Rendering cancelled` | 调度问题 | 每页渲染队列 |
| 渲染成功但 `mean` 偏暗/发灰 | Blender 未识别 `skipBlender` | 反色，需原生写点 |
| probe 不再冻结 UI 且 `stride≥2`、`scannedPixels≤预算` | 防冻结生效 | — |

### 第 14 轮（v0.1.14）：params 写入被 Xray 拒绝——写通道走 `wrappedJSObject` waive

实机证据（v0.1.13，Zotero 10.0.8 Windows）：`paintError = "render: Not allowed to define cross-origin
object as property on [Object] or [Array] XrayWrapper"`，抛点 `src/core/render.js` ~944
（构建后行号，即逐属性写 realm params 处；`params.transform = geometry.renderTransform` 一行，
sandbox 数组正是那个 cross-origin object）。第 13 轮的「sandbox→realm 原生对象属性写入方向可用」
判断只对原始类型成立。

@oracle 盘点结论：
1. 写侧：Gecko 的 XrayWrapper 拒绝在 wrapper 上 **define 跨 realm 对象值**；原始类型（number/string/boolean）
   直写永远安全。修法 = 写通道 waive：`paramsObj.wrappedJSObject` 存在时经
   `paramsObj.wrappedJSObject.<key> = value` 写（写到未包壳的底层 realm 对象上），否则直写
   （离线/无 realm 路径行为不变）。
2. 三处同修（只修一处会连环炸）：`canvasContext`、`viewport`、`transform` 全部走同一 waive 写通道。
   `transform` 保持 sandbox `number[]`（读侧安全依据：Gecko 仅对 TypedArray 元素读下禁令，
   Xray 允许 chrome Array 元素读；且 Zotero fork 的 pdf.js 对 `params.transform` 是按下标读，
   勿换 Float32Array——那正是被禁的那类）。
3. 读侧其余核对：`skipBlender` 是 boolean 值 expando，Xray 允许（fork canvas.js:902–903 读取该属性），
   勿动；保持「render() 之前设置」时序（overlay.js:375 现状）。
4. viewport 来源审计：喂回 pdf.js 的必须是 `pdfPage.getViewport()` 原始返回（realm 对象），
   不得是 `localViewport` 沙箱拷贝；`localViewport`/`localPDFPage` 仅服务检测/几何侧。
   审计结果：沙箱唯一渲染调用点 overlay.js `paintRegions` → `renderRegion` 传的 `pdfPage` 是
   `pageView.pdfPage` 原始对象（非 `localPDFPage`），`params.viewport` 即 `pdfPage.getViewport()`
   返回值，原始透传，无违规调用点，未改调用方。

修复（@fixer，208 测试通过，`dist/figure-color-preservation-0.1.14.xpi`）：

1. `src/core/render.js`：新增 `paramsSink(paramsObj)`（`wrappedJSObject` 存在 → 返回底层对象，
   读取本身 try/catch 兜底；否则返回原对象）；`canvasContext` / `viewport` / `transform` /
   `renderOptions` 循环全部改写 `sink.<key>`。`viewportOptions` 的 scale/rotation 是原始类型，直写不动。
2. 测试：208 通过（新增 3 个：mock Xray wrapper——对象值直写即抛 v0.1.13 原文错误、原始类型放行、
   `wrappedJSObject` 指底层对象——断言 canvasContext/viewport/transform 与对象值 renderOptions
   落在底层对象且 wrapper 上零直写；无 `wrappedJSObject` 时直写回退；
   `params.viewport` === `pdfPage.getViewport()` 原始返回而非 local 拷贝，overlay 级同断言补进 realm handoff 用例）。
3. 版本 0.1.14（package.json + manifest.json）。

下次实机（v0.1.14）判定矩阵：
| probePaint / probe 证据 | 结论 | 下一步 |
| --- | --- | --- |
| `paintError:null` + region `nonWhite>0` | 出图，原色已落画布 | 复测视觉项 |
| `paintError:null`、`nonWhite>0` 但 `mean` 呈反色 | Blender 未跳（`skipBlender` 失效） | 下一轮主题：原生写点 |
| 新 `can't access` 文本 | 又一处 realm 可见性 | 继续按文本定位抛点 |

### 第 15 轮（v0.1.15）：结构性修复——渲染调用整体搬进 viewer realm

实机证据（v0.1.14，Zotero 10.0.8 Windows）：`paintError = "render: Permission denied to access property
Symbol.iterator"`，抛点 `beginDrawing @ resource://zotero/reader/pdf/build/pdf.mjs:11490`。被迭代的值是
第 14 轮刻意保留的 sandbox `number[]` `params.transform`：Xray 允许按下标读，但 pdf.js 在 realm 里对它做
展开/迭代，元素访问仍算跨边界 → 直接拒。第 13/14 轮修的都是「属性写方向」，数组本身无论 waive 与否都是外来
对象，打补丁无法穷尽。另一条实测事实决定了必须换结构：同一台机器多次重启，`realm.route` 在 `direct` 与
`wrapped` 之间漂移，任何依赖单一通道的方案都不牢靠。

@oracle 定的规则：**只有原始类型和 realm 对象允许跨界**。据此把 render 调用整体移进 realm。

修复（@fixer，230 测试通过（44 suites），`dist/figure-color-preservation-0.1.15.xpi` 29 862 B）：

1. 新模块 `src/zotero/realm-render.js`。realm 侧 helper 签名（9 个参数：8 个原始类型 + 2 个 realm 对象）：
   `window.__fcpRenderRegion(pdfPage, canvas, bufWidth, bufHeight, renderScale, rotation, tx, ty, background)`。
   realm 内部完成全部工作：`pdfPage.getViewport({scale, rotation})`、`canvas.width/height`、
   `getContext('2d')`、reset + clear + 背景填充、`var transform = [1, 0, 0, 1, tx, ty]`（realm 原生数组）、
   `params = {canvasContext, viewport, transform}`、`ctx.skipBlender = true`（realm 内写 realm context，
   fork 的 blender 必定可见）、`pdfPage.render(params)`。返回 realm 对象 `{task, done: task.finished ??
   task.promise}`：fork 的 `RenderTask` 只有 `promise`，故取 `??`；sandbox 侧 `renderRegionViaHelper` 对
   settled 值带 `success === false` 的情况仍抛出，`finished` 与 `promise` 两种语义都不会把失败当成功。
   `tx/ty` 由 sandbox 几何算好后按数字传入，buffer 尺寸同理为数字，realm 侧不读 sandbox 对象属性。
2. 注入与解析：`innerWin.eval(RENDER_HELPER_SRC)`（与第 12 轮主窗口桥同一手法）；存在性由第二次
   `eval("typeof window.__fcpRenderRegion")` 证明，**不读 expando**（第 11/12 轮教训：Xray 会藏 JS 定义的
   window 属性）；函数值再经双通道解析（`direct` → `wrappedJSObject`），因为漂移的正是 wrapper 类型。
   per-window `WeakMap` 缓存正负结果：CSP 拒绝或通道不可达只记一次，不逐次 paint 重试；同一 window 重复
   `eval` 是幂等赋值，切 PDF / viewer 重载换了 window 会自动重新注入。
3. `src/zotero/overlay.js`：`paintRegions` 每 pass 解析一次 helper。命中 → `paintPath = "helper"`，走
   `renderRegionViaHelper`；未命中 → 保留第 13/14 轮 legacy 路径（`paramsFactory` + `paramsSink` waive 写 +
   sandbox 侧 `context.skipBlender`）并记 `paintPath = "legacy"`。逐 region 串行 `await`、`generation`
   取消、`pushTask` 挂 `this.tasks`、`lastPaintError` / `fcp-error` / visibility 语义两条路径共用。
   `src/zotero/reader-session.js` 传入 `tag`，供 `warnOnce` 标注是哪个 reader。
4. probe 侧防冻结加固（`src/zotero/paint-probe.js`）：`MAX_SAMPLED_PIXELS` 4 M → **1 M**（单次
   `getImageData` 读回 ≤ ~1 MP，跨界像素拷贝才是冻结源头），per-side `MAX_SAMPLE_SIDE` 2000 之后追加
   `sqrt(maxPixels / (w * h))` 等比收缩；`MAX_SCAN_PIXELS = 250_000` 分析预算不变（仍按 page 画布 + 保留
   region 数量切分，stride 只影响分析循环）。新增字段：`readbackPixels`（本次读回窗口面积，`page` 与
   `regions` 均带；实测单测数据 3738×4844 → 采样盒 `[1369, 1922, 1000, 1000]`、`readbackPixels` 1 000 000、
   stride 3、`scannedPixels` 111 556），裁剪时另带 `sampledBox`；`target.paintPath`（`"helper"` / `"legacy"` /
   null，未知值一律报 null）。`src/zotero/main.js probePaint(pageNumber, options)` 透传 options，
   `maxPaintReadbackPixels` 是 `maxSampledPixels` 的别名。
5. 测试：`npm test` 230 通过、0 失败（上轮 208，+22）。新增 `tests/js/realm-render.test.mjs` 13 个：真源串
   直接编译后跑（realm 造 params / 造 transform、`skipBlender` 早于 `render()`、`finished ?? promise`、
   失败上抛、cancel 交接、参数校验拒绝、CSP 只 warn 一次、Xray stand-in、通道不可达告警）；
   `tests/js/overlay.test.mjs` helper 路径 5 个（helper 命中并上报 `paintPath`、串行 await、cancel 交接、
   reject → `fcp-error` + hidden、`withEval:false` → `paintPath:"legacy"`）；`tests/js/paint-probe.test.mjs`
   读回上限与 `paintPath` 4 个。
6. 版本 0.1.15（package.json + manifest.json）。

CSP 风险（本轮唯一新增风险面）：helper 注入用 `innerWin.eval`，与第 12 轮主窗口桥同一手法但是**不同文档**：
主窗口 bridge 的 `eval` 实机已成功，pdf.js `viewer.html` 若带不含 `'unsafe-eval'` 的 CSP，`win.eval` 会抛
`EvalError`。此时 `ensureRenderHelper` 返回 null，`warnOnce("render-helper-eval")` 记一次，paint 自动回落
legacy，即第 14 轮行为，不会更差；代价只是这一轮修复在该文档上不生效。

下次实机（v0.1.15）判定矩阵：
| probePaint / probeAll 证据 | 结论 | 下一步 |
| --- | --- | --- |
| `target.paintPath:"helper"` + `paintError:null` + region `nonWhite>0` | 出图，原色已落画布 | 复测视觉项 |
| `paintPath:"helper"`、`nonWhite>0` 但 `mean` 呈反色 | Blender 仍没跳过（realm 内写点也无效） | 下一轮主题：blender 原生开关 |
| `paintPath:"legacy"` | `eval` 被 CSP 拒或读通道不可达 | 看 ring 里 `render-helper-eval` / `render-helper-unreachable`，legacy 按第 14 轮判定 |
| `paintPath:"helper"` 仍报 `Symbol.iterator` | 该窗口未命中 helper，或另有迭代点 | 贴 `paintError` 原文 + stack |
| probe 仍冻结 UI | 读回未生效 | 核对 `readbackPixels ≤ 1e6` 与 `sampledBox` |

### 第 16 轮（v0.1.16）：检测层补矢量路径——纯向量图不再是盲区

离线证据（A1 fixture，v0.1.15）：第 7 页 Figure 5 与 Figure 6a 是纯矢量图——operatorList 里只有
`constructPath` + fill/stroke，没有任何 XObject。检测层只认 `paintImageXObject` /
`paintFormXObjectBegin`，矢量路径整条被丢弃，Figure 5 是全文档唯一假阴性（`uncovered =
["page 7 Figure 5"]`）。根因一句话：placements 层没有路径出口。

修复（@fixer，244 测试通过（44+1 suites），`dist/figure-color-preservation-0.1.16.xpi` 32 002 B）：

1. `src/core/placements.js`：`constructPath`（6.5.438 里码值 91，参数 `[mode, points, minMax]`，
   `minMax` 为当前 CTM 用户空间的四元包围盒，存 `Float32Array`）按 mode 判定去向：mode ∈
   {stroke 20 … closeEOFillStroke 27} → 产出 `kind:"path"` placement；`endPath`（28，裁剪路径）→
   skip（`path-not-painted`）。`rawFillPath`（94）恒为填充，包围盒在 `args[1]`。`toBounds` 兼容
   typed array。顺带修一个既有 CTM bug：`paintFormXObjectBegin` 现在压入 `{ctm, formDepth,
   form:true}` 并应用表单 `/Matrix`，`paintFormXObjectEnd` 回退到该条目——表单内部不配对的 `save`
   不再把表单变换漏到外层。fixture 的表单 `/Matrix` 全是单位阵，故 oracle 数字不变。诊断新增
   `pathBoxCount`。
2. `src/core/pdf-source.js`：`MEASURED_OP_CODES` 扩到 constructPath / rawFillPath / 8 个 paint 码，
   `getOperatorList` 保证这些操作被记录。码值在 4.10.38（Zotero 内置）与 6.5.438 中一致。
3. `src/core/detector.js`：merge-first 管线——painted path box 先全部收集，去掉非法/出页/零面积，按
   `maxPathBoxesPerPage: 1200` 截断（超出记 `pathBoxesTruncated`），然后 union-find 链式合并：两框
   在 X、Y 两轴上的间隙都 ≤ 容差才并入，反复扫描直到框数稳定（`pathMergeMaxPasses: 30`）。合并后的
   簇作为单个 `kind:"path"` placement 走原有 evaluatePlacement / caption / 置信度 / 过滤管线；
   XObject placement 不参与合并。容差 `pathMergeGapDiagonalRatio: 0.018`（612×792 页约 18 pt）。
   必须在合并前过滤会把 Figure 5 的细碎小框用 `minSidePt` 全部误杀，所以原始框不设小框门槛。
   打分：路径证据 +0.05（`vector-path`），无 caption 的独立矢量簇给 0.25（`standalone-path`），
   准入门槛加 `(isPath && ratio >= pathAnchoredAreaRatio)`，`pathAnchoredAreaRatio: 0.015`；第 1 页
   页眉 logo 簇（ratio≈0.0039）仍拒。region 新增 `sourceKinds`（去重来源集合，多来源 `kind:"multi"`）。
   `placementCount` 语义改为进检测器的候选数，原始量记 `rawPlacementCount` / `rawPathBoxCount`。
4. 参数取值证据：容差扫描 0.008 / 0.012 会把 Figure 5 拦腰截断（簇停在 y 559.7），0.018 与 0.025
   结果相同且完整，取 0.018；第 11 页同组面板间隙 15.5–17.4 pt 被链住、面板之间 ≥23 pt 仍分开。
   cap 从 600 提到 1200：第 11 页原始框 1009 个，600 会截掉 409 个；1009 框全量合并实测 5.4 ms。
5. probe / 会话：region 条目新增 `kind`（`overlay.js` 导出 `regionKindLabel`：`path` /
   `xobject`（image|form|multi）/ `struct`，混合以 `+` 连接），`main.js` `describeSession` 键文档同步。
6. `package.json` 新增 `npm run detect`（单跑 fixture 检测并重写 `reports/A1-detection.json`）。
7. 测试 +14：`tests/js/placements.test.mjs` 矢量路径 7 个（painted/endPath/Float32Array/无包围盒/
   rawFillPath/表单 `/Matrix` 作用于内部路径/diagnostics 计数），`tests/js/detector.test.mjs` 6 个
   （近框链合、远框保持分开、小簇 `path-below-area-threshold`、caption 锚定的小路径簇、
   `sourceKinds` 混合、截断诊断），`tests/js/fixture-detect.test.mjs` 把「Figure 5 已知假阴性」断言改为
   `uncovered = []`，第 4 页拆出独立断言（有 7 个原始矢量框但全部不过门槛）。244 = 230 + 14，全绿。

A1 前后对比（`reports/A1-detection.json`，页面左上角坐标）：

| 页面 | v0.1.15 | v0.1.16 | 判定 |
| --- | --- | --- | --- |
| 7 | Figure 6 form `[320.37,72.45,560.49,133.00]`；Figure 5 无覆盖 | Figure 5 `path` `[57.46,75.19,291.55,305.04]` conf 0.85；Figure 6 `form+path` `[320.37,72.45,560.49,165.43]` conf 0.90（扩到含 6a 面板及其标签） | 假阴性清零，`uncovered=[]` |
| 5 | Figure 2/3 两块（oracle 基准） | rect 不变（最差角点差 4e-5），kind 变 `form+path` | 无回归 |
| 11 | Figure 11/12/13 三块 | 原三块不变；新增 3 个 `path` 区域 conf 0.65（`[60.29,84.35,209.43,163.92]` 等，页顶三个无 caption 的矢量小图） | 新区域框内无正文文本，判真阳性 |
| 1/2/4/8/14/15/16 | 0 区域 | 0 区域（第 4 页 7 个原始框合成 2 簇，均被 `below-min-area` 拒） | 无误报 |
| 3/6/9/10/12/13 | caption 图块 | rect 不变（仅第 13 页 y0 635→634，路径并入所致） | 无回归 |

第 7 页新纳入的文字只有图内小字号标注与图例（fs 6.8–8.7），正文不在任何区域里。性能：最坏页（第 11
页，1009 框）检测 5.4 ms，全文档一轮 detect 约 200–390 ms（含 pdf.js 解析），风险低。

下次实机（v0.1.16）判定矩阵（只针对检测层新增面）：
| probeAll / probePaint 证据 | 结论 | 下一步 |
| --- | --- | --- |
| 第 7 页 regions 从 1 条变 2 条、新条目 `kind` 含 `path`、`paintError:null` | 矢量图覆盖恢复 | 复测该页视觉项 |
| `kind:"path"` 区域框住正文段落 | 该文档路径噪声大、簇过大 | 调低 `pathMergeGapDiagonalRatio`（0.012）重测 |
| 同一图被拆成多条 `path` 区域 | 容差偏小 | 调高到 0.025 重测 |
| 纯装饰页冒出区域且 ratio 在 0.015–0.02 | `pathAnchoredAreaRatio` 偏松 | 上调该值 |
| ring 里 `pathBoxesTruncated > 0` 且该页图缺角 | cap 截断 | 上调 `maxPathBoxesPerPage` |

### 第 17 轮（v0.1.17）：检测层按水平间隙切段——同基线的另一栏正文不再吞掉图注

离线证据（A1 fixture，v0.1.16）：第 9 页 `Figure 8: Kafka producer throughput and latency.` 与左栏正文行
`records and 10 million records. We set the number of YCSB` 落在同一条基线上（正文 x 54.00–294.12 /
y 441.40，图注 x 339.43–536.46 / y 442.16，字号同为 9.96 pt，PDF 用户空间）。`collectTextLines` 只按基线
y 分桶，两段被拼成一行，`collectCaptions` 取行首匹配 → 该行不被认成图注，Figure 8 既无 caption 也无区域，
而且 `uncovered` 里看不到它（图注本身没被提取，属静默假阴性）。根因一句话：text line 层没有水平切段。

阈值取值证据（同一 fixture 实测）：栏内间隙（词距、表内间距）最大约 2.0 个字号单位；最小真实栏间距 2.17
个单位 = 21.64 pt（9.96 pt 字号）；第 9 页肇事行的「正文—图注」间隙 45.31 pt = 4.55 个单位。切段条件取
`gap > max(2 × 该行字号中位数, 8 pt)`：2 个单位落在词距（≤2.0）与栏间距（≥2.17）之间；8 pt 绝对下限防止
6–7 pt 小字号时按单位数误切单词。副作用可接受：第 13 页三栏并排图注 `Figure 15/16/17` 段间间隙 15.93 pt
（1.60 单位）与 16.40 pt（1.65 单位），仍不切段，与 v0.1.16 行为一致（不为这两条图注下调阈值，否则会在
正文词距处误切）。

修复（@fixer，254 测试通过（47 suites），`dist/figure-color-preservation-0.1.17.xpi` 32 331 B）：

1. `src/core/captions.js`：新增 `splitByGap`，`collectTextLines` 在每个基线桶内先按 x 排序、再按上述间隙
   切成 segment，每个 segment 出一条 line（`rect` / `text` / `baselineY` / `fontSize` 只覆盖该段）。常量
   `DEFAULT_COLUMN_GAP_MIN_FONT_SIZE_UNITS = 2`、`DEFAULT_COLUMN_GAP_MIN_PT = 8`，可用 options
   `columnGapMinFontSizeUnits` / `columnGapMinPt` 覆盖。只有一段时不切，行 rect 与旧实现逐字节相同（回归
   安全）。line 排序改为 `baselineY` 降序、`rect[0]` 升序做 tiebreak，多段行输出顺序确定。
2. `src/core/detector.js`：与某图注绑定但未落入所选行的 placement 逐条产生 `dropped-row` reject 记录
   （过去静默丢弃）。全文档命中 1 条（第 11 页）。
3. 下游消费点核对：切段后的 rect 只经 `collectCaptions` 进 detector。detector 内 `caption.rect` 的消费者是
   `linkCaption`（x 重叠 + 垂直间隙）、`pickNearestRow` / `rowGap`（选行）、`captionKey`（rect x/y 取整做
   键）、`scoreRegion` 证据标签；render / realm / overlay 层不消费 text line，只用 regions 与 captions，
   故本轮不动渲染层。
4. 测试 +10：`tests/js/captions.test.mjs` 6 个（两栏切段、每段独立 rect、图注位于段首可匹配、单段行 rect
   不变、阈值随字号缩放且受 8 pt 下限保护、options 覆盖阈值），`tests/js/detector.test.mjs` 1 个
   （`dropped-row` 记录），`tests/js/fixture-detect.test.mjs` 3 个（第 9 页 captions = 7/8/9、切段图注不落入
   自身区域、全文档 15 条图注与 18 个区域清单）。254 = 244 + 10，全绿。
5. 文档：`reports/A1_DETECTION.md` 第 5 节 survey 与统计重写，第 6 节 false positive 计数改为按 18 个区域
   说明、`dropped-row` 由「诊断字段限制」改为已实现、新增第 13 页 Figure 16/17 遗留限制。

A1 前后对比（`reports/A1-detection.json`，区域与 caption rect 均为页面左上角坐标）：

| 页面 | v0.1.16 | v0.1.17 | 判定 |
| --- | --- | --- | --- |
| 9 | captions 7、9；Fig 7 `form+path` `[56.55,81.96,555.45,180.45]` conf 0.90、Fig 9 `[317.88,356.42,558.01,452.18]` conf 0.95；Figure 8 无图注、无区域 | captions 7、8、9；caption 8 rect `[339.43,339.88,536.46,349.84]`（切段后只含图注本身）；新增 Fig 8 `form+path` `[317.88,235.75,558.01,331.51]` conf 0.95、面积比 0.0474 | 该页假阴性清零，`rejected` 仍为空 |
| 其余 15 页 | 17 个区域 | 17 个区域完全不变（全文档 18 = 17 + 第 9 页 1 个） | 无回归、无误报 |

全文档统计：15 条图注（Figure 1–15）全部有区域覆盖，18 个接受区域（15 个绑定图注 + 第 11 页页顶 3 个无图注
矢量小图），`uncovered = []`，观察到的 false positive 0，`dropped-row` 1 条，最大面积比仍 0.1541（第 12 页
Figure 14）。性能：切段只在基线桶内做一次排序扫描，实测 warm detect 第 11 页 20.6–29.3 ms、第 9 页
18.9–20.5 ms（含 operator list 与 text content 解析），与 v0.1.16 同量级，无新增风险。

下次实机（v0.1.17）判定矩阵（只针对切段新增面）：

| probeAll 证据 | 结论 | 下一步 |
| --- | --- | --- |
| 第 9 页 regions 由 2 条变 3 条，新条目 captionNumber 8、`kind:"form+path"`、`paintError:null` | 真机 pdf.js 报告的 textItem 间隙与离线一致 | 复测该页视觉项（Figure 8 原色覆盖） |
| 第 9 页仍 2 条且 caption 列表里没有 8 | 真机 textItem 的宽度/间隙与 pdfjs-dist 报告不同 | 看该页 lines 分段，必要时把 `columnGapMinFontSizeUnits` 下调到 1.8 重测 |
| 某页正文段落被切成多段、区域框住半截句子 | 阈值偏紧、该文档词距偏大 | 上调 `columnGapMinFontSizeUnits`（2.5）或 `columnGapMinPt` |
| ring 里 `dropped-row > 0` 且该页图缺半边 | 选行判据在该文档布局上偏严 | 按记录 rect 调 `rowMergeGapPt` |
| 第 13 页 Figure 16/17 需要覆盖 | 一行三条图注，间隙 1.60/1.65 单位低于阈值 | 另做「一行多图注」按 `Figure N:` 再切，不动本轮阈值 |

## 第 18 轮：第二个夹具（Flash-Level 论文）暴露的两处识别缺陷 — v0.1.18

### 新夹具与真值基准

加入第二个 PDF 夹具 `Flash-Level Asynchronous Execution for In-Storage LSM-Tree Operations.pdf`
（仓库根目录；18 页 ACM 双栏排版，无 `/Figure` 结构标签，图形均为内联 Form XObject 与 Image XObject）。
MuPDF 逐页抽取的内嵌图 bbox 作真值：10 幅插图（Figure 1–10，分布于第 1/3/4/5/6/8/9/10/12 页，第 10 页两幅），
pdf.js 检测器 10/10 命中，rect 角点差 ≤ 2 pt（验收阈值）。新测试文件 `tests/js/flash-detect.test.mjs`
（7 test；`helpers/doc.mjs` 的 `openFixture` 参数化后可加载任一夹具）；`tests/js/detector.test.mjs` 增 5 test
锁住两条新规则的边界。全量 `npm test` 266/266 通过（254 → 266），结果见 `reports/flash-detection.json`。

### 缺陷一：图注行被裁剪外框侵入，链接失败（第 4、12 页）

现象：Figure 3 / Figure 10 区域无 captionNumber，整篇 `uncovered = [3, 10]`，conf 0.65（仅证据分）。
根因（pdf.js `getTextContent` 实测）：这两页图注文字带裁剪路径，pdf.js 返回**绘图组** bbox 而非文字行 bbox。
第 4 页 "3:" 项 transform=[9,0,0,9,317.88,94.32]（行矩形 y 94.32–103.32，数字宽 4.5），bbox 却是
x 317.88–557.97、y 72–161.42（整个图形+图注组，宽 240）。`linkCaption` 原判定要求图形外与整行 bbox 的间隙
≤ 8 pt（`maxCaptionGapPt`），bbox 顶 161.42 高出图形底 103.68 达 57.7 pt → 候选全部被拒。
修复（`linkCaption`）：允许图形外框侵入图注行，侵入深度 ≤ min(行高, `maxCaptionOverlapPt` = 12) 时计作 0 间距
（PDF 与 CSS 两套坐标各按所在侧计算）；超过上限仍不算图注。第 4 页侵入 4.6 pt、第 12 页侵入 2.3 pt（实测）；
PipeBWrite 全 16 页侵入均 ≤ 1.8 pt，行为不变。`rowGap` 同用该容差，否则选行与链接不一致
（第 12 页 "10:" 与相邻正文同处一行，行高 9.96 > 容差，正文词距 8.17 pt 会胜出并使链接失败）。

### 缺陷二：区域内小图块被面积上限丢弃，外框不贴边（第 1 页，第 6 页同类）

现象：第 1 页 Figure 1 区域顶 252.00（真值 239.28），左缘 344.19（真值 317.88），缺左上角 3D-LSM 立方体簇。
根因：该簇 3 张子图（CSS 例如 [358.01,239.28,474.07,277.41]）单块面积比低于 `imageMinAreaRatio` = 0.01，
按 `image-below-area-threshold` 丢弃；图注行锚定的行联合只含主图，不含它们。
修复：面积上限拒绝不再即时丢弃，合并后统一做**区域内吸收**（`absorbAreaRejected`，在 `mergeRegions` 之后、
按页排序之前执行，使 `pageAreaRatio` 与排序看到增长后的 rect）：候选中心严格位于某已接受区域内
（四边各缩 `absorbCenterInsetPt` = 1 pt）、候选 rect 不与该区域图注矩形（区域新增公开字段 `captionRects`）相交、
并入后仍 ≤ `maxAreaRatio` = 0.35 时，吸收进增长最小的区域（evidence 追加 `absorbed-image`/`absorbed-path`，
被吸收条目不再进 `rejected`）。中心判定使第 1 页页眉处 ACM logo 四块（CSS [461.64,36,558.01,79.21]，
在 Figure 1 区上方 160 pt）不被吸收。

### 修复前后对照（CSS rect = [left, top, right, bottom]，`reports/flash-detection.json`）

| 页 | 修复前 | 修复后 |
|---|---|---|
| 1 | `[344.19,252.00,557.97,351.00]` form+image conf 0.95，无图注 | `[317.88,239.28,558.00,350.59]` form+path+image conf 0.95，captionNumber 1（3 张子图吸收，顶 252 → 239.28 与真值一致） |
| 3 | `[59.96,247.48,285.68,392.42]` form+path conf 0.95 | 不变 |
| 4 | `[317.88,72.00,557.97,161.42]` form+path，无图注 conf 0.65 | `[317.88,72.00,558.00,161.44]`（Form XObject 经图注链接并入行联合，右/底 +0.03/+0.02 pt），captionNumber 3，conf 0.95 |
| 5 | `[54,203.94,294.12,369.41]` form+path conf 0.95 | 不变 |
| 6 | `[317.88,283.59,558.00,448.88]` form+path conf 0.95 | rect 不变，2 张内部子图吸收（evidence +`absorbed-image`） |
| 8/9 | form+path conf 0.95 | 不变 |
| 10 | 两区 form+path conf 0.95（cap 8/9） | 不变 |
| 12 | `[54,72.00,557.93,243.64]`，无图注 conf 0.65 | `[54,72.00,558.01,243.66]`（右/底 +0.08/+0.02 pt，Form 并入所致），captionNumber 10，conf 0.95 |
| 整篇 | uncovered [3,10]，10 区域，max pageAreaRatio 0.1843（第 5 页） | uncovered []，10 区域，max pageAreaRatio 0.1785（第 5 页） |

第 2/7/11/13–18 页（引言尾、参考文献、致谢等）仍 0 区域；第 3 页 `rejected` 顺序有变（面积拒绝条目现统一排在
区域级拒绝之后，纯诊断顺序，内容不变）。

### PipeBWrite 回归：零影响

16 页吸收 0 次（逐页运行 `detectPageRegions`，无任何 `absorbed-*` evidence）；18 个接受区域、逐页接受数
`[0,0,1,0,2,1,2,0,3,1,6,1,1,0,0,0]`、第 5 页 oracle rect、第 9 页 Figure 8 双图 rect、第 1 页拒绝原因
（3 × `below-min-area` + 1 × `path-below-area-threshold`）与第 16 轮记录逐项一致；max pageAreaRatio 0.1541
（第 12 页 Figure 14）不变；`reports/A1-detection.json` 已用修复后检测器重写，与上述记录一致。

### 遗留限制增补（待用户实测判断）

- 图注 bbox 被裁剪组放大时，若同一行混入正文词，`captionText` 可能含噪（本夹具第 4/12 页实测干净，
  图注文本为完整 "Figure 3: Microbenchmark results on RocksDB." / "Figure 10: YCSB performance across
  different value sizes."）。
- 吸收仅针对面积上限拒绝（`image-below-area-threshold` / `path-below-area-threshold`）；`no-figure-evidence`、
  `no-caption-below` 等仍不吸收（保守）。
- 第 10/12 页图注编号字号 6–8 pt，行高接近容差上限 12 pt，排版再紧 2 pt 以上链接可能再失败。

### 构建产物

- `npm run build` 成功：`dist/figure-color-preservation-0.1.18.xpi`（33,183 字节，14 条目，全部 ASCII 路径），
  `package.json` 与 `manifest.json` 同为 0.1.18。
- 本机仍无 Zotero 7，第 1–7 项真机验收不变，待用户执行；验收矩阵同第 9 节（在 v0.1.18 XPI 上重跑，另加：
  Flash-Level 论文第 1/3/4/5/6/8/9/10/12 页区域高亮与图注号、第 4/12 页覆盖完整性，待用户回填）。
- UI change: the toolbar toggle now injects one small stylesheet per toolbar document and styles itself
  through its `aria-pressed` attribute. The enabled state renders as a solid rounded accent chip and the
  disabled state as muted translucent grey, so both states are clearly distinct in light and dark themes;
  hover, active and focus-visible feedback were added. Detection and rendering logic are unchanged.

## 第 19 轮：工具栏开关后叠加层整体偏移 — v0.1.19

### 真机症状（v0.1.18 XPI）

首次打开 PDF 时颜色保留位置正确；把工具栏开关关掉再打开，同一页的覆盖框整体偏移（该页所有区域同方向、同比例
位移），区域识别本身没变（RegionCache 命中，regions 条目与图注号一致）。手动缩放（放大/缩小、适应宽度）之后
覆盖层仍然正确，因为 `onViewScaleChange` 会用新 viewport 重绘。

### 假设：enable 那一轮 paint 与 viewer 的 relayout 抢跑

`setEnabled(true)` 里的 `repaintAttached()` 与工具栏状态变更在同一 tick 完成；此时工具栏收起/展开引起的可用宽度
变化、以及 fit-width 的重缩放还没跑完，`pageView.viewport` 仍是旧值。paint 按旧 viewport 换算 CSS 坐标与画布尺寸，
viewer 随后替换 viewport 且不通知插件，于是整页画布停在旧比例上，看起来就是"整体偏移"。首开正常与此一致：
首开由 `pagesloaded`/`pagerendered` 驱动，那时布局已稳定。

### 补充：同一 PDF 一次正常一次偏移 — 热缓存竞态

真机反馈同一份 PDF 一次打开正常、一次打开偏移，原因在 RegionCache：它在同一进程内常驻。热缓存时检测瞬时返回，
上色与 viewer 的重排在同一 tick 完成，撞上竞态；冷缓存时解析页面要几十到几百毫秒，反而避开了竞态。因此 350 ms
的 settled 复查现在在首次打开（`start()`）、文档切换（`queueDocumentCheck()`）、开关开启（`setEnabled(true)`）三处
都挂（`scheduleSettledCheck()` 覆盖旧计时器，重复武装不叠加）；`describeSession` 新增 `settledRepaints` 计数，
真机上该计数非零且偏移同时消失，即为"paint 与重排抢跑"的证据。

### 本轮改动（几何数学未动）

- `src/zotero/overlay.js`：`paintRegions` 记录 `lastPaintGeometry`（本轮 paint 实际使用的 viewportWidth/Height/Scale/Rotation、
  deviceScale 与时刻 `at`）；新增 `geometryStale()` 比较这四个字段，容差 `GEOMETRY_TOLERANCE` = 0.01（亚像素取整）。
  一侧不可读算作"移动"（paint 不可能用了页面已不再报告的几何），两侧都不可读算未变；任何跨 realm 抛错返回 false，
  即读不到就不重绘。scale/rotation 也参与比较，使被旋转补偿掩盖的过期 paint 仍能被认出。
- `src/zotero/reader-session.js`：`SETTLED_REPAINT_MS` = 350；`scheduleSettledCheck()` 在首开、文档切换与
  `setEnabled(true)` 三处武装（见上节补充，覆盖旧计时器不叠加），
  到点仅重绘"有缓存区域且 `geometryStale() === true`"的页（走既有 `paintOverlay`：区域取缓存、viewport 现读）；
  重复 enable 只保留一个计时器；`destroy()` 显式清理该计时器。
- `src/zotero/paint-probe.js`：新增 `lastPaintGeometry` / `liveViewport`（paint 时视口 vs 探测时视口并排）、
  `hostBox`（宿主 div 的 clientWidth/Height 与 rect 宽高）、`cssVars`（`--scale-factor` / `--user-unit` /
  `--total-scale-factor`）以及每画布的 `rectLeft/rectTop/rectWidth/rectHeight` 与 `offsetParent` 标签
  （`"<tag>.<first class>"`）。空字符串的自定义属性保持 null，不变成 0（Zotero reader 根本不定义 `--user-unit`）。
- `src/zotero/main.js`：`describeSession` 新增 `scale`（`currentScale` / `currentScaleValue` / `defaultZoomValue`，
  不可读记 null，读取抛错记 `warnOnce("probe-scale")`）与 `settledRepaints`（settled 路径重绘页数，真机证据计数）。

### 真机验收（用户执行，`Zotero_figureColor.probeAll()`）

| 观察 | 结论 | 下一步 |
|---|---|---|
| 开关后 `target.lastPaintGeometry.viewportWidth` ≠ `target.liveViewport.width` | paint 用的 viewport 已过期（本轮假设成立） | 确认 settled 重绘是否已消除视觉偏移 |
| settled 到点后两值仍不等 | relayout 晚于 350 ms | 上调 `SETTLED_REPAINT_MS`，或改为 `pagerendered` 之后再校验一次 |
| 两值相等但视觉仍偏 | 不是 paint 时刻过期，而是布局解析问题 | 看 `cssVars.scaleFactor` 是否为 null、`hostBox.rectWidth` 是否等于 `liveViewport.width` |
| `regions[i].offsetParent` 不是 `div.page` | 画布挂在别的元素里，坐标系不同 | 查 `ensureHostPositioning` 与宿主选择 |
| `cssVars.userUnit` ≠ 1 | 该文档带 UserUnit，paint 与 viewer 的缩放基准不同 | paint 侧按 UserUnit 校正 |
| `scale.currentScale` 与 `target.lastPaintGeometry.viewportScale` 不一致 | 偏移由 fit-width 重缩放引起 | 同上，按 settled 时刻复核 |

### 测试

全量 `npm test` 285/285 通过（266 → 285，+19）：`overlay.test.mjs` 5 test（`geometryStale`：未 paint、几何未变、
视口尺寸变、仅 scale 变、viewport 缺失与读取抛错）；`reader-session.test.mjs` 7 test（enable 恰好武装一个
`SETTLED_REPAINT_MS` 计时器、首开与文档切换各武装一次、`settledRepaints` 只计被重绘的页且无过期几何时为 0、
只重绘几何移动的页、连续开关不叠加计时器、destroy 后计时器不再执行）；
`paint-probe.test.mjs` 6 test（paint 时与探测时视口并排、缺省为 null、空自定义属性保持 null、`hostBox` 与每画布
rect 及 `offsetParent` 标签、朴素替身仍为 null、无 tagName 的主机记 null）；`probe-all.test.mjs` 1 test
（`currentScale` 读取抛错时三项均记 null）。`src/core/viewport.js` 与 `src/zotero/realm-render.js` 未改。

### 构建产物

- `package.json` 与 `manifest.json` 同为 0.1.19；`build/` 与 `dist/` 由 `npm run build` 重新生成，未手改。
- 本机仍无 Zotero 7，第 1–7 项真机验收不变，另加上表六项，待用户回填。

## 第 20 轮：Form XObject 内容画在自己 /BBox 之外 — 检测层加裁剪栈 — v0.1.20

### 症状（Flash-Level 论文第 8 页 Figure 6）

区域高亮比实际墨迹宽：接受区域 `[14.32, 72.00, 286.88, 169.12]`，MuPDF 真值无墨迹在 x = 58.9 左侧，
即左缘多出约 44 pt 纯空白。第 1 页顶部同因偏大约 13 pt，PipeBWrite 第 13 页底部偏 0.79 pt。

### 根因

`collectPlacements` 只按 CTM 记录图元外框，未做裁剪。规范渲染器会把 Form XObject 的内容切在它自己的
`/BBox` 上：第 8 页该 form 有 16 条图例条位于局部 x0 = −68（在 `/BBox` 之外），pdf.js 照常返回它们的外框，
MuPDF 则不画，于是未裁剪的边界把区域左缘拖到 14.32。

### 修复规则（`src/core/placements.js`）

- 与 CTM 遍历并行维护一条裁剪栈，活动裁剪框 `clip` 存**页面用户空间**坐标（与记录的外框同一空间）；
  `null` 表示"已知无裁剪"，与 `[0, 0, 0, 0]`（裁剪到空集）必须区分——`intersectRects` 对零面积矩形回答
  "无重叠"。
- 带可用 `/BBox` 的 form：`clip = intersect(父裁剪框, 该 form 页面空间外框)`；form 结束时经既有
  `form: true` 栈条目恢复进入前的裁剪框（进入值 `entryClip` 在赋值前捕获，故未闭合 save 不会泄漏）。
  `save`/`restore` 同样携带 `clip`。
- 缺 `/BBox`（或空 `/BBox`）的 form **原样继承**父裁剪框，与 pdf.js 一致。承重的正是这一点：PipeBWrite 第 7 页
  有 3 个无 `/BBox` 的 form 装着画 Figure 5 的 51 条 path，若在此处继承空裁剪，实测该页 pathBoxes 211 → 160、
  区域 2 → 1、整篇 18 → 17，Figure 5 被整幅删掉。
- 图元记录前一律过裁剪：完全在外 → `skipped` 记 `outside-clip`（图元丢弃）；部分在外 → 夹取到裁剪框。
  `diagnostics.pathBoxCount` 只计裁剪后保留的 path；新增 `diagnostics.clippedCount` 统计被裁剪删掉或缩小的图元数，
  使调查能分辨"外框贴合"是算出来的还是碰巧。
- `/Group`（`OPS.beginGroup`）引起的裁剪本轮不做：两夹具实测无影响，且需要新的运算符码映射。

### 修复前后对照（CSS rect = [left, top, right, bottom]）

| 页 | 修复前 | 修复后 |
|---|---|---|
| Flash 8（Figure 6） | `[14.32,72.00,286.88,169.12]` ratio 0.0546 | `[58.76,72.00,286.88,169.12]` ratio 0.0457（左缘 +44.44 pt，其余三边不动；该页 `clippedCount` 16：3 条 path 整条丢弃，13 条夹取；pathBoxes 71 → 68） |
| Flash 1（Figure 1） | `[317.88,239.28,558.00,350.59]` ratio 0.0551 | `[317.88,252.00,558.00,350.59]` ratio 0.0488（顶部 930×616 子图被所在 form 的 `/BBox` 切掉 12.72 pt） |
| PipeBWrite 13（Figure 15） | `[54.00,72.00,555.52,157.84]` ratio 0.0888 | `[54.00,72.00,555.52,157.05]` ratio 0.088（底缘 −0.79 pt，`clippedCount` 2） |
| PipeBWrite 7（Figure 5/6） | 两区，Figure 5 左缘 57.46 | 不变（3 个无 `/BBox` form 原样继承，该页 `clippedCount` 0） |
| Flash 5 | rect 不变 | rect 不变（`clippedCount` 1，夹取处不影响区域边界） |
| PipeBWrite 1 | 1 区 | rect 不变（`clippedCount` 3） |

整篇数量不变：Flash 10 个接受区域，PipeBWrite 18 个（逐页 `[0,0,1,0,2,1,2,0,3,1,6,1,1,0,0,0]`）；
`clippedCount` 合计 Flash 18（第 1/5/8 页 1/1/16）、PipeBWrite 5（第 1/13 页 3/2）。
`reports/flash-detection.json`（`scripts/survey_pdf.mjs` 重写）与 `reports/A1-detection.json`（`npm test` 内的
调查 test 重写）均已更新，除上表数字外只差一处诊断字段：第 13 页 `kind` 由 `path+form` 变 `form+path`
（证据标签按首次出现顺序拼接，纯顺序变化，内容不变）。

### 两处对规则的扩展（记录）

- 裁剪同时作用于 Image XObject（原规则只提 path）：第 1 页超出的那一行是图片而非矢量，不裁图片就拿不到
  顶部 252 的目标值。
- 整个 form 落在父裁剪框之外时，该 form 自身记 `outside-clip` 不入 `placements`，其子图元仍以该 form 自己的
  外框为裁剪框（保持 `null`/矩形两态，不引入第三态），代价是孙辈不再同时受祖父约束。

### 测试

全量 `npm test` 294/294 通过（285 → 294，+9；53 suites）：`placements.test.mjs` 新 suite
「placements: form /BBox clipping」6 test（path 完全在外记 `outside-clip`、path 部分在外被夹取、嵌套 form
裁剪复合且 form 结束后裁剪消失、无 `/BBox` form 继承父裁剪框、`/BBox` 为 `[0 0 0 0]` 视作无裁剪、
Image 一并裁剪并计入 `clippedCount`）；`flash-detect.test.mjs` +1（第 8 页左缘落在 58–60 且其余三边不变），
第 1 页 test 由旧的 `top <= 241` 改写为 `|top − 252| <= 0.5`（旧断言在修复前也不精确，新值为 MuPDF 真值裁剪边界）；
`fixture-detect.test.mjs` +2（第 7 页无 `/BBox` form 守卫、第 13 页底部 `|bottom − 157.05| <= 0.5`）。
`src/core/geom.js` 的 `intersectRects` 复用，未改。

### 遗留限制增补（待用户实测判断）

- 图元被夹取后，区域某一边可能恰好等于 `/BBox` 边：若该 form 的 `/BBox` 本身比可见墨迹大，这一边仍会偏大
  （裁剪只保证不小于渲染器给出的边界，不保证贴紧墨迹）。
- `/Group` 的 `S`（隔离混合模式）与组裁剪未处理；两夹具实测中性，其它文档若出现"区域比可见内容大"可从此处查。
- 裁剪框只由 `/BBox` 与 CTM 得出，不考虑路径自身的裁剪路径（`W`/`W*` + `n`）：pdf.js 把这类裁剪路径的
  外框也放进 `constructPath` 的 `minMax`，本轮未区分。

### 构建产物

- `package.json` 与 `manifest.json` 同为 0.1.20；`build/` 与 `dist/` 由 `npm run build` 重新生成，未手改。
- 本机仍无 Zotero 7，第 1–7 项真机验收不变，另加：Flash-Level 论文第 8 页 Figure 6 与第 1 页 Figure 1、
  PipeBWrite 第 13 页 Figure 15 的高亮是否贴边，待用户回填。

## 第 21 轮：第三个夹具（Borges 论文）— 画到页外的矢量框把两幅图粘成一团 — v0.1.21

### 新夹具与症状

加入第三个 PDF 夹具 `Borges_ A Low-Latency Distributed Shared Log on a CXL Memory_SSD Hybrid.pdf`
（仓库根目录；18 页 IEEE 双栏，无 `/Figure` 结构标签，插图全部由内联矢量 path 绘制）。改动前的基线调查
`reports/borges-survey.json`（`scripts/survey_pdf.mjs` 生成）：18 页识别出 14 条图注、7 个接受区域，
第 12 页一幅图都没有——该页 72 条 path 聚成 1 簇，用户空间外框 `[54.00, −13846.29, 558.00, 720.00]`
（面积比 15.15）按 `page-sized` 丢弃，该页 7 条图注 Figure 6–12 全部 uncovered。第 13 页正常（两区）。

### 根因（两处叠加，缺一不可）

1. 该页有 15 条退化 path：`h ≈ 14455 pt`、`w ≈ 11.4 pt`、y0 = −13846.29，只有 4.2 % 的自身面积落在页内，
   却把上下两带图钉在一起（未过滤时整簇面积比 15.15，被 `page-sized` 丢弃）。
2. 两带之间只有 13.19 pt（下带顶 644.27 / 上带底 631.08，用户空间），小于路径合并容差 18.02 pt
   （`pathMergeGapDiagonalRatio` 0.018 × 页面对角线 1001.39），因此删掉页外框之后两带仍会重新粘成一簇。

### 规则一：画在页外的 path 框不参与聚类（`mergePathPlacements`）

- 仅作用 `kind === "path"`（Image / Form 完全不变）：可见面积 ÷ 自身面积 < `pathMinVisibleAreaRatio` = 0.25
  时整条丢弃，并计入新诊断 `diagnostics.pathBoxesOffPage`。
- 阈值两侧余量（三夹具实测）：被丢弃者最大可见比 0.042（约 6 倍余量），被保留者最低 1.0——除第 12 页那 15 条外，
  三夹具没有任何 path 框部分出页（4 倍余量）。
- 丢弃而非裁剪到页边：裁剪后该簇面积比 0.748，仍会盖住两带之间的正文；保留框也不夹取，
  y0 = −40 的出血框照旧把联合边拖到 −40（`detector.test.mjs` 有守卫）。

### 规则二：图注行埋在簇内 → 沿该行切开（`splitAtInteriorCaptions`）

- 合格行（`findInteriorCaptionRows`，已导出供 test 直接断言）：图注行在簇的垂直内部——`row[1] > 簇底 + 12` 且
  `row[3] < 簇顶 − 12`（`maxCaptionOverlapPt`，与 `linkCaption` 容忍图注 bbox 侵入的容差同源）——且水平重叠
  ≥ `minCaptionOverlapRatio` = 0.3 × min(行宽, 簇宽)（同一个常量，不新设阈值）。第 12 页两条图注 slab
  分别在 y 634.67–644.63（Figure 6–9）与 544.82–554.78（Figure 10–12）。
- 选行：先切离簇垂直中心最近的一条，其余行由同一循环在新带上继续发现；迭代上限复用 `pathMergeMaxPasses` = 30；
  无合格行时整段为 no-op。
- 分区：成员按该行 y slab 分下/上两带，跨行的成员归"露出较多"的一侧（平手归上带），一个成员都不丢。
- 每条带用**同一个 18.02 pt 容差**重跑 `mergePass` 直到收敛。此处必须迭代：跨 slab 的链断开后，
  第 12 页下带单轮只收敛到 3 个重叠分组（border 会偏），迭代后才是 1 个。
- 反丢图守卫：任一带 0 成员、或高度 < `minSidePt` = 24、或既无图注链接又不过 `pathAnchoredAreaRatio` = 0.015
  → 整次切分作废，原簇整条保留（宁可不切，不产生空白区域或丢图元）。

### 修复前后对照（CSS rect = [left, top, right, bottom]）

| 页 | 修复前 | 修复后 |
|---|---|---|
| Borges 12 | 1 簇 / 0 区域，簇框用户空间 `[54.00,−13846.29,558.00,720.00]` ratio 15.15 → `page-sized`；uncovered [6,7,8,9,10,11,12] | 2 簇 / 2 区域：`[54.00,72.00,557.99,147.73]` cap 6 conf 0.90 ratio 0.0787（用户空间 `[54,644.3,558,720]`）、`[54.00,160.92,558.00,237.58]` cap 10 conf 0.90 ratio 0.0797（用户空间 `[54,554.4,558,631.1]`）；`pathBoxesOffPage` 15、`pathClusterSplits` 1；uncovered [7,8,9,11,12]（同组子图注不单独成区） |
| Borges 整篇 | 7 个接受区域 | 9 个（逐页 `[0,1,1,0,1,1,0,1,0,0,0,2,2,0,0,0,0,0]`，仅第 12 页变化） |
| Borges 13 | 两区 `[54.00,72.00,294.05,127.62]` cap 13 / `[317.96,72.00,558.00,166.15]` cap 14，conf 0.90 | 不变（off 0 / splits 0，37 form + 51 path 无一被丢弃） |
| Flash（18 页） | 10 个接受区域 | 逐页 rect / conf / pageAreaRatio 与 `reports/flash-detection.json` 全等；off 0、splits 0 |
| PipeBWrite（16 页） | 18 个接受区域，逐页 `[0,0,1,0,2,1,2,0,3,1,6,1,1,0,0,0]` | 逐个 rect 全等（`reports/A1-detection.json` 重写后与修复前逐字节一致）；off 0、splits 0 |

补充实测：单独关掉规则一（阈值置 0）时，规则二仍能切出同样两条带，但 `pathClusterSplits` 变 2 且留下一个
`page-sized` 残簇；两条规则同时生效才是 off 15 / splits 1 且无残簇。

### 测试

全量 `npm test` 319/319 通过（294 → 319，+25；53 → 55 suites）：

- `detector.test.mjs` 新 suite「detector: off-page path boxes and interior-caption splits」8 test：页外框丢弃并计数
  （第 12 页几何 11.4 × 14455）、可见比恰为 0.25 保留 / 略低即丢、保留的出血框不被夹到页边、13.2 pt 粘连 + 行内图注
  → 两带各自被接受（conf ≥ 0.85）、2.3 / 4.6 pt 边缘侵入不成行（`findInteriorCaptionRows` 返回 `[]`）、
  4 pt 细带触发反丢图守卫（整簇保留、区域 rect 不变）、水平重叠 0.227 < 0.3 不切、跨行成员归露出较多一侧且不丢成员。
- 新文件 `tests/js/borges-detect.test.mjs` 11 test：14 条图注、逐页接受数、第 12 页 off = 15 / clusters = 2 /
  splits = 1、两条带 rect（CSS 与用户空间各一份）与 conf、区域内不含任何图注框且切分后已无合格行、
  该页 16 条小 form 仍只按 `below-min-area` 拒绝、第 13 页两区逐项全等、除第 12 页外两条规则均 no-op，
  并写出基线报告 `reports/borges-detection.json`（新增 `pathBoxesOffPage` / `pathClusterSplits` 两项诊断）。
- `flash-detect.test.mjs` +3、`fixture-detect.test.mjs` +3：逐页 `pathBoxesOffPage` / `pathClusterSplits` 为 0、
  全部接受区域 rect 与上表 pin 值逐个全等、任何接受区域内没有图注行。两份既有报告的对象字段未增未删，
  故 `reports/A1-detection.json` 与 `reports/flash-detection.json` 无 diff。

### 遗留限制增补（待用户实测判断）

- 规则二只在图注行"埋在簇内"时才切：两幅纯矢量图若上下堆叠而中间没有图注行，仍粘成一簇（保守的合并型假阴性，
  区域偏大而非偏小）。
- 跨 slab 的成员整块归一侧：若一条 path 的两半分属上下两幅图（本夹具未出现），切分后它只撑大其中一带。
- 规则一只按自身面积比整条丢弃，不做"按可见部分裁剪"：真有 75 % 以上画在页外的出血插图时，本轮会把它的框整个去掉，
  而不是留下页内那一半。
- 反丢图守卫依赖 `linkCaption` 与 `pathAnchoredAreaRatio`：两带都取不到图注锚定且面积不过门时，切分会被作废。

### 构建产物

- `package.json` 与 `manifest.json` 同为 0.1.21；`npm run build` → `dist/figure-color-preservation-0.1.21.xpi`
  （37,937 字节，3 条目：`manifest.json` / `bootstrap.js` / `content/index.js`）；`build/` 与 `dist/` 重新生成，未手改。
- 本机仍无 Zotero 7，第 1–7 项真机验收不变，另加：Borges 论文第 12 页 Figure 6–9 与 Figure 10–12 两组是否各自
  高亮为独立区域、第 13 页两图是否不变，待用户回填。

## 第 22 轮：第四个夹具（FluidKV 论文）— 出血画框与图上文字决定不了边界 — v0.1.22

### 新夹具与症状

加入第四个 PDF 夹具 `FluidKV_ Seamlessly Bridging the Gap between Indexing Performance and Memory-Footprint on Ultra-Fast Storage.pdf`（仓库根目录；14 页 ACM 双栏，无 `/Figure` 结构标签，插图是 clip-path 画框包住内联矢量画或数字表格）。改动前的基线调查 `reports/fluidkv-survey.json`：18 条图注、14 个接受区域，逐页 `[0,1,3,2,1,0,0,0,2,2,3,0,0,0]`。

- 第 6 页 Figure 10 整幅丢失：唯一簇 `below-confidence-threshold`，用户空间 `[210.40, 473.80, 800.10, 805.50]`，面积比 0.65。
- 第 5 页两带只出 1 个（Figure 9，conf 0.85）；Figure 7 所在簇用户空间 `[-43.36, 488.50, 835.01, 807.89]`，面积比 0.97，被拒。
- 第 2 页 Figure 1 只框出右下碎片（CSS `[346.83, 85.00, 548.97, 123.18]`，conf 0.75），同簇其余部分用户空间到 x 976。
- 第 10 页 Figure 13 的六个面板全部无图注锚定（`below-confidence-threshold`）。
- 已接受的区域普遍比图上文字窄：9 个区域的左边界比旋转 90° 的轴标题窄 0.82–1.30 pt。

### 根因（三类，互不重叠）

1. **出血画框拽宽联合框**：第 2/5/6 页的画框画到裁切线外 17.2–364 pt。第 21 轮的规则一只管"绝大部分在页外"的框（可见比 < 0.25 整条丢弃），可见比合格的框仍拿**原始外框**参与聚类，于是页外那一截把联合框拽出页：第 5 页面积比 0.97（比正文还大）、第 6 页 0.65 → 两页的簇都掉到置信度线下；第 2 页只剩页内那一小块被接受。
2. **宽图注行的链接距离**：`maxCaptionGapPt` = 26 pt 是按"图注紧贴在图下方"标定的固定值。第 10 页六个 80.7 × 51.9 pt 面板与图注行 `[53.80, 616.50, 559.73, 625.46]` 之间实测 30.59 pt（面板行高 + 排版间距），超出 4.59 pt → 六个面板全无锚定；同 bbox 的 path 簇另有 aspect 9.69 > `maxAspect` 8 被拒。
3. **图内文字不参与边界**：区域只由"画出来的几何"决定，轴标题、刻度文字、表头文字一律落在框外。实测 Flash 第 8 页 "16K" 刻度距画框 3.41 pt，区域比标签窄 15.35 pt；FluidKV 有 9 个区域被旋转轴标题撑出 0.82–1.30 pt 缺口。

### 规则一（扩）：可见比合格的 path 框也先裁到页边再聚类（`mergePathPlacements`）

- 丢弃判据不动（可见面积 ÷ 自身面积 < `pathMinVisibleAreaRatio` = 0.25 时整条丢弃，`pathBoxesOffPage` 只统计这一种丢弃）；活下来的框改存 `intersectRects(rect, pageRect)`，聚类与合并都用裁剪后的框。
- 理由：读者看不到的墨迹不该决定高亮画在哪。第 5 页那簇裁后落在页内，配合规则二切成两带（面积比 0.2297 与 0.1959，各自 conf 0.80）；第 6 页裁后 0.65 → 0.1511 被接受。
- 与第 21 轮的分工实测：FluidKV 每页 `pathBoxesOffPage` 都是 0（出血框可见比全都合格，只是被裁边），"整条丢弃"那一半在四夹具里仍只在 Borges 第 12 页生效；Borges / Flash / PipeBWrite 的逐页 off 计数依旧全 0。

### 规则二（改）：跨图注行的成员按 slab 切开，不再整块归一侧（`splitMembersAtSlab`）

- 旧行为：跨 slab 的成员整块交给"露出较多"的一侧。实测 FluidKV 第 5 页留下一条 `[354.43, 580.00, 533.86, 601.10]`（用户空间）：一条从图注行上方 8 pt 就开始的画框被整块算给下带，把 21.1 pt 的细条撑成"图"。
- 新行为：跨 slab 的成员与 slab 求差，下/上两带各拿自己那一截；截得厚度 < `minSidePt` = 24 pt 的部分丢掉（那是图注行里的横线或下伸部，不是画）。成员仍不整条丢失，两带各用同一个 18.02 pt 容差重跑 `mergePass` 的逻辑不变。
- 对 Borges 第 12 页的连带影响（唯一一处既有报告 diff）：上带的用户空间顶边 644.27 → 644.63，即正好停在 Figure 6–9 图注行的上沿，不再多带 0.36 pt 的跨行画框（CSS bottom 147.73 → 147.37，`pageAreaRatio` 0.0787 → 0.0784）；区域数与其余 rect 全等。

### 规则三：宽图注行按自身宽度换取链接余量（`linkCaption`）

- 新容差 = `maxCaptionGapPt` + `captionGapWidthAllowanceFactor` × max(图注宽, 候选宽) ÷ 页宽；新常量 `captionGapWidthAllowanceFactor` = 6，`maxCaptionGapPt` 仍 26。
- 取 `max()` 而不是只看图注宽：第 10 页按图注宽 505.93（候选宽 506.65）算得 26 + 6 × 506.65 ÷ 612 = 30.96 pt，实测间距 30.59 pt，余 0.38 pt 通过。
- 归一化到页宽的原因：通栏图注（约 82 % 页宽）最多加 5 pt，跨栏的窄候选不会因此够过 25.42 pt 的中缝。
- `maxAspect` 保持 8：第 10 页那簇同 bbox 的 path 框（506.65 × 52.27，aspect 9.69）仍按 `extreme-aspect` 拒绝，Figure 13 由 form 簇 + 图注链接拿到（conf 0.85）。实测把 `maxAspect` 提到 12：FluidKV 第 11 页 Figure 16 与 17 之间那条宽扁簇（用户空间 `[56, 649.2, 566.8, 708.3]`）被接受，把两栏两图粘成一条通栏带，区域 3 → 2（17 → 16），Flash / Borges / PipeBWrite 区域数不变——放宽 aspect 换不到第 10 页，反而丢掉第 11 页的分栏。

### 规则四：接受区域横向吃掉属于自己的文字（`expandRegionsWithText`，新诊断 `textExpandedRegions`）

- 位置：`mergeRegions` / `absorbAreaRejected` 之后、盖 `pageAreaRatio` 之前。管线改动：`collectPageEvidence` 返回已过滤的 `textItems`，`detectPageRegions` 透传（缺省时整条规则 no-op），`src/zotero/overlay.js` 不变。
- 只横向生长：垂直带由画与规则二决定。实测若允许纵向，第 3 页 Figure 2 带会顺着标签的 ascender 从 y 708.31 一路长到 792。
- 四条准入：(a) 文字基线严格落在区域垂直带内；(b) 与竖直边缘的距离 ≤ `textExpansionPt` = 24 pt（实测标签最大跨距 3.41 pt，FluidKV 第 2 页最近的正文 run 30.60 pt，双栏中缝 25.42 pt → 够到标签而够不到另一栏）；(c) run 中心与区域中心在页面竖直中线同侧；(d) 与该区域已绑定的图注框不相交。
- 其余护栏：空白 run（`item.str` 全是空格）跳过——pdf.js 会按整词字距给出空格框，Borges 第 13 页图例行尾那条越出文字列 2.6 pt；生长后面积比超过 `maxAreaRatio` 即停；每侧累计不超过 24 pt（否则 PipeBWrite 第 3 页会链到页边 x 612，多长 54 pt 吃掉 ACM 版权竖排戳）；宽度增益 < 0.5 pt 不算；每个 run 只用一次。
- 实测效果（与 `textExpansionPt: 0` 的控制跑逐页对比）：FluidKV 长 9 个区域（第 3 页 2、第 4 页 1、第 9 页 1、第 10 页 2、第 11 页 3，左边界各 0.82–1.30 pt，全是旋转轴标题）；Flash 长 2 个（第 8 页 "16K" 跨距 3.41 → 长 15.35 pt，第 10 页 "50" 跨距 3.31 → 长 13.92 pt）；Borges 18 页与 PipeBWrite 16 页均为 0。

### 修复前后对照（CSS rect = [left, top, right, bottom]）

| 页 | 修复前 | 修复后 |
|---|---|---|
| FluidKV 2 | 1 区 `[346.83, 85.00, 548.97, 123.18]` conf 0.75 ratio 0.0159；同簇其余部分用户空间 `[270.90, 431.10, 976.00, 787.80]`（出页 364 pt）`below-confidence-threshold` | 1 区 `[270.89, 4.18, 612.00, 146.61]` cap 1 conf 0.80 ratio 0.1002；`pathClusterSplits` 1 |
| FluidKV 5 | 1 区（cap 9）`[340.76, 250.60, 547.53, 324.48]` conf 0.85；cap 7 簇 ratio 0.97 被拒 | 2 区 `[0.00, 0.00, 612.00, 181.89]` cap 7 与 `[0.00, 190.86, 612.00, 346.04]` cap 9，conf 0.80，ratio 0.2297 / 0.1959；`splits` 2 |
| FluidKV 6 | 0 区（唯一簇 ratio 0.65 被拒） | 1 区 `[210.41, 0.00, 612.00, 182.31]` cap 10 conf 0.80 ratio 0.1511；`splits` 1 |
| FluidKV 10 | 2 区（cap 14/15）；Figure 13 六个面板全无锚定 | 3 区：新增 cap 13 `[56.04, 83.68, 562.69, 135.95]` conf 0.85 ratio 0.0546；cap 14/15 左边界 56.04 → 55.03、317.96 → 316.93（规则四） |
| FluidKV 整篇 | 14 区，逐页 `[0,1,3,2,1,0,0,0,2,2,3,0,0,0]`；18 条图注 | 17 区，逐页 `[0,1,3,2,2,1,0,0,2,3,3,0,0,0]`；规则四另长 9 处边界，全部区域都在页内 |
| Flash（18 页） | 10 区 | 仍 10 区，仅第 8 页 cap 6 左边 58.76 → 43.41（长 15.35 pt，"16K"）、第 10 页 cap 9 左边 317.88 → 303.96（长 13.92 pt，"50"）；`reports/flash-detection.json` 已按这两处更新（该文件不是 `npm test` 重写的产物） |
| Borges（18 页） | 9 区，第 12 页上带 CSS `[54.00, 72.00, 557.99, 147.73]` ratio 0.0787 | 9 区，同带上带顶边停在图注行上沿：CSS bottom 147.73 → 147.37，ratio 0.0787 → 0.0784（规则二）；`textExpandedRegions` 全 0 |
| PipeBWrite（16 页） | 18 区，逐页 `[0,0,1,0,2,1,2,0,3,1,6,1,1,0,0,0]` | 逐个 rect 全等（`reports/A1-detection.json` 重写后与修复前逐字节一致）；off / splits / 文字生长全 0 |

### 测试

全量 `npm test` 346/346 通过（319 → 346；55 → 58 suites）：

- 新文件 `tests/js/fluidkv-detect.test.mjs` 12 test：18 条图注、七个有图页共 17 个区域、所有区域在页内、第 2/5/6 页出血裁剪后的 rect、第 5 页沿图注行切成两带（`splits` 2）且只剩一条内部图注行 `[317.96, 571.01, 559.80, 579.98]`（Figure 8 未被锚定）、第 10 页 30.59 pt 链接成功、`maxAspect` 仍 8 且该页恰一条 `extreme-aspect` 拒绝、逐页生长计数 `[0,0,2,1,0,0,0,0,1,2,3,0,0,0]`、`textExpansionPt: 0` 控制跑除这两处生长外一切不变、六个无图页仍空，写出基线报告 `reports/fluidkv-detection.json`。
- `detector.test.mjs` +10：跨行成员裁到两侧（含"细条丢掉、不留下 21 pt 假图"）、链接余量按页宽归一（505.9 pt 宽图注 30.59 pt 通过 / 窄图注 29.61 pt 不通过 / 余量取自图注行而非子 form）、文字生长 8 test（20 pt 拉入、26 pt 不拉、基线须在带内、不吃已绑图注、跨半页不拉、空格 run 忽略、无 textItems 时 no-op、链式生长在原边界 ±24 pt 内停住）。
- `flash-detect.test.mjs`：第 8 页裁剪 + 生长边界、pin 更新为 `[8,"6",[43.41,72,286.88,169.12]]` 与 `[10,"9",[303.96,143.23,558,277.86]]`、新 test「只长这两幅刻度文字是文本的图」断言逐页生长恰为 `["page 8 grew 1","page 10 grew 1"]`。
- `borges-detect.test.mjs` / `fixture-detect.test.mjs`：把"三条边界规则在测量页以外是 no-op"扩成含文字生长——Borges 18 页与 PipeBWrite 16 页的 `textExpandedRegions` 必须全 0，PipeBWrite 的 18 个 pin rect 不变。

### 遗留限制增补（待用户实测判断）

- FluidKV 第 5 页 Figure 8 仍未单独成区：两带切开后它的图注行落在下带内部，按"同组子图注不单独成区"报告为 cap 7 / cap 9 两个区域。（第 23 轮检测侧收紧已解决：三张图各自成区，`uncoveredCaptions` 为空。）
- 规则四只横向：文字高出画框（很长的旋转轴标题、画框上方的表头）时纵向缺口仍在；实测放开纵向会长到页边，需要另一套"这段文字属于这张图"的判据。
- `captionGapWidthAllowanceFactor` 是单点标定（第 10 页只余 0.38 pt）：面板行间距再大一些（比例超过约 6 pt / 页宽）仍会漏图注。
- 规则一裁到页边后，真跨页出血的插图会把高亮顶到页边：页外那一截不可见也不留白，但页边那侧的留白会被算进区域。
- 规则四依赖 pdf.js 的 `str` 与 `transform`：调用方只给 rect 时（`{rect, baselineY}`）空白 run 守卫失效，需要调用方自己过滤。

### 构建产物

- `package.json` 与 `manifest.json` 同为 0.1.22；`npm run build` → `dist/figure-color-preservation-0.1.22.xpi`（39,423 字节，3 条目：`manifest.json` 448 / `bootstrap.js` 6,117 / `content/index.js` 152,109）；`build/` 与 `dist/` 重新生成，未手改。
- 本机仍无 Zotero 7，第 1–7 项真机验收不变，另加：FluidKV 第 2 页 Figure 1 是否整框、第 5 页两带是否分开、第 6 页 Figure 10 是否出现、第 10 页 Figure 13 六面板是否成区、各图左侧轴标题是否被包住；Borges 第 12 页上带上沿改停在图注行上沿（0.36 pt）是否影响观感，待用户回填。

## 第 23 轮：真机「新开什么都不画 / 关开画错位」— zotero 层四项修复 — v0.1.23

### 症状（真机 Zotero 10.0.8）

- S1：新开一个 PDF，高亮什么都不画；同一个文件关掉重开有时又是好的。诊断页在这类标签里报 `eventBus: false`，`ready` 要么 false（`ready-timeout`），要么 true 但 `settledRepaints: 0`。
- S2：工具栏按钮关掉再打开，高亮出现但位置错（整体偏移），随手缩放一下才对。
- 与第 20–22 轮无关：那些是检测层的框对不对，本轮是 zotero 层画不画、何时画。

### 真机探针证据（v0.1.22，全新启动 Zotero，reader `item:316`）

- 日志有 `no-event-bus:item:316 ... @ bindEvents`，诊断页 `attempts: 3`：bus 在头三个 pass 都还没解析出来，正是下面第 1 条根因的形状。
- 同一会话稍后转成 `eventBus: true`、`ready: true`，第 5 页画上、`overlays: 2`：订阅最终是绑上了，但页面早已渲染完毕，`pagerendered` 那串事件在订阅之前就跑完了 —— 于是"画不画"取决于文档事件与 `bindEvents()` 谁先到，即启动时序彩票，与"同一个文件关掉重开有时是好的"一致。
- 同一次启动的 `docId` 始终是打印指纹形式（`fcp:<fingerprint>`），WeakMap 兜底键没有出现过，所以第 2 条根因的抖动在这次启动里没有重现：F3 是按规则实现的护栏，等真出现 Xrays 挡住两个打印字段的机器再验。
- 探针没有改变 F1–F4 的范围，只是把 S1 定性为"订阅窗口错过 + 没有补挂点"，而非检测或绘制本身的错。

### 根因（四处，全在 `src/zotero/`，检测层无关）

1. `recoveryPass()` 只问"有没有 pdfDocument"，没有 `eventBus` 也照样 `ready = true` 并结束循环。没有 bus 就没有 `pagerendered` 订阅，而这是 pdf.js 建好一页的唯一通知：这一 pass 之后才建起来的页面再没有画家 → S1。
2. 兜底 docId 抖动。Xrays 挡住 `fingerprints` 与 `loadingTask.docId` 时 `resolveDocumentId()` 落到 WeakMap，读一次换一个 wrapper 对象就 mint 一个新的 `fcp:doc-N`；旧代码把新串当成"换了文档"，于是每个 document 事件都 `invalidateDocument` + `detachAll`，把刚挂上的画布当场拆掉。
3. 全篇重绘的补挂点不全：`start()`、文档切换、`setEnabled(true)` 三处挂了 settled 检查，而 `start()` 那次重绘跑在 pdf.js 建页之前（页面视图还是空的），此后没有任何一处会再补一次全篇 pass。
4. `pagerendered` 那条逐页路径无条件 `scheduleSettledCheck()`，连一页都没画成（`pdfPage` / `div` / `viewport` 还没到位、功能关闭）也照挂。加载期间事件一串到达时，同一个 timer 被反复重挂，1.5 s 的落地时间一路往后推，真正需要它的那一次（画在尚未排完版的视口上的页面）反而被推到整串事件之后 → S2 的错位窗口。

### 四项修复（`src/zotero/reader-session.js` + `src/zotero/overlay.js`）

1. **就绪连 eventBus 一起算**（`recoveryPass()`）：文档在手但 bus 未解析时进入等待态——`syncDocumentId()`、`overlayCount() === 0` 时补一次重绘、`notify()`，返回 false 让循环继续，且不打 `recovered`；`ready = true`、全篇重绘、`recovered` 警告与结束循环全都等到 `bindEvents()` 真绑上为止。快预算（`RECOVERY_MAX_PASSES`）与慢心跳不变，循环仍不会空转。
2. **`catchUpPaint(trigger)`**：每个触发点最多一次额外全篇 pass，且只在 `overlayCount() === 0` 时跑。挂在 `start()` 重绘之后（`"start"`）与 `queueDocumentCheck()` 中 id 未变那一支（`"pagesloaded"`，恢复循环自己起的首轮扫描也走这里，所以无 bus 的会话同样有补挂点）；门是 `!destroyed && enabled && ready`，自己不起 timer。健康会话付不出代价：`repaintAttached()` 会 await 自己的 job，返回时页面已挂上，`overlayCount() > 0` 直接 no-op。
3. **docId 只认打印身份**：`overlay.js` 新增 `isProvisionalDocumentId()`（`/^fcp:doc-\d+$/`），会话新增 `applyDocumentId()`。打印 → 另一个打印才是真切换（invalidate + detach + 重绘 + settled + 自续一次）；兜底 → 打印是静默收养（换 key、置 `documentIdAdopted`，不 invalidate、不 detach、不重绘，画布与缓存都留着）；打印永不退回兜底（`syncDocumentId()` 同一护栏）；兜底 → 另一个兜底保持当前 key，抖动止住。
4. **画成了才挂 settled**（`onPageRenderedEvent`）：`attachPageNumber()` 改为把 `attachPageView()` 的 job 返回出来，只有真起了画才 `scheduleSettledCheck()`。timer 的替换语义不变，所以仍不可能叠 pass；区别是加载期间那些什么都没画的触发点不再把落地时间推后。

### 检测侧收紧（同轮追加）：出血画框是证据，不是范围

同轮在 `src/core/` 追加一条检测规则， FluidKV 第 2/5/6 页的框仍画得过宽。改动只在 `mergePathPlacements` 与 `detector-options.js`。

- 根因：插图被一个 clip-path 画框（`re`）整页宽地画出来，画框按原来的规则参与聚类，于是它既是证据又是范围。三处后果：第 2 页 Figure 1 的框出页 364 pt，裁到页边后把区域顶成 341 pt 宽 ratio 0.1002 的通栏带；第 5 页一个 150 pt 高的框把三张图粘成一簇（ratio 0.97），并跨过 Figure 7 与 Figure 8 之间 28.29 pt 的中缝，切开后只剩两条 612 pt 通栏带，Figure 8 无自己的区域；第 6 页唯一的 path 簇就是这个框（ratio 0.65），裁到页边后仍是一整页宽带。
- 判据（只看 RAW 裁页前的 rect、只作用于 path 落点）：`area(raw) ≥ pathFullBleedAreaRatio × pageArea` 且 `width(raw) ≥ pathFullBleedWidthRatio × pageWidth`。新选项 `pathFullBleedAreaRatio` = 0.25、`pathFullBleedWidthRatio` = 0.8。RAW 而不是裁页后的 rect，是因为真出血的框大半画在页外，裁完就看不出它是框。
- 四个 PDF 全量 path 落点扫描标定：判为画框的恰 6 个，全在 FluidKV 第 2 页（2 个）、第 5 页（3 个）、第 6 页（1 个），最小面积比 0.3239、最小宽度比 0.8633；`Borges_ … Hybrid.pdf` 第 6 页 `[57.8, 516.2, 551.65, 720]`（面积比 0.2077、宽度比 0.807）与 Flash 第 12 页 `[54, 548.36, 557.93, 720]`（0.1785 / 0.8234）是真正的插图，卡在 0.25 之下——0.25 就落在 0.2077 与 0.3239 之间，两侧各余 0.042 与 0.074；面积够 0.25 而宽度不足 0.8 的 15 个是 Borges 第 12 页那些 14455 pt 高的离页框（最大宽度比 0.0186），宽度这条把它们留在画作一类，仍由可见比规则丢掉；PipeBWrite 一个画框都没有。
- 处理：画框不进 `mergePass`（既不撑并集也不搭桥，跨栏的那 28.29 pt 中缝不再被框填上），画作按 18.02 pt 容差自己聚；`splitAtInteriorCaptions` 之后把画框作为证据重挂——落在某个存活簇的容差内就算属于它、不增加范围，直接丢掉；一个簇都没匹配上的（框内的画是纯矢量填充或被可见比丢掉）就自己成一个框，仍可被图注锚定。`maxPathBoxesPerPage` 的截断与 `pathBoxCount` 改成只数发出来的框。`mergePass` 本身与 18.02 pt 容差未动。

修复前后对照（CSS rect = [left, top, right, bottom]，取自 `reports/fluidkv-detection.json`）：

| 页 | 收紧前 | 收紧后 |
|---|---|---|
| FluidKV 2 | 1 区 `[270.89, 4.18, 612.00, 146.61]` cap 1 conf 0.80 ratio 0.1002；`pathBoxCount` 2、`splits` 1 | 1 区 `[326.63, 85.00, 549.64, 123.18]` cap 1 conf 0.75 ratio 0.0176（画作 + 左侧 20.20 pt 旋转轴标题/图例）；`pathBoxCount` 1、`splits` 0 |
| FluidKV 5 | 2 区 `[0.00, 0.00, 612.00, 181.89]` cap 7 与 `[0.00, 190.86, 612.00, 346.04]` cap 9，conf 0.80，ratio 0.2297 / 0.1959；`splits` 2，`uncoveredCaptions` `["8"]` | 3 区 `[55.10, 84.98, 293.67, 170.58]` cap 7 conf 0.90、`[321.96, 84.24, 549.80, 190.34]` cap 8 conf 0.85、`[328.32, 250.60, 547.53, 324.48]` cap 9 conf 0.85；`splits` 0，`uncoveredCaptions` `[]`，两栏中缝 28.29 pt 复原 |
| FluidKV 6 | 1 区 `[210.41, 0.00, 612.00, 182.31]` cap 10 conf 0.80 ratio 0.1511；`pathBoxCount` 2、`splits` 1 | 1 区 `[364.13, 91.94, 552.47, 170.48]` cap 10 conf 0.90 ratio 0.0305；`pathBoxCount` 1、`splits` 0 |
| FluidKV 9 / 10 | cap 12 `[56.04, 83.68, 556.70, 173.84]`（`splits` 1）、cap 13 `[56.04, 83.68, 562.69, 135.95]` | 逐个 rect 全等；第 9 页仍 `splits` 1（那是真正的两图接缝） |
| FluidKV 整篇 | 17 区，逐页 `[0,1,3,2,2,1,0,0,2,3,3,0,0,0]`；14 条拒绝（含 3 条 `dropped-row`）；文字生长 9 处 `[0,0,2,1,0,0,0,0,1,2,3,0,0,0]` | 18 区，逐页 `[0,1,3,2,3,1,0,0,2,3,3,0,0,0]`；11 条拒绝（3 条 `dropped-row` 全消）；生长 11 处 `[0,1,2,1,1,0,0,0,1,2,3,0,0,0]` |
| Flash / Borges / PipeBWrite | 10 / 9 / 18 区 | 零回归：把 `pathFullBleedAreaRatio` 设成 `Infinity`（画框集为空 = 改动前的代码）与新码各跑一遍，四个 PDF 的区域集合与全部诊断逐字节相同（拒绝 32 / 58 / 28），`reports/flash-detection.json`、`borges-detection.json`、`A1-detection.json` diff 干净 |

- 生长侧数字按新码重测：标签最大跨距 20.20 pt（第 2 页 "DRAM" / "PM" 图例，最近一条边缘离画作 1.03 pt），第 5 页 Figure 9 的 y 轴刻度 12.44 pt；把 `textExpansionPt` 扫到 26 / 30 / 40 pt，FluidKV 再也长不出别的东西，故 24 pt 不动。第 6 页长 0 处：垂直带内的 run 本就在框内，旁边的 "Write-intensive mode" 跨距 41.16 pt，超出上限。
- 第 22 轮遗留限制第一条（FluidKV 第 5 页 Figure 8 未单独成区）由本节关闭。

### 不动的东西（invariants）

- zotero 四项修复本身 `src/core/` 零改动：检测规则、阈值不变；同轮追加的检测侧收紧只改 `mergePathPlacements` 与 `detector-options.js`（见上一节），`reports/*.json` 基线除 FluidKV 外全不变——`A1-detection.json`、`borges-detection.json` 被测试重写后与收紧前逐字节一致，`fluidkv-detection.json` 按新码重写。
- 会话健康时行为不变：等待态与 catch-up 都只在"一页都没画上"时才动手，docId 收养每个会话最多发生一次，settled 检查仍是同一 timer 的替换语义。
- `build/` 与 `dist/` 全部重新生成，未手改。

### 测试

全量 `npm test` 360/360 通过（346 → 355 → 360；58 → 60 → 61 suites）：

- `tests/js/reader-session.test.mjs` 新段 `reader session: fresh-open paint gaps`，7 test：does not declare readiness while the event bus is unresolved（文档在手也不算 ready，两个等待 pass 各补一次画并 `notify`，循环只留一个 timer，bus 到位那一 pass 才 ready 且绑上 `pagesloaded` 与 `pagerendered`）；warns about a missing bus once per realm instead of once per pass（`noBusWarned` 门，`releaseRealm()` 复位）；catches up once when nothing mounted, and not again when pages are painted；skips the catch-up while the feature is off or the session is gone；adopts a printed document id without invalidating or detaching；holds a provisional key that the WeakMap fallback re-mints；arms the settled check after a pagerendered paint。
- `tests/js/overlay.test.mjs` +2（`overlay: provisional document ids`）：兜底 key 判 provisional，而 fingerprints 与 loadingTask docId 判打印（`fcp:doc-1x` 要整串才算）；同一对象保持同一 key、新 wrapper mint 新 key、`resolveDocumentId(null)` 仍为 null。
- `tests/js/detector.test.mjs` +5（新段 `detector: full-bleed clip frames are evidence, never extent`）：全页宽画框不再把 312 pt 中缝两侧的两幅图粘成一条（收紧前 `[20, 592, 612, 760]` 通栏带且第二幅图无区域，收紧后两幅各自成区、区域宽度 ≤ 96 pt）；只有画框的一页仍出一个可锚定的框；0.0788 面积比 / 0.807 宽度比的短通栏带（Borges 第 12 页那类）仍算范围而不是框；0.2097 面积比 / 0.964 宽度比的画作仍算范围；0.346 面积比但只有 0.402 宽度比的半页高栏不算框。
- `tests/js/fluidkv-detect.test.mjs` 按新码改 5 处断言：标题与逐页计数改 18 区 `[0,1,3,2,3,1,0,0,2,3,3,0,0,0]`、第 2/5/6 页 rect、原「第 5 页沿图注行切成两带」换成「第 5 页是三张图而不是两条通栏带」（`splits` 0、`uncoveredCaptions` `[]`、中缝 28.29 pt、每区宽度 < 244.8 pt 即页宽的 40 %）、生长改 11 处并补第 2 页与第 5 页 Figure 9 两行。
- 既有的其余各条一条未改断言即通过，只有一处新增段的计数按实际路径写准（等待态每 pass 各补一次画，故总线出现那一 pass 前重绘为 3 次）。

### 遗留限制增补（待用户实测判断）

- 两个都拿不到打印身份的文档之间真"换文档"仍检测不到（兜底 key 之间不换 key）：此时只能靠工具栏关开或缩放触发重绘。
- docId 收养时 RegionCache 不搬 key（`RegionCache` 没有改名 API），兜底 key 下的条目留在 LRU 里直到被挤出；代价是命中率，不是正确性。
- `describeSession()` 未暴露 `documentIdAdopted`；若真机需要看收养有没有发生，再加一个字段即可。
- 本机仍无 Zotero 7，第 1–7 项真机验收不变，另加：新开 PDF 是否直接画上（不等缩放）、诊断页 `eventBus` 是否转 true、`settledRepaints` 在工具栏关开后是否 ≥ 1、恢复标签页在慢心跳下是否补画。
- 检测侧：画框判据只看尺寸，页中间的通栏真插图若同时满足面积 ≥ 0.25 与宽度 ≥ 0.8 也会被当画框而不撑范围（此时区域由框里的画作决定，四个夹具里最贴边的真插图是面积比 0.2077）。画框匹配不到任何簇时自己成区，所以框里只有文字（无画的表格框）会框出一块含正文的区域。
- 检测侧：第 6 页那类"画作已被画框完全包住"的图，区域收窄到画作后不再覆盖画框留白；真机若观感上希望连框一起盖，需要的是"画框也当范围"的另一套判据（例如仅在该页只有一簇时）。
- 本机仍无 Zotero 7，检测侧的视觉效果待真机回填：FluidKV 第 2 页是否只盖住表格与轴标题而不再吃掉左栏、第 5 页是否三张图分别成区、第 6 页 Figure 10 是否收窄、Borges 与 Flash 与 PipeBWrite 是否一切照旧。

### 构建产物

- `package.json` 与 `manifest.json` 同为 0.1.23；`npm run build` → `dist/figure-color-preservation-0.1.23.xpi`（41,438 字节，3 条目：`manifest.json` 448 / `bootstrap.js` 6,117 / `content/index.js` 158,484）；`build/` 与 `dist/` 重新生成，未手改。检测侧收紧后 xpi 由 40,746 涨到 41,438 字节（`content/index.js` 156,393 → 158,484），版本号不变。
## 第 24 轮：真机双页签「切页画错 / 关开画错」— zotero 层五处修复 — v0.1.24

### 症状（真机 Zotero 10.0.8，同一文档开两个读者页签）

前提：同一 PDF 在两个页签里各开一个 reader（真机为恢复标签页 + 新开的同一个文件）。

- T1：关掉一个页签再打开，高亮画错（该画的页没画 / 画在已作废的挂载点上）。处置：重开页签后正常。
- T2：切到另一个页签，画到错的画布上——可见文档里的画布 `offsetParent` 为 null、rect 为 0×0，看得见的那页反而没高亮。处置：切回来正常。
- T3：工具栏开关关掉再打开，画到错区域：FluidKV 第 6 页 Figure 10 拿到了 PipeBWrite 第 6 页的 rect（±1–3 pt）。处置：再开一次对上了。
- 与第 23 轮无关：那一轮是单页签的「画不画 / 何时画」，本轮是多个页签共存时「画在谁的画布、按谁的区域」。

### 真机探针证据（`probeAll`，v0.1.23）

- 两个会话报同一个文档身份：`item:317` 与 `item:308` 的 `docId` 都是 `fcp:3e708112401a3e23`；而只开一个文档时同一份 PDF 报 `fcp:bd8e2cda401a3e23`。同一份文档两种指纹、两个会话共用一个 key，区域缓存必然互相踩——T3 的形状。
- 探针只看得到「两个会话同一个 id」，看不出哪个 id 是对的：`fingerprints` 与 `loadingTask.docId` 在两个 realm 里返回同一对值，指向同一份 PDF，故打印身份本身可信，问题在 key 不带读者身份。
- 可见文档里 0×0 的画布说明：会话记着的画布已经不在活动文档的 DOM 树里，而旧代码只按「这个页号挂过没有」判断，不检查还在不在树上——T2 的形状。
- 切页签没有任何钩子被触发：`visibilitychange` 与 Zotero 的页签选中通知都没绑，选中页签变了也没有人重算 realm——T1/T2 都要等下一次随机事件才可能被纠正。

### 根因与五处修复

1. **挂载完整性**（`src/zotero/overlay.js`）：新增 `canvasConnected(canvas, host)`，`attach()` 的重挂循环改成「已挂载但掉出页面 DOM 就丢条目、重挂一次」，`lastPaintError` 记 `mount: host detached`；`ensureHostPositioning()` 返回布尔（detached 的 host 不做定位上下文），`paintRegions()` 在无几何错误时把它记成 `mount: host detached`。连通性未知（老 host 没有 `isConnected`）一律当「在」，避免测试替身误报。
2. **只数活着的覆盖层**（`src/zotero/reader-session.js`）：`overlayCount()` 只统计 `connected` 的画布（`overlay.js` 新增 `get connectedCount()` 与 `isMounted()`），所以「画过了」不再等于「看得见」。
3. **页签激活钩子**（`src/zotero/main.js` + `reader-session.js`）：`bindEvents()` 里绑 realm 的 `visibilitychange`，`main.js` 注册 Zotero Notifier 的 `tab` 观察（`addZoteroNotifier` / `removeZoteroNotifier`，`itemID` 匹配到会话就唤醒该会话，匹配不到就唤醒全部活会话），二者都走会话的 `onTabActivate()`：`queueDocumentCheck()` + `reevaluateRealm()`。`reevaluateRealm()` 只在 realm 真的换了（`realmId` 变化）时才重绑并记 `realmSwitches`，同一 realm 内切回来是 no-op，健康会话不付拆画布的代价。
4. **区域缓存带读者身份**（`src/core/cache.js` + `reader-session.js`）：新增导出 `scopedDocumentId(scope, documentId)`；会话新增 `cacheScope`（`item:<itemID>`）与 `cacheKey()`，所有读写缓存、`invalidateDocument` 都用这个 key，而 `session.documentId` 仍是打印原文（第 23 轮的打印/兜底规则不变）。同一份 PDF 的两个读者从此各算各的区域。
5. **桥按读者应答**（`src/zotero/main.js` 的 `VIEWER_BRIDGE_SRC`）：`Zotero_FigureColorPreservation_Bridge.handle(msg)` 不再用 `readers[0]`，而是在沙箱内用 `msg.tabID` 匹配 `viewer.activeTab`（缺失时用 `Zotero.Viewer.getTabID(viewer)` 或 `Zotero_Tabs.getSelected()` 推），匹配不到才退回第一个 reader；两处 `getTabID` 各自 try/catch。多页签时请求不再永远由第一个 reader 回答。

### 探针新增字段（`src/zotero/main.js` 的 `describeSession` / `probeAll`）

- `cacheKey`：缓存实际用的 key（`item:<id>|<docId>`），与 `docId` 并排看就能区分「指纹撞了」和「key 没带身份」。
- `realmId`：realm 指纹，取内层 window 的 pauli `__ID__`（形如 `iwin:<n>`），拿不到时用 `href:<href>@<route>`，都没有则 null。
- `freshDocId`：现场 `resolveDocumentId(session.currentPDFDocument())` 的值，用来和会话记着的 `docId` 对照（不等就说明 id 漂移）。
- `mountDetached`：该会话覆盖层里有几条已掉出页面 DOM（覆盖层没有 `isMounted` 时按「已挂载」算）。
- `probeAll()` 顶层新增 `docIdentityDistinct`：所有活会话的 `freshDocId` 是否互不相同（`new Set(fresh).size === fresh.length`）；少于两个可比较 id 时为 null。false 表示指纹碰撞或 realm 混用，本轮真机证据就是它。

### 不动的东西（invariants）

- `src/core/detector.js` 与 `detector-options.js` 零改动：检测规则、阈值不变，`reports/*.json` 八个文件在 `npm test` 后仍与基线逐字节相同（md5 校验通过）。`src/core/cache.js` 只加了一个纯函数 `scopedDocumentId`，`RegionCache.key` 与 LRU 行为不变。
- 健康的单页签会话行为不变：realm 未变时 `reevaluateRealm()` 不拆不挂，画布都连着时 `catchUpPaint()` 与 `overlayCount()` 都是 no-op，`visibilitychange` 在未绑 DOM 的替身上不报错。
- `build/` 与 `dist/` 全部重新生成，未手改。

### 测试

全量 `npm test` 377/377 通过（360 → 377；61 → 65 suites），新增 17 条：

- `tests/js/cache.test.mjs` +3（新段 `per-reader scope`）：`keeps two readers of one document id apart`（同一 `fcp:` id 加两个 scope 得到两个 key，都能独立存取）；`invalidates one reader without touching the other`；`leaves the key bare when there is no scope`（空 scope 原样返回，老 key 形状不变）。
- `tests/js/overlay.test.mjs` +4（新段 `overlay: mount integrity`）：`treats an unknown connectivity flag as connected`；`reports a detached host instead of a clean paint`（host 掉出文档时 `lastPaintError` 为 `mount: host detached` 且 `connectedCount` 为 0）；`re-mounts a canvas the viewer threw out and reports a clean paint`（画布被 viewer 摘掉后重挂到新 host，`connectedCount` 回到 1）；`refuses a host that left the document as a positioning context`。
- `tests/js/reader-session.test.mjs` +4：`keys the region cache by reader, not by document alone`（两个同指纹读者的 scoped key 不同，探测到的区域按 `item:<id>|fcp:` 记）；`wakes the reader behind the selected tab`；`keeps a connected overlay across an activation over the same realm`（同 realm 激活不拆画布、不增 `realmSwitches`）；`counts only the overlays that are still connected`。
- `tests/js/probe-all.test.mjs` +3（新段 `probeAll: per-reader identity`）：`keeps two readers of one fingerprint apart`（两个读者的 `docId` 同为 `fcp:seed`，`cacheKey` 各带自己的 `item:` 前缀，而 `docIdentityDistinct` 为 false——正是真机那一幕）；`reports the mount state of the overlay it probed`；`wakes the session behind the selected tab`。
- `tests/js/viewer-bridge.test.mjs` +3：`matches the tab id from Zotero.Viewer.getTabID when the record keeps none`；`answers for the right reader however many readers are open`；`survives a Viewer.getTabID that throws`（取不到 tab id 时退回第一个 reader，仍能应答）。

### 遗留限制增补（待用户实测判断）

- 指纹碰撞只是按读者遮住：`RegionCache` 的 key 带 `item:<id>`，但打印身份本身在两个 realm 里相同这件事没变，同一 itemID 的两个页签（真·同文档双开）仍共用一个 key——那时靠的是同一个区域集合，正确性不受影响。
- `realmId` 依赖 pauli 的 `__ID__`：没有它时退化成 `href:<href>@<route>`，同一 URL 的两个 realm 会算同一个 realm，`reevaluateRealm()` 就不重绑。真机上若出现「切页签不重画」，先看 `realmId` 是不是同一个值。
- 本机仍无 Zotero 7，第 1–7 项真机验收不变，另加：双页签来回切十次是否每次都画在可见页上（T2）、`probeAll` 的 `docIdentityDistinct` 在多文档时是否为 true、`mountDetached` 是否始终 0、工具栏关开是否还串区域（T3）、关掉再打开页签后是否直接画上（T1）。
- 页签通知拿不到 `itemID` 时会唤醒全部活会话（最多多跑几次 `queueDocumentCheck`），没有按页签精确化。

### 构建产物

- `package.json` 与 `manifest.json` 同为 0.1.24；`npm run build` → `dist/figure-color-preservation-0.1.24.xpi`（43,903 字节，3 条目：`manifest.json` 448 / `bootstrap.js` 6,117 / `content/index.js` 168,408）；本轮 zotero 层五处修复使 xpi 由 41,438 涨到 43,903 字节（`content/index.js` 158,484 → 168,408）；`build/` 与 `dist/` 重新生成，未手改。

---

## 第 25 轮：0.1.24 真机探针解码——「启动 latch 错文档」— zotero 层五处修复 — v0.1.25

### 真机证据（0.1.24，稳定复现）

- 重启后恢复的页签正常，切到另一页签不正常；探针在切过去之后采集。
- `docIdentityDistinct: true`：两个活会话现场读到的 pdfDocument 确为两个不同对象。
- item:483：`docId` 是 FluidKV 的指纹 `fcp:bd8e2cda…`，而 `freshDocId` 是自己的 `fcp:3e708112…`；其 p9 两条画布的矩形（÷2.6667 后）与 FluidKV p9 的 accepted 两条 ±0.7pt 吻合，而不是 PipeBWrite p9 自己的三条；`target.page.canvasWidth` 为 null。
- item:316 健康：`docId == freshDocId`，p5 三条画布带自己的收紧矩形。
- `realmId` 两边同为 `href:…viewer.html@wrapped`（pauli `__ID__` 拿不到、href 共用），字段无判别力；`realmSwitches` 根本没进探针输出。

### 机制解码

启动恢复时非活动页签的 viewer realm 解析不到（开机日志 `inner-window-missing` / `no-event-bus`），主窗桥的「只有一个 reader」兜底把**另一个**（FluidKV）的 `PDFViewerApplication` 交给了 483 的会话：`syncDocumentId` 打印的是 FluidKV 的指纹，检测跑在 FluidKV 的 `pdfPage` 上，画布挂进 FluidKV 的 `div.page`。之后没有任何路径纠正：`reevaluateRealm()` 只比 window 对象（pdf.js 复用同一 iframe window，判「没换」）；`queueDocumentCheck()` 里 `applyDocumentId()` 从现场文档读回的还是桥兜底的旧文档，判「same」早退；PipeBWrite 自己的 `pagesloaded` 发在它自己的总线上（会话订的是 latch 住的那条），永远不会再武装。于是 PipeBWrite 真页面上覆盖层为零（用户所见「没反色」），FluidKV 页面则被叠了两套同矩形画布（316 看着正常）。探针 `active: item:316` 也是假报：沙箱读不到 `Zotero_Tabs.selectedID`，回落到「第一个会话」。Notifier 回调签名读错（把 `type` 当 `id`），`getByTabID('tab')` 恒 null，实际一直是「唤醒全部」。

### 修复（`src/zotero/`，检测层零改动）

1. **文档身份漂移**（`reader-session.js`）：新增 `docIdentityDrift()`——现场 `resolveDocumentId(currentPDFDocument())` 为打印值且 ≠ 已 latch 的 `documentId` 才算漂移（provisional 与已静默采纳的会话跳过，避免 Xrays 下每次读到新铸 key 造成拆画布循环）；新增 `applyDocDrift(freshId)`——先用**旧** key `invalidateDocument`，再改 `documentId`、`detachAll()`、`repaintAttached()`、`scheduleSettledCheck()`，记 `doc-drift` warn。接入 `onTabActivate()`、`recoveryPass()`、`visibilitychange`、`queueDocumentCheck()` 扫描。
2. **激活顺序**（`reader-session.js`）：`onTabActivate()` 先 `reevaluateRealm()` 再 `queueDocumentCheck()` 再查漂移；同窗不同文档由漂移分支兜住。
3. **画布来源戳**（`overlay.js` + `paint-probe.js`）：新增 `realmStamp(win)`（每 window 一次性序号 `__fcpRealm`，探针 `realmId` 与画布同源）；每张画布写 `dataset.fcpRealm` / `dataset.fcpDoc`（write-once，保留创建那一路的来源）；探针每区域回报 `fcpRealm` / `fcpDoc`。
4. **Notifier 签名**（`main.js`）：回调改 `(event, type, ids, extra, idArg)`，`wakeTabSessions(event, ids, extra)` 用 `ids[0]` 经 `Zotero.Reader.getByTabID` 精确唤醒被选页签的会话，取不到仍回落唤醒全部。
5. **探针补字段**（`main.js` 的 `describeSession`）：新增 `realmSwitches`、`documentIdAdopted`；`realmId` 改用与画布一致的 window 序号戳（拿不到才退回 href 串）。

### 不动的东西（invariants）

- `src/core/detector.js` 与 `detector-options.js` 零改动；`reports/*.json` 八个文件在 `npm test` 后仍与基线逐字节相同。
- 健康单页签会话不付漂移代价：指纹一致时 `docIdentityDrift()` 返回 null，不拆不挂；`onTabActivate` 只多两次只读取值。
- `build/` 与 `dist/` 全部重新生成，未手改。

### 测试

全量 `npm test` 385/385 通过（377 → 385；65 suites 不变），新增/改写：

- `reader-session`：激活即按现场指纹 re-key（旧 key 缓存失效、`doc-drift` warn、重复唤醒幂等、扫描路径同判）；provisional latch 让位给静默采纳；`recoveryPass` re-key 并武装 settled 复查。
- `overlay`：来源戳写入与 write-once 语义（后到的一路不覆盖创建者的戳）。
- `paint-probe`：区域回报 `fcpRealm` / `fcpDoc`，未戳画布报 null。
- `probe-all`：端到端「latch 错 realm」会话在激活后改挂自己文档；Notifier 签名路由三条（按 tab 精确唤醒、无法定位时唤醒全部、非 select 事件不动作）；key 顺序与激活顺序的旧断言同步更新。

### 遗留限制增补（待用户实测判断）

- `documentIdAdopted` 为 true 的会话不再做漂移检查（静默采纳与漂移互斥，防循环）；采纳后若 realm 再被 latch 错，只能靠 realm 切换路径纠正。真机若再现「另一页签空白」，先看 `doc-drift` 是否出现、`realmSwitches` 是否增长。
- 探针 `overlays` 仍是页面组数（`overlays.size`），不是连通画布数；判断「看得见」要靠 `target.canvasCount` 与画布的 `fcpRealm`。
- `active` 字段在沙箱读不到 `Zotero_Tabs` 时仍回落到第一个会话，可能与肉眼所在页签不符；以 `freshDocId == docId` 且 `realmId` 与画布 `fcpRealm` 一致为健康判据。
- 真机验收：两页签（PipeBWrite + FluidKV）重启后切过去应**自动**画上——483 的 p9 应出现自己的三条矩形（56.6/82.0 起那条 + 右栏两条），`probeAll` 里 483 的 `docId` 应变为 `fcp:3e708112…` 且 `freshDocId` 相等；来回切十次不依赖关开。

### 构建产物

- `package.json` 与 `manifest.json` 同为 0.1.25；`npm run build` → `dist/figure-color-preservation-0.1.25.xpi`（45,702 字节，3 条目：`manifest.json` / `bootstrap.js` / `content/index.js`）；`build/` 与 `dist/` 重新生成，未手改。

---

## 第 26 轮：0.1.25 真机仍复现——反向 latch（316 住进 483 的窗口）— realm 归属校验 — v0.1.26

### 真机证据（0.1.25，稳定复现，方向与第 25 轮相反）

- 重启恢复 PipeBWrite（483）正常；切到 FluidKV（316）无反色，白块形状与 483 一模一样。
- 483 健康：`docId == freshDocId == fcp:3e708112…`，`realmId r1`，`realmSwitches 1`，p9 三条自己的区域（与 A1 基线吻合），nonWhite 12–14%——第 25 轮的漂移修复把它治好了。
- 316 被污染：`docId fcp:3e708112…`（483 的），`freshDocId fcp:bd8e2cda…`（自己的）；`realmId r5`（探针当场才铸出，说明它自己的窗口很晚才可见），`realmSwitches 0`；p11 六张画布全部 `fcpRealm: r1`（483 的窗口）、`fcpDoc: 3e708112`；`route: wrapped`、`eventBus: true`（订的是 483 的总线）。
- 全日志无一条 `doc-drift`——漂移检查在 316 上从未触发。

### 机制解码

启动时 316 的 iframe 解析不到，桥的「只有一个 reader」兜底把 483 的窗口交给 316 当 realm（latch），就绪判定、`syncDocumentId`、检测、pageViews、画布创建全走 r1：316 用 483 的文档指纹缓存、把区域画进 483 的 DOM，自己页面上覆盖层为零。`docIdentityDrift()` 也经 latch 的 realm 读文档，fresh == latched 恒成立，**反向 latch 对漂移不可见**；静默赋值点（`waitUntilReady`、`recoveryPass`）不经过 `reevaluateRealm`，所以 `realmSwitches` 不动。`RegionCache.invalidateDocument` 按裸 doc key 删除，316 的扫尾把 483 的缓存一并擦掉（跨页签缓存互撞）。

### 修复（`src/zotero/` + `src/core/cache.js`，检测层零改动）

1. **realm 出处**（`reader-session.js`）：`resolveInnerRealm()` 返回 `{win, provenance}`（chain/scan/src/bridge/none），`resolveInnerWindow()` 变薄壳；新增归属谓词 `realmBelongsToReader(win, reader)`——直接核对 reader 内部链/视图/宿主 frames，桥的猜测不能自证。
2. **采纳门槛**（`reader-session.js`）：`recoveryPass()` 与 `waitUntilReady()` 只有当 realm 未确认时才花 `BRIDGE_GUESS_PASSES = 8` 轮猜测预算；桥猜测在预算耗尽前不得用「文档非空」判就绪；预算耗尽才按最后手段采纳（记 `realmProvenance`）。统一采纳路径 `adoptRealm()`。
3. **切换即 re-key**（`reader-session.js`）：`reevaluateRealm()` 发现持有的 realm 不可信且自己的窗口已出现时，`adoptRealm()` 换 realm 并 `syncDocumentId()`，不再要求 window 对象不同才动。
4. **漂移加固**（`reader-session.js`）：`docIdentityDrift()` 移除 `documentIdAdopted` 短路（静默采纳后不再永久屏蔽漂移）；新增信任门 `!realmConfirmed() → null`——不可信 realm 报的是「猜测」不是「漂移」，防止每次唤醒误拆画布；provisional 守卫保留。
5. **scoped 缓存失效**（`cache.js`）：新增 `keysByDocument` 索引（`set()`/`begin()` 注册、驱逐时 `unindexKey()`）；`invalidateDocument()` 按索引精确删除 + `${docKey}::` 前缀兜底 + epoch bump——316 的失效不再擦掉 483 的条目。
6. **唤醒计数**（`main.js`）：`wakeStats`（count/nullTarget）在 `wakeTabSessions()` 累加，`probeAll` 顶层暴露 `wake`。
7. **可见性绑定**（`reader-session.js`）：`visibilitychange` 绑到 reader 自己 realm 的 document（拿不到才退回 latch 的 realm）。
8. **来源戳可改写**（`overlay.js`）：`stampCanvas` 的 `fcpRealm` 在 realm 变更后重写（不再 write-once 冻结），`fcpDoc` 保持 write-once。
9. **探针补字段**（`main.js`）：每会话 `realmProvenance` / `realmOwned`；顶层 `wake`；`probeAll` 顶层 `version`（上一轮已加，本轮起可在机器上直接核对版本）。

### 不动的东西（invariants）

- `src/core/detector.js` 与 `detector-options.js` 零改动；`reports/*.json` 基线在 `npm test` 后仍逐字节相同。
- 已确认 realm 的健康会话不付新代价：谓词命中即直通，漂移门只多一次布尔判断。
- `build/` 与 `dist/` 全部重新生成，未手改。

### 测试

全量 `npm test` 399/399 通过（385 → 399；65 → 66 suites），新增/改写：

- `reader-session` 新增 describe「realm ownership and bridge guesses」10 条：provenance 命名、成员判定接受/拒绝、桥猜测不能自证、漂移信任门、猜测预算在 recovery 与 readiness 中的接受路径、轮询中途自己窗口出现即采纳。
- `cache` 3 条：驱逐后解除索引并可重加；前缀兜底接住未索引条目；按文档 epoch 只失效被擦文档。
- `overlay`：过期 `fcpRealm` 重写断言（realm 变更后来源戳更新）。
- `probe-all`：key 顺序数组加入 `realmProvenance`/`realmOwned` 并断言取值；新增 `wakeStats` 增量与顶层 `wake` 字段断言。

### 遗留限制增补（待用户实测判断）

- 桥猜测预算（8 轮）耗尽后仍会接受猜测 realm：若两个 reader 的 iframe 同时长时间不可解析，猜测可能仍 latch 错窗，但漂移保持静默、唤醒时的 realm 重解析会继续 healing——观察 `realmProvenance: "bridge"` 且 `realmOwned: false` 即为该状态。
- Xrays 下 reader 内部链读空时谓词只能拒绝，一切走桥猜测；真机若长期 `realmOwned: false` 且不自愈，需要按页签把 reader 自己的 iframe window 从主窗桥取回。
- `mountDetached`（Zotero ~60 s 卸载后留下的 stale page div）行为不变，靠 recovery 跟随新 iframe window。
- `active` 仍可能是「第一个会话」回落值，不作为肉眼页签证据。
- 真机验收（0.1.26）：安装后 `probeAll()` 顶层 `version` 应为 `0.1.26`；两页签（PipeBWrite + FluidKV）重启恢复后直接切换、不点关开——两个会话都应 `docId == freshDocId`、`realmOwned: true`、自己页面画布的 `fcpRealm` 等于自己的 `realmId`；切换时顶层 `wake.count` 增长；来回切十次均自动画上。

### 构建产物

- `package.json` 与 `manifest.json` 同为 0.1.26；`npm run build` → `dist/figure-color-preservation-0.1.26.xpi`（47,155 字节）；较 0.1.25（45,702 字节）增 1,453 字节，全部来自 realm 出处/归属与缓存索引逻辑；`build/` 与 `dist/` 重新生成，未手改。

## 第 27 轮：真机跨文档污染定案——统一文档身份验证入口 — v0.1.27

### 真机证据（0.1.26，四次 probeAll 采样）

- T1 item:316 健康：`docId == freshDocId == fcp:bd8e2cda…`，`realmId r1`，画布来源戳一致。
- T2 切到 item:483，错误已现（off-on 之前）：`docId fcp:bd8e2cda…`（316 的），`freshDocId fcp:3e708112…`（自己的），`cacheKey item:483|fcp:bd8e2cda…`；p11 三条区域与 316 完全相同。
- T3 off-on：区域不变，画布来源戳跳到第三个窗口（r3）；T4 缩放：仍不变。`wake {count:0}`。

### 根因（详见 `reports/CROSS_DOCUMENT_BUG_ROOT_CAUSE.md`）

`start()` 用未经归属证明的 realm 铸造 `documentId`；`adoptRealm()`/`reevaluateRealm()` 换窗口不换身份；`PageOverlay.detect()` 缓存命中直接画旧区域并置 `painted`；deck 切换不发任何能触发 re-key 的唤醒事件（notifier 计数 0、`visibilitychange` 不触发、总线无文档事件）；`queueDocumentCheck` 先改身份后用新 `cacheKey()` 失效——旧条目成孤儿，污染在每次 repaint 自我固化。检测层与指纹碰撞均排除（T2–T4 期间 B 根本没跑检测）。

### 修复（`src/zotero/`，检测层零改动）

1. **统一验证入口**（`reader-session.js`）：新增 `ensureCurrentDocument(trigger)`——先 `reevaluateRealm()`（realm 必须先于身份比较：文档身份经 realm 读出，跳过这步就是拿别人的 viewer 答「同一文档」），再 `validateDocumentIdentity(trigger)`。返回值 `"ok"|"rekeyed"|"wait"`，`wait` = realm 仍是未证实猜测，调用方不画也不清（fail-safe no-paint，猜测预算即自动恢复）。
2. **旧键先存再切**（`reader-session.js`）：新 `commitRekey(freshId, trigger)` 在写入新身份前捕获 `staleKey = cacheKey()`，`invalidateDocument(staleKey)`，再 `detachAll`/`repaintAttached`/`scheduleSettledCheck`；`applyDocDrift()` 变薄壳转调 `commitRekey`，既有测试锚点保留。`queueDocumentCheck.run` 的「先改后失效」顺序 bug 一并消除。
3. **唤醒全部接入**：`recoveryPass`（"recovery"）、`onTabActivate`（"tab-activate"）、`queueDocumentCheck`（"document-check"，非 `ok` 即返回）、`onViewScaleChange`（"scale-change"，同文档缩放仍复用 `regionBoxes` 零重检测；overlay 键不符先 `restampOverlay` 再重检测）、`setEnabled(true)`（"enable"）。无新定时器。
4. **overlay 提交守卫**：`paintOverlay` await 后校验 `overlay.documentId === cacheKey()`，不符则 `overlay.clear()` 丢弃（晚到的检测/缓存结果不再画到换过的文档上）；`attachPageView` 重绑分支改 `restampOverlay`——新文档不再继承旧文档的 `docId`/已画状态。
5. **探针补字段**（`main.js`，`describeSession`）：`lastValidation{trigger,decision,after,at}`（谁问的、判了什么、之后身份是什么）、`docIdStale`（docId ≠ freshDocId）、`lastStaleKey`/`staleKeyPresent`（旧键残留可见）、`realmUnproven`（true 且 docId 有值 = 故意停在「宁可不画」态）；`realmOwned` 注明语义为帧成员关系而非文档归属；`version` 改报 bootstrap 的安装版本（Run-JS 裸环境回落核心版本）。

### 不动的东西（invariants）

- `src/core/detector.js`/`detector-options.js` 零改动；`reports/*.json` 基线逐字节不变（`npm test` 强制）。
- 无论文专用规则、无缓存全清、无固定等待；已确认 realm 的健康会话不付新代价。

### 测试

- 新增 `tests/js/cross-document.test.mjs`：13 条（唤醒 re-key、失效顺序、overlay 跨文档不继承、缩放守卫、异步晚到提交、同指纹双会话隔离）。修复前 5 RED（与根因一一对应：`documentId 'fcp:aaa' vs 'fcp:bbb'`、`invalidated [[新键]]`、`overlay.documentId` 旧键、`paintRegions` 拿旧框、`commits 1 vs 0`），修复后 13/13 GREEN。
- 更新 `reader-session.test.mjs:799`（旧键失效语义）与 `cache.test.mjs`、`probe-all.test.mjs`（新字段断言）。
- 全量 `npm test`：412 tests / 72 suites / **0 fail**（399 → 412）。

### 遗留限制增补（待 Stage B 判断）

- `realmUnproven: true` 的会话会「宁可不画」：若某 PDF 长期不画且该字段为 true，说明真机上 iframe 解析迟迟不成功——观察 `realmProvenance: "bridge"`。
- T2 的确切采纳路由需下次采样看 `realmRoute`/`realmProvenance` 定论；r1/r2/r3 窗口身份系单次日志重建。
- Mock 已覆盖 realm 切换与文档替换，但 Gecko 跨 realm wrapper 稳定性、deck 切换的真实唤醒路径仍只能真机验证（`reports/STAGE_B_CROSS_DOCUMENT_VERIFICATION.md`）。

### 构建产物

- `package.json` 与 `manifest.json` 同为 0.1.27；`npm run build` → `dist/figure-color-preservation-0.1.27.xpi`（49,597 字节）；`build/` 与 `dist/` 重新生成，未手改。

## 第 28 轮：切 tab 长时间不刷新的根因——notifier 注册签名错误 — v0.1.28

### 真机回归（0.1.27）

跨文档污染已修复、on/off/on 逻辑正确；但切换 tab 后反色可能长时间不刷新，只有默认打开的 tab 会自动刷新，执行一次 on/off/on 后切换才恢复正常。

### 根因（PROVEN，@oracle 审计 + 代码核对）

`main.js addZoteroNotifier` 用错 Zotero 10 的注册签名：真实契约是 `Notifier.registerObserver(ref, types, id)`，`ref` 必须是带 `notify(event, type, ids, extraData)` 方法的对象（Zotero 自身 reader.js 即此用法），返回**字符串**哈希。旧代码 `registerObserver("figure-color", "tab", callback)` 传了字符串 ref：注册成功（无异常、日志无告警），但每次 `tab` 事件派发 `ref.notify(...)` 在字符串上 TypeError，被 notifier 吞掉——`wakeTabSessions` 从未执行，`wakeStats.count` 恒 0（与历次真机日志吻合）。第二处：返回的字符串哈希被 `typeof id === "number"` 判成 null，`removeZoteroNotifier` 因此从不注销，每启动/卸载周期泄漏一个观察者。该缺陷 0.1.26 即存在，不是本轮新引入的回归，而是「deck 切换没有任何唤醒事件」一直如此的原因。离线 mock 按插件臆想的契约实现 `registerObserver`，且测试直接调 `wakeTabSessions`，所以 412 条测试全部看不到此缺陷。

症状分布的解释：默认/新开 tab 自带 recovery loop 跑到 ready，正常刷新；隐藏 >60 s 的 tab 被 Zotero 卸载后重建 realm，而 ready 后心跳已停、总线/缩放仍绑在死 realm 上——没有任何驱动重解析，只有 `setEnabled`（on/off/on）会完整重采纳+重画，与用户观察一致。0.1.27 的 fail-safe no-paint 撤掉了 0.1.26 依赖的无条件 scalechange 重画，使缺唤醒的问题更显性（PLAUSIBLE）。

### 修复（3 处，检测层零改动）

1. **notifier 注册按真实契约**（`main.js`）：`const ref = { notify: (event, type, ids, extra) => wakeTabSessions(event, ids, extra) }`，`api.registerObserver(ref, ["tab"], "figure-color")`；id 接受 `string|number`，`removeZoteroNotifier` 仅在 `null` 时跳过。
2. **工具条重渲染即唤醒**（`main.js onRenderToolbar`）：ready、未销毁、无挂起操作的会话在每次 `renderToolbar` 调 `ensureCurrentDocument("toolbar-render")`——realm 被重建后面板必然重渲染工具条，这是确定性唤醒时机；realm 未变则零重画，独立 try/catch（`toolbar-render-wake`）。
3. **`wait` 不再停摆**（`reader-session.js`）：`queueDocumentCheck.run` 与 `onViewScaleChange` 对 `"wait"` 判定先 `scheduleSettledCheck()` 再返回（防抖已有），未证实 realm 不再永久停放；`"rekeyed"`/`"ok"` 行为不变，门控未放松。

未采纳（留作后备）：ready 后保留慢心跳轮询 realm；visibilitychange  hacks 已证伪。

### 测试

- `probe-all.test.mjs` mock 重写为 Zotero 真实契约：`registerObserver(ref, types, id)` 返回字符串哈希并存储 `{ref, types}`，`trigger(event, type, ids, extra)` 调 `ref.notify(...)` 且 ref 无 `notify` 即抛；tab 切换用例改经 `trigger("select","tab",[tabID])` 驱动并断言 `wakeStats` 计数增长；新增「用 Zotero 返回的原 id 注销」用例。
- 新增死 realm 复活用例（probe-all）：会话在 W1 ready 后窗口被替换，下一次 `renderToolbar` 触发采纳 W2——新总线重绑、`realmSwitches` 增长、发生重画。
- `reader-session.test.mjs` 新增「隐藏再显示后的自愈」describe：`onTabActivate` 换 realm 重绑（新总线绑定、死总线解绑、`realm-switched` 日志）、未证实 realm 上缩放延迟而 `wait` 恰好重排一次 settled、document sweep 对 `wait` 重排不停摆。
- 对照验证：还原 `main.js`/`reader-session.js` 后恰好这 5 条新/改用例 RED，恢复后全绿。
- 全量 `npm test`：417 tests / **0 fail**（412 → 417）。

### 真机验收要点

- 每次切换 tab 后 `probeAll().wake` 计数应增长；颜色恢复不再依赖 on/off/on。
- Zotero 错误日志不再出现每次切 tab 一条的 `ref.notify` TypeError。
- 若 `wake.count` 增长但 `nullTarget` 同步增长，说明该 build 的 `getByTabID` 不解析——此时由 toolbar-render 唤醒兜底，仍应恢复。
- 若某 tab 长期不画且 `realmUnproven: true`，属「宁可不画」态，观察 settled 重排是否最终收敛。

### 构建产物

- `package.json`、`manifest.json`、`build/manifest.json` 同为 0.1.28；`npm run build` → `dist/figure-color-preservation-0.1.28.xpi`（49,715 字节）；`build/` 与 `dist/` 重新生成，未手改。

### 真机验收结果（0.1.28）

- 快切换（<60 s）反色跟随正确；来回 8 次切换 `wake.count` 同步增长 8，`nullTarget=0`。
- 四会话（item 316/457/481/483）各自独立指纹，`docIdStale` 全 false，`lastValidation` 均有新鲜 `document-check ok` 记录（`tab-activate` 被随后的 debounce 记录覆盖属预期）。
- 调试观察者旁证：Zotero 10 每次 reader tab 切换发 `select:tab:["tab-XXXX"]`，打开时另发 `load:tab`；插件观察者全部收到。
- 遗留观察：修复前那次卡死采样（`wake.count=1`、481 `lastValidation:null`+`docIdStale:true`）与「切换多次」的叙述不完全吻合，疑为采样时进程/时机错位；若复发请立刻采 `probeAll()`，那将是新边界的证据。
- 待补验：隐藏 >60 s（realm 重建）慢切换一次、off/on 一次；预期分别由 toolbar-render 唤醒与 enable 路径覆盖。
