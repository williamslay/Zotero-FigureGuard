# Zotero Figure Guard — Agent Guide

Zotero Figure Guard is a PDF reader extension for Zotero 7–10. Under Zotero's dark theme, the built-in PDF reader inverts the entire page, turning colored figures into washed-out or inverted silhouettes. This extension automatically detects figure regions on each page and restores original PDF colors inside those regions only, leaving body text and margins dark. It never modifies PDF files, does not rely on Reading Mode, and preserves Zotero's layout.

This document is the engineering contract for AI coding agents and maintainers working in this repository. Open issues are tracked in [docs/KNOWN_ISSUES.md](./docs/KNOWN_ISSUES.md), release procedures in [docs/RELEASING.md](./docs/RELEASING.md), and contributor build/test instructions in [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md).

## Layers & Modules

Detection logic lives in `src/core/` (pure functions, zero Zotero imports, directly testable in Node), the Zotero integration layer lives in `src/zotero/`, and the bootstrap entry point is `bootstrap.js`. Add-on ID: `figure-guard@zotero.org`.

Bootstrap:

- `bootstrap.js` (196 lines): XPI bootstrap inside the chrome sandbox; loads `content/index.js` and registers/tears down across windows.

Detection layer `src/core/`:

| File | Lines | Responsibility |
| --- | --- | --- |
| `detector.js` | 2076 | Takes `pdf.js` `getOperatorList()` + text layout and outputs figure bounding boxes for one page; filters decorative rules, full-page frames, and ruled tables/algorithms |
| `detector-options.js` | 175 | Single source of truth for detection thresholds and flags |
| `text-layout.js` | 771 | Text-line prose/caption blocker classification, typography prior, Table/Algorithm territory claiming, clear-sight geometry (`hasDirectSightValid`), page substrate filtering, standalone image gate, and 4-way label expansion |
| `captions.js` | 239 | Caption-to-graphic region pairing |
| `placements.js` | 490 | Maps XObjects, inline/mask images, shading fills, clip paths (`W`/`W*`), and paths onto page coordinates |
| `cache.js` | 180 | Caches region sets scoped by `item:<itemID>\|<documentFingerprint>` so tabs never cross-contaminate |
| `pdf-source.js` | 126 | Document fingerprinting and document-level extraction |
| `render.js` | 110 | Converts regions into canvas rendering parameters |
| `geom.js` | 138 | Rectangle geometry utilities |
| `viewport.js` | 83 | Viewport and page geometry helpers |
| `index.js` | 54 | Public aggregation and `CORE_VERSION` |

Integration layer `src/zotero/`:

| File | Lines | Responsibility |
| --- | --- | --- |
| `main.js` | 1769 | Entry point: `startup`/`shutdown`, Notifier wiring, `renderToolbar` handler, localized toolbar toggle (`原色` / `Original`), global `FigureGuard` API, `probeAll()` |
| `reader-session.js` | 2201 | Single-reader lifecycle: realm resolution and ownership validation, document/page events, foreground-first priority queue, settled repaint checks |
| `overlay.js` | 907 | Overlay canvas mounting, painting, geometry staleness (`geometryStale()`), and document connection (`isMounted()`) checks |
| `paint-probe.js` | 554 | Painting probe for real-device diagnostics |
| `xray.js` | 330 | Xray-safe operator list extraction channel |
| `realm-render.js` | 256 | Executes rendering inside the reader's own realm |
| `zoom.js` | 88 | Zoom change linkage |

Session timing constants live in `src/zotero/reader-session.js:29-75`: `READY_POLL_MS` 250, `READY_TIMEOUT_MS` 20000, `RECOVERY_INTERVAL_MS` 5000, `RECOVERY_MAX_MS` 180000, `RECOVERY_SLOW_INTERVAL_MS` 20000, `DOCUMENT_CHECK_MS` 300, `SETTLED_REPAINT_MS` 350, document events `DOCUMENT_EVENTS`, and page render event `PAGE_RENDERED_EVENT`. Changing these alters recovery cadence and requires real-device confirmation.

## Zotero 10.0.8 Runtime Facts (Source-Verified)

Treat these facts as fixed invariants when modifying `src/zotero/`:

