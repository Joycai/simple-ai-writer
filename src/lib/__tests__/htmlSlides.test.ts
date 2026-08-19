/**
 * Reading an .html deck by slide — the text-level splitter behind read_slides'
 * HTML path.
 *
 * The load-bearing property is agreement with `pptx/harvester.js`: the same
 * selector list, tried in the same order, with the same "no sections at all
 * means the body is one slide" fallback. If that drifts, "slide 7" means one
 * thing here and another in the exported deck.
 */
import { describe, expect, it } from "vitest";

import { HARVESTER_SOURCE } from "../pptx/harvest";
import { SLIDE_TIERS, readHtmlSlideRange, splitHtmlSlides } from "../pptx/htmlSlides";

describe("the slide convention", () => {
  it("is the same list the exporter's harvester uses", () => {
    // Held as a test rather than a comment because the failure is silent and
    // late: a drifted list means "slide 7" addresses one box while reading and
    // a different one in the exported deck, and the author reviewing "the
    // change to slide 7" would be looking at the wrong one.
    // Non-greedy to the closing "];" — a character class excluding "]" would
    // stop inside the very first entry, "[data-slide]".
    const literal = /SLIDE_SELECTORS\s*=\s*\[([\s\S]*?)\];/.exec(HARVESTER_SOURCE);
    expect(literal).not.toBeNull();
    const fromHarvester = [...literal![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(fromHarvester).toEqual([...SLIDE_TIERS]);
  });
});

const page = (body: string) => `<!doctype html>\n<html>\n<body>\n${body}\n</body>\n</html>\n`;

describe("splitHtmlSlides", () => {
  it("splits on <section> and returns each slide's source verbatim", () => {
    const html = page(`<section><h1>一</h1></section>\n<section><h1>二</h1></section>`);
    const slides = splitHtmlSlides(html);

    expect(slides.map((s) => s.index)).toEqual([1, 2]);
    expect(slides[0].html).toBe("<section><h1>一</h1></section>");
    expect(slides[1].html).toBe("<section><h1>二</h1></section>");
    // Offsets must address the real source, so an edit can be located by them.
    expect(html.slice(slides[1].start, slides[1].end)).toBe(slides[1].html);
  });

  it("prefers [data-slide] over every other selector", () => {
    const html = page(
      `<section class="slide"><div data-slide="1">A</div><div data-slide="2">B</div></section>`,
    );
    const slides = splitHtmlSlides(html);
    expect(slides).toHaveLength(2);
    expect(slides[0].html).toBe('<div data-slide="1">A</div>');
  });

  it("prefers section.slide over a bare .slide elsewhere", () => {
    const html = page(`<div class="slide">chrome</div><section class="slide">real</section>`);
    const slides = splitHtmlSlides(html);
    expect(slides).toHaveLength(1);
    expect(slides[0].html).toBe('<section class="slide">real</section>');
  });

  it("matches class as a whole token, not a substring", () => {
    const html = page(`<div class="slideshow">no</div><div class="deck slide">yes</div>`);
    const slides = splitHtmlSlides(html);
    expect(slides).toHaveLength(1);
    expect(slides[0].html).toBe('<div class="deck slide">yes</div>');
  });

  it("counts nesting so an inner tag of the same name does not end the slide", () => {
    const html = page(`<section><section class="inner">x</section>tail</section><section>2</section>`);
    const slides = splitHtmlSlides(html);
    // Nested matches are kept, in source order — querySelectorAll hands the
    // exporter the same list, and agreeing beats being clever.
    expect(slides.map((s) => s.html)).toEqual([
      '<section><section class="inner">x</section>tail</section>',
      '<section class="inner">x</section>',
      "<section>2</section>",
    ]);
  });

  it("ignores tags inside <script>, <style> and comments", () => {
    const html = page(
      `<script>var s = "</section><section>fake";</script>\n` +
        `<!-- <section>commented</section> -->\n` +
        `<style>.slide::after { content: "<section>"; }</style>\n` +
        `<section>real</section>`,
    );
    const slides = splitHtmlSlides(html);
    expect(slides).toHaveLength(1);
    expect(slides[0].html).toBe("<section>real</section>");
  });

  it("is not fooled by a '>' inside an attribute value", () => {
    const html = page(`<section title="a > b"><p>x</p></section>`);
    const slides = splitHtmlSlides(html);
    expect(slides).toHaveLength(1);
    expect(slides[0].html).toBe('<section title="a > b"><p>x</p></section>');
  });

  it("treats the body as one slide when nothing matches", () => {
    const slides = splitHtmlSlides(page(`<div><p>just a page</p></div>`));
    expect(slides).toHaveLength(1);
    expect(slides[0].html).toContain("just a page");
    expect(slides[0].html.startsWith("<body>")).toBe(true);
  });

  it("runs an unclosed slide to the end of the file rather than dropping it", () => {
    const slides = splitHtmlSlides(page(`<section>1</section><section>unterminated`));
    expect(slides).toHaveLength(2);
    expect(slides[1].html).toContain("unterminated");
  });
});

describe("readHtmlSlideRange", () => {
  const deck = (n: number) =>
    page(Array.from({ length: n }, (_, i) => `<section><h1>第 ${i + 1} 页</h1></section>`).join("\n"));

  it("labels slides and reports the whole deck when it fits", () => {
    const range = readHtmlSlideRange(deck(3));
    expect(range.total_slides).toBe(3);
    expect(range.from_slide).toBe(1);
    expect(range.to_slide).toBe(3);
    expect(range.next_slide).toBeNull();
    expect(range.markdown).toContain("## Slide 1");
    expect(range.markdown).toContain("## Slide 3");
  });

  it("pages on a slide boundary and hands back the next start", () => {
    const first = readHtmlSlideRange(deck(20), undefined, 200);
    expect(first.from_slide).toBe(1);
    expect(first.to_slide).toBeLessThan(20);
    expect(first.next_slide).toBe(first.to_slide + 1);

    const second = readHtmlSlideRange(deck(20), first.next_slide!, 200);
    expect(second.from_slide).toBe(first.next_slide);
    expect(second.markdown).toContain(`## Slide ${first.next_slide}`);
  });

  it("cuts a single oversized slide and points at read_file for the rest", () => {
    const html = page(`<section>${"字".repeat(500)}</section>`);
    const range = readHtmlSlideRange(html, 1, 100);
    expect(range.markdown).toContain("was cut at 100");
    expect(range.markdown).toContain("read_file (start_line=");
    // The cut must not pretend the slide was fully delivered.
    expect(range.markdown.length).toBeLessThan(400);
  });
});
