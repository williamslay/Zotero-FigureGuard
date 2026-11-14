/**
 * Throwaway debug: dump cluster candidates, confidence breakdown, captions,
 * and form/image placements for FluidKV pages 2,5,6,7,8,10.
 * Usage: node scripts/debug_fluidkv.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { OPS, openFixture } from "../tests/js/helpers/doc.mjs";
import { collectPageEvidence } from "../src/core/pdf-source.js";
import { DEFAULT_DETECTOR_OPTIONS, areaRatioOf } from "../src/core/detector-options.js";
import { rectArea, rectWidth, rectHeight } from "../src/core/geom.js";

const PDF = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "FluidKV_ Seamlessly Bridging the Gap between Indexing Performance and Memory-Footprint on Ultra-Fast Storage.pdf",
);
const OUT = "/tmp/opencode/fluidkv_dump.txt";

const opts = DEFAULT_DETECTOR_OPTIONS;
// compute tolerance
// page is 612x792, diagonal = sqrt(612^2+792^2) = 1001.16
const diag = Math.hypot(612, 792);
const mergeTolerance = opts.pathMergeGapDiagonalRatio * diag;

const lines = [];
function log(s) { lines.push(s); }

// Replicate scoreRegion logic for breakdown
function scoreBreakdown({ kinds, caption, link, rect, pageRect, standalonePath, standaloneImage }) {
  const parts = [];
  let conf = 0;
  const isForm = kinds.includes("form");
  const isImage = kinds.includes("image");
  const isPath = kinds.includes("path");

  if (caption) {
    const add = link?.side === "below" ? 0.4 : 0.45;
    conf += add;
    parts.push(`caption(+${add})`);
    if (link?.side === "above" && link.gap <= opts.smallCaptionGapPt) {
      conf += 0.05;
      parts.push(`close-gap(+0.05) gap=${link.gap.toFixed(1)}`);
    }
  }
  if (isImage) { conf += 0.15; parts.push("image(+0.15)"); }
  else if (isForm) { conf += 0.1; parts.push("form(+0.1)"); }
  else if (isPath) { conf += 0.05; parts.push("path(+0.05)"); }
  if (standaloneImage) { conf += 0.15; parts.push("standalone-img(+0.15)"); }
  if (standalonePath) { conf += 0.25; parts.push("standalone-path(+0.25)"); }

  const ratio = areaRatioOf(rect, pageRect);
  if (ratio >= 0.02 && ratio <= 0.5) { conf += 0.2; parts.push(`area(+0.2) r=${ratio.toFixed(4)}`); }
  else if (ratio > opts.minAreaRatio && ratio < 0.02) { conf += 0.1; parts.push(`area(+0.1) r=${ratio.toFixed(4)}`); }
  else parts.push(`area(+0) r=${ratio.toFixed(4)}`);

  const inset = opts.marginInsetPt;
  const insideMargins = rect[0] >= pageRect[0]+inset && rect[1] >= pageRect[1]+inset && rect[2] <= pageRect[2]-inset && rect[3] <= pageRect[3]-inset;
  if (insideMargins) { conf += 0.1; parts.push("margins(+0.1)"); }
  else parts.push("margins(+0)");

  const aspect = rectWidth(rect) / rectHeight(rect);
  if (aspect >= opts.minAspect && aspect <= opts.maxAspect) { conf += 0.05; parts.push(`aspect(+0.05) a=${aspect.toFixed(2)}`); }
  else parts.push(`aspect(+0) a=${aspect.toFixed(2)}`);

  conf = Math.min(1, conf);
  const gate = Boolean(caption) || (isImage && ratio >= opts.unanchoredImageMinAreaRatio) || (isPath && ratio >= opts.pathAnchoredAreaRatio);
  return { conf, parts, gate, ratio };
}

const { doc, close } = await openFixture(PDF);
const targetPages = [2, 5, 6, 7, 8, 10];

for (const pageNum of targetPages) {
  const page = await doc.getPage(pageNum);
  const evidence = await collectPageEvidence({ pdfPage: page, OPS });
  const { placements: rawPlacements, captions, pageRect, viewport } = evidence;

  log(`\n${"=".repeat(80)}`);
  log(`PAGE ${pageNum}  pageRect=${JSON.stringify(pageRect)}  mergeTolerance=${mergeTolerance.toFixed(2)}pt`);
  log(`${"=".repeat(80)}`);

  // Captions
  log(`\nCAPTIONS (${captions.length}):`);
  for (const cap of captions) {
    log(`  [${cap.number}] rect=${JSON.stringify(cap.rect.map(v=>Math.round(v*100)/100))} label="${cap.label ?? cap.number}"`);
  }

  // Non-path placements (forms/images)
  const xoPlacements = rawPlacements.filter(p => p.kind !== "path");
  log(`\nFORM/IMAGE PLACEMENTS (${xoPlacements.length}):`);
  for (const p of xoPlacements) {
    const r = p.rect.map(v => Math.round(v*100)/100);
    const ar = areaRatioOf(p.rect, pageRect);
    const w = rectWidth(p.rect), h = rectHeight(p.rect);
    log(`  ${p.kind} rect=[${r}] area_ratio=${ar.toFixed(5)} w=${w.toFixed(1)} h=${h.toFixed(1)}`);
  }

  // Path placements — show clusters from diagnostics
  const pathPlacements = rawPlacements.filter(p => p.kind === "path");
  log(`\nPATH PLACEMENTS: ${pathPlacements.length} raw`);

  // Run detectFigureRegions to get actual detection result
  const { detectFigureRegions } = await import("../src/core/detector.js");
  const result = detectFigureRegions({
    placements: rawPlacements,
    captions,
    pageRect,
  });

  // The diagnostics has evaluated array — but let's manually reconstruct
  // Path clusters come from mergePathPlacements. We need to inspect them.
  // The result.diagnostics has pathBoxCount = cluster count.
  log(`\nPATH CLUSTERS (from detection): ${result.diagnostics.pathBoxCount} clusters`);

  // To get per-cluster info, we need to inspect evaluated placements that are paths.
  // evaluated includes both xo and path-cluster placements.
  // Let's look at regions and rejected.
  log(`\nACCEPTED REGIONS (${result.regions.length}):`);
  for (const r of result.regions) {
    log(`  rect=[${r.rect.map(v=>Math.round(v*100)/100)}] kind=${r.kind} conf=${r.confidence} caption=${r.captionNumber} evidence=${JSON.stringify(r.evidence)}`);
  }

  log(`\nREJECTED (${result.rejected.length}):`);
  for (const r of result.rejected) {
    log(`  rect=[${(r.rect||[]).map(v=>Math.round(v*100)/100)}] kind=${r.kind} reason=${r.reason} conf=${r.confidence}`);
  }

  // Now manually score each path cluster to understand confidence breakdown
  // We need to know: what are the clusters after mergePathPlacements?
  // The evaluated list in diagnostics has them.
  const evaluated = result.diagnostics.evaluated;
  log(`\nEVALUATED PLACEMENTS (post-merge): ${evaluated.length}`);
  for (const ev of evaluated) {
    const r = ev.rect.map(v => Math.round(v*100)/100);
    const ar = areaRatioOf(ev.rect, pageRect);
    const w = rectWidth(ev.rect), h = rectHeight(ev.rect);
    const aspect = w / h;
    let filterInfo = ev.passesBasicFilter ? "PASS" : `FAIL:${ev.rejectReason}`;
    log(`  #${ev.index} ${ev.kind} rect=[${r}] ar=${ar.toFixed(5)} w=${w.toFixed(1)} h=${h.toFixed(1)} asp=${aspect.toFixed(2)} ${filterInfo}`);
  }

  // For path clusters that have captions or are near them, compute manual score
  log(`\nMANUAL CONFIDENCE BREAKDOWN (path clusters):`);
  const pathClusters = evaluated.filter(e => e.kind === "path" && e.passesBasicFilter);
  for (const pc of pathClusters) {
    // Check if any caption links
    let bestLink = null;
    for (const cap of captions) {
      const overlap = Math.max(0, Math.min(pc.rect[2], cap.rect[2]) - Math.max(pc.rect[0], cap.rect[0]));
      const needed = opts.minCaptionOverlapRatio * Math.min(rectWidth(cap.rect), rectWidth(pc.rect));
      if (overlap < needed) continue;
      const maxOverlap = Math.min(rectHeight(cap.rect), opts.maxCaptionOverlapPt);
      const gapAbove = pc.rect[1] - cap.rect[3];
      const gapBelow = cap.rect[1] - pc.rect[3];
      let link = null;
      if (gapAbove >= -maxOverlap && gapAbove <= opts.maxCaptionGapPt) {
        link = { gap: Math.max(0, gapAbove), side: "above" };
      } else if (gapBelow >= -maxOverlap && gapBelow <= opts.maxCaptionGapPt) {
        link = { gap: Math.max(0, gapBelow) + 1, side: "below" };
      }
      if (link && (!bestLink || bestLink.gap > link.gap)) {
        bestLink = link;
        bestLink.caption = cap;
      }
    }

    const hasCaption = Boolean(bestLink);
    const standalonePath = !hasCaption && areaRatioOf(pc.rect, pageRect) >= opts.pathAnchoredAreaRatio;
    const bd = scoreBreakdown({
      kinds: ["path"],
      caption: bestLink?.caption ?? null,
      link: bestLink,
      rect: pc.rect,
      pageRect,
      standalonePath,
    });
    log(`  #${pc.index} rect=[${pc.rect.map(v=>Math.round(v*100)/100)}] conf=${bd.conf.toFixed(3)} gate=${bd.gate} caption=${bestLink?.caption?.number ?? "none"} link=${bestLink ? bestLink.side + " gap=" + bestLink.gap.toFixed(1) : "none"} parts=[${bd.parts.join(", ")}]`);
  }

  // For fig 1 (p2) and fig 9 (p5) — show text items inside/near the figure area
  // to understand the left-cut issue
  if (pageNum === 2 || pageNum === 5) {
    log(`\nTEXT ITEMS (for left-cut analysis):`);
    const textContent = await page.getTextContent();
    const textItems = (textContent?.items ?? []).filter(i => !i?.type);
    // For page 2, figure 1 rect is [346.83, 85, 548.97, 123.18] in viewport (top-left)
    // We need user space. Viewport converts. But let's look at user-space items in the same y-band
    // In user space (bottom-left origin), the figure band for fig1 would be around y=668-707 (792-123=669, 792-85=707)
    // Actually viewport top-left y: viewport_y = pageHeight - user_y (at scale 1)
    // So viewport [346.83, 85, 548.97, 123.18] → user space [346.83, 792-123.18, 548.97, 792-85] = [346.83, 668.82, 548.97, 707]
    // Let's dump text items in the right column (x > 300) for p2, and around fig9 area for p5
    const figRect = pageNum === 2 ? [346.83, 668.82, 548.97, 707] : [340.76, 467.52, 547.53, 541.4];
    log(`  Figure rect (user space approx): [${figRect}]`);
    for (const item of textItems) {
      if (!item.str || !item.transform) continue;
      // item.transform = [a,b,c,d,e,f], e=x, f=y (baseline position)
      const x = item.transform[4];
      const y = item.transform[5];
      // check if in the vertical band of the figure
      if (y < figRect[1] - 10 || y > figRect[3] + 10) continue;
      if (x < 300) continue; // right column
      const width = item.width ?? 0;
      const h = item.height ?? 0;
      const itemRect = [x, y, x + width, y + h];
      const inFigure = x >= figRect[0] - 5 && x <= figRect[2] + 5;
      const leftOfFigure = x < figRect[0];
      if (leftOfFigure || inFigure) {
        log(`  "${item.str.substring(0, 40)}" x=${x.toFixed(1)} y=${y.toFixed(1)} w=${width.toFixed(1)} h=${h.toFixed(1)} ${leftOfFigure ? "LEFT-OF-RECT" : "IN-RECT"}`);
      }
    }
  }

  page.cleanup();
}

await close();

const output = lines.join("\n");
fs.writeFileSync(OUT, output + "\n");
console.log(`Written: ${OUT} (${lines.length} lines)`);
