# Stage A 测试结果总表

状态口径：**PASS** = 本机离线可复现证据；**FAIL** = 未达标；**NOT TESTED** = 本环境无法运行（无 Zotero 二进制），待 B 实机；**BLOCKED** = 缺源码依据或本机不可达的运行时接入点，附最小下一步。XPI 状态只报 **Built / Not integration-tested**。

## 0. 环境与命令

| 项 | 值 |
|---|---|
| Node.js / npm | v22.23.0 / 10.9.8 |
| pdfjs-dist（离线 harness） | 6.5.438（主）+ 4.10.38（operator 对照） |
| Canvas 后端 | `@napi-rs/canvas` 1.1.0 |
| Python oracle | 3.12.3（仅生成期望值，不参与插件运行时） |
| 构建工具 | esbuild 0.28.2 + 系统 zip；`zip`/`unzip` 可用；无 Playwright、无 Zotero |
| 命令 | `npm test`（89 tests）/ `npm run probe` / `npm run render` / `npm run build` |
| 测试文件 | `fixture/PipeBWrite.pdf`（16 页，612×792，rotation 0，无 StructTreeRoot，第 5 页 0 Image XObject + 2 Form XObject） |

## 1. Definition of Done 对照（规范 §6）

| # | DoD 项 | 状态 | 证据 |
|---|---|---|---|
| 1 | JS 自动识别第 5 页 Figure 2/3，可复现测试 + 对象/坐标输出，非仅 Python oracle | **PASS（离线）** | `reports/A1_DETECTION.md` §4：bbox 差异 0.00 pt（阈值 ≤2 pt）；`npm test` 断言 |
| 2 | 离线 PDF.js 裁剪图 + 原色质量与坐标精度量测 | **PASS（离线）** | `reports/A2_RENDER.md` §2–§4：MAE 2.586/3.482，语义色类相对差 ≤1.8 %（black 除外，见该节说明），缩放对齐位移 `0,0` |
| 3 | detector / region-renderer / Zotero integration 隔离，无手动框选 | **PASS** | `src/core/*`（纯数据 + pdf.js 适配）与 `src/zotero/*`（仅 Zotero 接入）分层；core 零依赖 pdfjs-dist/node-canvas |
| 4 | `.xpi` 打包、可重建、manifest 与 Zotero 格式一致；能否安装留待 B | **Built / Not integration-tested** | `reports/A3_BUILD_AND_LIMITS.md`；两次构建条目一致 |
| 5 | `reports/` 含实测日志、命令、环境版本、未解决兼容点，无伪造通过 | **PASS** | 本文件 + A0/A1/A2/A3 |
| 6 | B 阶段最少点击步骤与反馈格式 | **PASS** | `docs/STAGE_B_USER_CHECKLIST.md`（已按 lane C 实际 UI 刷新） |

## 2. A0 — 结构核查

| 检查项 | 状态 | 证据/说明 |
|---|---|---|
| `getOperatorList()` 保留 Form begin/end + `/BBox` + `/Matrix` | **PASS（离线实测）** | `reports/A0-probe-page5.json`；重建 CTM 与 oracle 一致 |
| operator 编码跨 pdfjs-dist 版本一致（4.10.38 vs 6.5.438） | **PASS（离线实测）** | 7 个 op 码逐一对照相同 |
| Blender 条件（Zotero 8–10 `window.theme && !ctx.skipBlender`） | **源码确认**（tag 8.0.0/10.0.8 + zotero/pdf.js `canvas.js:902–903`） | 端到端保色 **NOT TESTED** |
| Zotero 7 深色为 CSS-only、无 window.theme | **源码确认**（reader@fx115 `pdf-view.js:733–741`） | overlay 是否被 CSS 波及 **NOT TESTED** |
| XPI manifest 约束（manifest_version 2、`applications.zotero`、`6.999`/`10.0.*`、experiment 不解析） | **源码确认**（zotero.org dev 文档 + `xpcom/plugins.js`） | 扩展管理器实际装载 **NOT TESTED** |
| reader→pdf.js 对象链 `_internalReader._primaryView._iframeWindow` | **源码确认**（reader.js:1315–1327 @7.0.24） | 用户实际版本可解析 **NOT TESTED** |
| 旧假设更正：`getByDocID`/`getByURI`/`setPage`/`getFullText`/`outerContextWindow`/`zotero-reader-destroyed` 在 7–10 不存在 | **源码确认**（0 grep 命中） | — |

