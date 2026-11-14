# A1 — JavaScript 自动识别结果

结论：**PASS（离线，无 Zotero）**。第 5 页 Figure 2/Figure 3 由纯 JavaScript 检测器自动定位，页面 bbox 与 fixture 期望差异 0.00 pt（验收阈值 ≤ 2 pt）；图注与两栏正文未被当作原色区域；整篇提取到的 15 条 Figure 图注全部有对应区域（18 个接受区域），观察到的 false positive 为 0，已知 false negative 0 条；第 13 页并排的 Figure 16/17 图注未被提取，属遗留限制，见第 6 节。

## 1. 运行方式与环境

```bash
npm test          # node --test tests/js/*.test.mjs → 266 tests / 266 pass / 0 fail
npm run probe     # 离线 operator list 探针（见 reports/A0_RESEARCH.md）
node scripts/survey_pdf.mjs "Flash-Level Asynchronous Execution for In-Storage LSM-Tree Operations.pdf" reports/flash-detection.json   # 第二个夹具（v0.1.18 起）
```

| 项 | 值 |
|---|---|
| Node.js | v22.23.0 |
| pdfjs-dist（离线 harness 用） | 6.5.438 |
| 检测核心依赖 | 无（`src/core` 纯数据 + pdf.js 适配层） |
| Python oracle | 仅生成期望值，不参与检测运行 |

检测器不读取页码、`/Im5`、`/Im6`、xref 或文件 SHA：这些值只出现在测试断言里。

## 2. 代码分层

```text
src/core/geom.js              矩阵/矩形运算（PDF 顺序合成、四角轴对齐 bbox、IoU）
src/core/placements.js        operator list → 候选 placement（Form /BBox + /Matrix + 累积 CTM；Image 单位方形）
src/core/captions.js          getTextContent → 文本行重建 → Figure 图注矩形
src/core/detector.js          候选绑定、评分、接受/拒绝、子图合并
src/core/detector-options.js  全部阈值
src/core/pdf-source.js        pdf.js 适配：getOperatorList + getTextContent + 结构标签
src/core/viewport.js          用户空间 → viewport（CSS 像素）
src/core/cache.js             文档指纹 + pageIndex 缓存，含失效 epoch
src/zotero/*                  Zotero 接入层（A3）
```

`detector.js`、`placements.js`、`captions.js` 只接受普通对象输入，不引用 pdf.js，因此可被浏览器插件、Node 测试与后续 UI 共用。

v0.1.18 起识别规则补两条（`maxCaptionOverlapPt` = 12 pt，`absorbCenterInsetPt` = 1 pt，均见 `src/core/detector-options.js`）：图注行允许被图形外框侵入（pdf.js 对带裁剪路径的图注会返回整个绘图组的 bbox，此时侵入深度计作 0 间距，超过上限仍不算图注）；合并后因面积上限被丢弃的图块，若其中心落在某个已接受区域内、不与该区域图注矩形相交、且并入后仍不超面积上限，则吸收进增长最小的区域，不再计为被拒。两条规则由 Flash-Level 夹具（`tests/js/flash-detect.test.mjs`）验证。

## 3. 识别规则

候选来源（规范 §2 顺序）：

1. tagged-PDF 的 `/Figure` 结构标签定位。
2. Image XObject：单位方形经绘制 CTM 得到页面矩形。
3. Form XObject：`/BBox` × 可选 `/Matrix` × 累积 CTM（含嵌套），取四角轴对齐边界。
4. 图注文本：`Figure N:` / `Fig. N` 模式，配合文本项 `transform` 与 advance width 重建行矩形。

基础过滤与拒绝原因（`src/core/detector-options.js`）：

| 规则 | 阈值 | 拒绝原因 |
|---|---|---|
| 面积过小（图标、项目符号） | areaRatio < 0.004 | `below-min-area` |
| 面积过大（页面背景、整页扫描） | areaRatio > 0.8 | `page-sized` |
| 短边过短（分隔线、下划线、装饰条） | < 24 pt | `thin-rule` |
| 长宽比极端 | 超出 0.15–8 | `aspect` |
| 完全绘制在页面外 | — | `off-page` |

证据要求（保守，规范 §2 禁止"把所有 Form 都当成 Figure"）：一个区域成立必须至少满足下列一项，且 confidence ≥ `acceptConfidence` = 0.6：

- 与 `Figure N:` 图注锚定；
- 具备 `/Figure` 结构标签；
- 为无图注的独立 Image XObject 且面积 ≥ 0.02。

未满足者保持"不覆盖"，即宁可漏检也不在白化正文（`docs/DECISIONS_AND_RISKS.md` 降级方案）。

图注绑定规则：

