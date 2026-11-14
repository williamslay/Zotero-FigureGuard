# Stage B：用户在真实 Zotero 中的验收清单

**只有 Stage A 的 Codex 交付候选 `.xpi` 后才需要执行。** 建议先备份 Zotero 数据目录或使用独立测试 profile；所有 PDF 保留原件。

## 先反馈环境信息

- 操作系统：Windows / macOS / Linux，版本：______
- Zotero “帮助 → 关于 Zotero”中的版本：______（如能提供 Build ID 一并提供）
- 安装的候选插件版本 / XPI 文件名：______
- Zotero PDF 外观主题：Dark / Black / Custom / Other：______（Zotero 8+ 为 reader 深色主题开关）
- 是否安装其它 PDF 色彩插件：______（首次最好暂时禁用，排除冲突）
- Zotero 大版本属于：7.x / 8.x / 9.x / 10.x：______（深色机制不同：7 是 CSS，8+ 是渲染期重着色）

## 安装与功能

> **安装失败排查（0.1.0）**：首个包安装时报“could not be installed. It may be incompatible with this version of Zotero”。原因是 Zotero 解析 manifest 时强制要求 `applications.zotero` 同时提供 `id`、`update_url`、`strict_max_version`，0.1.0 缺少 `update_url`，整个 manifest 解析失败。0.1.1 已补齐该字段并把 `strict_max_version` 放宽到 `10.9.9`。请使用 `dist/figure-color-preservation-0.1.1.xpi` 重新安装；若仍报同一错误，请回传“帮助 → 关于 Zotero”的精确版本。

- [ ] 打开 Zotero，菜单 `工具 → 插件`（或所在版本中的 Add-ons 管理器），从文件安装 XPI；关闭并重新打开 PDF 视图。
- [ ] 插件显示为已启用，无版本不兼容提示。
- [ ] 打开任意 PDF 后，阅读器工具栏出现一个「原色」按钮（自动模式默认开启，点击可临时停用/启用覆盖层）。
- [ ] 打开 `PipeBWrite.pdf` 第 5 页，设置 Zotero Dark Theme。
- [ ] Figure 2 自动恢复灰色 Urgent Zone 与米色 Non-urgent Zone，仍是局部白色或浅色底。
- [ ] Figure 3 自动恢复绿色、黄色等原始语义配色。
- [ ] 普通正文和 Figure Caption 保持深色主题；双栏和分页无变化。
- [ ] Figure 2/3 不偏移、不裁断（对比离线提供的原色图）。
- [ ] 缩放 100%、150%、200% 后边界仍对齐，不闪烁或积累重复图层。
- [ ] 滚动离开并返回第 5 页、切换 Tab 和重开文献后正确恢复。
- [ ] 选择/复制正文、查找、高亮、滚动、右键标注不受影响。
- [ ] 关掉「原色」开关后恢复 Zotero 原显示；再打开后原色恢复；关闭 Zotero/重启没有明显异常。

## 诊断（失败时必填）

菜单位置：`Run JavaScript` 在 **工具 → 开发者 → Run JavaScript**（英文界面 Tools → Developer → Run JavaScript，窗口标题「执行 JavaScript」）。日志窗口在 **帮助 → 调试日志（Debug Output Logging）→ 查看输出日志**；JS 报错窗口在 **工具 → 开发者 → Error Console**。

0. **0.1.9 起首选：逐 reader 探针（不需要选中标签）**，同窗口执行并回传整串：

   ```js
   JSON.stringify(Zotero.getMainWindow().FigureColorPlugin.probeAll())
   ```

   返回 `{at, sessions:[…], active, count, log}`。`sessions` 每个条目对应一个已打开的 PDF reader：
   `key` 是 `item:<编号>`；`ready/innerWin/eventBus` 是该 reader 是否已被插件接管；
   `realm` 是插件锁定的那个窗口的自述（`pva` 是该窗口上 `PDFViewerApplication` 的 typeof、
   `frames` 是该窗口内 iframe 数、`href` 是它的地址，截断 120 字符；跨 realm 读取抛错时另有 `realmError`）；
   `overlays` 是挂上的覆盖层页数；`currentPage` 是当前页；`target` 是该页覆盖层的像素证据
   （`page.nonWhite` 页面自身有墨比例、`regions[].nonWhite` 覆盖层有墨比例、`regions[].mean` 平均色、
   `regions[].grid` 5×5 平均 RGB、`regions[].errClass` 该块是否绘制失败、`paintError` 失败原因）；
   最多报 8 个 reader，超出时 `truncated:true`。沙箱读不到 `Zotero_Tabs.selectedID`，
   所以必须逐个 reader 报，不能只看一个。
   0.1.8 的 `probePaint(pageNumber)` 仍可用，但它只看第一个 reader，后台标签会给出 `target:null`。

