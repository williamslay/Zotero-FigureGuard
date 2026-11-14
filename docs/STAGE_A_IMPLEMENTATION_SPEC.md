# Stage A — Codex 独立开发与离线验证规格（优先级最高）

## 0. 任务定义和完成边界

目标插件暂名 **Figure Color Preservation for Zotero**。保留 Zotero 10 传统 PDF 阅读器（非 Reading Mode）的原排版、Dark Theme、双栏正文及图注；对可信 Figure 区域覆盖 **原始 PDF 色彩**。Figure 可以保留白色底色，不能改变文中的语义色标、灰/米区分、彩色路径；不得修改 PDF 本体。

**开发期间不要求 Zotero 软件安装。** Stage A 必须尽可能完成候选插件源码与 `.xpi`、可运行的自动定位核心、独立 PDF.js 颜色/裁剪实验和自动化验证；所有 Zotero 专有运行行为只能标注“待 B 实机验证”。不可声称 Stage A 已在 Zotero 实测。

约束：最简可交付，不引入 OCR/AI/机器学习、后台网络请求或 telemetry；不要安装驱动/改 Zotero 系统文件；不创建额外常驻服务；不要强制用户手动框选；对无法确信的 Figure 不做破坏性颜色转换。人工修正框选作为 **后续版本**，不是 Stage A 必做。

## 1. 已提供测试素材（不是代码中应硬编码的识别规则）

- `fixture/PipeBWrite.pdf`：用户提供的 16 页论文；**仅作本地测试，不要提交到公开仓库**。
- `fixture/page5-original-2x.png`：第 5 页完整原色参考（612×792pt，2×渲染）。
- `fixture/figure2-original-3x.png`、`fixture/figure3-original-3x.png`：原色图片，供 RGB / 图形结构比对。
- `fixture/fixture-verified.json`：源文件 SHA-256、Form XObject BBox、CTM、页面坐标、图注边界。脚本 `scripts/inspect_pdf.py` 可重现这些数值。

第 5 页（`pageIndex=4`）页面 612×792 pt、0 个 Image XObject、2 个顶层 Form XObject：

|对象|xref|Form BBox（本地）|页面 top-left BBox（pt）|附近图注|
|---|---:|---|---|---|
|`/Im5`|15|`[0,0,240,102]`|`[54,72,294.13,174.05]`|Figure 2:|
|`/Im6`|16|`[0,0,549.12,325.92]`|`[317.88,72,558.00,214.52]`|Figure 3:|

注意：`/Im5` 的 `Im` 名称不是 `/Image` 类型标志；以 `/Subtype` 为准。它们没有 PDF `/Figure` 语义标签。不要把上述坐标、xref、文件 SHA 写成插件的识别判据；这些只是回归测试的期望值。对其它 PDF 必须动态计算。

## 2. 候选识别算法（自动、保守、能解释）

**候选生成：**
1. 如果 PDF 页面有可用 tagged-PDF 结构树 Figure 标记，可优先利用对应定位；如果树没有位置信息，不能假定已能直接得到 BBox。
2. Image XObject：从绘制时的 CTM 获取单位方形在页面中的范围。过滤页面级背景、微小图标、水印、重复页眉等；图片可能仅是 Figure 一部分。
3. Form XObject：优先使用 Form 的 `/BBox`、可选 `/Matrix`、外层绘制 CTM（包括嵌套）；保留矩形四角变换得到的轴对齐边界；正确处理裁剪（如可获取）。不能把所有 `/Form` 都当成 Figure。
4. 结合附近的 `Figure N:` / `Fig. N` 图注的文本几何、相对位置、大小和非整页面积进行置信度筛选。Figure Caption 本身保持暗色，不归入原色覆盖区。
5. 不属于上述 XObject 的直接矢量路径，允许暂不处理，明确记录 false negative；不能从缺失 XObject 推断“图表不存在”。

**禁止**：依赖 `Im5`/`Im6` 固定资源名、单一尺寸阈值、默认每个 Form 都是插图、逐页无条件回退为白底整页。

### 关键架构限制：离线 Python 与插件 JavaScript 必须隔离

`scripts/inspect_pdf.py` 是用于离线核对的 **Python oracle**，不是扩展运行时。用户的 Zotero 不应依赖 Python、PyMuPDF、pypdf。

