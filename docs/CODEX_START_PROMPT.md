# 直接交给 Codex 的完整启动任务

请在当前目录完成 **Zotero Figure Color Preservation 插件 — Stage A** 开发，不要询问用户是否安装 Zotero。本项目的 Stage B 才由用户在真机 Zotero 上完成。先认真阅读 `README.md`、`docs/STAGE_A_IMPLEMENTATION_SPEC.md`、`docs/DECISIONS_AND_RISKS.md`、`docs/STAGE_B_USER_CHECKLIST.md`。

本包已包含真实测试论文 `fixture/PipeBWrite.pdf`、第 5 页 Figure 2/3 的原色参考图、verified fixture JSON、PDF 对象扫描脚本和 Python smoke tests。你需要开发实际运行在插件中的 JavaScript 自动图形检测模块；现有 Python 脚本只是校准基准，不能作为 Zotero 插件的运行时依赖。

**执行要求**

1. 遵循最简原则，优先自动识别 `/Image`、`/Form` XObject 和可用 PDF Figure 结构标记；不能把所有 Form 当 Figure。对本论文自动匹配 Figure 2/3 及相邻 caption，页面 bbox 与 fixture 误差不超过 2pt，不硬编码文件哈希、页码、Form 名称或坐标。首次成功后检查全 PDF 的误判情况。
2. 优先检查当前公开的 Zotero Reader / PDF.js 源码与具体 version/tag，确定可复用 API。`PDFPageProxy.getOperatorList()` 的 Form 边界是否保留必须离线实测；若不保留，选择能够在真实插件 JS 运行时执行的最小替代方案，不能以 Python 作为替代。
3. 优先使用自动定位 + 独立原色 Canvas 裁剪覆盖的实现。Zotero 10 的 `ctx.skipBlender` 属于特定版本内部接口，要标注风险、准备 B 阶段验证；不要未经验证就声称已恢复 Zotero 真机原色。
4. 使用独立浏览器/Node PDF.js harness 离线验证原色 Figure 渲染、页面/裁剪坐标及缩放。可以使用 Playwright 或同类工具；不要引入 OCR/ML 或服务端依赖。
5. 实现 bootstrapped Zotero 插件源码及可重复构建的 `.xpi`。默认自动图形识别，附一个简单启用/停用开关；不做手动框选功能，不修改 PDF，不做 telemetry。
6. 在 `reports/` 中留下 A0/A1/A2/A3 每个阶段的源码依据、实际命令、PASS/FAIL/BLOCKED 结果、图片/日志及已知限制。确保离线 JS tests 实际运行通过；不能只写伪代码。
7. 交付 `dist/figure-color-preservation-0.1.0.xpi`、所有源码、构建脚本、测试和 Stage B 安装/故障反馈说明。没有 Zotero 软件时将 XPI 标为 **candidate / not integration-tested**。

不得把原始论文 PDF 发布到公共代码仓库。无需让用户参与 Stage A 的每一个步骤；你应自主完成 A0→A3 并提交尽可能完整的候选插件。若遇到确实不可跨越的接口差异，提交已完成的模块、最小阻塞说明与可供 Stage B 确认的日志，不要虚报成功。
