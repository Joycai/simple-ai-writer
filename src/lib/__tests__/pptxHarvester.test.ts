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

  it("honours object-fit before taking the cheap data-URL path", () => {
    // The shortcut hands the original bytes straight to PowerPoint, which is
    // right only when the page draws the whole picture stretched to the box.
    // A `cover`-cropped portrait passed through untouched arrives squashed.
    expect(HARVESTER_SOURCE).toContain("function fitMapping(");
    expect(HARVESTER_SOURCE).toMatch(/if \(!mapping && !radius && src\.indexOf\("data:"\) === 0/);
  });
});
