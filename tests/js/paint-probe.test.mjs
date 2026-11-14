import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { probeOverlay } from "../../src/zotero/paint-probe.js";
import { probePaint } from "../../src/zotero/main.js";

/** All-white pixel data for a requested sample box. */
function whiteFill(x, y, w, h) {
  return new Uint8ClampedArray(w * h * 4).fill(255);
}

/** First half of the pixels dark (20,30,40), second half white. */
function halfDarkFill(x, y, w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  data.fill(255);
  const total = w * h;
  for (let i = 0; i < total / 2; i += 1) {
    data[i * 4] = 20;
    data[i * 4 + 1] = 30;
    data[i * 4 + 2] = 40;
    data[i * 4 + 3] = 255;
  }
  return data;
}

/** Fully transparent pixel data: every channel, alpha included, is 0. */
function zeroFill(x, y, w, h) {
  return new Uint8ClampedArray(w * h * 4);
}

/**
 * A canvas whose getImageData returns generated data sized to the requested
 * box, so downsample assertions can see what the probe actually asked for.
 */
function fakeCanvas({ width = 4, height = 2, fill = whiteFill, throws = false, style } = {}) {
  const calls = [];
  const canvas = {
    width,
    height,
    style: style ?? { left: "10px", top: "20px", width: "100px", height: "50px" },
    getContext() {
      if (throws) {
        return {
          getImageData() {
            throw new Error("tainted canvas");
          },
        };
      }
      return {
        getImageData(x, y, w, h) {
          calls.push([x, y, w, h]);
          return { data: fill(x, y, w, h) };
        },
      };
    },
  };
  canvas.calls = calls;
  return canvas;
}

/** A PageOverlay stand-in: inner window at 1.5 scaling, one page view. */
function fakeOverlay(canvases) {
  return {
    pageNumber: 3,
    painted: true,
    canvases: canvases ?? [fakeCanvas()],
    innerWin: { devicePixelRatio: 1.5, visualViewport: { scale: 1.25 } },
    pageView: {
      div: { clientWidth: 612, clientHeight: 792 },
      canvas: fakeCanvas({ width: 61, height: 72 }),
    },
  };
}

describe("paint probe: probeOverlay geometry", () => {
  it("reports page, device scale and per-canvas CSS box", () => {
    const result = probeOverlay(fakeOverlay());
    assert.equal(result.pageNumber, 3);
    assert.equal(result.painted, true);
    assert.equal(result.canvasCount, 1);
    assert.equal(result.deviceScale.devicePixelRatio, 1.5);
    assert.equal(result.deviceScale.visualScale, 1.25);
    assert.equal(result.page.cssWidth, 612);
    assert.equal(result.page.cssHeight, 792);
    assert.equal(result.page.canvasWidth, 61);
    assert.equal(result.page.canvasHeight, 72);
    assert.equal(result.page.nonWhite, 0);
    assert.equal(result.truncated, undefined);
    const region = result.regions[0];
    assert.equal(region.index, 0);
    assert.equal(region.cssLeft, "10px");
    assert.equal(region.cssTop, "20px");
    assert.equal(region.cssWidth, "100px");
    assert.equal(region.cssHeight, "50px");
    assert.equal(region.bufWidth, 4);
    assert.equal(region.bufHeight, 2);
    assert.equal(region.sampledBox, undefined);
  });

  it("stays silent about fields a missing overlay cannot carry", () => {
    const result = probeOverlay(null);
    assert.equal(result.pageNumber, null);
    assert.equal(result.painted, false);
    assert.equal(result.canvasCount, 0);
    assert.equal(result.deviceScale.devicePixelRatio, null);
    assert.equal(result.deviceScale.visualScale, null);
    assert.equal(result.page.cssWidth, null);
    assert.deepEqual(result.regions, []);
    assert.equal(result.error, undefined);
  });

  it("reports the provenance stamped on the canvas", () => {
    const canvas = fakeCanvas();
    canvas.dataset = { fcpRealm: "r7", fcpDoc: "fcp:printed" };
    const region = probeOverlay(fakeOverlay([canvas])).regions[0];
    assert.equal(region.fcpRealm, "r7", "the probe echoes which realm handed the canvas out");
    assert.equal(region.fcpDoc, "fcp:printed", "and which document's regions it shows");
  });

  it("reports null provenance for a canvas the stamp never reached", () => {
    const region = probeOverlay(fakeOverlay([fakeCanvas()])).regions[0];
    assert.equal(region.fcpRealm, null, "an unstamped canvas says so instead of guessing");
    assert.equal(region.fcpDoc, null);
  });
});

