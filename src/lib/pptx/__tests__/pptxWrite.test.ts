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
import JSZip from "jszip";
import { readFileSync } from "node:fs";
import { deckToPptx } from "../write";
import type { HarvestedDeck } from "../deck";

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

describe("deckToPptx", () => {
  it("writes a real package with one part per slide", async () => {
    const bytes = await deckToPptx(DECK);

    // "PK\x03\x04" — anything else is not a zip and will not open anywhere.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)))
      .toHaveLength(2);
    const first = await zip.file("ppt/slides/slide1.xml")!.async("string");
    const second = await zip.file("ppt/slides/slide2.xml")!.async("string");
    expect(first).toContain("量化做市方案");
    expect(second).toContain("• 一期：接入行情");
    expect(first).toContain('typeface="PingFang SC"');
    // 64 CSS px at the wide layout scale becomes approximately 48 pt.
    expect(first).toMatch(/sz="4800"/);
    // The legacy writer expands text boxes for font-metric slack. Pin its
    // current placement here, so migration cannot silently move old HTML decks.
    expect(first).toContain('<a:off x="645566" y="1117397"/>');
    expect(first).toContain('<a:srgbClr val="F8FAFC"');
    expect(first).not.toContain("<p:pic>");
  });

  it("embeds image bytes and connects the picture to its media part", async () => {
    const png = readFileSync(new URL("../../../../src-tauri/icons/32x32.png", import.meta.url));
    const withImage: HarvestedDeck = {
      canvas: DECK.canvas,
      slides: [{ blocks: [{ kind: "image", x: 96, y: 96, w: 192, h: 192,
        data: `data:image/png;base64,${png.toString("base64")}` }], degraded: [] }],
    };
    const zip = await JSZip.loadAsync(await deckToPptx(withImage));
    const slide = await zip.file("ppt/slides/slide1.xml")!.async("string");
    const rels = await zip.file("ppt/slides/_rels/slide1.xml.rels")!.async("string");
    const id = slide.match(/r:embed="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    const relationship = rels.match(new RegExp(`<Relationship[^>]*Id="${id}"[^>]*/>`))?.[0];
    expect(relationship).toContain("/image");
    const target = relationship?.match(/Target="([^"]+)"/)?.[1];
    expect(target).toMatch(/^\.\.\/media\//);
    const media = await zip.file(`ppt/${target!.slice(3)}`)!.async("uint8array");
    expect(media).toEqual(new Uint8Array(png));
    expect(slide.match(/<p:pic>/g)).toHaveLength(1);
  });

  it("writes an empty deck rather than throwing on one", async () => {
    // A page whose slides all pruned to nothing is a real outcome (an author
    // exporting the wrong file); it must produce an openable, empty deck.
    const bytes = await deckToPptx({ canvas: { width: 1280, height: 720 }, slides: [] });
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });
});
