/**
 * Measured deck → .pptx bytes.
 *
 * Deliberately thin: everything that could be decided without a library lives
 * in `deck.ts`, so this file is the one place that knows pptxgenjs exists and
 * can be replaced wholesale if that ever changes.
 *
 * The library is loaded lazily. It is ~1 MB and only the author who turned the
 * Beta switch on ever needs it, so it must not sit in the app's startup bundle.
 */

import { slideSize, toShapes, type HarvestedDeck } from "./deck";

/** Layout name used when the deck's aspect ratio is not a standard one. */
const CUSTOM_LAYOUT = "SAW_CUSTOM";

export async function deckToPptx(deck: HarvestedDeck): Promise<Uint8Array> {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const pres = new PptxGenJS();

  const size = slideSize(deck.canvas);
  if (size.standard) {
    pres.layout = size.standard;
  } else {
    pres.defineLayout({ name: CUSTOM_LAYOUT, width: size.width, height: size.height });
    pres.layout = CUSTOM_LAYOUT;
  }

  deck.slides.forEach((_, index) => {
    const slide = pres.addSlide();
    for (const shape of toShapes(deck, index)) {
      if (shape.kind === "image") {
        slide.addImage({ data: shape.data, x: shape.x, y: shape.y, w: shape.w, h: shape.h });
        continue;
      }
      if (shape.kind === "rect") {
        slide.addShape(shape.radius > 0 ? "roundRect" : "rect", {
          x: shape.x,
          y: shape.y,
          w: shape.w,
          h: shape.h,
          ...(shape.radius > 0 ? { rectRadius: shape.radius } : {}),
          ...(shape.fill
            ? { fill: { color: shape.fill.hex, transparency: shape.fill.transparency } }
            : { fill: { color: "FFFFFF", transparency: 100 } }),
          ...(shape.line
            ? {
                line: {
                  color: shape.line.color.hex,
                  width: shape.line.ptWidth,
                  transparency: shape.line.color.transparency,
                },
              }
            : {}),
        });
        continue;
      }
      slide.addText(
        shape.runs.map((run) => ({
          text: run.text,
          options: {
            bold: run.bold,
            italic: run.italic,
            underline: run.underline ? { style: "sng" as const } : undefined,
            color: run.color,
            fontSize: run.ptSize,
            fontFace: run.font,
          },
        })),
        {
          x: shape.x,
          y: shape.y,
          w: shape.w,
          h: shape.h,
          align: shape.align === "justify" ? "justify" : shape.align,
          // The box was measured on the glyphs themselves, so PowerPoint's own
          // text insets would push the text off its measured position.
          margin: 0,
          // Centred rather than top: PowerPoint's line height is not the
          // browser's, and centring splits that difference across the box
          // instead of letting it all accumulate downwards.
          valign: "middle",
          wrap: true,
          // Only where reflow is possible — see TEXT_SLACK in deck.ts.
          fit: shape.shrink ? "shrink" : "none",
        },
      );
    }
  });

  const out = await pres.write({ outputType: "uint8array" });
  return out as Uint8Array;
}
