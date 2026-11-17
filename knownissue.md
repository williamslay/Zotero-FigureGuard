# Zotero Figure Guard — 已知问题

记录当前仍未闭环的问题：现象、已排除项、现有证据、代码状态、下一步判别法。架构与约定见 [AGENTS.md](./AGENTS.md)。

状态标记：**待真机** = 代码已在 `dev` 上改完并通过两级测试，等真机结论；**未解决** = 还没有可靠修法；**未验证** = 已实现但没人跑过。

真机环境统一为 Zotero 10.0.8 / Windows。

## 1. 工具栏「原色」开关单击不生效 — 未解决

**现象**：单击开关既不改按钮样式也不改图表颜色，需要连点两下；双击的每一次按下都被记录，且各只动作一次。

**已排除**（都有实测或源码依据）：

- 事件绑定方式：改绑 `pointerdown` 后症状不变。
- 覆盖层拦截：覆盖层是 `pointer-events: none`。
- 图标本身：开关已是纯文字。
- 窗口激活：重新激活 Zotero 窗口后，原生工具栏按钮第一次单击就生效；但先点 PDF 页面空白处激活、再单击我们的开关，仍然无效。
- 原生 tooltip 吃掉首次按下：Windows 上 tooltip 由系统显示（mozilla-central `layout/xul/nsXULTooltipListener.cpp:554-556`），且 tooltip 不捕获鼠标（Raymond Chen, The Old New Thing, 2020-01-10）。Zotero/Firefox 语境里没有该症状的先例记录。去掉按钮 `title` 后症状不变。
- 读数本身不可信：读数一度挂在 tooltip 里，现在渲染进按钮内的 `span.fg-count`，不悬停也能看到，冻结状态可复核。

**决定性证据**（构建 SHA256 `e6dfb0be…`）：单击那一次 `D/W/B/M/I` 全为 0，`@-,-`、`x=?`，即五个候选目标（`renderToolbar` 给的 document、它的 `defaultView`、按钮本身、主窗口 document、reader 内层文档）都没看到这次 pointerdown。间隔约 1 秒连点两次单击，计数仍全 0。chip 尺寸 225x25，说明被点的就是我们正在读数的那颗节点。

**代码状态**：`dev` 上 `6d615ce` 把激活改成阶梯 `pointerdown` → `mouseup` → `click`，一次按下序列只动作一次，`pressActivated` 负责去重，键盘 `click`（`detail === 0`）绕过该标志。此前 click 被 `detail === 0` 过滤挡住了，而 Zotero 自身的阅读器工具栏按钮全部只用 `click`，所以这一档最可能才是真实通路。

**下一步判别法**：

- 单击时 `m` 或 `k` 增加且颜色恢复 → 问题解决，删除全部临时计数。
- `m` 或 `k` 增加而颜色仍是灰的 → 事件侧已通，问题在绘制侧。
- `m`/`k`/`p` 全不动 → 输入根本没进 iframe 的 DOM，DOM 按下类监听已耗尽，需要换 Zotero 层面的触发（挂进 Zotero 自己的 React 工具栏，或改用不受该 iframe 焦点流程影响的宿主）。

## 2. 开关节点会丢失，且跨重启与切标签不复原 — 待真机

**现象**：某个 tab（普通 PDF）上开关完全不见，反复关闭并重开 Zotero 多轮、切换标签多轮之后仍是丢失状态；而该 tab 的图表原色功能照常生效。

**结论**：会话活着、`renderToolbar` 确实回调过，丢的只是按钮节点。

**原因层级**：`renderToolbar` 的容器每次派发前先 `replaceChildren`（zotero/reader `src/common/components/common/custom-sections.js:18`），我们追加的节点随之清空；该事件每个 reader 文档只派发一次。我们的 `append` 是同步的，所以不是 `append` 抛错，而是节点被清空之后没有任何机制再补挂——此前唯一的回归路径是下一次 `renderToolbar`。

