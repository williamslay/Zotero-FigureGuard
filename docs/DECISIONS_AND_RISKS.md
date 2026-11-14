# 架构决策与风险边界

## 已确认事实（对本 PDF）

- 此 fixture 的 Figure 2/3 均为独立 Form XObject，而不是 Image XObject。
- Figure 2/3 的几何边界可由 `/BBox` + 可选 `/Matrix` + 外层 `cm` 累积 CTM 计算；真实图的填色需要保留。
- 该文档无 `/StructTreeRoot`，因而不能凭标准 `/Figure` 结构标签直接定位。
- 第 5 页的图注在 Form XObject 外，能作为自动识别附近文本证据。

## 必须在 A 阶段回答的问题

1. Zotero Reader 的 PDF.js `getOperatorList` 对 nested Form 的 begin/end、矩阵、BBox 有什么输出？是否可能扁平化？优先做可复现离线实验。
2. 如果 `getOperatorList` 信息不足，使用 JS 在运行时获得 PDF bytes/解析原始 Form 的最简方式是什么？插件不得依赖 Python。
3. PDF.js 另一个原色 canvas 可以用裁剪变换局部渲染吗？在普通浏览器中做到 100%、150%、200% 并截图。
4. Zotero 10 特定构建中 `skipBlender` 何时生效？是否只有 beginDrawing 前设置？
5. Zotero Reader 的插件入口和 viewer realm 如何接入？区分静态源证据与实机证据。

## 三条“不应偷换”的结论

- PDF 中存在 Form 对象 ≠ PDF 标记了 Figure 语义；需要筛选。
- **离线 Python 成功** ≠ 插件端 JavaScript 自动识别成功。
- **已生成 XPI** ≠ 在用户的 Zotero 版本里安装/工作成功。

## 降级方案

- 首选透明局部覆盖；若自动识别把某对象错当 Figure，应选择不覆盖、标记不确定，而不是白化整个页面。
- 若识别到 Form BBox，但字体/边框有少量遗漏，可在 Figure 内加入 1–2 pt margin，不包含图注。
- 若目标 Zotero 版本不再支持 `ctx.skipBlender`，提供明确版本诊断，不在运行时随意改写全局 `window.theme` 导致整页闪烁或影响别的标签页；先研究受控的隔离渲染办法。
- 如果 XPI 注入或跨 realm 的调用在无 Zotero 环境下不可验证，交付源码、候选 XPI、诊断日志开关和 B 的检查指南；不要掩盖。

## 非目标

- 自动 OCR 或机器学习 Figure 检测。
- 解析所有可能的 PDF 结构、字体与标注。
- 彻底取代 Zotero Dark Theme；重排 PDF 正文。
- 修改用户 PDF 或 Zotero 数据库。
- 内联网/云端遥测、自动上传 PDF。
