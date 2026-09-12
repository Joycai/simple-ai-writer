/**
 * Reading an `.html` file **by structure** — by slide when it is a deck
 * (`read_slides`' HTML path, the counterpart to its .pptx one), by landmark
 * when it is not (`landmarkIndex`, the map `read_file` puts in front of a
 * page the selectors cannot divide). Pure text either way.
 *
 * Why this exists: the model writes decks as HTML (see `./index.ts`), but the
 * only way to read one back was `read_file`, which pages by 4000 characters of
 * source. Finding slide 7 of a 60k-character deck therefore meant a dozen
 * blind reads before any edit could start — and once found, a targeted
 * `propose_edit` still needs the *exact* source of that one slide to quote.
 * The same argument reaches the pages that are not decks at all: a long
 * landing page or report had no map of any kind, because the markdown indexes
 * find nothing in markup. Both halves live here because both need the one tag
 * scanner and the one offset-to-line map — see
 * `docs/feature/agent/html-read-edit-plan.md` D4.
 *
 * **The slide convention is shared with `harvester.js`, deliberately.** That
 * file's `SLIDE_SELECTORS` is what the exporter treats as a slide; if this
 * module disagreed, "slide 7" would mean one thing while reading and another
 * while exporting, and an author reviewing "the change to slide 7" would be
 * looking at the wrong box. The list is duplicated rather than imported
 * because harvester.js is injected into a sandboxed frame as raw text (it
 * cannot import — and its bytes are hashed into the app's `script-src`, so it
 * cannot grow an import either), so the invariant is held by a test:
 * `htmlSlides.test.ts` parses the list back out of the harvester source and
 * compares. Editing harvester.js therefore means updating two things — the
 * `sha256-` in tauri.conf.json, and this list if the selectors moved.
 *
 * Pure and text-level rather than DOM-based: this runs in the tool layer, not
 * in a renderer, and `harvest.ts`'s offscreen frame exists to *measure* a
 * page (which needs layout). Slicing source needs no layout, and a pure
 * function is the part that can carry tests.
 */

import type { SlideRange } from "../fs/pptx";

/**
 * Selectors tried in order; the first that matches anything wins.
 *
 * Mirrors `SLIDE_SELECTORS` in harvester.js — see the module comment. Exported
 * so `htmlSlides.test.ts` can hold the two lists to each other rather than
 * leaving the invariant to a comment nobody reads at the moment it matters.
 */
export const SLIDE_TIERS = ["[data-slide]", "section.slide", ".slide", "section", "article"] as const;

/** Elements whose contents are raw text: tags inside them are not markup. */
const RAW_TEXT_TAGS = ["script", "style", "textarea"];

/** One slide's source, and where it sits in the file. */
interface HtmlSlide {
  /** 1-based position in the deck. */
  index: number;
  /** Offset of the element's opening `<` in the source. */
  start: number;
  /** Offset just past the element's closing `>`. */
  end: number;
  /** The element's source, verbatim — quotable straight into propose_edit. */
  html: string;
  /** 1-based line the slide opens on — what `rewrite_lines` takes. */
  startLine: number;
  /** 1-based line the slide's closing tag ends on, inclusive. */
  endLine: number;
}

interface Tag {
  name: string;
  /** Offset of `<`. */
  start: number;
  /** Offset just past `>`. */
  end: number;
  /** Raw attribute text between the tag name and the closing `>`. */
  attrs: string;
  closing: boolean;
  selfClosing: boolean;
}

/**
 * Every markup tag in source order, with comments, doctypes and the contents
 * of raw-text elements skipped.
 *
 * Skipping matters more than it looks: a generated deck routinely carries a
 * `<script>` whose strings mention `<section>`, and a scanner that counted
 * those would close slides in the wrong place. Attribute values are scanned
 * quote-aware for the same reason — `title="a > b"` must not end the tag.
 */