## 3. A1 — JavaScript 自动识别

| 检查项 | 状态 | 数值 |
|---|---|---|
| 第 5 页 Figure 2 bbox vs fixture | **PASS** | 54, 72, 294.13, 174.05（Δ 0.00 pt） |
| 第 5 页 Figure 3 bbox vs fixture | **PASS** | 317.88, 72, 558.00, 214.52（Δ 0.00 pt） |
| 第 5 页不把整页/双栏正文/图注当原色区 | **PASS** | 仅 2 个候选；区域面积比 0.0506/0.0706；图注在区域外（gap ≈10.8 pt） |
| 不硬编码页码/`Im5`/`Im6`/xref/SHA | **PASS** | 检测路径零引用；仅测试断言引用 |
| 全文档 false positive 列举与规则解释 | **PASS** | 观察到 0 FP；14/15 图注覆盖；`reports/A1_DETECTION.md` §5–§6 |
| 已知 false negative | 记录 | 第 7 页 Figure 5（纯矢量路径，无 XObject）——规范允许 unsupported |
| `/Figure` 结构标签路径（真实文档） | **NOT TESTED** | fixture 无 StructTreeRoot；仅单元测试。下一步：B 阶段换一份 tagged PDF 观察 |
| Image XObject 路径（真实文档） | **NOT TESTED** | 第 5 页 0 Image；仅单元测试。同上 |
| 诊断完整性 | 已知限制 | 绑定图注但未入选中的 placement 无 reject 记录（A1 §6） |

## 4. A2 — 原色裁剪渲染与覆盖几何

| 检查项 | 状态 | 数值 |
|---|---|---|
| 尺寸（vs 参考 PNG） | **PASS** | 730×316 / 730×438，Δ 0 px（阈值 ±2 px） |
| MAE | **PASS** | 2.586 / 3.482（阈值 ≤8） |
| 语义色类（gray/beige/green/colored/black…） | **PASS** | 相对差 ≤1.8 %；最大 black 11.9 %（阈值 ≤15 %） |
| 墨量 nonWhite | **PASS** | Δ 0.0014 / 0.0005（阈值 ≤0.05） |
| 灰度负控（防相似度掩盖语义色） | **PASS** | beige/colored/green 相对差 100 % → 检查正确失败 |
| 缩放 100/150/200 % 对齐 | **PASS** | 最佳位移全部 `0,0`（±2 px 扫描全局最小） |
| 重复渲染确定性 | **PASS** | MAE 0 |
| CropBox 偏移 / 旋转 0/90/180/270 合成测试 | **PASS** | `tests/js/viewport.test.mjs` + fixture 旋转渲染（A2 §6） |
| Zotero Blender 跳过端到端 | **NOT TESTED** | 本实验用未做颜色反演的 pdf.js；下一步见 B 清单第 2 项 |
| Gecko canvas + dpr 2/3 像素结果 | **NOT TESTED** | Node 用 `@napi-rs/canvas` |

## 5. A3 — 插件与打包