- The `doc` passed to `renderToolbar` is the reader iframe's own document (`resource://zotero/reader/reader.html` inside `<browser id="reader">`), **not** the main chrome window document. Dispatch site: `zotero/reader` `src/common/components/common/custom-sections.js:3-26`.
- Before each dispatch, that container calls `replaceChildren()`, wiping previously appended nodes; `append()` must be called synchronously during the event or it throws `"Append must be called directly and synchronously in the event"` (`custom-sections.js:18-24`). Our handler satisfies this synchronously (`src/zotero/main.js:742-782`).
- `renderToolbar` is triggered by a toolbar mount `useEffect` depending on `[replaceChildren, params]`; `reader-ui` passes no `params`, so it fires only once per opened reader document and does not re-fire on page turns (`zotero/reader` `src/common/components/toolbar.js:272`). Only the selected reader receives its own `renderToolbar`.
- All built-in Zotero reader toolbar buttons use `click` only (`toolbar.js` `onClick` at lines 86/109/117/125/132/172/181/188/196/207/220/257/265/292) with no `mousedown`/`pointerdown` gate. The only pointer logic in `toolbar.js` is the reading progress bar (`toolbar.js:315-358`).
- Zotero's chrome layer knows cross-iframe pointer events can be dropped: `chrome/content/zotero/xpcom/reader.js` records the press window in `_handlePointerDown`, and when press and release land in different windows `_handlePointerUp` manually re-dispatches `mouseup`/`pointerup` to the original iframe (self-described as a `"nonsense work-around"`). Re-dispatch occurs on release only.
- On Windows, native tooltips are top-level OS windows that do not capture the mouse (`mozilla-central` `layout/xul/nsXULTooltipListener.cpp:554-556`), so "tooltip eats the first press" is not a valid explanation.
- Notifier wiring is in `src/zotero/main.js:1060-1080`; tab switches produce `select` and opens produce `load`, both feeding `wakeTabSessions` (`src/zotero/main.js:955`).
- After a reader panel stays hidden for ~60 s, Zotero unloads it and rebuilds its realm and `eventBus`; our session object persists because `sessions` is keyed by the reader object (`src/zotero/main.js:173`, `584-608`).
- Global entry point is `Zotero.getMainWindow().FigureGuard`, exposing `startup`, `shutdown`, `setEnabled`, `clearCache`, `getSessions`, `getLog`, `runProbe`, `probeAll`, `probePaint`, `maintainButtons`, `wakeTabSessions`, and `version`.
- There is **no `MutationObserver`** and **no `setInterval`** anywhere in the repository. All maintenance piggybacks on existing events; adding new listeners or timers requires explicit justification.

## Session, Button, and Overlay Ownership

- `sessions: Map<reader, {session, startPromise, closeWatch}>` (`src/zotero/main.js:173`, `597`). `ensureSession` and `syncOpenReaders` share one function and reader key, enforcing one session per reader.
- `session.start()` must **not** be awaited by the toolbar handler because `append()` must return synchronously (`src/zotero/main.js:602-606`). This is why figure restoration can succeed even if a button node was lost.
- `buttonLinks: Map<session, link>` (`src/zotero/main.js:175`) tracks `button`, `doc`, `onPointerDown`, `onMouseUp`, `onClick`, `off`, plus `toolbarDoc`, `append`, and `parent` from `renderToolbar` for re-mounting.
- The toggle button label is localized via `resolveZoteroLocale(doc)` / `resolveButtonStrings(doc)`: Chinese locales (`zh` / `zh-*`) display `"原色"`, and all other or unknown locales display `"Original"`.
- Normal button creation runs only in `onRenderToolbar`; `createButton` always calls `detachButton` first. The sole re-mount path is `maintainButtons()`, called by `wakeTabSessions` when `link.button.isConnected === false` and the toolbar document contains no `.fg-toggle`.
- Zotero's `DIV.toolbar` sets `-moz-window-dragging: drag`; `.fg-toggle` must explicitly set `-moz-window-dragging: no-drag` in both `TOGGLE_CSS` and inline styles, or Windows intercepts single clicks as titlebar drags.
- Overlay canvases live inside `pageView.div`; scrolling recycles and recreates `pageView`, detaching canvases from the document. Settled repaint checks test both `geometryStale()` and `!isMounted()`, rebinding via `attachPageNumber()` onto the live `pageView`.

