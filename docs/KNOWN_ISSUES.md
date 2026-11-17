# Zotero Figure Guard — 已知问题

记录当前仍未闭环的问题：现象、已排除项、现有证据、代码状态、下一步判别法。架构与约定见 [AGENTS.md](../AGENTS.md)。

状态标记：**待真机** = 代码已在 `dev` 上改完并通过两级测试，等真机结论；**未解决** = 还没有可靠修法；**未验证** = 已实现但没人跑过。

真机环境统一为 Zotero 10.0.8 / Windows。

## 1. 工具栏「原色」开关单击不生效 — 已解决（真机已验收）

**根因**：Zotero 阅读器的 `DIV.toolbar` 带有 `-moz-window-dragging: drag`；我们的 `BUTTON.fg-toggle` 设了 `appearance: none` 但未设置 `-moz-window-dragging: no-drag`（计算值为 `default`），导致 Windows 将单击当作标题栏窗口拖拽拦截，`D/W/B/M/I/U` 均未收到按下事件；双击时才漏出 `k1 + p1 = t2`。

**修复与清理**：已在 `TOGGLE_CSS` 与内联样式中显式设置 `-moz-window-dragging: no-drag`，并修复 `hitToggle` 对已挂载直接目标的命中（兼容键盘 `(0, 0)` 坐标）。真机已确认单击生效，随后已一并移除临时诊断计数、`span.fg-count` 及多余的跨文档/窗口绑定目标。

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

## 4. 首次恢复延迟与多标签并发 — 待真机（本轮已改调度）

此前 `repaintAttached()` 与 `onViewScaleChange()` 会用 `Promise.all` 把整篇 PDF 的所有页面并发全跑，且后台标签也会在 `start()` / `recoveryPass()` / `pagerendered` 中直接执行检测与渲染，导致打开新标签时首屏可见页被全篇以及后台页签抢占。本轮已改为仅前台执行（`isForeground()` + 切走即 `pauseBackgroundWork()`）、按 `currentPageNumber` 距离动态优先串行调度，并对同页 `detect()` 与 `inFlightPaint` 去重，待真机验证首屏变色速度与按钮响应性。

## 5. 文档计数漂移 — 已同步

自动更新清单与测试补齐后，[DEVELOPMENT.md](./DEVELOPMENT.md) 与 [AGENTS.md](../AGENTS.md) 的用例数已同步为 431（CI 级）与 513（完整回归）。此后每次改动测试都要一并更新这两处。

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