Codex 必须产出可独立运行、可被浏览器插件调用的 **JavaScript/TypeScript 图形定位模块**，并做离线 JS 自动化测试。优先调查目标 `zotero/reader` 使用的 PDF.js `getOperatorList()` 是否保留 `paintFormXObjectBegin`、`paintFormXObjectEnd` / BBox / Matrix 信息：不保证所有版本一致。

若 operator list 展平了 Form 或没有足够矩阵/边界，则需明确提出**最小可行替代方案**并实现：如使用允许在插件运行时获得的 PDF bytes 与可打包的 JS PDF 对象解析路径。须证明插件能够实际取得 PDF 文件字节及识别必要 Form 数据；**不能把 Python 验证通过当作 JavaScript runtime 已经实现**。避免无边界地手写完整 PDF parser；对 unsupported 格式给出受控失效和日志。

缓存：每个文档按 `document fingerprint + pageIndex` 缓存候选区域；取消过期任务，避免多次重复解析同一页。

## 3. 原色绘制方案：优先双渲染与局部覆盖

**首选：B 路线（更容易隔离风险）**

1. Zotero 原生 PDF.js 使用 Dark Theme 绘制页面（不能干扰原流程）。
2. 为自动识别的 Figure BBox 建独立 canvas；以相同 PDF page 和 viewport 进行局部绘制，使用 `transform` 裁切页面，原色渲染为白底。
3. 独立的 overlay 通过 PDF.js `viewport.convertToViewportRectangle()` 计算在 page canvas 上方的 CSS 位置；由缩放/旋转状态和设备像素比计算栅格尺寸。普通浏览时 `pointer-events: none`。
4. 只对可见页按需绘制，缩放/旋转/主题变化后重新安排，针对 renderTask、文档/tab 关闭处理清理。对原色主题隐藏无意义的 overlay。不得遮挡批注/文本选择交互。

**关键待实测假设**：在 Zotero 10.0.6 相关研究中，`CanvasGraphics.beginDrawing()` 的 `window.theme && !ctx.skipBlender` 条件允许特定 context 绕过 Blender。它不是稳定公开接口。目标机 Zotero 版本未知，Codex 必须查阅相应 tag/源版本，注明依据、版本和迁移风险；离线仅能证明特定源版本成立，不能证明本机行为。

**备选：A 路线（对象级拦截）**：如能基于实际 Zotero PDF.js fork 安全绕过对指定 Form 的颜色变换、且无需复杂 patch，才考虑单次绘制。不要假设在 Form begin/end 中切换 `ctx.skipBlender` 会生效：Blender 是在 `beginDrawing()` 建立的，可能不支持对象级动态切换。

**PDF.js 接口**：`PDFPageProxy.render`、`getViewport`、`getOperatorList` 是基础入口；`PDFViewerApplication`、`ctx.skipBlender`、内部 `Blender`、reader iframe 是版本相关入口。不要把后者当公开稳定 API。`transform` 是局部 canvas 像素到 page viewport 的预变换，要实测裁剪、基准坐标及 90° 旋转。

## 4. 插件实现边界

- 优先使用标准 bootstrapped Zotero 扩展（`manifest.json`、`bootstrap.js`），参考官方 `make-it-red` 示例、Zotero Reader `renderToolbar` 事件。插件 ID 唯一，版本与匹配范围可配置；调试按需启用，禁止上报遥测。
- 自动模式默认开启；一个 toolbar toggle 供用户临时停用/启用原色保护；显示状态可用于 B 阶段排障。不要开发复杂设置面板。
- 注入阅读器须尊重 iframe 和 realm 隔离，并可在 reader 重新建立、PDF 换页、reader 关闭、插件卸载时清理所有 listener/overlay/renderTask。
- 避免全局 monkey-patch；如无法避免，必须限域、有明确回滚和重复加载保护。
- `.xpi` 可由 zip 构成，但 manifest 必须满足**目标 Zotero** 扩展管理器约束。参考已有 Zotero 10 插件的 manifest 版本兼容字段；不得凭普通 Firefox 扩展例子假设 `applications.gecko` 可用。
- 不修改原始 PDF，不依赖外部服务器，无后台上传。

## 5. Stage A 分阶段任务与交付证据