describe("paint probe: probeOverlay pixels", () => {
  it("reports zero ink and null mean for all-white data", () => {
    const region = probeOverlay(fakeOverlay()).regions[0];
    assert.equal(region.nonWhite, 0);
    assert.equal(region.mean, null);
    assert.equal(region.grid.length, 25);
    // A 4x2 buffer only reaches grid rows 0 and 2 and columns 0..3; cells the
    // box never covers are [0,0,0], cells it covers average white.
    for (const cell of [0, 1, 2, 3, 10, 11, 12, 13]) assert.deepEqual(region.grid[cell], [255, 255, 255]);
    assert.deepEqual(region.grid[4], [0, 0, 0], "a column with no pixels is [0,0,0]");
    assert.deepEqual(region.grid[20], [0, 0, 0], "a row with no pixels is [0,0,0]");
  });

  it("reports half ink and the ink colour for half-dark data", () => {
    const canvas = fakeCanvas({ width: 4, height: 2, fill: halfDarkFill });
    const region = probeOverlay(fakeOverlay([canvas])).regions[0];
    assert.equal(region.nonWhite, 0.5);
    assert.deepEqual(region.mean, [20, 30, 40]);
    assert.equal(region.grid.length, 25);
    // The dark pixels fill the whole top row: grid rows confined to the top,
    // which is the offset-bug signature this grid exists to reveal.
    for (const cell of [0, 1, 2, 3]) assert.deepEqual(region.grid[cell], [20, 30, 40]);
    for (const cell of [10, 11, 12, 13]) assert.deepEqual(region.grid[cell], [255, 255, 255]);
    assert.deepEqual(region.grid[4], [0, 0, 0], "a column with no pixels is [0,0,0]");
  });

  it("copies a Float64Array-backed buffer (Xray stand-in) before indexing", () => {
    const fill = (x, y, w, h) => Float64Array.from(halfDarkFill(x, y, w, h));
    const region = probeOverlay(fakeOverlay([fakeCanvas({ fill })])).regions[0];
    assert.equal(region.nonWhite, 0.5);
    assert.deepEqual(region.mean, [20, 30, 40]);
  });

  it("counts transparent pixels as ink", () => {
    const canvas = fakeCanvas({ width: 4, height: 2, fill: zeroFill });
    const region = probeOverlay(fakeOverlay([canvas])).regions[0];
    assert.equal(region.nonWhite, 1);
    assert.deepEqual(region.mean, [0, 0, 0]);
  });

  it("records a throwing getImageData as an error and keeps geometry", () => {
    const canvas = fakeCanvas({ throws: true });
    const region = probeOverlay(fakeOverlay([canvas])).regions[0];
    assert.equal(region.error, "tainted canvas");
    assert.equal(region.nonWhite, null);
    assert.equal(region.mean, null);
    assert.equal(region.grid, null);
    assert.equal(region.bufWidth, 4);
    assert.equal(region.cssLeft, "10px");
  });

  it("reports which render route painted the page", () => {
    const overlay = fakeOverlay([fakeCanvas()]);
    assert.equal(probeOverlay(overlay).paintPath, null, "null before the first paint");
    overlay.paintPath = "helper";
    assert.equal(probeOverlay(overlay).paintPath, "helper", "rendered inside the pdf.js viewer realm");
    overlay.paintPath = "legacy";
    assert.equal(probeOverlay(overlay).paintPath, "legacy", "rendered by the sandbox-side call");
    overlay.paintPath = "sideways";
    assert.equal(probeOverlay(overlay).paintPath, null, "an unknown route is not reported");
  });
});