## Activation Ladder

The toolbar toggle uses the capture-phase sequence `pointerdown` → `mouseup` → `click` on the toolbar document from `renderToolbar`, firing the session toggle at most once per press sequence: `pressActivated` is set on `pointerdown` or `mouseup` and cleared if `mouseup` lands outside or when the trailing `click` arrives; keyboard `click` (`detail === 0` strict equality) bypasses `pressActivated`. `hitToggle` checks bounding boxes, direct target ancestry on a mounted button (supporting `(0, 0)` keyboard events), and `.fg-toggle` stand-ins after React re-renders.

## Branch Model

`main` is the only long-lived public branch:

1. Branch `feature/<topic>` from the latest `main` (or develop on `dev` for multi-step rounds).
2. Develop, push, and open a PR into `main` (CI gate runs automatically), or fast-forward/merge `dev` after real-device verification.
3. Version tags are created only on `main`.
4. Install the CI artifact or local `dist/` build on real Zotero to verify before cutting a release.

`internal` archives pre-open-source history (internal design docs and round logs) and is never built by CI.

`dev` holds the current development round; pushes to `dev` do not trigger CI.

## Versioning & Workflows

Versions follow accepted features, not builds:

- Merging features or running test builds does not consume version numbers.
- Cut a minor bump (`v0.6.0`) for new features after real-device acceptance, or a patch bump (`v0.6.1`) for fixes on a released version.
- One tag = one version; tags are never moved or reused. Pushing a `v*` tag triggers a formal release.
- Four version fields must match: Git tag, `package.json`, `package-lock.json`, and `manifest.json`.

Two GitHub Actions workflows (requiring only built-in `GITHUB_TOKEN`):

- **CI** (`.github/workflows/ci.yml`): runs on PRs and pushes to `main` (`npm ci` → `npm run test:ci` → `npm run build` → `verify-xpi.mjs`), uploading the XPI and `SHA256SUMS.txt` as an artifact (`contents: read`).
- **Release** (`.github/workflows/release.yml`): runs on `v*` tags; verifies the tag belongs to `main`'s history and all four version fields match, builds and verifies the XPI, creates the GitHub Release via `gh release create --verify-tag --generate-notes`, and updates `updates.json` on `gh-pages` via `scripts/generate-updates-json.mjs` for formal releases.

## Two-Tier Testing

- `npm run test:ci` — Public CI tier; no copyrighted PDFs required. Runs PDF-free test files only (currently 18 files, 461 tests); `cancelled` must be 0.
- `npm test` (`npm run test:fixture`) — Full maintainer regression (currently 25 files, 543 tests). Detection baselines rely on 5 copyrighted paper PDFs placed locally at the paths listed in [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md). When those PDFs are missing, 79 tests across 7 files are `cancelled` instead of failing, so full regression runs locally rather than as a public CI gate.

Always run tests via `npm test` or `npm run test:ci` (bare `node --test` triggers a spurious failure). Detection baselines (accepted region counts): PipeBWrite 18, FluidKV 18, Flash 10, Borges 9, plus HiKV fixtures. Whenever any threshold in `src/core/` changes, run `npm test` and verify these counts.

## Build Contract

- The packaged XPI contains **exactly four entries**: `manifest.json`, `bootstrap.js`, `content/index.js` (esbuild bundle of `src/zotero/main.js`), and `content/figureguard-icon.svg`.
- XPI files are not byte-reproducible due to zip timestamps; validate entry list, ID, and version rather than fixed archive hash equality.
- Always run `node scripts/verify-xpi.mjs --expect-version <version>` after packaging (also writes `dist/SHA256SUMS.txt`).
- Maintainer real-device checks install directly from workspace `dist/`.

## Engineering Constraints

- Only change detection heuristics when backed by measured evidence—never tune "because it looks nicer."
- Do not add timers (`setInterval`), extra event listeners, or cache-clearing workarounds without explaining why existing event hooks are insufficient.
- Never add per-paper special-case rules.
- `TOGGLE_CSS` is a template literal; never put backticks inside its comments.
- Remove temporary diagnostic code (counters, `span.fg-count`, redundant bindings) once real-device conclusions are confirmed.