- 每个 placement 最多服务一个图注（`assignment`）；冲突时，**位于图形下方的图注优先于更近但位于上方的图注**（`betterLink`），因此夹在两个图注之间的面板会绑定到自己的图注。
- 同一图注只取最近的一行（`pickNearestRow`）；垂直间距 ≤ `rowMergeGapPt` = 6 pt 的多个 placement 合并为一个区域（子图行）。
- 图注与图形的垂直距离 ≤ 26 pt，且水平重叠 ≥ 30 %；距离 ≤ 18 pt 时追加置信度。
- 图注本身不进入覆盖矩形：覆盖区止于图形 bbox。

## 4. 第 5 页验收（fixture 第 5 页，612×792 pt，0 个 Image XObject，2 个顶层 Form XObject）

| Figure | 检测 bbox（top-left, pt） | fixture 期望 | Δ 最大边 | 图注 | gap | confidence | 页面面积比 |
|---|---|---|---:|---|---:|---:|---:|
| Figure 2 | 54, 72, 294.13, 174.05 | 54, 72, 294.13, 174.05 | 0.00 pt | `Figure 2:`（下方） | ≈10.8 pt | 0.95 | 0.0506 |
| Figure 3 | 317.88, 72, 558.00, 214.52 | 317.88, 72, 558.00, 214.52 | 0.00 pt | `Figure 3:`（下方） | ≈10.9 pt | 0.95 | 0.0706 |

第 5 页负例检查（`tests/js/fixture-detect.test.mjs`）：

- 该页只有 2 个 placement 候选，均为识别出的图；**没有整页尺寸候选**，因此"整页"不会被当作原色区域。
- 双栏正文是纯文本，不产生任何 placement；两个区域面积比 0.0506 / 0.0706，均远小于页面，正文未被覆盖。
- 图注矩形位于区域之外（垂直间距 10.7–10.9 pt），断言 `keeps captions out of the covered regions` 通过；图注继续走 Zotero Dark Theme 着色。

## 5. 全文档 survey（16 页）

数据来源：`reports/A1-detection.json`（由测试写入，可复现）。

| 页 | placement 候选 | 图注号 | 接受区域（图注 / conf / 面积比） | 拒绝原因 | 未覆盖图注 |
|---:|---:|---|---|---|---|
| 1 | 4 | — | — | `below-min-area` ×3、`path-below-area-threshold` ×1 | — |
| 2 | 0 | — | — | — | — |
| 3 | 6 | 1 | Fig 1（合并 2）/ 0.95 / 0.0841 | `below-min-area` ×4 | — |
| 4 | 2 | — | — | `below-min-area` ×2 | — |
| 5 | 8 | 2, 3 | Fig 2（合并 2）/ 0.95 / 0.0506；Fig 3（合并 2）/ 0.95 / 0.0706 | `below-min-area` ×4 | — |
| 6 | 11 | 4 | Fig 4（合并 2）/ 0.95 / 0.0313 | `below-min-area` ×8、`path-below-area-threshold` ×1 | — |
| 7 | 4 | 6, 5 | Fig 6（合并 2）/ 0.90 / 0.0461；Fig 5（合并 1）/ 0.85 / 0.1110 | `no-figure-evidence` ×1 | — |
| 8 | 0 | — | — | — | — |
| 9 | 7 | 7, 8, 9 | Fig 7（合并 3）/ 0.90 / 0.1014；Fig 8（合并 2）/ 0.95 / 0.0474；Fig 9（合并 2）/ 0.95 / 0.0474 | — | — |
| 10 | 2 | 10 | Fig 10（合并 2）/ 0.95 / 0.0474 | — | — |
| 11 | 20 | 11, 12, 13 | Fig 11（合并 6）/ 0.90 / 0.0856；Fig 12（合并 6）/ 0.90 / 0.0856；Fig 13（合并 1）/ 0.95 / 0.0421；3 个无图注 `path` 区域 / 0.65 / 0.0245 | `dropped-row` ×1、`no-figure-evidence` ×3 | — |
| 12 | 2 | 14 | Fig 14（合并 2）/ 0.95 / 0.1541 | — | — |
| 13 | 6 | 15 | Fig 15（合并 6）/ 0.95 / 0.0888 | — | — |
| 14 | 0 | — | — | — | — |
| 15 | 0 | — | — | — | — |
| 16 | 0 | — | — | — | — |

统计：15 条 Figure 图注（Figure 1–15）全部被区域覆盖，共 18 个接受区域；最大区域面积比 0.1541（第 12 页 Figure 14），无任何区域超过页面四分之一。第 9 页的 Figure 8 由 v0.1.17 的同行切段恢复，其余 14 条与 v0.1.16 完全一致。

## 6. false positive / false negative 说明