describe("paint probe: probeOverlay sampling budget", () => {
  it("samples a centred box inside the one-megapixel readback budget", () => {
    const canvas = fakeCanvas({ width: 3000, height: 2000 });
    const region = probeOverlay(fakeOverlay([canvas])).regions[0];
    assert.deepEqual(region.sampledBox, [1000, 500, 1000, 1000]);
    assert.equal(region.sampledBox[2] * region.sampledBox[3] <= 1_000_000, true, "the readback area is capped");
    assert.equal(region.readbackPixels, 1_000_000);
    assert.deepEqual(canvas.calls, [[1000, 500, 1000, 1000]], "getImageData gets the box, not the canvas");
    assert.equal(region.nonWhite, 0);
  });

  it("shrinks a tall oversized canvas to the readback budget", () => {
    // The real-machine page canvas measured 3738x4844 = 18.1 MP; copying it whole
    // across the boundary is what froze the UI.
    const canvas = fakeCanvas({ width: 3738, height: 4844 });
    const result = probeOverlay(fakeOverlay([canvas]));
    const box = result.regions[0].sampledBox;
    assert.equal(box[2] * box[3] <= 1_000_000, true);
    assert.equal(result.regions[0].readbackPixels, box[2] * box[3]);
    assert.deepEqual(canvas.calls, [box], "one getImageData for the whole probe");
  });

  it("reports the readback window of an unclipped canvas", () => {
    const canvas = fakeCanvas({ width: 40, height: 20 });
    const region = probeOverlay(fakeOverlay([canvas])).regions[0];
    assert.equal(region.sampledBox, undefined, "an in-budget canvas is not clipped");
    assert.equal(region.readbackPixels, 800);
    assert.equal(region.scannedPixels, 800);
  });

  it("honours a shrunk budget through options", () => {
    const canvas = fakeCanvas({ width: 300, height: 40 });
    const region = probeOverlay(fakeOverlay([canvas]), { maxSampledPixels: 100, maxSampleSide: 10 }).regions[0];
    assert.deepEqual(region.sampledBox, [145, 15, 10, 10]);
  });

  it("honours maxPaintReadbackPixels through options", () => {
    const canvas = fakeCanvas({ width: 300, height: 40 });
    const region = probeOverlay(fakeOverlay([canvas]), { maxPaintReadbackPixels: 100, maxSampleSide: 10 }).regions[0];
    assert.deepEqual(region.sampledBox, [145, 15, 10, 10]);
  });

  it("caps the pixel scan with a stride and keeps one readback", () => {
    const canvas = fakeCanvas({ width: 3000, height: 2000 });
    const region = probeOverlay(fakeOverlay([canvas])).regions[0];
    assert.equal(region.stride, 3, "the probe shares 250k across page and region: 334^2 fits 125k, 500^2 does not");
    assert.equal(region.scannedPixels, 334 * 334);
    assert.equal(canvas.calls.length, 1, "the sample box is still read back in one getImageData");
    assert.deepEqual(canvas.calls[0], [1000, 500, 1000, 1000]);
    assert.equal(region.nonWhite, 0);
  });

  it("honours maxScanPixels through options", () => {
    const canvas = fakeCanvas({ width: 300, height: 40 });
    const region = probeOverlay(fakeOverlay([canvas]), { maxScanPixels: 200 }).regions[0];
    assert.equal(region.stride, 12, "25*4 fits the 100-pixel share, 28*4 does not");
    assert.equal(region.scannedPixels, 100);
  });

  it("keeps stride 1 for canvases inside the scan budget", () => {
    const result = probeOverlay(fakeOverlay([fakeCanvas({ width: 4, height: 2 })]));
    assert.equal(result.regions[0].stride, 1);
    assert.equal(result.regions[0].scannedPixels, 8);
    assert.equal(result.page.stride, 1, "the page sample shares the same budget split");
    assert.equal(result.page.scannedPixels, 61 * 72);
  });

  it("keeps at most eight regions and flags truncation", () => {
    const canvases = Array.from({ length: 10 }, () => fakeCanvas());
    const result = probeOverlay(fakeOverlay(canvases));
    assert.equal(result.canvasCount, 10);
    assert.equal(result.regions.length, 8);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.regions.map((region) => region.index), [0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("paint probe: main.probePaint", () => {
  it("reports an empty session-less state without Zotero", () => {
    const result = probePaint();
    assert.equal(typeof result.at, "string");
    assert.equal(result.ready, false);
    assert.equal(result.innerWin, false);
    assert.equal(result.overlays, 0);
    assert.equal(result.currentPage, null);
    assert.equal(result.target, null);
    assert.ok(Array.isArray(result.log));
  });

  it("accepts a page number and still returns null target without a session", () => {
    const result = probePaint(2);
    assert.equal(result.target, null);
    assert.equal(result.currentPage, null);
  });
});

describe("paint probe: paint failure evidence", () => {
  it("carries the last paint error and the failed-canvas class", () => {
    const canvas = fakeCanvas();
    canvas.classList = { contains: (name) => name === "fcp-error" };
    const overlay = fakeOverlay([canvas]);
    overlay.lastPaintError = "render: Cannot use the same canvas";
    const result = probeOverlay(overlay);
    assert.equal(result.paintError, "render: Cannot use the same canvas");
    assert.equal(result.regions[0].errClass, true);
  });

  it("reports no paint error and no error class for a healthy overlay", () => {
    const result = probeOverlay(fakeOverlay());
    assert.equal(result.paintError, null);
    assert.equal(result.regions[0].errClass, false);
  });
});

/**
 * The stale-geometry evidence added for the "the boxes sit displaced after the
 * toolbar toggle off→on" report: the viewport the last paint used, the viewport
 * the page has now, the host box, the reader's zoom custom properties, and each
 * canvas' own box and positioning host.
 */
describe("paint probe: stale geometry evidence", () => {
  /** `fakeOverlay` plus the realm reads the new fields need. */
  function geometryOverlay({ viewport = null, computed = null, withRects = false } = {}) {
    const overlay = fakeOverlay();
    const rect = (left, top, width, height) => () => ({ left, top, width, height });
    overlay.pageView.viewport = viewport;
    if (computed) overlay.innerWin.getComputedStyle = () => computed;
    if (withRects) {
      overlay.pageView.div.getBoundingClientRect = rect(8, 12, 620, 800);
      const host = { tagName: "DIV", className: "page" };
      for (const [index, canvas] of overlay.canvases.entries()) {
        canvas.getBoundingClientRect = rect(10 + index, 20 + index, 100, 50);
        canvas.offsetParent = host;
      }
    }
    return overlay;
  }

  it("puts the paint-time viewport next to the live one", () => {
    const overlay = geometryOverlay({ viewport: { width: 700, height: 900, scale: 1.25, rotation: 0 } });
    overlay.lastPaintGeometry = {
      at: 1, viewportWidth: 612, viewportHeight: 792, viewportScale: 1, viewportRotation: 0, deviceScale: 2,
    };
    const result = probeOverlay(overlay);
    assert.equal(result.lastPaintGeometry.viewportWidth, 612, "the size the canvases were painted at");
    assert.equal(result.lastPaintGeometry.viewportScale, 1);
    assert.equal(result.liveViewport.width, 700, "the size the page has now — the pair differs, so the paint is stale");
    assert.equal(result.liveViewport.height, 900);
    assert.equal(result.liveViewport.scale, 1.25);
    assert.equal(result.liveViewport.rotation, 0);
  });

  it("reports nulls for an overlay that never painted and a page without a viewport", () => {
    const result = probeOverlay(geometryOverlay());
    assert.equal(result.lastPaintGeometry, null);
    assert.deepEqual(result.liveViewport, { width: null, height: null, scale: null, rotation: null });
    assert.deepEqual(result.cssVars, { scaleFactor: null, userUnit: null, totalScaleFactor: null });
  });

  it("keeps an absent custom property null instead of reading it as zero", () => {
    const overlay = geometryOverlay({
      computed: {
        getPropertyValue: (name) => {
          if (name === "--scale-factor") return "1.5";
          if (name === "--total-scale-factor") return " 2 ";
          return "";
        },
      },
    });
    const result = probeOverlay(overlay);
    assert.equal(result.cssVars.scaleFactor, 1.5);
    assert.equal(result.cssVars.totalScaleFactor, 2, "the value is trimmed before parsing");
    assert.equal(result.cssVars.userUnit, null, "`--user-unit` is not defined by Zotero's reader");
  });

  it("labels the positioning host and reports each canvas box", () => {
    const overlay = geometryOverlay({
      withRects: true,
      computed: { getPropertyValue: () => "" },
      viewport: { width: 700, height: 900, scale: 1.25, rotation: 0 },
    });
    const result = probeOverlay(overlay);
    assert.equal(result.hostBox.clientWidth, 612);
    assert.equal(result.hostBox.rectWidth, 620);
    assert.equal(result.hostBox.rectHeight, 800);
    const region = result.regions[0];
    assert.equal(region.rectLeft, 10);
    assert.equal(region.rectTop, 20);
    assert.equal(region.rectWidth, 100);
    assert.equal(region.rectHeight, 50);
    assert.equal(region.offsetParent, "div.page", "the host label is compared against the page div");
  });

  it("stays silent about boxes a plain overlay stand-in cannot give", () => {
    const result = probeOverlay(fakeOverlay());
    assert.equal(result.hostBox.rectWidth, null, "no getBoundingClientRect on the stand-in div");
    assert.equal(result.hostBox.clientWidth, 612, "the property reads still work");
    assert.equal(result.regions[0].rectWidth, null);
    assert.equal(result.regions[0].offsetParent, null, "no offsetParent means no host label");
  });

  it("drops a host element that carries no tag name", () => {
    const overlay = geometryOverlay({ withRects: true });
    overlay.canvases[0].offsetParent = { tagName: "", className: "page" };
    assert.equal(probeOverlay(overlay).regions[0].offsetParent, null);
  });
});
