# 上游核对入口（Codex 应以实际使用的版本和代码为准）

1. Zotero Reader 源码：https://github.com/zotero/reader
2. Zotero 官方示例插件 make-it-red：https://github.com/zotero/make-it-red
3. Zotero 开发文档（Reader API / renderToolbar）：https://www.zotero.org/support/dev/zotero_7_for_developers
4. Zotero 插件开发介绍：https://www.zotero.org/support/dev/client_coding/plugin_development
5. PDF.js PDFPageProxy 文档（render / getOperatorList / getViewport）：https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html
6. Zotero PDF Noir 的 Zotero 10.0.6 Blender 分析：https://github.com/Zhanyuanium/Zotero-PDF-Noir/blob/main/docs/m0-findings.md

重要：PDF Noir 分析明确针对特定 10.0.6 构建；不可无核对套用到未知 Zotero 版本。其插件主要改动 raster image pipeline；本 fixture 第 5 页两个图是 Form XObject，因此不能仅沿用 drawImage hook。
