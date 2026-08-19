/**
 * The pure half of HTML → PPTX: unit conversion, slide sizing, colour parsing,
 * pruning, and the slack that keeps PowerPoint's own line breaking from
 * pushing text out of a box.
 *
 * This is where the bugs live. The measuring half runs inside the sandboxed
 * preview frame against a real layout engine (harvester.js) and the writing
 * half is a call into pptxgenjs — neither is meaningfully testable in node,
 * and both were kept deliberately thin so that everything worth checking
 * ended up here.
 */
import { describe, expect, it } from "vitest";
import {
  cssColor,
  degradedSummary,
  inchesPerPx,
  pruneBlocks,
  slideSize,
  toShapes,
  type Block,
  type HarvestedDeck,
} from "../pptx/deck";

const CANVAS = { width: 1280, height: 720 };

function deckOf(blocks: Block[], degraded: string[] = []): HarvestedDeck {
  return { canvas: CANVAS, slides: [{ blocks, degraded }] };
}

describe("slideSize", () => {
  it("snaps a 16:9 page to PowerPoint's own widescreen size", () => {
    // Not tidiness: a deck declared 13.333×7.5 opens as an ordinary widescreen
    // presentation, where 13.333×7.49 is an odd size every template fights.
    // And the name is WIDE, not 16x9 — pptxgenjs's "16x9" is the *old* 10×5.625
    // size, which would silently produce a deck three quarters the expected one.
    expect(slideSize({ width: 1280, height: 720 })).toEqual({
      width: 13.333, height: 7.5, standard: "LAYOUT_WIDE",
    });
    // Off by a pixel from a border or a rounded rect — still 16:9.
    expect(slideSize({ width: 1278, height: 720 }).standard).toBe("LAYOUT_WIDE");
  });

  it("snaps 4:3 too", () => {
    expect(slideSize({ width: 1024, height: 768 })).toEqual({
      width: 10, height: 7.5, standard: "LAYOUT_4x3",
    });
  });

  it("keeps a non-standard page's own aspect rather than letterboxing it", () => {
    const square = slideSize({ width: 1080, height: 1080 });
    expect(square.standard).toBeNull();
    expect(square.width / square.height).toBeCloseTo(1, 3);
  });
});

describe("inchesPerPx", () => {
  it("makes 96 CSS pixels one inch for a 1280-wide deck", () => {
    // Which is what makes `font-size: 32px` land as 24pt — the size the author
    // would have picked in PowerPoint anyway.
    expect(inchesPerPx(CANVAS, slideSize(CANVAS)) * 96).toBeCloseTo(1, 3);
  });
});

describe("cssColor", () => {
  it("reads the forms getComputedStyle actually returns", () => {
    expect(cssColor("rgb(17, 24, 39)")).toEqual({ hex: "111827", transparency: 0 });
    expect(cssColor("rgba(17, 24, 39, 0.5)")).toEqual({ hex: "111827", transparency: 50 });
    expect(cssColor("rgb(17 24 39 / 25%)")).toEqual({ hex: "111827", transparency: 75 });
  });

  it("treats a fully transparent colour as nothing to paint", () => {
    // Every element in a page has a background-color, and almost all of them
    // say rgba(0, 0, 0, 0). Reading that as a colour would paint the entire DOM
    // as a stack of opaque black rectangles.
    expect(cssColor("rgba(0, 0, 0, 0)")).toBeNull();
    expect(cssColor("transparent")).toBeNull();
    expect(cssColor(undefined)).toBeNull();
  });

  it("reads hex and named colours, and refuses what it cannot", () => {
    expect(cssColor("#abc")).toEqual({ hex: "AABBCC", transparency: 0 });
    expect(cssColor("#11223344")).toEqual({ hex: "112233", transparency: 73 });
    expect(cssColor("white")).toEqual({ hex: "FFFFFF", transparency: 0 });
    expect(cssColor("color-mix(in srgb, red, blue)")).toBeNull();
  });
});

describe("pruneBlocks", () => {
  it("drops what would only add layers nobody can edit around", () => {
    const kept = pruneBlocks([
      { kind: "rect", x: 0, y: 0, w: 100, h: 40, fill: "rgb(1, 2, 3)" },
      // A layout container: no fill, no border — invisible, and there are
      // hundreds of them in any real page.
      { kind: "rect", x: 0, y: 0, w: 100, h: 40 },
      // A hairline artefact.
      { kind: "rect", x: 0, y: 0, w: 100, h: 0.4, fill: "rgb(1, 2, 3)" },
      { kind: "text", x: 0, y: 0, w: 100, h: 20, runs: [{ text: "  ", sizePx: 16 }], align: "left", lines: 1 },
      { kind: "text", x: 0, y: 0, w: 100, h: 20, runs: [{ text: "标题", sizePx: 16 }], align: "left", lines: 1 },
      { kind: "image", x: 0, y: 0, w: 10, h: 10, data: "" },
    ]);
    expect(kept).toHaveLength(2);
    expect(kept[0].kind).toBe("rect");
    expect(kept[1].kind).toBe("text");
  });
});

