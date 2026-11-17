---
name: Bug report
about: Report missed/mis-merged figures, toolbar toggle issues, or rendering bugs
title: "[Bug]: "
labels: bug
---

## Environment

- **OS**: (e.g., Windows 11 / macOS 15 / Ubuntu 24.04)
- **Zotero Version**: (e.g., 10.0.8 / 7.0.x)
- **Figure Guard Version**: (shown in Add-ons Manager or `probeAll().version`)

## Description

Briefly describe what happened and what you expected to see.

## Steps to Reproduce

1. PDF type (academic paper / scanned PDF / two-column layout, etc.)
2. Action taken (switch tabs, scroll, zoom, click `Original` / `原色`, etc.)
3. Observed behavior

## Diagnostics (optional, very helpful for integration issues)

In Zotero, open **Tools → Developer → Run JavaScript** and run:

```js
Zotero.getMainWindow().FigureGuard.probeAll();
```

<details>
<summary>Paste output JSON (if available)</summary>

```json

```

</details>
