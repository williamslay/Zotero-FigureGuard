import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CAPTION_RE, collectCaptions, collectTextLines, textItemRect } from "../../src/core/captions.js";

/** Builds a PDF.js-like text item anchored at (x, baselineY). */
function item(str, x, baselineY, size = 9.963, width = str.length * size * 0.5) {
  return { str, transform: [size, 0, 0, size, x, baselineY], width, height: size, fontName: "f0" };
}

describe("captions: text item geometry", () => {
  it("rebuilds the user-space box from transform + advance width", () => {
    const rect = textItemRect(item("Figure 2:", 54, 599.615, 9.963, 37.02));
    assert.ok(Math.abs(rect[0] - 54) < 1e-9);
    assert.ok(Math.abs(rect[1] - 599.615) < 1e-9);
    assert.ok(Math.abs(rect[2] - 91.02) < 1e-9);
    assert.ok(Math.abs(rect[3] - 609.578) < 1e-3);
  });

  it("estimates width when the producer omits it", () => {
    const rect = textItemRect({ str: "Figure 3:", transform: [10, 0, 0, 10, 317.88, 559.149] });
    assert.ok(rect[2] > rect[0]);
  });

  it("returns null for degenerate items", () => {
    assert.equal(textItemRect({ str: "x", transform: [1, 0, 0, 0, 1, 1], width: 5 }), null);
    assert.equal(textItemRect(null), null);
  });
});

describe("captions: line reconstruction", () => {
  it("joins runs that share a baseline", () => {
    const lines = collectTextLines([
      item("Figure ", 54, 599.615),
      item("2: The map", 82, 599.615),
      item("Body text elsewhere", 54, 500),
    ]);
    assert.equal(lines.length, 2);
    const first = lines.find((l) => l.text.includes("Figure"));
    assert.ok(first.text.includes("2: The map"));
    assert.ok(first.rect[0] <= 54 && first.rect[2] > 82);
    assert.ok(lines[0].baselineY > lines[1].baselineY, "sorted top of page first");
  });

  it("keeps separate baselines separate", () => {
    const lines = collectTextLines([item("Figure 1:", 54, 700), item("Figure 2:", 54, 600)]);
    assert.equal(lines.length, 2);
  });

  it("ignores empty and non-text items", () => {
    const lines = collectTextLines([item("   ", 10, 500), { type: "marked-content", str: "Figure 9:" }]);
    assert.equal(lines.length, 0);
  });
});

describe("captions: horizontal gap segmentation", () => {
  // Fixture-shaped row: the Figure 8 caption shares one baseline with the body
  // text of the left column (baselines 441.4 and 442.16, gap 45.31 pt).
  const row = [
    item("records and 10 million records. We set the number of YCSB", 54, 441.4, 9.963, 240.12),
    item("Figure 8: Kafka producer throughput and latency.", 339.43, 442.16, 9.963, 197.03),
  ];

  it("splits a baseline that two columns share", () => {
    const lines = collectTextLines(row);
    assert.equal(lines.length, 2);
    assert.deepEqual(
      lines.map((line) => line.text.slice(0, 12)),
      ["Figure 8: Ka", "records and "],
    );
  });

  it("gives every segment its own rect", () => {
    const [captionLine] = collectTextLines(row);
    assert.ok(Math.abs(captionLine.rect[0] - 339.43) < 1e-9, "segment starts at the caption, not the body text");
    assert.ok(Math.abs(captionLine.rect[2] - 536.46) < 1e-9);
    assert.equal(captionLine.itemRects.length, 1);
  });

  it("lets the caption match at the head of its segment", () => {
    const captions = collectCaptions(collectTextLines(row));
    assert.deepEqual(captions.map((caption) => caption.number), ["8"]);
    assert.ok(Math.abs(captions[0].rect[0] - 339.43) < 1e-9, "caption rect is the segment rect");
  });

  it("keeps a single-segment row untouched", () => {
    const lines = collectTextLines([
      item("Figure 2:", 54, 599.615, 9.963, 37.02),
      item("the pipeline", 93.5, 599.615, 9.963, 48),
      item("stays one line", 144, 599.615, 9.963, 55),
    ]);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].text, "Figure 2: the pipeline stays one line");
    assert.ok(Math.abs(lines[0].rect[0] - 54) < 1e-9);
    assert.ok(Math.abs(lines[0].rect[2] - 199) < 1e-9);
    assert.equal(lines[0].itemRects.length, 3);
  });

  it("applies the threshold at two font sizes, with an 8 pt floor", () => {
    // 10 pt text: threshold = max(2 x 10, 8) = 20 pt.
    const joined = collectTextLines([item("AAAA", 54, 500, 10, 40), item("BBBB", 114, 500, 10, 40)]);
    assert.equal(joined.length, 1, "a gap of exactly 20 pt stays one line");
    const split = collectTextLines([item("AAAA", 54, 500, 10, 40), item("BBBB", 114.5, 500, 10, 40)]);
    assert.equal(split.length, 2, "20.5 pt opens a new segment");

    // 3 pt text: 2 x 3 = 6 pt would cut inside a word, so the 8 pt floor applies.
    const tinyJoined = collectTextLines([item("AAAA", 54, 300, 3, 20), item("BBBB", 81, 300, 3, 20)]);
    assert.equal(tinyJoined.length, 1, "a 7 pt gap is word spacing, not a column");
    const tinySplit = collectTextLines([item("AAAA", 54, 300, 3, 20), item("BBBB", 83, 300, 3, 20)]);
    assert.equal(tinySplit.length, 2, "9 pt exceeds the floor");
  });

  it("honours an explicit threshold", () => {
    // 16.4 pt gap at 9.963 pt text: 1.65 units, below the default 2, above 1.
    const runs = [item("FIO 4 KB random R/W", 54, 120, 9.963, 100), item("Figure 16: FIO", 170.4, 120, 9.963, 60)];
    assert.equal(collectTextLines(runs).length, 1);
    assert.equal(collectTextLines(runs, { columnGapMinFontSizeUnits: 1 }).length, 2);
    assert.equal(collectTextLines(runs, { columnGapMinPt: 200 }).length, 1);
  });

  it("splits two adjacent figure captions across a 1.9x column gutter", () => {
    const runs = [
      item("Figure 9: Random-load Performance. This figure", 72, 370, 9.963, 222.3),
      item("Figure 10: Write Amplification of WiscKey.", 313.7, 370, 9.963, 200),
    ];
    const lines = collectTextLines(runs);
    assert.equal(lines.length, 2);
    const captions = collectCaptions(lines);
    assert.deepEqual(
      captions.map((c) => c.number),
      ["9", "10"],
    );
  });
});