function scanTags(html: string): Tag[] {
  const tags: Tag[] = [];
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;

    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      i = close === -1 ? html.length : close + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const close = html.indexOf(">", lt + 2);
      i = close === -1 ? html.length : close + 1;
      continue;
    }

    const closing = html[lt + 1] === "/";
    const nameStart = lt + (closing ? 2 : 1);
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(html.slice(nameStart, nameStart + 64));
    if (!nameMatch) {
      i = lt + 1; // a bare "<" in text
      continue;
    }
    const name = nameMatch[0].toLowerCase();

    // Walk to the unquoted ">" that ends this tag.
    let j = nameStart + name.length;
    let quote: string | null = null;
    for (; j < html.length; j++) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
    }
    const end = Math.min(j + 1, html.length);
    const attrs = html.slice(nameStart + name.length, j);
    tags.push({ name, start: lt, end, attrs, closing, selfClosing: /\/\s*$/.test(attrs) });
    i = end;

    // A raw-text element's body is not markup — jump the scanner past it.
    if (!closing && RAW_TEXT_TAGS.includes(name)) {
      const close = html.toLowerCase().indexOf(`</${name}`, end);
      i = close === -1 ? html.length : close;
    }
  }
  return tags;
}

/** Whether an attribute string carries `class="… slide …"` as a whole token. */
function hasClass(attrs: string, want: string): boolean {
  const m = /(^|\s)class\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  if (!m) return false;
  const value = m[3] ?? m[4] ?? m[5] ?? "";
  return value.split(/\s+/).some((c) => c === want);
}

/** Whether an attribute string declares `data-slide`. */
function hasDataSlide(attrs: string): boolean {
  return /(^|\s)data-slide(\s|=|\/|$)/i.test(attrs);
}

function matchesTier(tag: Tag, tier: (typeof SLIDE_TIERS)[number]): boolean {
  switch (tier) {
    case "[data-slide]":
      return hasDataSlide(tag.attrs);
    case "section.slide":
      return tag.name === "section" && hasClass(tag.attrs, "slide");
    case ".slide":
      return hasClass(tag.attrs, "slide");
    case "section":
      return tag.name === "section";
    case "article":
      return tag.name === "article";
  }
}

/**
 * Elements HTML closes for you — they have no end tag, ever.
 *
 * `elementEnd` depth-counts for a closing tag and falls back to the end of the
 * file when it finds none. That fallback is right for a container someone
 * forgot to close and catastrophically wrong here: `</img>` does not exist, so
 * without this list an `<img id="logo">` reports a range running to the last
 * line of the document, and a model asked to change the logo hands
 * `rewrite_lines` a range covering everything below it.
 *
 * The list is the HTML spec's void elements. `<br>`/`<hr>`/`<meta>`/`<link>`
 * are here as well as in `NEVER_LANDMARK` — that one decides what is worth
 * *listing*, this one decides where an element *ends*, and the second question
 * is asked by the slide splitter too (`[data-slide]` and `.slide` match any
 * tag, an `<img data-slide="1">` included).
 */
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/**
 * Where the element opened by `tags[at]` ends, by depth-counting its own tag
 * name. An element that is never closed runs to the end of the file — the
 * same thing a browser does with it, and better than dropping the slide.
 * A void element ends at its own `>`, because it has no closing tag to find.
 */
function elementEnd(html: string, tags: Tag[], at: number): number {
  const open = tags[at];
  if (open.selfClosing || VOID_TAGS.has(open.name)) return open.end;
  let depth = 1;
  for (let k = at + 1; k < tags.length; k++) {
    const tag = tags[k];
    if (tag.name !== open.name) continue;
    if (tag.closing) {
      if (--depth === 0) return tag.end;
    } else if (!tag.selfClosing) {
      depth++;
    }
  }
  return html.length;
}

/**
 * Split a page into slides.
 *
 * Matches are returned in source order, nested ones included, because that is
 * what `document.querySelectorAll` hands the exporter — a deck that nests one
 * `.slide` inside another is pathological, and the two sides agreeing about it
 * matters more than either being clever.
 */
