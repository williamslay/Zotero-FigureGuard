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
});

describe("captions: figure labels", () => {
  const cases = [
    ["Figure 2: caption text", "2"],
    ["Fig. 3) caption text", "3"],
    ["FIGURE 10: caption text", "10"],
    ["Fig 7a: subfigure", "7a"],
  ];
  for (const [text, number] of cases) {
    it(`accepts ${JSON.stringify(text)}`, () => {
      const captions = collectCaptions([{ text, rect: [54, 599, 200, 610], fontSize: 10 }]);
      assert.equal(captions.length, 1);
      assert.equal(captions[0].number, number);
    });
  }

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
});
