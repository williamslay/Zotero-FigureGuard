# A2 — 原色局部裁剪渲染与覆盖几何

结论：**PASS（离线）**。pdf.js 在 Node + `@napi-rs/canvas`（非 Zotero、非 Playwright）环境下，对自动识别出的 Figure bbox 做局部原色渲染：尺寸、像素误差、语义色类分布与墨量全部满足本文件定义的验收标准；100 % / 150 % / 200 % 缩放与页面旋转的坐标函数通过测试。此处证明的是**裁剪与坐标算法**，不证明 Zotero 的 `skipBlender` 生效。

## 1. 运行方式与环境

```bash
npm run render    # 生成 reports/A2-render.json 与 reports/A2/*.png
npm test          # tests/js/render.test.mjs：8 tests / 8 pass（A2 验收断言）
```

| 项 | 值 |
|---|---|
| Node.js / npm | v22.23.0 / 10.9.8 |
| pdfjs-dist | 6.5.438（`pdfjs-dist/legacy/build/pdf.mjs`） |
| Canvas 后端 | `@napi-rs/canvas` 1.1.0（Node 无浏览器 Canvas） |
| 参考图 | `fixture/figure2-original-3x.png`、`fixture/figure3-original-3x.png`（Python oracle 生成） |
| 渲染参数 | `padViewport` = 1.6 CSS px（每边），参考图对应 `overlayGeometry({ scale: 1, deviceScale: 3, padViewport: 1.6 })` |

`padViewport` 是 CSS 像素，不随缩放变化；栅格尺寸 = `scale × devicePixelRatio`。参考 PNG 即页面坐标下 3× 裁剪、每边约 1.6 pt padding，因此与本 harness 的默认参数直接可比。

## 2. 误差度量定义

| 度量 | 定义 | 阈值 | 设立理由 |
|---|---|---|---|
| 尺寸 | 裁剪画布宽/高 与参考 PNG 之差 | ≤ 2 px | 允许 `ceil` 取整与 padding 舍入 |
| MAE | 重叠区域逐通道平均绝对误差（0–255） | ≤ 8 | 抗锯齿相位差可容忍，色道错乱会远超 |
| 语义色类比 | 各色类像素占比 与参考占比的**相对差** | ≤ 15 % | 防止整体相似度掩盖语义色丢失 |
| 墨量 | 非白像素比 `nonWhiteRatio` 之差 | ≤ 0.05 | 检测裁切错位、区域过大致正文进入/图形丢失 |
| 缩放对齐 | 裁剪图与整页渲染同区域的**最佳对齐位移** | 必须为 `0,0` | 位移非零说明 overlay 坐标随缩放漂移 |
| 重复渲染 | 同参数两次渲染 MAE | = 0 | 无跨渲染状态泄漏 |

语义色类由 `tests/js/helpers/png.mjs` 的 `semanticClasses()` 判定（通道条件固定）：

- `gray`：三通道近似相等且亮度在 200–235（Figure 2 灰柱，对应桶 `224,224,224`）
- `beige`：R ≥ 235、G ≥ 220、R−B 在 10–45（米色柱，对应桶 `224,224,192`）
- `green`：G−R ≥ 12 且 G−B ≥ 12（Figure 3 彩色数据系列）
- `yellow` / `cyan` / `magenta`：对应通道占优条件
- `black`：最大通道 < 64（坐标轴与文字）
- `colored`：max−min > 20（任意非灰彩色）

**为什么不只用 MAE**：`gray`/`beige`/`colored` 占比在整幅图中占主导，整体 MAE 对"米色变成灰色"这类语义错误不敏感；因此色类比与墨量是主判据，MAE 是辅助判据（见 §5 灰度负控）。

## 3. 测量结果（3× 渲染 vs 参考 PNG）