- **观察到的 false positive：0。** 18 个接受区域中 15 个绑定到真实 `Figure N:` 图注，另外 3 个是第 11 页页顶的无图注矢量小图（conf 0.65，面积比 0.0245），框内无正文文本，判真阳性；没有区域落在正文或图注上。
- **第 1 页三枚图标**：三个 placement 面积比 < 0.004，按 `below-min-area` 拒绝。规则依据：小于 0.4 % 页面的 XObject 属于图标 / 项目符号 / 装饰，不具备独立原色覆盖价值。
- **第 7 页 Figure 5（唯一已知 false negative）**：图注存在，但该栏没有对应 XObject placement——图形由直接矢量路径绘制，未经过 Form 或 Image XObject。规范 §2.5 允许此类暂不处理，检测器不推断"图表不存在"，只做不覆盖。（v0.1.16 已恢复，见第 8 节。）
- **第 7 页 Figure 6**：面积比 0.0162，低于 0.02，但具备图注锚定且 confidence 0.80 ≥ 0.6，因此接受。依据：`unanchoredImageMinAreaRatio` = 0.02 只约束"无图注的独立图片"，图注锚定优先。
- **第 7 页 1 处、第 11 页 3 处 `no-figure-evidence`**：通过基础过滤但无图注、无结构标签、非独立大图（confidence 0.45 < 0.6），保持不覆盖。第 11 页三处并排块位于页面上部（用户空间 x 56.5–555.5、y 626.9–710），是无图注 Form，宁漏不错覆盖。
- **`dropped-row`（v0.1.17 已补）**：与某图注绑定但未落入所选行的 placement 过去被静默丢弃、不留 reject 记录；现在逐条记为 `dropped-row`。全文档共 1 条（第 11 页），其余页面的 placement 要么被接受、要么已有明确原因。
- **第 13 页 Figure 16 / Figure 17（遗留限制，非本次回归）**：三条图注 `Figure 15/16/17` 排在同一基线上（三栏并排），段间间隙分别为 15.93 pt（1.60 个字体单位）与 16.40 pt（1.65 个字体单位），均小于 2 个字体单位的切段阈值，因此该行不切段，只有行首的 `Figure 15` 被当作图注。v0.1.16 及更早版本同样如此；阈值不为这两条图注下调，否则会在正文词间距（最大约 2.0 个字体单位）处误切。

## 7. 本阶段未验证的部分

| 项目 | 状态 | 说明 |
|---|---|---|
| Zotero reader 的 pdf.js `getOperatorList()` 是否给出相同 operator 与矩阵 | 待 B 实机验证 | 已在 pdfjs-dist 4.10.38 与 6.5.438 上验证 operator 一致 |
| `/Figure` 结构标签路径 | NOT TESTED（真实文档） | 本 fixture 无 `/StructTreeRoot`，仅单元测试覆盖 |
| Image XObject 路径 | NOT TESTED（真实文档） | 本 fixture 第 5 页 0 个 Image XObject，仅单元测试覆盖 |
| 直接矢量路径图的召回 | 已知 unsupported | 见第 7 页 Figure 5 |

## 8. v0.1.16 复测（矢量路径检测层）

检测层补上 `constructPath` / `rawFillPath` 出口并做近框链式合并后（参数与验证见
`A3_BUILD_AND_LIMITS.md` 第 16 轮），`npm run detect` 重写本报告的 `A1-detection.json`，要点：

- **false negative 清零**：15 条 Figure 图注全部有区域覆盖，第 7 页 Figure 5 以 `kind:"path"`
  区域 `[57.46,75.19,291.55,305.04]`（conf 0.85）覆盖；Figure 6 区域扩为 `form+path`
  `[320.37,72.45,560.49,165.43]`（conf 0.90），含 6a 面板及其标签。
- **第 11 页新增 3 个 `kind:"path"` 区域**（conf 0.65，无图注）：页顶三个无图注矢量小图，框内无正文
  文本，判真阳性；原三个无图注 Form 带仍按 `no-figure-evidence` 拒绝，不变。
- **无回归**：第 5 页 oracle rect 不变（最差角点差 4e-5）；第 1/2/4/8/14/15/16 页仍 0 区域（第 1 页
  logo 簇、第 4 页装饰簇分别被 `path-below-area-threshold` / `below-min-area` 拒）；第 3/6/9/10/12/13
  页 caption 图块 rect 不变（仅第 13 页 y0 635→634，路径并入所致）。
- 观察到的 false positive 仍为 0；`tests/js/fixture-detect.test.mjs` 断言 `uncovered = []`。
- **v0.1.18 对本文档结果无影响**：新识别规则在 PipeWrite 夹具上零触发（16 页均无吸收，图注行无侵入裁剪），
  `reports/A1-detection.json` 全部 18 个区域 rect/conf/evidence 与上表一致，第 1 页拒绝原因仍为
  3 × `below-min-area` + 1 × `path-below-area-threshold`。
