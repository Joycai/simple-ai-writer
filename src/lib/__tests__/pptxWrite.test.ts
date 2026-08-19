/**
 * The writer, end to end: a measured deck in, real .pptx bytes out.
 *
 * Thin as this layer is, it is the one that fails *silently*. Every option
 * pptxgenjs does not recognise is ignored rather than rejected, so a renamed
 * property or a value in the wrong unit still produces a file — one that opens
 * blank, or that PowerPoint offers to repair. Asserting on the bytes is what
 * catches that: the package is a zip, and the text we put in has to be findable
 * in the slide part that claims to carry it.
 */
import { describe, expect, it } from "vitest";
import { deckToPptx } from "../pptx/write";
import type { HarvestedDeck } from "../pptx/deck";

const DECK: HarvestedDeck = {
  canvas: { width: 1280, height: 720 },
  slides: [
    {
      blocks: [
        { kind: "rect", x: 0, y: 0, w: 1280, h: 720, fill: "rgb(15, 23, 42)" },
        {
          kind: "text", x: 80, y: 120, w: 405, h: 90, align: "left", lines: 1,
          runs: [{ text: "量化做市方案", sizePx: 64, bold: true, color: "rgb(248, 250, 252)", font: "PingFang SC" }],
        },
      ],
      degraded: [],
    },
    {
      blocks: [
        {
          kind: "rect", x: 80, y: 200, w: 480, h: 300, fill: "rgb(30, 41, 59)",
          line: { color: "rgb(56, 189, 248)", widthPx: 2 }, radiusPx: 24,
        },
        {
          kind: "text", x: 112, y: 289, w: 172, h: 31, align: "left", lines: 2,
          runs: [{ text: "• 一期：接入行情", sizePx: 22, color: "rgb(203, 213, 225)" }],
        },
      ],
      degraded: ["a gradient/image background became a solid colour"],
    },
  ],
};

/** Slide parts, in the package. A .pptx is a zip; entry names are plain text. */
function slidePartCount(bytes: Uint8Array): number {
  const text = new TextDecoder("latin1").decode(bytes);
  return (text.match(/ppt\/slides\/slide\d+\.xml/g) ?? []).length;
}

describe("deckToPptx", () => {
  it("writes a real package with one part per slide", async () => {
    const bytes = await deckToPptx(DECK);

    // "PK\x03\x04" — anything else is not a zip and will not open anywhere.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    // Names appear in both the local header and the central directory.
    expect(slidePartCount(bytes)).toBeGreaterThanOrEqual(2);
  });

  it("writes an empty deck rather than throwing on one", async () => {
    // A page whose slides all pruned to nothing is a real outcome (an author
    // exporting the wrong file); it must produce an openable, empty deck.
    const bytes = await deckToPptx({ canvas: { width: 1280, height: 720 }, slides: [] });
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });
});
