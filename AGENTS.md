# Zotero Figure Guard — Agent 指南

Zotero Figure Guard 是 Zotero 7–10 的 PDF 阅读器扩展。深色主题下，Zotero 原生 PDF 阅读器把整页反色，彩色图表跟着变成灰白轮廓；本扩展自动检测页面中的图表区域，只把这些区域恢复为 PDF 的原始颜色，其余部分保持深色。它不修改 PDF 文件，不依赖 Reading Mode，不改变 Zotero 的排版。检测逻辑在 `src/core/`（纯函数，与 Zotero 无关），Zotero 集成层在 `src/zotero/`，引导入口是 `bootstrap.js`，插件 ID 为 `figure-guard@zotero.org`。本文件面向在本仓库工作的 AI 编码代理与维护者，记录分支模型、版本策略与测试层级。

## 分支模型

`main` 是唯一的长期公开分支。功能的走法：

1. 从最新的 `main` 切出 `feature/<主题>` 分支。
2. 开发、推送，向 `main` 开 pull request。PR 触发 CI 门禁。
3. 合并。合并提交在 `main` 上再跑一次 CI，然后删掉 feature 分支。
4. 装上这次合并产出的 CI Artifact，在真机 Zotero 上验收该功能。

`internal` 分支保存开源改造前的完整历史，额外包含内部设计文档与逐轮开发日志，不参与 CI 构建。

## 版本策略

版本号跟着功能走，不跟着构建走：

- 合并功能不消耗版本号，测试构建也不需要单独的版本号。每次 PR 与每次合并到 `main` 都会存一个以运行号加短 SHA 命名的 Artifact，例如 `zotero-figure-guard-run12-1a2b3c4`，直接装它试功能。
- 一组已合并的功能在真机验收通过后，才切一个版本：新功能升 minor（`v0.6.0`），已发布版本上的修补升 patch（`v0.6.1`）。
- 一个 Tag 对应一个版本。已发布的 Tag 不移动、不复用。推送到 `v*` Tag 就是正式发布。
- 版本号手动维护：CI 不会自动 bump，也不会在每次推送 `main` 时发版。

两条 GitHub Actions 工作流，都不需要额外的 Token 或外部服务器：

- **CI** `.github/workflows/ci.yml`：pull request 与推送到 `main` 时触发。执行 `npm ci` → `npm run test:ci` → `npm run build` → XPI 校验，并把 xpi 与 `SHA256SUMS.txt` 存成 Actions Artifact 供下载。权限只有 `contents: read`，不发 Release。测试或构建失败即工作流失败。
- **Release** `.github/workflows/release.yml`：推送 `v*` Tag 时触发。先确认该 Tag 存在且位于 `main` 的历史中，再校验 Tag 与 `package.json`、`package-lock.json`、`manifest.json` 四处版本一致，然后测试、构建、校验 XPI，最后用 `gh release create --verify-tag --generate-notes` 创建 Release 并上传 xpi 与 `SHA256SUMS.txt`。权限为 `contents: write`，用的是自动提供的 `GITHUB_TOKEN`。

## 两级测试

- `npm run test:ci` — 公开 CI 级，不需要受版权保护的 PDF。只跑不碰真实 PDF 的测试文件（当前 17 个文件、390 个用例），全部实际执行并通过，结果里 `cancelled` 必须为 0。GitHub Actions 的 CI 就是这一级。
- `npm test`（等价于 `npm run test:fixture`）— 维护者本地的完整回归级。检测层的回归基线取自 5 篇论文的 PDF，这些 PDF 受版权保护、不随仓库分发，需要自行放到 README「运行测试」一节列出的路径。缺少这些 PDF 时，被依赖真实 PDF 的用例会取消（cancelled）而不是通过，所以完整回归只在维护者本地跑，不作为公开 CI 的强制门槛。

发布步骤与失败处理见 [docs/RELEASING.md](./docs/RELEASING.md)。