export function splitHtmlSlides(html: string): HtmlSlide[] {
  return splitHtmlDeck(html).slides;
}

/**
 * What the fallback tier is called when no selector matched.
 *
 * Its own name rather than `"body"` because that is the fact worth telling
 * whoever asks: a page with no sections is not divided, it is one slide the
 * size of the whole page. Reviewing a "1 slide" card is how an author catches
 * a deck whose slides were spelled `<div class="page">`.
 */
export const WHOLE_PAGE_TIER = "the whole page (no slide sections found)";

/** A split page, and which selector decided the division. */
interface HtmlDeck {
  /** The matched selector, or {@link WHOLE_PAGE_TIER}. */
  tier: string;
  slides: HtmlSlide[];
}

/**
 * The split plus the tier that produced it.
 *
 * The tier is reportable on its own: "12 slides on `section.slide`" and "1
 * slide, the whole page" are the difference between a deck and a page the
 * author *thinks* is a deck, and that is knowable before anything is
 * converted — see `export_pptx`'s approval card.
 */
export function splitHtmlDeck(html: string): HtmlDeck {
  return deckFrom(html, scanTags(html));
}

/** {@link splitHtmlDeck} on a scan the caller already has. */
function deckFrom(html: string, tags: Tag[]): HtmlDeck {
  const raw = splitRaw(html, tags);
  return { tier: raw.tier, slides: withLines(html, raw.slides) };
}

interface RawSplit {
  tier: string;
  slides: Omit<HtmlSlide, "startLine" | "endLine">[];
}

/** The split itself; {@link splitHtmlDeck} adds the line numbers. */
function splitRaw(html: string, tags: Tag[]): RawSplit {
  for (const tier of SLIDE_TIERS) {
    const hits = tags
      .map((tag, at) => ({ tag, at }))
      .filter(({ tag }) => !tag.closing && matchesTier(tag, tier));
    if (!hits.length) continue;
    return {
      tier,
      slides: hits.map(({ tag, at }, n) => {
        const end = elementEnd(html, tags, at);
        return { index: n + 1, start: tag.start, end, html: html.slice(tag.start, end) };
      }),
    };
  }

  // No sections at all: the body is one slide, exactly as harvester.js decides.
  const body = tags.findIndex((t) => t.name === "body" && !t.closing);
  if (body >= 0) {
    const start = tags[body].start;
    const end = elementEnd(html, tags, body);
    return { tier: WHOLE_PAGE_TIER, slides: [{ index: 1, start, end, html: html.slice(start, end) }] };
  }
  return { tier: WHOLE_PAGE_TIER, slides: [{ index: 1, start: 0, end: html.length, html }] };
}

/**
 * 1-based line number for each of `offsets`, counted in one pass.
 *
 * Sorted rather than walked in slide order because slides may nest (the
 * splitter returns nested matches, deliberately — see above), so their offsets
 * are not monotonic and a single forward scan over them would run backwards.
 */
function lineMapFor(html: string, offsets: readonly number[]): Map<number, number> {
  const map = new Map<number, number>();
  let line = 1;
  let i = 0;
  for (const off of [...new Set(offsets)].sort((a, b) => a - b)) {
    for (; i < off && i < html.length; i++) if (html[i] === "\n") line++;
    map.set(off, line);
  }
  return map;
}

/**
 * Attach each slide's line range.
 *
 * These are what make a targeted `rewrite_lines` possible at all: without them
 * the only way to change slide 7 is to quote its entire source into
 * `propose_edit`'s `find`, which pays for the same bytes a second time and
 * fails outright if the model reconstructs one space wrong.
 * `end` is exclusive, so the last line the slide occupies is the one holding
 * `end - 1`.
 */
function withLines(
  html: string,
  slides: Omit<HtmlSlide, "startLine" | "endLine">[],
): HtmlSlide[] {
  const lines = lineMapFor(
    html,
    slides.flatMap((s) => [s.start, Math.max(s.start, s.end - 1)]),
  );
  return slides.map((s) => ({
    ...s,
    startLine: lines.get(s.start) ?? 1,
    endLine: lines.get(Math.max(s.start, s.end - 1)) ?? 1,
  }));
}