### A0 — 结构核查与架构决策

**输入**：本交接包、公开 Zotero/reader 源码、PDF.js 文档。

交付：`reports/A0_RESEARCH.md`，说明具体来源的版本/commit、PDF.js operator list 在测试 PDF 上的表现、阅读器获取 PDF bytes / pdfPage 的方法、Blender 条件、Zotero XPI manifest 约束，以及采用 B 路线或 A 路线的理由。标注“源码确认/离线实测/待 B 验证”。

### A1 — 可运行的自动识别 JavaScript 模块

交付：`src/...` 可独立调用的 JS/TS 检测器及 `tests/...` JS 测试，用真实 `PipeBWrite.pdf` 识别 Figure 2 和 Figure 3（不能硬编码页码/名称），输出对象依据、置信度、页面矩形。对图注/正文不进行覆盖。

**验收**：运行一次非人工修正检测脚本，输出两图 bbox，和 fixture 参考边界逐个差异 ≤2 pt（不考虑必要的渲染 padding）；第 5 页不把整页、两栏正文、图注当作原色区域。列举其它页的 false positives，并解释筛选规则。

### A2 — 独立 PDF.js 裁剪渲染与覆盖几何

交付：能独立运行的测试 harness（Node + 浏览器 Canvas / Playwright 或等效方法）和原色 Figure 2/3 图像、差异报告、缩放 100%/150%/200% 几何测试。无需 Zotero；使用非 Zotero PDF.js 的原色渲染可证明裁剪算法，但**不能证明 Zotero 的 Blender 跳过成功**。

**验收**：Figure 2 的灰色/米色区、Figure 3 彩色元素可辨认且与参考图一致；误差标准需定义并写入 `reports/A2_RENDER.md`。不得只用整体像素相似度遮掩关键语义色的错误。CropBox/rotation 的通用坐标函数做合成测试。

### A3 — 候选插件 + 可复现打包 + 交付说明

交付以下**必需文件**：

```text
src/                                可读的插件与自动识别源码（不依赖 Python 运行）
dist/figure-color-preservation-0.1.0.xpi   候选安装包
scripts/build.*                     一条命令可重新打包
package.json 或等效构建入口          锁定必要依赖
reports/A0_RESEARCH.md
reports/A1_DETECTION.md
reports/A2_RENDER.md
reports/A3_BUILD_AND_LIMITS.md
reports/STAGE_A_TEST_RESULTS.md     每个检查项 PASS / FAIL / BLOCKED / NOT TESTED
docs/STAGE_B_USER_CHECKLIST.md      可直接给用户执行
```

A3 的候选 `.xpi` 若未在 Zotero 中安装，**只能标记 `Built / Not integration-tested`**，绝不写成 `Zotero tested`。没有源码依据的运行时接入点应报告 BLOCKED 并给出最小下一步，不可臆造。

## 6. Codex 完成 Stage A 的 Definition of Done

**全部满足才算 Stage A 完成**：

1. JavaScript 自动识别真实 PDF 第 5 页 Figure 2/3，附有可复现测试、对象和坐标输出，而不仅是 Python oracle 结果。
2. 浏览器/Node 离线 PDF.js 生成对应裁剪图；量测原色质量与坐标精度。
3. 源码清晰隔离 detector / region-renderer / Zotero integration，避免依赖人工框选。
4. `.xpi` 完成打包；可重建，manifest 与已查明的 Zotero 10 格式一致；**实际能安装与否留待 B**。
5. `reports/` 提供所有实测日志、命令、环境版本和未解决兼容点；没有伪造通过。
6. 告知用户“B 阶段最少点击步骤”和“问题反馈应包含的日志/截图”。

不要求 A 阶段运行 Zotero 本体，也不要求 A 阶段解决所有通用 PDF 的直接路径矢量图识别；可以标记已知 unsupported 类别。

## 7. Stage B 最短验收闭环（用户执行）

看 `docs/STAGE_B_USER_CHECKLIST.md`。需人工提供 Zotero 版本/Build ID、安装结果、开启 Dark Theme 后第 5 页 Figure 2/3 的截图、缩放表现及错误日志。有失败则交回 Codex：复现 -> 修复 -> 重发新的 XPI -> 实机再测。不得让用户做开发调试工作。
