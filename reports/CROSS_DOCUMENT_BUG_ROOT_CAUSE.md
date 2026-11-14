# 跨文档状态污染 — 根因报告（v0.1.27）

> 证据基线：Zotero 10.0.8 / Windows，v0.1.26 真机四次 `probeAll()` 采样（T1–T4）。
> 指纹为准：文档 A = `fcp:bd8e2cda…`（item 316，先开、健康）；文档 B = `fcp:3e708112…`（item 483，后开、被污染）。
> 注意：仓库 fixture `PipeBWrite.pdf` 的指纹是 `3e708112…`，与真机日志中 B 的指纹同名；论文名标签与指纹的对应以本文件为准，勿以简报中的论文名推断。

## 1. 真正的故障链（按最早错误状态转移排序）

1. **身份在无证明的 realm 上铸造**。`start()` 调 `syncDocumentId()`（`src/zotero/reader-session.js:777 → 1143-1155`）时不做 realm 信任、不做文档归属检查：resolver 当时返回哪个窗口，就用哪个窗口的 `pdfDocument` 指纹。B 会话（item 483）启动瞬间拿到的是仍载文档 A 的窗口（r1），于是 `documentId = A`。
2. **realm 采纳从不 re-key**。`adoptRealm()`（:1094-1101）只换 `innerWin`/provenance/事件总线，`reevaluateRealm()`（:1037-1069）只 detach + repaint；两者都不重新解析文档身份。B 后来采纳了自己的窗口（r2），`documentId` 仍是 A。
3. **缓存命中直接画，不验证**。`PageOverlay.detect()` 命中缓存即返回区域并置 `painted = true`，不跑检测（`src/zotero/overlay.js:541-550`）。于是 A 的三个第 11 页区域被画给 B，且此后每一轮 repaint 都重复画同一组旧区域。
4. **愈合路径缺触发**。deck 切换不发总线文档事件（`queueDocumentCheck` 不触发）、iframe `visibilitychange` 不触发、notifier 唤醒计数为 0（`wake.count: 0`，`src/zotero/main.js:641-655`）、`recoveryPass()` 一旦 `ready` 即停（:911-918）。四条唤醒通道其实都是同一个缺失物的替身：**统一的文档身份验证入口**。
5. **身份漂移被信任门吞掉**。realm 未确认时 `docIdentityDrift()` 返回 null（:984）；而 `realmConfirmed()`（:1080）把已接受的 `bridge-guessed` 直接视为可信——时间流逝被当成归属证明。异物文档因此显示为「已拥有」。

净效果：`item:483|fcp:bd8e2cda…` 下存着 A 的第 11 页区域；realm 自愈了（r1→r2→r3），画布跟着换主，身份和区域始终没换。

## 2. 与真机日志的对应

| 采样 | 观测 | 解释 |
|---|---|---|
| T1（A 健康） | docId == freshDocId，provenance `chain`，canvasRealms [r1] | 正常路径，无缺陷暴露 |
| T2（切到 B，错误已现） | docId=A，freshDocId=B，cacheKey `item:483\|A`，realmId r2 / canvasRealms [r1]，realmOwned true（provenance src） | 故障链 1+2+3 已完成：B 用 A 的键命中 A 的区域。`canvasRealms=[r1]`：pageView 经 `unwrapViewerApplication` 的 bridge 路由取自 r1 的页面（`realmRoutes` 按窗口永久钉住路由，:166/:230-239）。`realmOwned` 语义是「帧属于我」，从来不是「文档属于我」（`realmBelongsToReader` :329-355） |
| T3（off-on） | 区域不变；canvasRealms [r3] | off→on 经 `attachPageView` 重绑到第三个窗口（bridge 路由），仍用同一陈旧键 → 缓存命中 → 同一组框。canvas 换主、身份不换 |
| T4（缩放） | 区域不变 | `onViewScaleChange()`（:1578-1592）直接复用 `overlay.regionBoxes` 只重排不验证身份，把 A 的框按新缩放重画 |

## 3. 原实现违反的不变量

