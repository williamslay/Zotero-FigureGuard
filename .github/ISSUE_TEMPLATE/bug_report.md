---
name: Bug report
about: 反馈图表漏检/误检、工具栏按钮异常或显示问题
title: "[Bug]: "
labels: bug
---

## 环境信息

- **操作系统**：（例如 Windows 11 / macOS 15 / Ubuntu 24.04）
- **Zotero 版本**：（例如 10.0.8 / 7.0.x）
- **Figure Guard 版本**：（可在插件列表或 `probeAll().version` 查看）

## 问题描述

请简要描述发生了什么，以及你期望的行为。

## 复现步骤

1. 打开哪类 PDF（普通论文 / 扫描件 / 双栏排版等）
2. 执行了什么操作（切换标签、滚动、缩放、点击「原色」开关等）
3. 实际看到的现象

## 诊断信息（可选，排查集成问题时非常有帮助）

在 Zotero 中打开 **工具 → 开发者 → Run JavaScript**，运行：

```js
Zotero.getMainWindow().FigureGuard.probeAll();
```

<details>
<summary>粘贴输出 JSON（如有）</summary>

```json

```

</details>