describe("captions: figure labels", () => {
  const cases = [
    ["Figure 2: caption text", "2"],
    ["Fig. 3) caption text", "3"],
    ["FIGURE 10: caption text", "10"],
    ["Fig 7a: subfigure", "7a"],
    ["Figure 4 — System Overview", "4"],
    ["Fig. 5 – Results", "5"],
    ["Fig. 5 - Results", "5"],
    ["Fig . 8 : Throughput", "8"],
  ];
  for (const [text, number] of cases) {
    it(`accepts ${JSON.stringify(text)}`, () => {
      const captions = collectCaptions([{ text, rect: [54, 599, 240, 610], fontSize: 10 }]);
      assert.equal(captions.length, 1);
      assert.equal(captions[0].number, number);
    });
  }

  it("reconstructs PDF.js split punctuation runs like Fig + . + 8 + :", () => {
    const runs = [
      item("Fig", 54, 600, 10, 14),
      item(".", 68.5, 600, 10, 2.5),
      item("8", 74, 600, 10, 5),
      item(":", 79.5, 600, 10, 2.5),
      item("Throughput", 86, 600, 10, 55),
    ];
    const lines = collectTextLines(runs);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].text, "Fig. 8: Throughput");
    const captions = collectCaptions(lines);
    assert.equal(captions.length, 1);
    assert.equal(captions[0].number, "8");
    assert.equal(captions[0].label, "Fig. 8:");
  });

  it("accepts controlled delimiter-less and two-line captions when isolated or distinct", () => {
    const inlineCaption = collectCaptions([
      { text: "Figure 6 Performance comparison", rect: [54, 560, 230, 570], fontSize: 10, fontName: "bold" },
      { text: "We compare throughput across all three storage systems in detail.", rect: [54, 500, 294, 510], fontSize: 10, fontName: "regular" },
      { text: "Each workload runs for five minutes after warmup completes.", rect: [54, 488, 294, 498], fontSize: 10, fontName: "regular" },
      { text: "Memory bandwidth remains bounded throughout every experiment.", rect: [54, 476, 294, 486], fontSize: 10, fontName: "regular" },
    ]);
    assert.equal(inlineCaption.length, 1);
    assert.equal(inlineCaption[0].number, "6");

    const twoLine = collectCaptions([
      { text: "Figure 7", rect: [275, 560, 325, 570], fontSize: 10 },
      { text: "System architecture overview across CXL memory and flash tiers.", rect: [54, 545, 558, 555], fontSize: 10 },
    ]);
    assert.equal(twoLine.length, 1);
    assert.equal(twoLine[0].number, "7");
    assert.equal(twoLine[0].label, "Figure 7");
    assert.deepEqual(twoLine[0].rect, [54, 545, 558, 570]);
    assert.ok(twoLine[0].text.includes("System architecture overview"));
  });

  it("excludes prose cross-references even at line starts", () => {
    const proseLines = [
      { text: "Figure 6 shows that throughput increases across all workloads.", rect: [54, 500, 294, 510], fontSize: 10 },
      { text: "Figure 2, Flatstore reduces write amplification dramatically.", rect: [54, 480, 294, 490], fontSize: 10 },
      { text: "Figure 6-(b) shows that MEMREAD saturates flash channels.", rect: [54, 460, 294, 470], fontSize: 10 },
      { text: "Figure 5(a), the amplitude varies with queue depth.", rect: [54, 440, 294, 450], fontSize: 10 },
      { text: "Figure 6-11 summarize our sensitivity evaluation across traces.", rect: [54, 420, 294, 430], fontSize: 10 },
    ];
    assert.equal(collectCaptions(proseLines).length, 0);

    // Indented justified body paragraph opening ("Figure 6. ...")
    const indentedParagraph = [
      { text: "Figure 6. For larger value sizes, background compaction helps.", rect: [64, 500, 294, 510], fontSize: 10, fontName: "f0" },
      { text: "This behaviour continues across all four SSD devices in our cluster.", rect: [54, 488, 294, 498], fontSize: 10, fontName: "f0" },
    ];
    assert.equal(collectCaptions(indentedParagraph).length, 0);

    // Embedded multi-line body paragraph starting "Figure 6 <ProperNoun>..."
    const denseParagraph = [
      { text: "Earlier storage engines suffer from high compaction stalls on flash.", rect: [54, 524, 294, 534], fontSize: 10, fontName: "f0" },
      { text: "Our evaluation confirms consistent latency tail behavior.", rect: [54, 512, 294, 522], fontSize: 10, fontName: "f0" },
      { text: "Figure 6 ByteFS improves throughput by 3x across all workloads.", rect: [54, 500, 294, 510], fontSize: 10, fontName: "f0" },
      { text: "Moreover, the background write log keeps queues bounded.", rect: [54, 488, 294, 498], fontSize: 10, fontName: "f0" },
    ];
    assert.equal(collectCaptions(denseParagraph).length, 0);

    // Delimiter-less line on a page with graphic context disabled/absent stays rejected without distinct font
    const noGraphicPage = collectCaptions(
      [
        { text: "Summary of experiments conducted across all workloads.", rect: [54, 540, 294, 550], fontSize: 10, fontName: "f0" },
        { text: "Figure 6 ByteFS throughput scales cleanly with thread count.", rect: [54, 500, 294, 510], fontSize: 10, fontName: "f0" },
        { text: "Each run measures steady-state performance under YCSB-A.", rect: [54, 488, 294, 498], fontSize: 10, fontName: "f0" },
        { text: "Cache hit rates stay above ninety percent during the benchmark.", rect: [54, 476, 294, 486], fontSize: 10, fontName: "f0" },
      ],
      { placements: [], pageRect: [0, 0, 612, 792] },
    );
    assert.equal(noGraphicPage.length, 0);
  });

  it("rejects body text that only mentions a figure", () => {
    assert.equal(CAPTION_RE.test("see Figure 2 for details"), false);
    assert.equal(collectCaptions([{ text: "in Figure 2.", rect: [0, 0, 1, 1] }]).length, 0);
  });

  it("keeps the caption rect untouched for the gap test", () => {
    const [caption] = collectCaptions([
      { text: "Figure 2: the pipeline", rect: [54, 599.615, 300, 609.578], fontSize: 10 },
    ]);
    assert.deepEqual(caption.rect, [54, 599.615, 300, 609.578]);
    assert.equal(caption.label, "Figure 2:");
  });

  it("ignores wrapped in-paragraph references starting a line with 'Figure N.'", () => {
    const lines = [
      {
        text: "percentage of the total time, for the reasons explained in",
        rect: [315.3, 193.1, 540.3, 203.1],
        fontSize: 10,
      },
      {
        text: "Figure 6. For larger pairs, log writing and the memtable",
        rect: [315.3, 181.3, 540.5, 191.2],
        fontSize: 10,
      },
    ];
    assert.equal(collectCaptions(lines).length, 0);
  });

  it("handles same-baseline dash captions next to prose without leaking prose as caption", () => {
    const row = [
      item("As discussed earlier, Figure 3 shows low tail latency under", 54, 440, 9.963, 240),
      item("Figure 4 — System Overview", 336, 440, 9.963, 180),
    ];
    const lines = collectTextLines(row);
    const captions = collectCaptions(lines);
    assert.deepEqual(captions.map((c) => c.number), ["4"]);
    assert.equal(captions[0].label, "Figure 4 —");
  });
});
