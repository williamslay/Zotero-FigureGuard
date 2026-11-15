/** Throwaway survey: run the frozen detector over the HiKV fixture. */
import path from "node:path";
import { DEFAULT_DETECTOR_OPTIONS, detectPageRegions } from "../src/core/index.js";
import { OPS, REPO_ROOT, openFixture } from "../tests/js/helpers/doc.mjs";

const PDF = path.join(
  REPO_ROOT,
  "HiKV - A Hybrid Index Key-Value Store for DRAM-NVM Memory Systems.pdf",
);

const round2 = (rect) => rect.map((v) => Math.round(v * 100) / 100);

const { doc, close } = await openFixture(PDF);
console.log("pages:", doc.numPages);

for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
  const page = await doc.getPage(pageNumber);
  const result = await detectPageRegions({ pdfPage: page, OPS });
  const viewport = page.getViewport({ scale: 1 });
  const toTop = (rect) => {
    const [x1, y1] = viewport.convertToViewportPoint(rect[0], rect[3]);
    const [x2, y2] = viewport.convertToViewportPoint(rect[2], rect[1]);
    return [x1, y1, x2, y2].map((v) => Math.round(v * 100) / 100);
  };
  const captions = result.captions.map((c) => String(c.number));
  const accepted = result.regions.map(
    (r) =>
      `cap=${r.captionNumber ?? "-"} src=${r.sourceKinds.join("+")} conf=${r.confidence.toFixed(2)} rect=${JSON.stringify(toTop(r.rect))}`,
  );
  const rejected = result.rejected.map((e) => `${e.reason}${e.rect ? JSON.stringify(toTop(e.rect)) : ""}`);
  const uncovered = captions.filter((n) => !result.regions.some((r) => String(r.captionNumber) === n));
  if (!accepted.length && !rejected.length && !captions.length) continue;
  console.log(
    `\npage ${pageNumber} placements=${result.diagnostics.placementCount} xobj=${result.diagnostics.rawPlacementCount - result.diagnostics.rawPathBoxCount} pathBoxes=${result.diagnostics.rawPathBoxCount} clusters=${result.diagnostics.pathBoxCount} splits=${result.diagnostics.pathClusterSplits} offPage=${result.diagnostics.pathBoxesOffPage}`,
  );
  console.log(`  captions: ${captions.join(",") || "-"}`);
  for (const line of accepted) console.log(`  + ${line}`);
  for (const line of rejected) console.log(`  - ${line}`);
  if (uncovered.length) console.log(`  uncovered: ${uncovered.join(",")}`);
}

await close();
