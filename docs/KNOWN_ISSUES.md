# Zotero Figure Guard — Known Issues

Tracks open and recently resolved engineering issues: symptoms, ruled-out causes, current evidence, code state, and next verification steps. For architecture and invariants, see [AGENTS.md](../AGENTS.md).

Status legend: **Pending real-device** = implemented on `dev` and passing both test tiers, awaiting real-Zotero confirmation; **Open** = no reliable fix yet; **Unverified** = implemented but not yet exercised on real hardware.

Real-device verification environment: Zotero 10.0.8 / Windows.

## 1. Toolbar Toggle Single-Click Ignored — Resolved (Verified on Real Device)

**Root cause**: Zotero's reader `DIV.toolbar` sets `-moz-window-dragging: drag`. Our `BUTTON.fg-toggle` used `appearance: none` without `-moz-window-dragging: no-drag` (computed as `default`), causing Windows to intercept single clicks as titlebar window drags before pointer/mouse events could reach the button; only double-clicks leaked through (`k1 + p1 = t2`).

**Fix and cleanup**: Explicitly set `-moz-window-dragging: no-drag` in both `TOGGLE_CSS` and inline styles, and fixed `hitToggle` connected-target matching (including `(0, 0)` keyboard activation). Verified single-click works on real Zotero, then removed temporary diagnostic counters, `span.fg-count`, and redundant cross-window/document bindings.

## 2. Toolbar Toggle Node Disappears and Does Not Recover Across Restarts / Tab Switches — Pending Real-Device

**Symptom**: On one tab (regular PDF), the toggle button is completely missing across repeated Zotero restarts and tab switches, while figure color restoration on that same tab continues working normally.

**Conclusion**: The session is alive and `renderToolbar` ran; only the mounted button DOM node was lost.

**Underlying mechanism**: The `renderToolbar` container calls `replaceChildren()` before each dispatch (`zotero/reader` `src/common/components/common/custom-sections.js:18`), clearing previously appended nodes, and the event only fires once per reader document. Our `append()` call is synchronous so it does not throw; once cleared, there was previously no repair path until another `renderToolbar`.

**Code state**: `maintainButtons()` (`src/zotero/main.js`, commit `6d615ce`) is invoked from `wakeTabSessions` without adding timers or listeners. Re-mount condition: `link.button.isConnected === false` and the toolbar document currently contains no `.fg-toggle`. It prefers `link.parent.appendChild(node)` when the parent is still connected, falling back to the saved bound `append(node)` callback, and calls `warnOnce("button-reattach", …)` if both fail. `probeAll()` now includes `button: {mounted, hasParent, hasAppend}` per session.

**Next verification step**: Switch to the affected tab to see if the toggle reappears; if still missing, inspect `button.mounted` / `hasParent` / `hasAppend` in `probeAll()` and check the console for `button-reattach`.

## 3. Figures Turn Gray Again After Scrolling — Pending Real-Device

**Symptom**: Figures restore their original colors initially, but after scrolling up and down for a while they revert to dark-mode gray; toggling the button off and back on restores them. Bounding boxes remain accurate when gray, indicating the region cache is intact and overlay canvases were detached.

**Cause**: Zotero recycles and recreates `pageView` elements during scrolling, taking any canvas mounted inside the old `pageView.div` out of the document. Previously, the settled repaint check only tested `geometryStale()`, skipping pages whose viewport hadn't changed even though the overlay canvas was no longer connected.

**Code state**: Settled repaint checks now trigger whenever either `geometryStale()` **or** `!isMounted()` is true, rebinding via `attachPageNumber()` onto the live `pageView`. Triggering still relies on existing `pagerendered`, toggle, and document-switch hooks with no added timers or listeners.

**Two points to confirm on real device**: Whether any brief gray-to-color delay is noticeable while scrolling, and whether there is any `pageView` recycling path that never fires `pagerendered`.

## 4. Initial Restoration Latency and Multi-Tab Concurrency — Pending Real-Device (Rescheduled)

Previously `repaintAttached()` and `onViewScaleChange()` ran all pages concurrently via `Promise.all`, and background tabs executed detection/rendering directly inside `start()`, `recoveryPass()`, and `pagerendered`, starving the visible viewport on newly opened tabs. Scheduling now enforces foreground-only execution (`isForeground()` + `pauseBackgroundWork()` on tab blur), dynamic serial priority ordered by distance from `currentPageNumber`, and per-page `detect()` / `inFlightPaint` deduplication. Needs real-device verification for first-screen speed and button responsiveness.

## 5. Test Count Synchronization — Synced

After adding the bootstrap uninstall/Undo cleanup, persistent figure cache, manual override store, manual figure editing (context menu + interactive 4-corner adjust/draw UI + override state consistency fixes), auto-update manifest tests, locale toggle tests, and Zotero-aligned layout/operator tests, counts in [DEVELOPMENT.md](./DEVELOPMENT.md) and [AGENTS.md](../AGENTS.md) are synced to `531` (CI tier) and `613` (full regression). Keep both updated whenever tests are added or removed.

## 6. Unverified Items Checklist

- Manual Figure Editing (`createViewContextMenu` hit testing, 4-corner handle adjust, manual draw-add, remove/reset, right-click recovery of suppressed figures, DPI/zoom/rotation alignment) on real Zotero 10.0.8 desktop UI.
- The "release already exists" guard branch in the Release workflow has not yet been triggered in practice.
- Add-on list icon rendering on real hardware (`manifest.json` `icons` pointing to `content/figureguard-icon.svg`).
- Page-by-page verification of HiKV figures 7/8/9.
- Full `probeAll()` output inspection on real Zotero including the new `button` fields.
- Repository GitHub settings verification: Actions workflow permissions (`contents: read`), artifact retention days, and `main` branch protection.
- Repository GitHub About description and topics.

## 7. Known Detection Coverage Boundaries

- Tuned for standard academic PDF layouts (vector paths, Form XObjects, two-column papers). Purely scanned bitmap PDFs and unusual shading/masking pipelines are not yet covered.
- Distant captions or independent side-by-side strip subfigures can still be missed or merged imperfectly.
- Major Zotero upgrades may change internal `pdf.js` structures; `probeAll()` is the primary diagnostic entry point.