| 检查 | Figure 2 | Figure 3 | 阈值 | 结果 |
|---|---|---|---|---|
| 尺寸 | 730×316 / 参考 730×316 | 730×438 / 参考 730×438 | ±2 px | PASS |
| MAE | 2.586 | 3.482 | ≤ 8 | PASS |
| `nonWhite` | 0.8636 / 0.8650（Δ 0.0014） | 0.7067 / 0.7072（Δ 0.0005） | Δ ≤ 0.05 | PASS |
| `gray` 占比 | 0.4473 / 0.4494（相对差 0.5 %） | 0.2446 / 0.2492（1.8 %） | ≤ 15 % | PASS |
| `beige` 占比 | 0.3166 / 0.3141（0.8 %） | 0.2814 / 0.2778（1.3 %） | ≤ 15 % | PASS |
| `green` 占比 | 0 / 0 | 0.0268 / 0.0271（1.1 %） | ≤ 15 % | PASS |
| `yellow` 占比 | 0 / 0 | 0 / 0 | ≤ 15 % | PASS |
| `black` 占比 | 0.0607 / 0.0575（5.6 %） | 0.0565 / 0.0505（11.9 %） | ≤ 15 % | PASS |
| `colored` 占比 | 0.3178 / 0.3167（0.3 %） | 0.3085 / 0.3118（1.1 %） | ≤ 15 % | PASS |

要点：Figure 2 的灰色与米色两类均在容差内；Figure 3 的绿色数据系列（`green` 2.7 %）与彩色总体保留。`black` 类相对差最大（Figure 3 为 11.9 %），原因是 3× 下细线与坐标轴抗锯齿落在 64 阈值边界，绝对差仅 0.6 个百分点。

产物：`reports/A2/figure2-pdfjs-3x.png`、`reports/A2/figure3-pdfjs-3x.png`、`reports/A2-render.json`（含全部数值与位移扫描）。

## 4. 缩放一致性（100 % / 150 % / 200 %）

裁剪画布必须与"整页渲染后按同一 CSS 框取窗"落在同一像素上。判据是**最佳位移为 `0,0`**（在 −2…+2 px 位移扫描中），并附加色类与墨量容差；MAE 只作记录，因为裁剪画布起点位于小数设备像素时抗锯齿相位与整页画布不同。

Figure 2：

| 缩放 | 裁剪 / 期望 CSS 框 | MAE | 最佳位移 | 最大色类绝对差 | `nonWhite` Δ |
|---|---|---:|---|---:|---:|
| 100 % | 244×106 / 243×105 | 12.069 | `0,0` | 0.0162 | 0.0049 |
| 150 % | 364×157 / 363×156 | 9.198 | `0,0` | 0.0068 | 0.0008 |
| 200 % | 484×208 / 483×207 | 7.757 | `0,0` | 0.0090 | 0.0019 |

Figure 3：

| 缩放 | 裁剪 / 期望 CSS 框 | MAE | 最佳位移 | 最大色类绝对差 | `nonWhite` Δ |
|---|---|---:|---|---:|---:|
| 100 % | 244×146 / 243×146 | 15.989 | `0,0` | 0.0104 | 0.0056 |
| 150 % | 364×217 / 363×217 | 11.884 | `0,0` | 0.0041 | 0.0019 |
| 200 % | 484×289 / 483×288 | 9.241 | `0,0` | 0.0026 | 0.0005 |

位移扫描证据（`reports/A2-render.json` 的 `shiftScan`）：`0,0` 在全部 25 个位移点中都是最小值，例如 Figure 2 @100 % 为 12.069，而相邻 `0,1` 为 14.457、`1,0` 为 13.954，`±2` 位移升到 18–31。

结论：CSS 定位与栅格尺寸随缩放线性一致，overlay 不漂移。

## 5. 灰度负控（防止相似度掩盖语义色）

把同一裁剪图转成灰度后再与参考比较，检查必须失败：

| 项 | Figure 2 灰度 | Figure 3 灰度 |
|---|---|---|
| MAE | 5.392（> 0） | 6.78（> 0） |
| `beige` | 0 / 0.3141（相对差 100 % → 失败） | 0 / 0.2778（100 % → 失败） |
| `colored` | 0 / 0.3167（100 % → 失败） | 0 / 0.3118（100 % → 失败） |
| `green` | 0 / 0 | 0 / 0.0271（100 % → 失败） |
| `gray` | 0.7647 / 0.4494（相对差 70 %） | 0.4667 / 0.2492（87 %） |
| `nonWhite` | Δ 0.0014（仍通过） | Δ 0.0005（仍通过） |

