/**
 * Source-scanning guards for the harvester's five "paints the wrong picture"
 * rules.
 *
 * `harvester.js` cannot be unit tested — jsdom has no layout engine, so every
 * `getBoundingClientRect` is zero and a test would only prove the mock works
 * (D14). What it *can* have is a ratchet: each rule below was a real defect
 * measured in a real browser (docs/feature/pptx-plan.md §6), and every one of
 * them failed **silently** — the export succeeded and produced a slide that
 * looked nothing like the page. There is no exception to catch and no
 * degradation to report, so the only defence is not to reintroduce them.
 *
 * A failure here is not a broken test. It means the shape of the fix was
 * undone, and the symptom will be a wrong-looking deck nobody is told about.
 */
import { describe, expect, it } from "vitest";
import { HARVESTER_SOURCE } from "../pptx/harvest";

describe("the harvester's fidelity rules", () => {
  it("resolves percentage corner radii against the box", () => {
    // `getComputedStyle` returns a percentage radius in the unit it was
    // written in, so `parseFloat("50%")` is 50 and a circle exports as a
    // squircle with 50px corners.
    expect(HARVESTER_SOURCE).not.toContain("parseFloat(style.borderTopLeftRadius)");
    expect(HARVESTER_SOURCE).toContain("function resolveRadius(");
  });

  it("keeps a gradient's alpha when averaging it", () => {
    // Averaging only the rgb turned a 10%-white frosted panel into solid
    // white, which on a dark slide hides every word written on it.
    expect(HARVESTER_SOURCE).toMatch(/return\s*\(\s*\n?\s*"rgba\(/);
  });

  it("gives every picture its place in paint order before awaiting it", () => {
    // Rasterizing is asynchronous, so pushing a picture when its promise
    // settles puts *all* pictures after everything the walk found — and later
    // shapes are the ones on top in PowerPoint. A full-bleed background photo
    // then buries the slide's whole text.
    expect(HARVESTER_SOURCE).toContain("function reserve()");
    // Only the awaited paths need a slot: the `<canvas>` branch pushes during
    // the walk, which is already in order.
    expect(HARVESTER_SOURCE).not.toMatch(/\.then\(function \(data\) \{\s*\n\s*if \(data\) push\(/);
    expect(HARVESTER_SOURCE).toContain('place(imgSlot, { kind: "image"');
    expect(HARVESTER_SOURCE).toContain('place(svgSlot, { kind: "image"');
  });

  it("knows a background clipped to its own glyphs is not a rectangle", () => {
    // `background-clip: text` is how a page writes a gradient heading. Taken
    // as an ordinary background it laid a solid coloured bar across the slide,
    // while the words — whose fill is transparent — came out in the inherited
    // colour instead of the gradient's.
    expect(HARVESTER_SOURCE).toContain("function clipsBackgroundToText(");
    expect(HARVESTER_SOURCE).toContain("function paintedColor(");
    expect(HARVESTER_SOURCE).not.toContain("color: style.color,");
  });

  it("ends a line at a <br> and around a block-level child", () => {
    // A `<br>` used to become a space and a block-level child contributed
    // nothing, so a two-line heading arrived as one long line and a stat block
    // arrived as `92%增长` in a single box with three font sizes in it.
    expect(HARVESTER_SOURCE).toContain("function isBlockLevel(");
    expect(HARVESTER_SOURCE).toContain("breakAfter = true");
    expect(HARVESTER_SOURCE).not.toMatch(/BR"\) \{\s*\n\s*if \(runs\.length\) runs\[runs\.length - 1\]\.text \+= " ";/);
  });

  it("finds a list item's marker from the text that sits inside it", () => {
    // `<li><span>…</span></li>` is what a generated deck writes about half the
    // time. Asking the span whether it is a list item answered no, so that one
    // bullet went missing while its siblings kept theirs.
    expect(HARVESTER_SOURCE).toContain("function listItemFor(");
    expect(HARVESTER_SOURCE).toContain("markerFor(item.el, item.style)");
  });

  it("measures a rotated element flat and turns the result back", () => {
    // `getBoundingClientRect` on a rotated element is the axis-aligned box
    // *around* it — bigger than the element, with the angle gone — so a
    // rotated badge exported upright inside an oversized pill.
    expect(HARVESTER_SOURCE).toContain("function pureRotation(");
    expect(HARVESTER_SOURCE).toContain("function applyRotations(");
    // Before the nulls are dropped: the spans are index ranges into the array.
    expect(HARVESTER_SOURCE).toMatch(
      /applyRotations\(blocks, rotations\);[\s\S]{0,200}blocks\.filter\(/,
    );
  });

  it("paints a linear gradient rather than averaging it away", () => {
    // pptxgenjs exposes no gradient fill, and the average flattened exactly the
    // panels a generated deck leans on hardest. Everything the parser will not
    // take — radial, repeating, a stack — still falls back to the average, and
    // that fallback is still reported to the author.
    expect(HARVESTER_SOURCE).toContain("function parseLinearGradient(");
    expect(HARVESTER_SOURCE).toContain("function rasterizeGradient(");
    expect(HARVESTER_SOURCE).toMatch(
      /if \(painted\) \{[\s\S]{0,400}\} else \{[\s\S]{0,200}averageColor\(style\.backgroundImage\)/,
    );
  });

  it("splits a CSS list on its top-level commas only", () => {
    // `rgba(0, 0, 0, .35) 0 18px 40px` is one shadow holding three commas.
    expect(HARVESTER_SOURCE).toContain("function splitOutsideParens(");
    expect(HARVESTER_SOURCE).toContain("function shadowOf(");
  });

  it("cuts a block down to what an ancestor's overflow leaves visible", () => {
    // A decorative circle parked half outside its card is cut at the card's
    // edge on the page; PowerPoint has no clipping and drew the whole circle.
    expect(HARVESTER_SOURCE).toContain("function clipFor(");
    expect(HARVESTER_SOURCE).toContain("function clipRect(");
    // The slide's own overflow stays PowerPoint's business: it cuts at the
    // slide edge anyway, and clipping there turns a circle hanging off the
    // corner into a rounded rectangle sitting in it.
    expect(HARVESTER_SOURCE).toContain("el === root ? clip : clipFor(style, rect, clip)");
  });

  it("carries a partial opacity down the walk", () => {
    // `opacity` composites rather than inheriting, so an ancestor's fade
    // applies to everything below it. Only zero used to be honoured.
    expect(HARVESTER_SOURCE).toContain("var opacity = alpha * (isFinite(own) ? own : 1);");
  });

  it("honours object-fit before taking the cheap data-URL path", () => {
    // The shortcut hands the original bytes straight to PowerPoint, which is
    // right only when the page draws the whole picture stretched to the box.
    // A `cover`-cropped portrait passed through untouched arrives squashed.
    expect(HARVESTER_SOURCE).toContain("function fitMapping(");
    expect(HARVESTER_SOURCE).toMatch(/if \(!mapping && !radius && src\.indexOf\("data:"\) === 0/);
  });
});
