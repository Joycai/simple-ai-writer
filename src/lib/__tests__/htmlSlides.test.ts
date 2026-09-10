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
import {
  SLIDE_TIERS,
  WHOLE_PAGE_TIER,
  readHtmlSlideRange,
  slideTitle,
  htmlPageIndex,
  landmarkIndex,
  splitHtmlDeck,
  splitHtmlSlides,
} from "../pptx/htmlSlides";

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

// "12 slides on section.slide" and "1 slide, the whole page" are the difference
// between a deck and a page someone only thinks is a deck — and the approval
// card could not tell them apart until the tier came back with the split.
describe("splitHtmlDeck", () => {
  it("names the selector that divided the page", () => {
    expect(splitHtmlDeck(page("<section>一</section><section>二</section>")).tier).toBe("section");
    expect(splitHtmlDeck(page('<div class="slide">一</div>')).tier).toBe(".slide");
    expect(splitHtmlDeck(page('<div data-slide="1">一</div>')).tier).toBe("[data-slide]");
  });

  it("names the fallback as what it is, not as 'body'", () => {
    const deck = splitHtmlDeck(page("<div><p>一张海报</p></div>"));
    expect(deck.tier).toBe(WHOLE_PAGE_TIER);
    expect(deck.slides).toHaveLength(1);
  });
});

