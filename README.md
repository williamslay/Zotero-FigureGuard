# Zotero Figure Color Preservation — Stage A / Stage B 交接包

> 本包是 **Codex 的开发输入**，不是已完成或验证通过的 Zotero 插件。

目标：保留 Zotero 10 原生 PDF 页面布局和 Dark Theme；自动识别图表区域，将这些区域以 PDF 原始颜色显示（允许局部白底），不修改 PDF，不进入 Reading Mode。

**实施分工**

- **Stage A — Codex 独立交付**：无需安装 Zotero；完成技术路径确认、JavaScript/TypeScript 自动识别实现、独立 PDF.js 渲染实验、插件源码、可安装的候选 `.xpi`、离线测试与测试报告。
- **Stage B — 用户实机验收**：在真实 Zotero（用户自行提供版本）安装候选插件并检验 Dark Theme、双栏排版、Figure 2/3、滚动/缩放/标注及兼容性。仅 Stage B 可以证明最终 Zotero 集成有效。

## Codex 从这里开始

1. 阅读 [`docs/STAGE_A_IMPLEMENTATION_SPEC.md`](docs/STAGE_A_IMPLEMENTATION_SPEC.md) —— **唯一规范文档**，覆盖之前的“手动框选 MVP”版本。
2. 阅读 [`docs/DECISIONS_AND_RISKS.md`](docs/DECISIONS_AND_RISKS.md) —— 明确已确认事实与有待验证的内部 API。
3. 本地运行 `python -m pip install -r requirements-dev.txt`，然后 `python -m unittest discover -s tests -v`。
4. 以 [`docs/CODEX_START_PROMPT.md`](docs/CODEX_START_PROMPT.md) 为任务指令，按 A0→A1→A2→A3 阶段开发。
5. 按 [`docs/STAGE_B_USER_CHECKLIST.md`](docs/STAGE_B_USER_CHECKLIST.md) 提供人工验收指引与诊断材料。

## 内容

```text
README.md
requirements-dev.txt
fixture/
  PipeBWrite.pdf                  原始测试 PDF（私有测试用，不得向公开仓库推送）
  fixture-verified.json           第 5 页结构对象及坐标预期
  figure2-original-3x.png         Figure 2 原色参考
  figure3-original-3x.png         Figure 3 原色参考
  page5-original-2x.png           整页原色参考
scripts/
  inspect_pdf.py                  独立 PDF 对象定位脚本（Python oracle）
tests/
  test_fixture.py                 无 Zotero 的结构检查
  test_package_structure.py       交接包完整性检查
docs/
  STAGE_A_IMPLEMENTATION_SPEC.md  核心开发约束 / 阶段 A 交付要求
  DECISIONS_AND_RISKS.md          技术判断与禁忌
  STAGE_B_USER_CHECKLIST.md       人工安装及回报模板
  CODEX_START_PROMPT.md           可复制指令
  REFERENCES.md                   资料出处
```

### 关键事实

第 5 页 `/Im5`、`/Im6` 是 **Form XObject**（非 `/Image`）：分别对应 Figure 2、Figure 3；PDF 不含结构树 `/StructTreeRoot`；这篇测试 PDF 无法靠“仅保留 Image XObject 原色”解决。`getOperatorList()` 是否携带 Form 的边界与可用信息必须由 Codex 在目标 PDF.js 版本中实测。

### 不属于 Stage A 的保证

- 不能保证某个 `.xpi` 在尚未测试的 Zotero 本机版本上能安装和正常工作。
- 独立 PDF.js 渲染通过，不代表 Zotero 的深色 Blender 能被成功绕过。
- `ctx.skipBlender` 等引用来自特定 Zotero 构建的第三方逆向验证，不是公开稳定 API。
