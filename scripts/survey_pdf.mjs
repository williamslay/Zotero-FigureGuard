/**
 * Run the offline detector survey against any PDF, in the same shape as the
 * A1 fixture survey, so real-machine symptom reports can be triaged without
 * Zotero. Usage: node scripts/survey_pdf.mjs <pdf-path> [out-json]
 */
import fs from "node:fs";
import path from "node:path";
import { OPS, openFixture } from "../tests/js/helpers/doc.mjs";
import { detectPageRegions } from "../src/core/index.js";

const input = process.argv[2];
if (!input) {
  console.error("usage: node scripts/survey_pdf.mjs <pdf-path> [out-json]");
  process.exit(1);
}
const output =
  process.argv[3] ||
  path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "reports",
    `${path.basename(input).replace(/\.pdf$/i, "")}-detection.json`,
  );

const { doc, close } = await openFixture(input);
const survey = [];
for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
  const page = await doc.getPage(pageNumber);
  const result = await detectPageRegions({ pdfPage: page, OPS });
  const viewport = page.getViewport({ scale: 1 });
  const toPageTopLeft = (rect) => {
    const [x1, y1] = viewport.convertToViewportPoint(rect[0], rect[3]);
    const [x2, y2] = viewport.convertToViewportPoint(rect[2], rect[1]);
    return [x1, y1, x2, y2].map((value) => Math.round(value * 100) / 100);
  };
  const captionNumbers = result.captions.map((caption) => String(caption.number));
  const diagnostics = result.diagnostics;
  survey.push({
    page: pageNumber,
    pageSize: [
      Math.round(viewport.width * 100) / 100,
      Math.round(viewport.height * 100) / 100,
    ],
    placements: diagnostics.placementCount,
    xobjects: diagnostics.rawPlacementCount - diagnostics.rawPathBoxCount,
    pathBoxes: diagnostics.rawPathBoxCount,
    pathClusters: diagnostics.pathBoxCount,
    captions: captionNumbers,
    accepted: result.regions.map((region) => ({
      rect: toPageTopLeft(region.rect),
      caption: region.captionNumber,
      kind: region.sourceKinds.join("+"),
      placements: region.placementCount,
      confidence: region.confidence,
      pageAreaRatio: Math.round(region.pageAreaRatio * 10000) / 10000,
    })),
    rejectedReasons: result.rejected.map((entry) => entry.reason),
    uncoveredCaptions: captionNumbers.filter(
      (number) => !result.regions.some((region) => region.captionNumber === number),
    ),
  });
  page.cleanup();
}
await close();

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(survey, null, 2)}\n`);
for (const entry of survey) {
  console.log(
    `p${entry.page} xo=${entry.xobjects} pathBox=${entry.pathBoxes} clusters=${entry.pathClusters}` +
      ` captions=[${entry.captions.join(",")}]` +
      ` accepted=${entry.accepted.length}` +
      ` [${entry.accepted.map((r) => `${r.caption ?? "-"}:${r.kind}:${r.rect.join(",")}:${r.pageAreaRatio}`).join(" | ")}]` +
      ` rejected=[${entry.rejectedReasons.join(",")}]` +
      ` uncovered=[${entry.uncoveredCaptions.join(",")}]`,
  );
}
console.log(`written: ${output}`);
