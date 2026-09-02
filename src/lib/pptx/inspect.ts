/**
 * What the browser measured, read back as an answer to "is this page all
 * right?" — the verification half of the HTML authoring loop.
 *
 * The model writes a page it cannot see. Until this existed, the only way it
 * learned that a heading spills off slide 3 or that a picture failed to load
 * was for the author to look at the preview and say so in prose — a whole
 * human turn per defect, which is why decks came back wrong twice before they
 * came back right. A coding agent's accuracy does not come from the model
 * being cleverer; it comes from a cheap deterministic checker it can run
 * itself. This is that checker for pages.
 *
 * **Nothing here needs a change to `harvester.js`.** Every block already
 * arrives with its box relative to its slide, and `canvas` is the first
 * slide's own rectangle, so "sticks out past the slide" is arithmetic on data
 * the exporter was already collecting. That matters more than it sounds:
 * touching the harvester means re-deriving the `sha256-` in tauri.conf.json
 * and keeping two selector lists in step, and this feature earns none of that
 * risk.
 *
 * A page with no `<section>`s at all is one slide — the body — whose canvas is
 * its own box, so a long scrolling promo page reports no overflow rather than
 * reporting all of itself as overflow. The check only fires where it means
 * something: a real deck whose content leaves the slide.
 */

import type { Block, HarvestedDeck, TextBlock } from "./deck";

/** Sub-pixel slop; browsers return fractional widths for whole-pixel boxes. */
const TOLERANCE_PX = 1;

/** Longest quoted text used to point the model at an offending box. */
const LABEL_MAX = 24;

/** How many overflowing blocks are named per slide before the rest are counted. */
const OVERFLOW_MAX_LISTED = 3;

/** One box that leaves the slide, and by how much. */
export interface Overflow {
  /** What the box is, in words the model can act on. */
  what: string;
  /** Which edges it passes, with the overshoot in CSS px. */
  past: string[];
}

export interface SlideReport {
  index: number;
  blocks: number;
  text: number;
  images: number;
  overflow: Overflow[];
  /** Notes the harvester recorded — pictures that failed, gradients flattened. */
  degraded: string[];
}

export interface DeckReport {
  canvas: { width: number; height: number };
  slides: SlideReport[];
  /** Slides with nothing on them at all. */
  empty: number[];
}

/** A short, quotable label for a block — enough to find it in the source. */
function label(block: Block): string {
  if (block.kind === "image") return "a picture";
  if (block.kind === "rect") return "a box";
  const text = (block as TextBlock).runs.map((r) => r.text).join("").replace(/\s+/g, " ").trim();
  if (!text) return "an empty text box";
  return `"${text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text}"`;
}

/**
 * The edges a block passes, with the overshoot rounded to whole pixels.
 *
 * Measured against the deck's canvas rather than each slide's own rectangle,
 * because that is what the export uses: the deck takes its size from the first
 * slide, so a later slide that is *itself* taller is not a differently-sized
 * slide in the .pptx — it is a slide whose bottom is cut off. Reporting it as
 * overflow is therefore not a false positive but the earliest possible warning.
 */
function overflowOf(block: Block, canvas: { width: number; height: number }): string[] {
  const past: string[] = [];
  const right = block.x + block.w - canvas.width;
  const bottom = block.y + block.h - canvas.height;
  if (block.x < -TOLERANCE_PX) past.push(`${Math.round(-block.x)}px past the left edge`);
  if (block.y < -TOLERANCE_PX) past.push(`${Math.round(-block.y)}px above the top edge`);
  if (right > TOLERANCE_PX) past.push(`${Math.round(right)}px past the right edge`);
  if (bottom > TOLERANCE_PX) past.push(`${Math.round(bottom)}px below the bottom edge`);
  return past;
}

/** Read a harvested deck for the things an author would have had to notice. */
export function inspectDeck(deck: HarvestedDeck): DeckReport {
  const slides: SlideReport[] = [];
  const empty: number[] = [];

  deck.slides.forEach((slide, i) => {
    const overflow: Overflow[] = [];
    for (const block of slide.blocks) {
      const past = overflowOf(block, deck.canvas);
      if (past.length) overflow.push({ what: label(block), past });
    }
    if (!slide.blocks.length) empty.push(i + 1);
    slides.push({
      index: i + 1,
      blocks: slide.blocks.length,
      text: slide.blocks.filter((b) => b.kind === "text").length,
      images: slide.blocks.filter((b) => b.kind === "image").length,
      overflow,
      degraded: slide.degraded,
    });
  });

  return { canvas: deck.canvas, slides, empty };
}

/** Whether a slide has anything the model should act on. */
function hasFinding(slide: SlideReport): boolean {
  return slide.overflow.length > 0 || slide.degraded.length > 0;
}

/**
 * The report as the model reads it.
 *
 * Only slides with a finding get a line; the rest are one closing sentence.
 * That is the difference between a result the model acts on and a wall it
 * skims: a clean 30-slide deck should cost a sentence, not thirty lines.
 */
export function formatDeckReport(report: DeckReport, path: string, tier: string): string {
  const { width, height } = report.canvas;
  const total = report.slides.length;
  const lines: string[] = [
    `${path}: ${total} slide(s) at ${Math.round(width)}×${Math.round(height)}px, ` +
      `split on \`${tier}\`.`,
  ];

  if (report.empty.length) {
    lines.push(
      `Slide(s) ${report.empty.join(", ")} measured as EMPTY — nothing on them was painted. ` +
        "Usually a wrong class name or a slide sized to nothing. (A slide a slideshow " +
        "script hides is shown before measuring, so `display: none` on the slide itself is not it.)",
    );
  }

  const flagged = report.slides.filter(hasFinding);
  for (const slide of flagged) {
    const parts: string[] = [];
    for (const over of slide.overflow.slice(0, OVERFLOW_MAX_LISTED)) {
      parts.push(`${over.what} is ${over.past.join(" and ")}`);
    }
    const rest = slide.overflow.length - OVERFLOW_MAX_LISTED;
    if (rest > 0) parts.push(`and ${rest} more box(es) outside the slide`);
    for (const note of slide.degraded) parts.push(note);
    lines.push(`Slide ${slide.index} (${slide.blocks} boxes): ${parts.join("; ")}.`);
  }

  const clean = total - flagged.length;
  lines.push(
    flagged.length === 0
      ? "Nothing is outside its slide and nothing degraded — the page converts as it looks."
      : `The other ${clean} slide(s) are clean.`,
  );
  return lines.join("\n");
}
