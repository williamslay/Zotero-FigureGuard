# Development & Testing Guide

This guide is for contributors and maintainers who want to build from source, run the test suites, inspect detection offline, or debug real-device behavior. For coding-agent contracts and Zotero runtime facts, see [AGENTS.md](../AGENTS.md). For release procedures, see [RELEASING.md](./RELEASING.md).

## Repository Layout

```text
bootstrap.js                 XPI bootstrap entry point (chrome sandbox)
manifest.json                Add-on manifest: ID, version, compatibility range, update_url
src/
  core/                      Pure JS detection layer (no Zotero dependency; runs directly in Node)
    detector.js              pdf.js getOperatorList() + text blockers -> per-page figure boxes
    detector-options.js      Thresholds and detection feature flags
    text-layout.js           Prose/caption sight blockers, substrate filter, 4-way label growth
    captions.js              Caption-to-figure pairing
    placements.js            XObjects, inline/mask images, shading, clip paths, and path mapping
    cache.js                 Document-scoped region cache keyed by item + document fingerprint
    region-overrides.js      Pure cache/override versions, bbox validation, and resolveEffectiveRegions
    pdf-source.js            Document fingerprint and document-level extraction
    render.js / viewport.js / geom.js
  zotero/                    Zotero integration layer
    main.js                  startup/shutdown, Notifier, localized toolbar toggle, context menu, FigureGuard API
    reader-session.js        Per-reader lifecycle, realm validation, foreground-first scheduling
    region-editor.js         Interactive 4-corner region adjustment & manual rectangle creation UI
    overlay.js               Overlay canvas mounting, cache-first detection, painting, geometry/connection checks
    persistent-figure-store.js  Per-attachment persistent auto-cache & manual override JSON store
    realm-render.js          Rendering inside the reader's own realm
    paint-probe.js / xray.js / zoom.js
scripts/
  build.mjs                  Bundles src/zotero/main.js via esbuild and packages dist/*.xpi
  verify-xpi.mjs             Verifies the 4-entry XPI contract and version, writes SHA256SUMS.txt
  run-tests.mjs              Two-tier test runner (ci vs all)
  generate-updates-json.mjs  Maintains Zotero auto-update manifest updates.json
  survey_pdf.mjs             Offline detector survey for any PDF -> JSON report
  probe_pdfjs_ops.mjs        Inspects pdf.js operator list and transforms for a page
  render_check.mjs           Offline rendering & semantic color verification
tests/js/                    node:test suites
fixture/                     Verified reference JSON fixture-verified.json (PDFs/PNGs not distributed)
assets/                      Add-on icon (figureguard-icon.svg) and README comparison images
docs/                        Developer documentation (DEVELOPMENT / KNOWN_ISSUES / RELEASING)
.github/workflows/           ci.yml (CI test & build) and release.yml (tag-driven release)
```

## Architecture Overview

1. **Detection Layer** (`src/core/detector.js`): Pure functions taking pdf.js `getOperatorList()` output and returning figure bounding boxes for a page. Full-page borders, decorative rules, and text underlines are filtered by threshold rules, while equal-sized subfigure panels in grids or rows are merged into a unified region.
2. **Cache Layer** (`src/core/cache.js`, `src/core/region-overrides.js`, `src/zotero/persistent-figure-store.js`): Memory `RegionCache` sets are scoped by `item:<itemID>|<documentFingerprint>` so switching across tabs never leaks regions between documents; persisted per-attachment JSON under `<Zotero Data Directory>/figureguard/cache/item-<id>.json` stores `autoCache` separately from `manualOverrides` and reconciles them via `resolveEffectiveRegions`.
3. **Integration Layer** (`src/zotero/`): Resolves and validates each reader session's own pdf.js realm, listens to document and page render events, and schedules detection and overlay painting foreground-first (prioritizing the active tab and visible `currentPageNumber`). Overlay canvases carry provenance stamps (`fcpRealm` / `fcpDoc`) to diagnose cross-tab misrouting or detached canvases.

## Building from Source

Prerequisites:

- Node.js 20+
- System `zip` and `unzip` commands (Debian/Ubuntu: `sudo apt install zip unzip`)

Build and verify the XPI package:

```bash
npm ci
npm run test:ci
npm run build
node scripts/verify-xpi.mjs
```

- `build/` (staging directory) and `dist/` (`zotero-figure-guard-<version>.xpi` and `SHA256SUMS.txt`) are generated artifacts and untracked in git.
- `verify-xpi.mjs` checks that the archive contains **only** the following four entries and that its embedded `manifest.json` ID and version match, exiting non-zero on any mismatch:
  - `manifest.json`
  - `bootstrap.js`
  - `content/index.js`
  - `content/figureguard-icon.svg`

## Running Tests

Tests are organized into two tiers.

### Level 1 — Public CI Suite (no external PDFs required)

```bash
npm run test:ci
```

Runs only the PDF-free test files (currently 22 files, 531 tests). All tests must execute and pass with `cancelled: 0`. This is the exact gate run by GitHub Actions CI.

### Level 2 — Full Fixture Regression (requires local PDFs)

```bash
npm test              # equivalent to npm run test:fixture
```

Runs the full maintainer suite (currently 29 files, 613 tests). Detection baselines rely on five academic paper PDFs that are copyrighted and not redistributed in this repository. Place them locally at the following paths (the first four at the repository root, the last one under `fixture/`):

```text
Borges_ A Low-Latency Distributed Shared Log on a CXL Memory_SSD Hybrid.pdf
Flash-Level Asynchronous Execution for In-Storage LSM-Tree Operations.pdf
FluidKV_ Seamlessly Bridging the Gap between Indexing Performance and Memory-Footprint on Ultra-Fast Storage.pdf
HiKV - A Hybrid Index Key-Value Store for DRAM-NVM Memory Systems.pdf
fixture/PipeBWrite.pdf
```

When these five PDFs are absent, `npm test` reports 79 cancelled cases across the 7 fixture-dependent test files (whose `before` hooks cannot open the files). Use `npm run test:ci` or `npm test` rather than bare `node --test`.

## Offline Probes & Real-Device Diagnostics

### Offline PDF Inspection

```bash
# Run the detector on any PDF and emit a per-page region report under reports/
node scripts/survey_pdf.mjs path/to/paper.pdf

# Dump pdf.js operator list and transforms for a specific page
node scripts/probe_pdfjs_ops.mjs path/to/paper.pdf 1

# Offline render check (requires full local fixtures)
npm run render
```

### Real-Device Diagnostics in Zotero

Open **Tools → Developer → Run JavaScript** in Zotero and execute:

```js
Zotero.getMainWindow().FigureGuard.probeAll();
```

This returns per-session readiness, document fingerprint, realm ownership, toolbar toggle state (`button`), overlay provenance stamps, identity validation (`lastValidation`, `docIdStale`), diagnostic logs, installed `version`, and `coreVersion`.

## Branch Model

- `main`: The only long-lived public branch; all release tags live here.
- `feature/*`: Short-lived feature branches cut from `main`, merged via pull request, then deleted.
- `dev`: Active development integration branch; verified against real Zotero before merging into `main`.
- `internal`: Pre-open-source historical archive; never built by CI.
