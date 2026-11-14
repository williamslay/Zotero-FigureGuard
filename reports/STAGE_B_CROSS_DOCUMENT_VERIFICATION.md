# Stage B 真机验收 — 跨文档污染修复（候选 v0.1.27）

候选包：`dist/figure-color-preservation-0.1.27.xpi`。

> 前提：卸载或禁用 0.1.26，安装 0.1.27。先用 `probeAll()` 顶层 `version` 确认为 `0.1.27` 再开始。
> 指纹为准：文档 A = `fcp:bd8e2cda…`（item 316），文档 B = `fcp:3e708112…`（item 483）。

## 1. 测试步骤

按顺序执行，每步之后可采样一次探针（脚本见 §3）。

1. **启动 Zotero，首先打开 PipeBWrite（item 316）**。等第 11 页 Figure 出现原色保护。
2. **切换 / 打开 FluidKV（item 483）**，翻到第 11 页。**关键判定点**：白底区域应是 FluidKV 自己的 Figure，不再是 PipeBWrite 的三个区域。
3. 在 FluidKV 中 **off → on**（工具栏开关）。白色区域不应跳到另一篇论文的位置。
4. 在 FluidKV 中**改变缩放**（100% → 150% → 200%）。Figure 保护应跟随正确区域。
5. **反向顺序**：关闭两篇，先打开 FluidKV，再打开 PipeBWrite。重复步骤 2–4，结果应同样正确。
6. 关闭一篇 PDF 后**重新打开**，检查第 11 页仍正确。
7. **其他 PDF 不退化**：打开 Flash、Borges 等原本正常的 PDF，确认原色保护与开关行为不变。

## 2. 预期正常状态（探针判据）

对**已就绪**的每个 Reader 会话：

- `version` = `0.1.27`。
- `docId == freshDocId`，且 `docIdStale` = false。切换文档后 FluidKV 会话应显示 `fcp:3e708112…`，不再是 `fcp:bd8e2cda…`。
- `cacheKey` = `item:483|<该会话自己的 freshDocId>`。
- `staleKeyPresent` = false（旧键下没有残留区域）。
- `lastValidation` 有记录，`trigger` 标注触发来源（`select` / `heartbeat` / `bus` 等），`after` 为当前文档身份。
- 允许的安全退化：文档归属暂时未确认时**可以暂时不画**（无原色覆盖层），但正确 Viewer 就绪后必须自动恢复绘制；此时 `realmRoute` / `realmProvenance` 会显示 `bridge` / `bridge-guessed` 类未证实状态。
- 画布来源戳（`target.regions[].fcpRealm`）与会话 `realmId` 不一致只是**诊断信号**（画布 DOM 宿主窗口不同），不再单独代表 Bug——`realmStamp()` 的字符串差异不能证明两个真实窗口不同（Gecko 跨 Realm wrapper）。

## 3. 精简探针脚本

Zotero → 工具 → Run JavaScript，勾选「主窗口」，执行：

```javascript
const all = Zotero.FigureColorPlugin.probeAll();
const rows = (all.sessions ?? []).map(s => ({
  key: s.key,
  docId: s.docId,
  freshDocId: s.freshDocId,
  docIdStale: s.docIdStale,
  staleKeyPresent: s.staleKeyPresent,
  cacheKey: s.cacheKey,
  realmRoute: s.realm?.route ?? null,
  provenance: s.realmProvenance,
  realmOwned: s.realmOwned,
  realmId: s.realmId,
  canvasStamps: (s.target?.regions ?? []).map(r => r.fcpRealm ?? null),
  lastValidation: s.lastValidation ?? null,
}));
return JSON.stringify({ version: all.version, wake: all.wake, sessions: rows }, null, 2);
```

> `docIdStale`、`staleKeyPresent`、`lastValidation`、`realmRoute` 是 0.1.27 新增字段；若显示 `undefined`，说明装的仍是旧版或该字段名在最终包中不同——以 `probeAll()` 原始 JSON 为准记录。

## 4. 若再次失败，收集这些

1. 完整 `probeAll()` 原始 JSON（不要裁剪，含 `warn` 环与 `wake` 计数）。
2. 失败会话的：`docId` / `freshDocId` / `docIdStale` / `staleKeyPresent` / `lastValidation` / `realmRoute` 一行对照。
3. 失败前最后 5 条 `warn` 条目（尤其 `inner-window-missing` / `no-event-bus`）。
4. 复现动作序列：先开哪篇、切换方式（点标签 / 关闭再开）、是否 off-on、是否缩放。
5. 是否只在 316 ↔ 483 之间出现，其他 PDF 是否干净。
