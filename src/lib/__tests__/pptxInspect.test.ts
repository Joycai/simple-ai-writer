/**
 * `inspect_html`'s pure half — the verification loop the HTML authoring line
 * did not have.
 *
 * What it has to get right is not the arithmetic (that part is two
 * comparisons) but *when it speaks*: a clean deck must cost a sentence, a page
 * that is legitimately one long slide must not report itself as overflowing,
 * and a slide that renders nothing must be impossible to miss.
 */
import { describe, expect, it } from "vitest";
import { formatDeckReport, inspectDeck } from "../pptx/inspect";
import type { Block, HarvestedDeck, HarvestedSlide } from "../pptx/deck";

const CANVAS = { width: 1280, height: 720 };

const text = (t: string, box: Partial<Block> = {}): Block => ({
  kind: "text",
  x: 0,
  y: 0,
  w: 200,
  h: 40,
  runs: [{ text: t, sizePx: 24 }],
  align: "left",
  lines: 1,
  ...box,
} as Block);

const image = (box: Partial<Block> = {}): Block =>
  ({ kind: "image", x: 0, y: 0, w: 100, h: 100, data: "data:,", ...box } as Block);

const slide = (blocks: Block[], degraded: string[] = []): HarvestedSlide => ({ blocks, degraded });
const deckOf = (slides: HarvestedSlide[], canvas = CANVAS): HarvestedDeck => ({ canvas, slides });

describe("inspectDeck", () => {
  it("says nothing is wrong when nothing is", () => {
    const report = inspectDeck(deckOf([slide([text("标题"), image()])]));

    expect(report.slides[0].overflow).toEqual([]);
    expect(report.slides[0].text).toBe(1);
    expect(report.slides[0].images).toBe(1);
    expect(report.empty).toEqual([]);
  });

  it("names the box that leaves the slide and by how much", () => {
    const report = inspectDeck(
      deckOf([slide([text("第三季度收入同比增长与渠道结构调整", { y: 700, h: 60 })])]),
    );

    const [over] = report.slides[0].overflow;
    expect(over.what).toContain("第三季度收入");
    expect(over.past).toEqual(["40px below the bottom edge"]);
  });

  it("catches every edge, including a box pushed off the top or left", () => {
    const report = inspectDeck(
      deckOf([slide([text("x", { x: -30, y: -12, w: 100, h: 40 }), image({ x: 1200, w: 200 })])]),
    );

    expect(report.slides[0].overflow[0].past).toEqual([
      "30px past the left edge",
      "12px above the top edge",
    ]);
    expect(report.slides[0].overflow[1].past).toEqual(["120px past the right edge"]);
  });

  // Browsers hand back fractional widths for whole-pixel boxes; a report that
  // flagged a 0.4px overshoot would be noise that trains the model to ignore it.
  it("ignores sub-pixel overshoot", () => {
    const report = inspectDeck(deckOf([slide([text("x", { x: 1080, w: 200.4 })])]));
    expect(report.slides[0].overflow).toEqual([]);
  });

  // The canvas IS the first slide's box, so a page with no sections — one slide
  // the height of the whole page — cannot overflow itself. That is what keeps a
  // long scrolling promo page from reporting all of itself as broken.
  it("does not flag a long single-slide page against a deck-sized canvas", () => {
    const tall = { width: 1280, height: 5200 };
    const report = inspectDeck(deckOf([slide([text("x", { y: 4800, h: 300 })])], tall));
    expect(report.slides[0].overflow).toEqual([]);
  });

  it("reports a slide that painted nothing", () => {
    const report = inspectDeck(deckOf([slide([text("一")]), slide([]), slide([text("三")])]));
    expect(report.empty).toEqual([2]);
  });

  it("carries the harvester's own degradation notes through", () => {
    const report = inspectDeck(deckOf([slide([text("x")], ["a picture could not be embedded"])]));
    expect(report.slides[0].degraded).toEqual(["a picture could not be embedded"]);
  });
});

describe("formatDeckReport", () => {
  const clean = deckOf([slide([text("一")]), slide([text("二")]), slide([text("三")])]);

  it("costs one sentence when the page is fine", () => {
    const out = formatDeckReport(inspectDeck(clean), "/proj/deck.html", "section.slide");

    expect(out).toContain("3 slide(s) at 1280×720px");
    expect(out).toContain("`section.slide`");
    expect(out).toContain("Nothing is outside its slide");
    // No per-slide noise for slides with nothing to say.
    expect(out).not.toContain("Slide 2");
  });

  it("lists only the slides with a finding, and counts the rest", () => {
    const deck = deckOf([
      slide([text("一")]),
      slide([text("挤出去的标题", { y: 700, h: 60 })]),
      slide([text("三")]),
    ]);

    const out = formatDeckReport(inspectDeck(deck), "/proj/deck.html", "section.slide");

    expect(out).toContain("Slide 2");
    expect(out).toContain("40px below the bottom edge");
    expect(out).toContain("The other 2 slide(s) are clean.");
    expect(out).not.toContain("Slide 1 (");
  });

  it("caps how many boxes one slide names", () => {
    const many = Array.from({ length: 7 }, (_, i) => text(`溢出 ${i}`, { y: 800 }));
    const out = formatDeckReport(inspectDeck(deckOf([slide(many)])), "/p/d.html", "section");

    expect(out).toContain("and 4 more box(es) outside the slide");
  });

  it("leads with empty slides, because they are the loudest kind of wrong", () => {
    const out = formatDeckReport(
      inspectDeck(deckOf([slide([]), slide([text("二")])])),
      "/p/d.html",
      ".slide",
    );

    expect(out).toContain("Slide(s) 1 measured as EMPTY");
    expect(out).toContain("wrong class name");
  });
});