- **不变量 2（文档身份一致）**：`start()` 与 realm 采纳路径允许 `documentId ≠ resolveDocumentId(currentPDFDocument())` 长期存在，且缓存命中使错误身份自我固化。
- **不变量 4（Overlay 跨文档不继承）**：`attachPageView` 重绑分支（:1520-1533）只改 `pageView/innerWin/docId`，不清 `regionBoxes/painted`，新文档直接继承旧文档的已画状态。
- **不变量 5（异步结果不跨代）**：`paintOverlay()`（:1547-1557）提交前只查 destroyed/enabled/overlay 身份，不查 realm/文档——晚到的 detect 结果可跨文档切换提交。
- **不变量 1（Reader–Viewer 绑定先于身份比较）**：`bridge-guessed` 接受即 `realmConfirmed()`，归属用等待次数背书。
- 附带缺陷（源码可确认，非推测）：`queueDocumentCheck.run` 先 `applyDocumentId()` 改身份（:1313），后用**新** `cacheKey()` 失效（:1334）——清的是新键，旧文档条目成孤儿。`applyDocDrift()`（:1016-1017）顺序是对的，证明这是笔误级顺序 bug。

## 4. 此前怀疑原因的判定

**证实（源码级）**
- Bug A：Viewer 切换后带旧身份直接绘制（adoptRealm/reevaluateRealm 不 re-key）。
- Bug C：缓存失效顺序错误（:1334 用新键）。
- Bug F：异步检测/绘制提交缺文档级守卫（paintOverlay 晚到提交）。
- Bug G：缩放路径无条件复用 `regionBoxes`。
- 缓存命中不验证（overlay.js:545-550）——污染能在 repaint 后存活的原因。

**半证实**
- Bug D（Bridge 误接纳）：跨 reader 返回路径确实存在（`c === r` 对窗口永假、`tabID` 未定义跳过匹配、`onlyCount === 1` 返回唯一帧；`main.js:588/572/594`），但 T2 的采纳路由需下次采样的 `realmRoute` 字段定论。

**排除**
- 指纹碰撞：错误 Reader 的 docId 来自另一 PDF 的**误绑定**，不是两文件真撞指纹。
- 「缓存被清空/需要清缓存」类解释：现象是旧条目**残留**并被命中，不是丢失。
- 检测质量：T2–T4 期间 B 根本没跑检测，几何数据是 A 的，与阈值无关。
- 「realm 错」单独成立：realm 已自愈（r2），污染仍在——错 realm 若配正确的 re-key 本可自愈。

## 5. 修复（v0.1.27，最小方案）

单一验证入口 `ensureCurrentDocument(trigger)`：解析 realm（沿用既有信任规则）→ 读 fresh 文档身份 → 未证实且猜测预算未用完则 `"wait"`（安全不画，预算即自动恢复）→ 身份变化时**先存旧键**再 `applyDocumentId`，`changed` 失效旧键，`adopted`（provisional→printed）保留条目。接线：`start` / `recoveryPass` / `reevaluateRealm` / `queueDocumentCheck` / `attachPageView` 重绑分支 / `paintOverlay` 提交守卫（await 前记 `expectedWin/expectedDoc`，变了则丢弃并 `overlay.clear()`）/ `setEnabled(true)` / `onViewScaleChange`。探针新增 `lastValidation{trigger,before,after,at}`、`realmRoute`、`docIdStale`、`staleKeyPresent`；`realmOwned` 保留名字并注明语义是帧成员关系。无新定时器、无缓存全清、无论文专用规则，检测层未动（基线逐字节不变）。

## 6. 未经真机验证的剩余不确定性

- r1/r2/r3 的窗口身份与 T2 的确切采纳路由是从单次日志重建的，非直接观察；下次采样看 `realmRoute` 即可定论。
- 真机上 deck 切换实际触发哪条唤醒路径（notifier `select` 是否送达会话）。
- 隐藏面板 iframe 的生命周期与窗口回收（T3 第三个窗口的来源）。
- 真实指纹碰撞率；Gecko 跨 realm wrapper 下 `realmStamp()` 字符串不能证明两个窗口必然不同。
- Mock 测试通过 ≠ 真机已修复：Realm 行为只能由 Stage B 证明，见 `STAGE_B_CROSS_DOCUMENT_VERIFICATION.md`。