即：墨量与整体相似度**无法**发现颜色丢失，只有语义色类能发现。这正是规范 §3 A2 验收"不得只用整体像素相似度遮掩关键语义色的错误"的落实。

## 6. 旋转与 CropBox 坐标

通用坐标函数：`toViewportRect()`（基于 `convertToViewportPoint()`，pdf.js 6.x 已移除 `convertToViewportRectangle()`，缺该方法时回退到 `viewport.transform`）与 `overlayGeometry()`（CSS 框 + 栅格尺寸 + 设备空间平移）。

合成单元测试（`tests/js/viewport.test.mjs`）：

- scale 1 时与 Python oracle 的 top-left 框一致；线性缩放；
- 页面自身 `/Rotate` 处理；四个旋转象限（0/90/180/270）不翻转矩形；
- **CropBox 偏移**（非零 MediaBox 原点）；
- viewport 缺失时抛错而非猜测；缺 `convertToViewportPoint` 时回退 `transform`；
- 栅格尺寸 = `scale × devicePixelRatio`；CSS 框不超出已绘制页面。

fixture 旋转渲染（`overlayGeometry` + `renderRegion`，3×）：

| 旋转 | viewport | 裁剪 bbox（viewport px） | CSS 框 | 画布 | `nonWhite` |
|---:|---|---|---|---|---:|
| 0 | 612×792 | 54.0, 72.0, 294.1, 174.1 | 52.4, 70.4, 243.3×105.3 | 730×316 | 0.8636 |
| 90 | 792×612 | 617.9, 54.0, 720.0, 294.1 | 616.3, 52.4, 105.3×243.3 | 316×730 | 0.8633 |
| 180 | 612×792 | 317.9, 617.9, 558.0, 720.0 | 316.3, 616.3, 243.3×105.3 | 730×316 | 0.8614 |
| 270 | 792×612 | 72.0, 317.9, 174.1, 558.0 | 70.4, 316.3, 105.3×243.3 | 316×730 | 0.8631 |

旋转 90°/270° 时宽高互换、框仍在页面内、墨量与 0° 一致（Δ ≤ 0.0024，两个 Figure 均如此）。

A2 过程中修复的真实缺陷：`renderRegion()` 原先用未旋转的 viewport 建立渲染视口，导致 90° 时裁剪为空白、180°/270° 部分缺失；现按 `rotation: viewport.rotation ?? rotation` 建立渲染视口（`src/core/render.js`）。

pdf.js `render()` 的 `transform` 参数在本版本是**设备空间纯平移**（无 `outputScale` 参与），与"栅格尺寸由 `scale × deviceScale` 决定、平移量 = CSS 框原点 × deviceScale"一致，已由上表 §4 的对齐结果证实。

## 7. 稳定性与其他检查

- 重复渲染：同参数两次裁剪 MAE = 0，`nonWhite` 与色类完全一致（阈值 size 0 px、MAE 0.5、色类 0.001、墨量 0.001）。
- 每个区域的裁剪由一次 `PDFPageProxy.render()` 完成，`RenderParameters.transform` 承担裁切，未修改 PDF 本体。
- Node 环境注意：全局无 `ImageData`，需从 `@napi-rs/canvas` 导入；`ImageData` 不支持区域切片，取窗需逐行复制。

## 8. 本阶段未证明的部分

| 项目 | 状态 | 说明 |
|---|---|---|
| Zotero 的 Blender 跳过（`ctx.skipBlender`） | 待 B 实机验证 | 本实验用未做颜色反演的 pdf.js，证明的是裁剪算法本身 |
| Zotero reader iframe 内真实 Canvas 与 devicePixelRatio | 待 B 实机验证 | Node 用 `@napi-rs/canvas`，非 Gecko Canvas |
| overlay 在真实滚动/双栏视图中的对齐 | 待 B 实机验证 | 几何函数已按 viewport 计算，需实机确认 DOM 挂载位置 |
| 高 DPI（dpr 2/3）在 Gecko 上的像素结果 | NOT TESTED | 仅 Node 侧 dpr 3 验证 |