/**
 * Longest index emitted before it is sampled instead of listed. Same number as
 * the heading and paragraph maps use on the markdown side, for the same
 * reason: an index that approaches the size of the thing it describes has
 * defeated its own purpose.
 */
const INDEX_MAX_ROWS = 60;

/**
 * A short label for a slide, for the index — the first heading's text, or
 * failing that the first text of any kind.
 *
 * Text only, and short: the index exists to be read *instead of* the deck, so
 * a line of it that approaches the size of the slide it describes has defeated
 * its own purpose.
 */
export function slideTitle(slideHtml: string, max = 40): string {
  const heading = slideHtml.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
  const source = heading ? heading[1] : slideHtml;
  const text = source
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "(no text)";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * One range of slides from a page, shaped exactly like the .pptx reader's.
 *
 * Sharing `SlideRange` is the point: the paging trailer the model reads
 * (`formatSlideRange`) is then identical for both kinds of deck, so a model
 * that has learned to page a .pptx already knows how to page an .html.
 * `markdown` carries HTML source here rather than markdown — the field is the
 * transport, and the model needs the source verbatim to quote it back into a
 * `propose_edit`.
 */
export function readHtmlSlideRange(
  html: string,
  startSlide?: number,
  maxChars = 4000,
): SlideRange {
  const slides = splitHtmlSlides(html);
  const total = slides.length;
  const from = Math.min(Math.max(1, Math.floor(startSlide ?? 1)), total);

  const parts: string[] = [];
  let to = from;
  let chars = 0;
  for (let n = from; n <= total; n++) {
    const slide = slides[n - 1];
    const head = `## Slide ${slide.index} (lines ${slide.startLine}-${slide.endLine})\n`;
    const cost = head.length + slide.html.length + 2;
    if (n > from && chars + cost > maxChars) break;

    // One slide bigger than the whole budget is usually a page the selectors
    // could not divide (so "slide 1" is the entire body). Returning it whole
    // would spend the run's context on one call, so it is cut here and handed
    // to read_file, which is the tool for reading a long file in order.
    //
    // The hand-off names the line the cut fell ON, not the slide's first line:
    // `start_line=${slide.startLine}` sent the model back to the top of the
    // very thing it had just been shown, so following the instruction re-read
    // the same 4000 characters. A whole-page slide opens at `<body>`, which
    // made that the entire journey wasted.
    //
    // A line number rather than read_file's mid-line cursor: the fraction's
    // denominator is that tool's page budget, and this module must not import
    // the agent layer to learn it — the dependency runs the other way. When
    // the cut lands inside one enormous line, `start_line=N` re-reads that
    // line's first page and read_file's own trailer carries on from there:
    // one page of overlap, and no dead end.
    if (n === from && slide.html.length > maxChars) {
      const cutOffset = slide.start + maxChars;
      const cutAt = lineMapFor(html, [cutOffset]).get(cutOffset) ?? slide.startLine;
      parts.push(
        `${head}${slide.html.slice(0, maxChars)}\n` +
          `[... slide ${slide.index} is ${slide.html.length} chars and was cut at ${maxChars}; ` +
          `read the rest with read_file (start_line=${cutAt}) — that is the line this cut falls on ...]`,
      );
      chars += maxChars;
      break;
    }

    parts.push(head + slide.html);
    chars += cost;
    to = n;
  }

  const body = parts.join("\n\n");
  const whole = from === 1 && to === total;
  return {
    markdown: whole ? body : `${slideIndex(slides)}\n\n${body}`,
    total_slides: total,
    from_slide: from,
    to_slide: to,
    next_slide: to < total ? to + 1 : null,
  };
}

/**
 * One line per slide: number, label, line range, size.
 *
 * Rides along on any response that could not carry the whole deck, rather than
 * being asked for (no `outline` parameter — plan §D2). The information is free
 * here (the splitter has already divided the entire file to answer this call
 * at all) and it is exactly what the model needs at that moment: without it,
 * "change slide 7" begins with paging 4000 characters at a time until slide 7
 * goes by, which on a 30-slide deck is most of a context window spent on
 * finding the thing rather than on doing it.
 */
export function slideIndex(slides: readonly HtmlSlide[]): string {
  // Sampled rather than truncated once the deck is bigger than the cap, for
  // the reason `paragraphIndex` gives (agent/tools.ts): the first sixty rows
  // of a two-hundred-section page map its first third, so the model would
  // still have to page through the rest and the index would have bought
  // nothing. Every row sampled is a real slide with a real line range, so a
  // coarse map of all of it beats a precise map of the beginning.
  const step = Math.ceil(slides.length / INDEX_MAX_ROWS);
  const shown = step > 1 ? slides.filter((_, i) => i % step === 0) : slides;
  const rows = shown.map(
    (s) =>
      `${s.index}. ${slideTitle(s.html)} (lines ${s.startLine}-${s.endLine}, ` +
      `${s.html.length >= 1000 ? `${(s.html.length / 1000).toFixed(1)}k` : s.html.length} chars)`,
  );
  return [
    step > 1
      ? `This deck has ${slides.length} slide(s); every ${step}th one is listed below ` +
        "with the lines it occupies, which is what rewrite_lines takes:"
      : `This deck has ${slides.length} slide(s); the line ranges below are what rewrite_lines takes:`,
    ...rows,
  ].join("\n");
}

/**
 * Elements that are a place on a page even without an `id` — the ones an
 * author would name when they say "the nav" or "the pricing table".
 *
 * `section` / `article` are in the list although a page with either would have
 * been split into slides before reaching here: a page with exactly ONE of them
 * is not a deck (`slideIndex` needs two to be a map of anything) and still
 * wants its one landmark listed.
 */
const LANDMARK_TAGS = new Set([
  "header", "nav", "main", "footer", "aside", "section", "article", "figure", "table", "form",
]);

/**
 * Tags that are never a landmark, however they are decorated. An `id` on a
 * `<style>` is a stylesheet's name, not a place in the document.
 */
const NEVER_LANDMARK = new Set([
  "html", "head", "body", "script", "style", "link", "meta", "title", "br", "hr", "base",
]);

/** Longest element prefix scanned for a landmark's label. */
const LABEL_SCAN_CHARS = 2_000;

/** Landmarks a page needs before an index of them earns its tokens. */
const LANDMARK_MIN = 2;

/**
 * An element's `id`, quoted or bare — the same shape `hasClass` reads, and a
 * literal pattern for the same reason: a built one has to survive two levels
 * of escaping to say `\s`, and when it does not it silently matches the letter
 * "s" instead and every id in the page disappears.
 */
function idOf(attrs: string): string | null {
  const m = /(^|\s)id\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  if (!m) return null;
  const value = m[3] ?? m[4] ?? m[5] ?? "";
  return value.trim() || null;
}

/** One place on a page, with where it sits in the source. */
interface Landmark {
  /** How the row names it: `<h2>` or `<section id="hero">`. */
  what: string;
  /** Whether this is a heading — headings survive the row cap first. */
  heading: boolean;
  start: number;
  end: number;
  label: string;
}

/**
 * The map a page with no slide sections gets — its landmarks, and the lines
 * each one occupies.
 *
 * This is the other half of the `read_file` gap `htmlIndex` closes. A deck
 * gets `slideIndex`; a long landing page or report gets nothing at all today,
 * because `headingIndex` matches markdown ATX headings (never present in HTML)
 * and `paragraphIndex` rarely clears its two-paragraph floor on markup. So the
 * one shape of `.html` the splitter cannot divide was also the one with no map
 * — and "rewrite the 三个季度 section" began by paging 4000 characters at a
 * time until that section went past.
 *
 * The structure that IS there is the markup, so that is what gets offered:
 * every heading, every element carrying an `id` (the anchors an author names),
 * and the handful of tags that are a place on their own. Same appearance rule
 * as every other index here — only when the response could not carry the whole
 * file — and no parameter, for the reason edit-loop-plan.md §D2 gives.
 */
export function landmarkIndex(html: string): string {
  return landmarkFrom(html, scanTags(html));
}

/**
 * The structural map of one page, whichever kind it is — what `read_file` puts
 * in front of a paged `.html`.
 *
 * One entry point rather than two calls, because the caller's two questions
 * ("is this a deck?" and "then what does its map look like?") are answered by
 * the same tag scan, and asking them separately scanned the whole file twice
 * on every page of every non-deck read.
 *
 * `isDeck` comes back rather than being folded into the string: whether to
 * name `read_slides` alongside the map depends on the running toolset, and
 * that is the agent layer's decision, not this module's
 * (docs/reference/tool-presence.md).
 */
export function htmlPageIndex(html: string): { isDeck: boolean; index: string } {
  const tags = scanTags(html);
  const deck = deckFrom(html, tags);
  // One slide the size of the whole page is not a deck, and "this deck has 1
  // slide" maps nothing — that page gets the landmark map instead.
  if (deck.tier !== WHOLE_PAGE_TIER && deck.slides.length >= 2) {
    return { isDeck: true, index: slideIndex(deck.slides) };
  }
  return { isDeck: false, index: landmarkFrom(html, tags) };
}

/** {@link landmarkIndex} on a scan the caller already has. */
function landmarkFrom(html: string, tags: Tag[]): string {
  const found: Landmark[] = [];

  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    if (tag.closing || NEVER_LANDMARK.has(tag.name)) continue;

    const heading = /^h[1-6]$/.test(tag.name);
    const id = idOf(tag.attrs);
    if (!heading && id === null && !LANDMARK_TAGS.has(tag.name)) continue;

    const end = elementEnd(html, tags, i);
    found.push({
      what: id ? `<${tag.name} id="${id}">` : `<${tag.name}>`,
      heading,
      start: tag.start,
      end,
      // Bounded: the label is 40 characters and the first text of an element
      // is at its front, so scanning a 200 KB <main> to the end would be work
      // thrown away — and there can be sixty of them.
      label: slideTitle(html.slice(tag.start, Math.min(end, tag.start + LABEL_SCAN_CHARS))),
    });
  }

  // One landmark is not a map of anything; fall through to whatever the caller
  // has next (the paragraph map).
  if (found.length < LANDMARK_MIN) return "";

  // Headings first when the cap bites, then the rest in source order. Not
  // every-Nth sampling the way paragraphIndex does it: paragraphs are
  // interchangeable and headings are not, so dropping half the headings to
  // make room for `<div id="...">`s would throw away the good rows to keep the
  // weak ones.
  let shown = found;
  let omitted = 0;
  if (found.length > INDEX_MAX_ROWS) {
    const headings = found.filter((f) => f.heading);
    const rest = found.filter((f) => !f.heading);
    const kept = new Set(
      [...headings.slice(0, INDEX_MAX_ROWS), ...rest].slice(0, INDEX_MAX_ROWS),
    );
    shown = found.filter((f) => kept.has(f));
    omitted = found.length - shown.length;
  }

  const lines = lineMapFor(
    html,
    shown.flatMap((f) => [f.start, Math.max(f.start, f.end - 1)]),
  );
  const rows = shown.map(
    (f, n) =>
      `${n + 1}. ${f.what} ${f.label} (lines ${lines.get(f.start) ?? 1}-${
        lines.get(Math.max(f.start, f.end - 1)) ?? 1
      })`,
  );

  return [
    "This page has no slide sections. Its landmarks and the lines they occupy — " +
      "the line ranges are what rewrite_lines takes, so a part of it can be named " +
      "without paging to it:",
    ...rows,
    omitted > 0 ? `[... ${omitted} more landmark(s) not listed ...]` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
