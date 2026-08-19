/**
 * HTML → PPTX, the whole of it.
 *
 * The premise: the model is already good at HTML — it is the layout language
 * it writes best, the app already previews it, approves it and lets the author
 * edit it — so the model should keep writing HTML and *nothing* about the
 * conversion should involve a model. This path is deterministic code: render
 * the page, ask the browser where everything ended up, write those boxes as
 * PowerPoint shapes. The same file converts the same way every time, and there
 * is no generated script to review.
 *
 * The pieces, in the order they run:
 *   `harvest.ts`   — lay the page out offscreen, collect measurements
 *   `deck.ts`      — pure: units, slide size, colours, pruning
 *   `write.ts`     — those shapes through pptxgenjs
 *
 * What this is *not*: a screenshot. Text stays text, so the deck that comes out
 * can be edited in PowerPoint — which is the only reason to produce a .pptx
 * rather than a PDF.
 */

import { readFile, writeBinaryFile } from "../fs/fileio";
import { degradedSummary } from "./deck";
import { harvestDeck } from "./harvest";
import { deckToPptx } from "./write";

export { isPptxExportEnabled, setPptxExportEnabled } from "./flag";

export interface PptxExportResult {
  /** Where the deck was written. */
  path: string;
  slides: number;
  /** Anything that could not be carried across faithfully, one line each. */
  degraded: string[];
}

/** Directory part of a path — what its relative links resolve against. */
function dirOf(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const cut = norm.lastIndexOf("/");
  return cut === -1 ? "" : norm.slice(0, cut);
}

/** "路演.html" → "路演.pptx". The default destination, not a fixed one. */
export function pptxPathFor(htmlPath: string): string {
  return htmlPath.replace(/\.html?$/i, "") + ".pptx";
}

/**
 * Convert one project `.html` into a `.pptx` beside it (or wherever `outPath`
 * says). Returns what was produced, including what degraded — a report that
 * says only "done" would hide the gradient that became a flat colour.
 */
export async function exportHtmlToPptx(
  htmlPath: string,
  outPath: string = pptxPathFor(htmlPath),
): Promise<PptxExportResult> {
  const html = await readFile(htmlPath);
  const deck = await harvestDeck(html, dirOf(htmlPath) || null);
  const bytes = await deckToPptx(deck);
  await writeBinaryFile(outPath, bytes);
  return { path: outPath, slides: deck.slides.length, degraded: degradedSummary(deck) };
}