1. 菜单 `工具 → 开发者 → Run JavaScript`，粘贴执行并在报告里回传返回的整串文本。（该窗口以 eval 方式执行：**顶层不能写 `return`，也不能以 `const` 声明结尾**，最后一行必须是表达式，否则报 `SyntaxError: return not in function`。）

   ```js
   var P = Zotero.getMainWindow().FigureColorPlugin;
   var reader = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID);
   var s = P ? P.getSessions().find((x) => x.reader === reader) : null;
   var w = s ? s.innerWin : (reader?._internalReader?._primaryView?._iframeWindow ?? null);
   var pv = w?.PDFViewerApplication?.pdfViewer ?? null;
   var n = pv ? (pv._pagesView ?? pv._pages ?? []).length : -1;
   JSON.stringify({
     plugin: !!P,
     session: !!s,
     enabled: s ? s.enabled : null,
     ready: s ? s.ready : null,
     docId: s ? String(s.documentId ?? null).slice(0, 12) : null,
     overlays: s ? s.overlays.size : null,
     canvases: s ? s.overlayCount() : null,
     innerWin: !!w,
     pdfDoc: !!pv?.pdfDocument,
     pageViews: n,
   })
   ```

   说明：Run JavaScript 用 `win.eval` 在主窗口 realm 执行；插件全局在 Zotero 的 bootstrap 沙箱里，主窗口看不到。0.1.2 起插件启动时把句柄发布到主窗口，用 `Zotero.getMainWindow().FigureColorPlugin` 取；0.1.1 及更早版本里 `globalThis.FigureColorPlugin` 为 undefined 属正常，不代表插件未加载。

   期望：`plugin:true, session:true, ready:true, docId` 非 null，翻到第 5 页后 `overlays≥1`、`canvases≥1`。

2. **首选探针（0.1.6+，从插件自己的 realm 读数）**，同窗口执行并回传整串：

   ```js
   JSON.stringify(Zotero.getMainWindow().FigureColorPlugin.runProbe())
   ```

   返回字段含义：`reader` 当前 reader 的类名；`session.attempts` 就绪轮询次数（250 表示跑满 20 s）；
   `session.innerWin` 是否解析到 pdf.js 窗口；`chain.k1/k2/k3` 是三条直连通道各自看到的类型；
   `chain.bridgeType`/`bridgeWin` 是 realm 桥（在主窗口 realm 求值）的结果；`timers.setTimeout` 应为
   `"function"`；`log` 是被沙箱吞掉的告警原文。判读：`chain.k3:"object"` 而 `session.innerWin:false`
   → 解析时机/逻辑问题；`chain.k3:"undefined"` 且 `bridgeWin:"object"` → realm 桥为唯一可用通道。
   `probeAll` 的补充判读（0.1.11 起以 `realm.route` 为准）：`realm.pva:"undefined"` 不再说明锁错窗口，
   要看 `realm.route`——`"cu-unwrap"` 或 `"wrapped"` 表示插件经该路线读通了 pdf.js 内部（此时
   `eventBus` 应为 `true`）；`route:null` 而 `realm.href` 为 `web/viewer.html` 表示三条路线都读不到该
   属性，属沙箱可见性问题，插件继续 20 s 心跳；`href` 为 `reader.html` 才是锁到外层 realm。
   `chain.readersSrc` 说明 reader 列表来源（`"_readers"` 表示该 Zotero 无 `getOpenReaders()`），
   `chain.bridgeRoute` 非 null 表示 realm 桥已可用。日志有 `recovery-slow:item:<编号>` → 180 s 快轮
   已用完，插件降到 20 s 心跳继续重试，不会放弃。

3. 本插件的告警以 `[figure-color]` 为前缀：`console.warn` 只在 **工具 → 开发者 → Error Console**
   （Firefox Browser Console）可见；0.1.6 起同时写入 `Zotero.debug`，所以在 **帮助 → 调试日志 →
   查看输出日志** 也能搜到。异常时贴出这些行原文。

## 最低截图回传

1. Zotero 版本 / About 界面截图。
2. 第 5 页 Dark Theme 全页截图（包含 Figure 2、Figure 3 及正文）。
3. Figure 2 和 Figure 3 放大截图各一张。
4. 若安装失败，直接截安装报错；若颜色错误，留诊断日志。

## 交还 Codex 的反馈格式

```text
Zotero version/build:
OS:
XPI version:
Install: PASS/FAIL
Auto detect Figure 2: PASS/FAIL
Auto detect Figure 3: PASS/FAIL
Original colors: PASS/FAIL
Text/captions stay dark: PASS/FAIL
Zoom/page alignment: PASS/FAIL
Annotations/text selection: PASS/FAIL
Toolbar toggle visible/works: PASS/FAIL
Reproduction steps:
Console/debug log excerpts:
Screenshots:
```

阶段 B 发现的 Zotero 专有兼容问题，Codex 修改后重新构建 XPI，用户复测。不必重新做阶段 A 已通过的基础 PDF 对象定位测试，除非相关逻辑被修改。