describe("toShapes", () => {
  it("places a box where the browser measured it", () => {
    const [shape] = toShapes(
      deckOf([{ kind: "rect", x: 640, y: 360, w: 320, h: 180, fill: "rgb(0, 0, 0)" }]),
      0,
    );
    expect(shape.x).toBeCloseTo(6.667, 2);
    expect(shape.y).toBeCloseTo(3.75, 2);
    expect(shape.w).toBeCloseTo(3.333, 2);
    expect(shape.h).toBeCloseTo(1.875, 2);
  });

  it("carries a font size across as the point size PowerPoint would have used", () => {
    const [shape] = toShapes(
      deckOf([{ kind: "text", x: 0, y: 0, w: 400, h: 40, align: "left", lines: 1,
        runs: [{ text: "标题", sizePx: 32, bold: true, color: "rgb(255, 255, 255)" }] }]),
      0,
    );
    if (shape.kind !== "text") throw new Error("expected a text shape");
    expect(shape.runs[0].ptSize).toBeCloseTo(24, 1);
    expect(shape.runs[0].bold).toBe(true);
    expect(shape.runs[0].color).toBe("FFFFFF");
  });

  it("grows a text box symmetrically so centred text does not drift", () => {
    // The slack is what absorbs PowerPoint re-breaking a line the browser fit.
    // Growing only rightwards would move the visual centre of every centred
    // heading — which in a deck is most of them.
    const [shape] = toShapes(
      deckOf([{ kind: "text", x: 100, y: 100, w: 400, h: 40, align: "center", lines: 1,
        runs: [{ text: "居中标题", sizePx: 32 }] }]),
      0,
    );
    const scale = inchesPerPx(CANVAS, slideSize(CANVAS));
    const centreBefore = (100 + 400 / 2) * scale;
    // Within a thousandth of an inch — the rounding both ends are stored at.
    expect(shape.x + shape.w / 2).toBeCloseTo(centreBefore, 2);
    expect(shape.w).toBeGreaterThan(400 * scale);
  });

  it("lets PowerPoint shrink only text that has somewhere to reflow to", () => {
    const single = toShapes(
      deckOf([{ kind: "text", x: 0, y: 0, w: 400, h: 40, align: "left", lines: 1,
        runs: [{ text: "一行", sizePx: 32 }] }]),
      0,
    )[0];
    const wrapped = toShapes(
      deckOf([{ kind: "text", x: 0, y: 0, w: 400, h: 120, align: "left", lines: 3,
        runs: [{ text: "很长的一段正文", sizePx: 32 }] }]),
      0,
    )[0];
    if (single.kind !== "text" || wrapped.kind !== "text") throw new Error("expected text shapes");
    expect(single.shrink).toBe(false);
    expect(wrapped.shrink).toBe(true);
  });

  it("gives the corner radius in inches, the unit the writer's option is in", () => {
    // pptxgenjs converts to OOXML's fraction itself. Handing it a fraction
    // (which is what the XML attribute holds) reads as a fraction of an inch —
    // a barely-rounded corner, and nothing anywhere reports a problem.
    const scale = inchesPerPx(CANVAS, slideSize(CANVAS));
    const [shape] = toShapes(
      deckOf([{ kind: "rect", x: 0, y: 0, w: 400, h: 200, fill: "rgb(0, 0, 0)", radiusPx: 24 }]),
      0,
    );
    if (shape.kind !== "rect") throw new Error("expected a rect");
    expect(shape.radius).toBeCloseTo(24 * scale, 3);
  });

  it("caps a radius at half the shorter side", () => {
    // Past that the adjustment is out of range and the shape stops being a
    // rounded rectangle at all.
    const [shape] = toShapes(
      deckOf([{ kind: "rect", x: 0, y: 0, w: 400, h: 200, fill: "rgb(0, 0, 0)", radiusPx: 400 }]),
      0,
    );
    if (shape.kind !== "rect") throw new Error("expected a rect");
    expect(shape.radius).toBeCloseTo(shape.h / 2, 3);
  });

  it("keeps a border only when its colour is actually visible", () => {
    const [shape] = toShapes(
      deckOf([{ kind: "rect", x: 0, y: 0, w: 400, h: 200, line: { color: "rgba(0, 0, 0, 0)", widthPx: 2 } }]),
      0,
    );
    // Neither fill nor a visible line — the block should not have survived at all.
    expect(shape).toBeUndefined();
  });

  it("returns nothing for a slide that is not there", () => {
    expect(toShapes(deckOf([]), 7)).toEqual([]);
  });
});

describe("degradedSummary", () => {
  it("says which slide lost what, so the author is told rather than surprised", () => {
    const deck: HarvestedDeck = {
      canvas: CANVAS,
      slides: [
        { blocks: [], degraded: [] },
        { blocks: [], degraded: ["a gradient/image background became a solid colour"] },
      ],
    };
    expect(degradedSummary(deck)).toEqual([
      "Slide 2: a gradient/image background became a solid colour",
    ]);
  });
});