| 检查项 | 状态 | 说明 |
|---|---|---|
| `npm run build` 可复现（一条命令） | **PASS** | 两次构建条目/长度一致；`unzip -l` 恰 3 条目 |
| XPI 结构（manifest.json + bootstrap.js 根 + content/index.js） | **PASS（构建期）** | `reports/A3_BUILD_AND_LIMITS.md` §2 |
| bundle 依赖纯净 | **PASS** | 0 `require(`；无 pdfjs-dist/@napi-rs |
| core 测试不受集成层影响 | **PASS** | 89/89 |
| bundle vm 冒烟（stub Zotero） | **PASS** | 全局发布、renderToolbar 注册、按钮同步 append、toggle 传导、shutdown 清零 |
| 代码审阅（3🔴4🟡3🔵） | **已修复** | 修复后重建与冒烟复跑，见 A3 报告修订 |
| XPI 在 Zotero 安装 | **PASS（实机，v0.1.1）** | 0.1.0 实机安装失败：Zotero 强制要求 `applications.zotero.update_url`，缺失致 manifest 解析失败。0.1.1 补齐并把 `strict_max_version` 放到 `10.9.9`，用户确认安装成功。见 A3 §8 |
| `Zotero.initializedPromise`（含回退） | **BLOCKED（待 B）** | 最小下一步：Run JavaScript 打印 `!!Zotero.initializedPromise` |
| 观察者服务形状（`Services.obs` vs `observers`） | **BLOCKED（待 B）** | 失效后果仅窗口关闭不清理 session；观察 `[figure-color]` 日志即可判定 |
| `Zotero.Reader._readers`（收养已开 reader） | **BLOCKED（待 B）** | 失效后果：启动前已开的 PDF 需重开一次 |
| `zotero-reader-state` DOM 事件 | **BLOCKED（待 B）** | 纯附加信号，主信号为标准 `unload` |
| `renderToolbar` 注册 + 工具栏按钮挂载 | **PASS（实机）** | 「原色」按钮在 reader 工具栏出现（0.1.1） |
| 插件句柄在 Run JavaScript 可见 | **已修复待复测** | 0.1.1 时 `globalThis.FigureColorPlugin` 为 undefined：bundle 全局在 Zotero 的 bootstrap 沙箱内，Run JavaScript 在主窗口 realm。0.1.2 发布到 `Zotero.getMainWindow().FigureColorPlugin`。见 A3 §9 |
| 点击「原色」后画面变化（保色覆盖层） | **NOT TESTED** | 用户报点击无画面变化；`plugin:false` 属句柄假阴性，无法定位。待 0.1.2 诊断 JSON |
| `pdfViewer._pages`/`pagesCount` 回退分支在 Zotero fork 内 | **部分 PASS（实机）** | 主窗口 realm 读 `(pv._pagesView ?? pv._pages).length` = 16 = 文档页数；overlay 是否覆盖全部页仍待看 |
| 滚动/缩放流畅度（双绘制的性能代价） | **NOT TESTED** | B 阶段主观观察 |

## 6. 未解决兼容点汇总（B 阶段输入）

1. 用户 Zotero 具体小版本未知；7 与 8+ 的深色机制不同（CSS vs 渲染期 Blender），主题开关引入版本介于 7.0.24 与 8.0.0 之间，未核实。
2. `ctx.skipBlender` 非稳定公开接口，fork 升级可能改名或改语义（`docs/DECISIONS_AND_RISKS.md` 第 4 条）。
3. 直接矢量路径图（无 XObject）为整类 unsupported，本阶段不解决（规范 §6 允许）。
4. overlay 与文本层/批注点击命中区的相互影响未在真实 DOM 验证（canvas 设了 `pointer-events: none`）。

## 7. 结论

Stage A 的 DoD 六项全部满足：检测与渲染以离线可复现证据 **PASS**；插件与打包 **Built / Not integration-tested**；所有 Zotero 运行时接入点按上表标记 NOT TESTED / BLOCKED 并附最小下一步，无伪造通过。可进入 B 阶段实机验收。

## 实机状态补充（v0.1.9）

| 项 | 状态 | 依据 |
| --- | --- | --- |
| 插件加载与工具栏挂载（实机） | PASS | v0.1.2 起「原色」按钮可见可点 |
| inner window 与 pdf.js 文档解析（实机） | PASS | v0.1.6 `runProbe()`：`ready:true`、`innerWin:true`、`docId` 非 null、`overlays:16` |
| 跨 realm 读取 pdf.js 数值数据 | PASS | v0.1.7 起区域已检测、canvas 已绘制，Xray TypedArray 错误消失 |
| 启动时恢复的 reader 能出图 | FIXED（待实机复验） | v0.1.8 三个 reader 全部 `ready-timeout`；v0.1.9 加 5 s 间隔 / 180 s 预算的慢恢复重试（`recovered:<tag>`） |
| 原色覆盖层实际着色 | NOT TESTED | v0.1.7 为纯白块，v0.1.8 未绘制；像素证据待 v0.1.9 `probeAll()` |
| 白块是否消失 / 图内是否原色 | BLOCKED（待实机） | 需一次真正绘制成功后的 `probeAll()` 输出与 p5 截图 |
| 缩放对齐、开关行为、正文深色 | NOT TESTED | 依赖上面的绘制成功 |

最小下一步：安装 `dist/figure-color-preservation-0.1.9.xpi`，重启 Zotero，打开 `PipeBWrite.pdf`，
在「工具 → 开发者 → Run JavaScript」执行
`JSON.stringify(Zotero.getMainWindow().FigureColorPlugin.probeAll())`，
同时回答「这一页有没有白色方块」。