**代码状态**：`dev` 上 `6d615ce` 新增 `maintainButtons()`（`src/zotero/main.js:334`），由 `wakeTabSessions` 调用（不新增监听器、不新增定时器）。重挂条件：`link.button.isConnected === false` 且该 toolbar document 内没有我们的 `.fg-toggle`；优先 `link.parent.appendChild`（父节点仍在文档时），否则退回本次 render 记录的 `append` 回调，两者都失败则 `warnOnce("button-reattach", …)`。`probeAll()` 每条会话新增 `button: {mounted, hasParent, hasAppend}`。

**下一步判别法**：切到那个 tab 看开关是否回来；若仍不见，看 `probeAll()` 里该会话的 `button.mounted` / `hasParent` / `hasAppend`，并找控制台里的 `button-reattach` 日志。

## 3. 滚动一段时间后图表重新变灰 — 待真机

**现象**：开启后图表恢复原色，但上下滚动一段时间，所有图表又变回暗黑模式下的灰色；关掉再打开开关可以恢复。变灰时图表位置与大小正常，说明区域缓存没问题，是覆盖层 canvas 掉了出去。

**原因**：阅读器滚动时 Zotero 会回收并重建 pageView，挂在旧 `pageView.div` 里的 canvas 随之离开文档；而稳定重绘检查过去只看视口几何（`geometryStale()`），几何没变就跳过这一页，记录仍写着 painted，却没人重挂 canvas。

**代码状态**：`dev` 上已改为几何变化、或 canvas 已不在文档（`isMounted()` 为 false）两种情况都重绘，并走 `attachPageNumber()` 把记录重绑到活的 pageView。触发仍依赖已有的 `pagerendered` 与开关、文档切换等站点，没有新增监听器或定时器。

**待真机确认两点**：滚动过程中是否仍能看见灰→色的恢复延迟；是否存在完全不触发 `pagerendered` 的页面回收路径（那种情况下稳定检查不会被 arm，仍需别的触发点）。

## 4. 首次恢复偶尔有延迟 — 未解决（本轮未改）

检测是异步的，多区域是逐个串行光栅化（pdf.js 一页只跑一个渲染任务），首绘还可能跑在 pdf.js 建好 page view 之前，由既有的 `catchUpPaint` 兜一次。属于已知代价，不是缺陷回归。

## 5. 文档计数漂移 — 待同步

README「运行测试」一节的用例数此前停在 405（CI 级）与 487（完整回归），实际已到 430 与 512。本轮已在 README 与 AGENTS.md 同步；此后每次改动测试都要一并更新这两处。

## 6. 未验证项清单

- Release 工作流「Release 已存在」的守卫分支从没真正跑过（只有一个线上 Release）。
- 插件列表里的图标渲染未真机确认（`manifest.json` 的 `icons` 指向 `content/figureguard-icon.svg`）。
- HiKV 的图 7/8/9 检测效果未逐张核对。
- `probeAll()` 在真机上的完整字段（含新增的 `button`）未跑过。
- GitHub 仓库设置未确认：Settings → Actions → Workflow permissions 是否为 `contents: read`；Artifact 保留天数；`main` 上没有分支保护。
- 仓库 About 的描述与 topics 未填。

## 7. 检测覆盖的已知边界

- 规则按学术 PDF 的常见图表形态调校：矢量路径、Form XObject、双栏排版。纯位图扫描件与特殊着色方式尚未覆盖。
- 图注与图相隔较远的排版、并排小图各自成带等边界情形，仍会漏检或并错。
- Zotero 大版本升级后 pdf.js 的内部结构可能变化，排查入口是 `probeAll()` 的字段。

## 清理待办

真机结论确定后要一并移除的临时诊断件：读数里的全部计数器（`p t c m k D W B M I U a` 与 `@x,y`、`x=`、`LT=`）、`span.fg-count` 及其 CSS 规则、以及为定位而加的多余绑定目标。AGENTS.md 的「激活阶梯与临时读数」一节列出了它们。