describe("slideTitle", () => {
  it("prefers the slide's heading", () => {
    expect(slideTitle("<section><p>正文</p><h2>标题</h2></section>")).toBe("标题");
  });

  it("falls back to any text, and says so when there is none", () => {
    expect(slideTitle("<section><p>只有正文</p></section>")).toBe("只有正文");
    expect(slideTitle('<section><img src="x.png"></section>')).toBe("(no text)");
  });

  // An index line that approaches the size of the slide it describes has
  // defeated its own purpose.
  it("truncates a long one", () => {
    expect(slideTitle(`<h1>${"字".repeat(80)}</h1>`)).toHaveLength(40);
  });

  it("does not mistake a script's contents for the slide's text", () => {
    expect(slideTitle("<section><script>var x = 1;</script><h1>真标题</h1></section>")).toBe("真标题");
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

  // The line range is what makes a targeted rewrite_lines possible: without
  // it, changing slide 7 means quoting its whole source into propose_edit's
  // `find` — the same bytes paid for twice, and a failed match if one space is
  // reconstructed wrong.
  it("labels each slide with the lines it occupies", () => {
    const range = readHtmlSlideRange(deck(3));

    expect(range.markdown).toContain("## Slide 1 (lines 4-4)");
    expect(range.markdown).toContain("## Slide 3 (lines 6-6)");
  });

  it("counts a multi-line slide's range to its closing tag", () => {
    const html = page("<section>\n  <h1>一</h1>\n</section>\n<section>二</section>");
    const [first, second] = splitHtmlSlides(html);

    expect([first.startLine, first.endLine]).toEqual([4, 6]);
    expect([second.startLine, second.endLine]).toEqual([7, 7]);
  });

  // Rides along on any partial response rather than being asked for: it is
  // free here (the splitter has already divided the whole file) and it is
  // exactly what the model needs before it can address anything.
  it("leads a paged response with an index of the whole deck", () => {
    const first = readHtmlSlideRange(deck(20), undefined, 200);

    expect(first.markdown).toContain("This deck has 20 slide(s)");
    expect(first.markdown).toContain("1. 第 1 页 (lines 4-4");
    expect(first.markdown).toContain("20. 第 20 页 (lines 23-23");
    // The index comes before the slides it indexes.
    expect(first.markdown.indexOf("20. 第 20 页")).toBeLessThan(first.markdown.indexOf("## Slide 1"));
  });

  // Uncapped, this index went out in full on EVERY paged response — a
  // two-hundred-section page spent thousands of tokens per call describing
  // itself. Sampled rather than truncated, for paragraphIndex's reason: the
  // first sixty rows of two hundred map the first third, so the model would
  // still have to page through the rest and the map would have bought nothing.
  it("samples a deck past the row cap instead of listing all of it", () => {
    const index = readHtmlSlideRange(deck(200), undefined, 200).markdown;
    const rows = index.split("\n").filter((l) => /^\d+\. 第 \d+ 页 \(lines /.test(l));

    expect(index).toContain("This deck has 200 slide(s)");
    expect(index).toContain("every 4th one is listed below");
    expect(rows.length).toBeLessThanOrEqual(60);
    // Every sampled row is a real slide with a real range, and the sampling
    // reaches the end of the deck — that is what makes it a map of all of it.
    expect(rows[0]).toMatch(/^1\. /);
    expect(rows[rows.length - 1]).toMatch(/^19[0-9]\. /);
  });

  it("lists every slide when the deck fits under the cap", () => {
    const index = readHtmlSlideRange(deck(20), undefined, 200).markdown;

    expect(index).toContain("the line ranges below are what rewrite_lines takes");
    expect(index).not.toContain("one is listed below");
    expect(index.split("\n").filter((l) => /^\d+\. 第 \d+ 页 \(lines /.test(l))).toHaveLength(20);
  });

  it("indexes a response that starts partway in, too", () => {
    const range = readHtmlSlideRange(deck(20), 10, 200);
    expect(range.markdown).toContain("This deck has 20 slide(s)");
  });

  // A response that carries the whole deck needs no map of it.
  it("omits the index when every slide is in the response", () => {
    expect(readHtmlSlideRange(deck(3)).markdown).not.toContain("This deck has");
  });

  it("cuts a single oversized slide and points at read_file for the rest", () => {
    const html = page(`<section>${"字".repeat(500)}</section>`);
    const range = readHtmlSlideRange(html, 1, 100);
    expect(range.markdown).toContain("was cut at 100");
    expect(range.markdown).toContain("read_file (start_line=");
    // The cut must not pretend the slide was fully delivered.
    expect(range.markdown.length).toBeLessThan(400);
  });

  // The hand-off used to name the slide's FIRST line, which sent the model
  // back to the top of the very thing it had just been shown — and a
  // whole-page slide opens at <body>, so following it re-read from the top of
  // the document (docs/feature/agent/html-read-edit-plan.md §7).
  it("hands off at the line the cut falls on, not the slide's first line", () => {
    const body = Array.from({ length: 60 }, (_, i) => `<p>第 ${i + 1} 段${"字".repeat(40)}</p>`).join("\n");
    const html = page(`<section>\n${body}\n</section>`);

    const range = readHtmlSlideRange(html, 1, 600);
    const at = Number(range.markdown.match(/read_file \(start_line=(\d+)\)/)![1]);

    // The section opens on line 4; the cut is 600 characters in, well past it.
    expect(splitHtmlSlides(html)[0].startLine).toBe(4);
    expect(at).toBeGreaterThan(4);
    // And it is a real line of the file, not past its end.
    expect(at).toBeLessThanOrEqual(html.split("\n").length);
    expect(range.markdown).toContain("that is the line this cut falls on");
  });
});

// The other half of read_file's .html map. A deck gets slideIndex; a page the
// selectors cannot divide got nothing at all — headingIndex matches markdown
// ATX headings (never present in HTML) and paragraphIndex rarely clears its
// two-paragraph floor on markup. So the one shape of .html with no map was
// also the one that most needed one.
describe("landmarkIndex", () => {
  const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<style id="theme">body { margin: 0 }</style>
</head>
<body>
<header id="top">
  <nav>首页</nav>
</header>
<main>
  <div id="hero" class="band">
    <h1>产品发布计划</h1>
    <p>让每一次发布都可预期。</p>
  </div>
  <div id="quarters" class="band">
    <h2>三个季度</h2>
    <table><tr><td>Q1</td></tr></table>
  </div>
  <div class="band"><h2>风险</h2></div>
</main>
<footer id="foot">2026</footer>
</body>
</html>`;

  it("lists headings, ids and the tags that are a place on their own", () => {
    const index = landmarkIndex(PAGE);

    expect(index).toContain("This page has no slide sections");
    expect(index).toContain('<div id="quarters"> 三个季度 (lines 15-18)');
    expect(index).toContain("<h1> 产品发布计划");
    expect(index).toContain('<header id="top">');
    expect(index).toContain("<table>");
    // A heading with no id is still a landmark — that is most of them.
    expect(index).toContain("<h2> 风险");
  });

  // "把「三个季度」那一节重写" has to arrive as a range, not as a search.
  it("gives a range that actually spans the named section", () => {
    const at = landmarkIndex(PAGE).match(/<div id="quarters">[^(]*\(lines (\d+)-(\d+)\)/)!;
    const lines = PAGE.split("\n");

    expect(lines[Number(at[1]) - 1]).toContain('id="quarters"');
    expect(lines[Number(at[2]) - 1]).toContain("</div>");
  });

  // An id on a <style> names a stylesheet, not a place in the document.
  it("never treats head furniture as a landmark", () => {
    const index = landmarkIndex(PAGE);
    expect(index).not.toContain("<style");
    expect(index).not.toContain("<html");
    expect(index).not.toContain("<body");
  });

  it("says nothing about a page with no structure to report", () => {
    expect(landmarkIndex(page(`<div>${"长文".repeat(200)}</div>`))).toBe("");
  });

  // `</img>` does not exist, so depth-counting for it ran to the end of the
  // file: an <img id="logo"> on line 5 of a 12-line page reported (lines 5-12),
  // and "change the logo" became rewrite_lines over everything below it. The
  // label was corrupted by the same runaway range — it read text out of the
  // rest of the document — so the row looked plausible rather than broken.
  it("ends a void element at its own tag, not at the end of the file", () => {
    const html = page(
      `<main>\n  <img id="logo" src="a.png">\n  <h1>标题</h1>\n  <input id="email" type="email">\n` +
        `  <div id="tail"><p>结尾</p></div>\n</main>`,
    );

    const index = landmarkIndex(html);
    const total = html.split("\n").length;
    // Each row is one line ending in its range, so anchoring to end-of-line is
    // what reads the range rather than the label's own parentheses.
    const ranges = [...index.matchAll(/<(?:img|input) id="[^"]*">.*\(lines (\d+)-(\d+)\)$/gm)];

    expect(ranges).toHaveLength(2);
    for (const [, from, to] of ranges) {
      // A void element occupies exactly the line it is written on.
      expect(Number(to)).toBe(Number(from));
      expect(Number(to)).toBeLessThan(total);
    }
    // The label is the element's own, not scavenged from the rest of the page.
    expect(index).not.toContain('<img id="logo"> 标题');
    expect(index).toContain('<img id="logo"> (no text)');
    // The real container beside them is unaffected.
    expect(index).toMatch(/<div id="tail">.*\(lines \d+-\d+\)$/m);
  });
});

// The same fallback, reached from the other side: `[data-slide]` and `.slide`
// match ANY tag, so a hand-written deck that marks a full-bleed picture as a
// slide hit it too — and there "slide 2 runs to the end of the file" is what
// the exporter and every quoted edit would have believed.
describe("void elements in the slide split", () => {
  it("does not let an <img data-slide> swallow the rest of the deck", () => {
    const html = page(
      `<div data-slide="1">第一页</div>\n<img data-slide="2" src="full.png">\n<div data-slide="3">第三页</div>`,
    );

    const slides = splitHtmlSlides(html);

    expect(slides).toHaveLength(3);
    expect(slides[1].html).toBe('<img data-slide="2" src="full.png">');
    expect(slides[2].html).toBe('<div data-slide="3">第三页</div>');
    expect(slides[1].startLine).toBe(slides[1].endLine);
  });
});

// read_file's one call for both questions: which kind of page is this, and
// what does its map look like. Two calls scanned the whole file twice on every
// page of every non-deck read.
describe("htmlPageIndex", () => {
  it("returns the deck index for a deck", () => {
    const html = page(
      Array.from({ length: 4 }, (_, i) => `<section><h1>第 ${i + 1} 页</h1></section>`).join("\n"),
    );

    const { isDeck, index } = htmlPageIndex(html);

    expect(isDeck).toBe(true);
    expect(index).toContain("This deck has 4 slide(s)");
  });

  // One slide the size of the whole page is not a deck: "this deck has 1
  // slide" maps nothing, so that page takes the landmark route instead.
  it("treats a single-section page as a page, not a one-slide deck", () => {
    const { isDeck, index } = htmlPageIndex(page("<section><h1>一</h1><h2>二</h2></section>"));

    expect(isDeck).toBe(false);
    expect(index).toContain("This page has no slide sections");
  });

  it("reports no map at all when there is no structure", () => {
    const { isDeck, index } = htmlPageIndex(page(`<div>${"长文".repeat(200)}</div>`));

    expect(isDeck).toBe(false);
    expect(index).toBe("");
  });

  // Headings survive the cap first: paragraphs are interchangeable and
  // headings are not, so every-Nth sampling would throw away the good rows to
  // keep the weak ones.
  it("keeps the headings when there are more landmarks than the cap", () => {
    const body =
      Array.from({ length: 30 }, (_, i) => `<h2>标题 ${i + 1}</h2>`).join("\n") +
      "\n" +
      Array.from({ length: 100 }, (_, i) => `<div id="b${i + 1}">块</div>`).join("\n");

    const index = landmarkIndex(page(body));
    const rows = index.split("\n").filter((l) => /^\d+\. </.test(l));

    expect(rows.length).toBeLessThanOrEqual(60);
    expect(index).toContain("<h2> 标题 1");
    expect(index).toContain("<h2> 标题 30");
    expect(index).toContain("more landmark(s) not listed");
  });
});
