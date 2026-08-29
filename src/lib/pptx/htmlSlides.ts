/**
 * Reading an `.html` deck **by slide** — the counterpart to `read_slides`'s
 * .pptx path, in pure text.
 *
 * Why this exists: the model writes decks as HTML (see `./index.ts`), but the
 * only way to read one back was `read_file`, which pages by 4000 characters of
 * source. Finding slide 7 of a 60k-character deck therefore meant a dozen
 * blind reads before any edit could start — and once found, a targeted
 * `propose_edit` still needs the *exact* source of that one slide to quote.
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
export interface HtmlSlide {
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
 * Where the element opened by `tags[at]` ends, by depth-counting its own tag
 * name. An element that is never closed runs to the end of the file — the
 * same thing a browser does with it, and better than dropping the slide.
 */
function elementEnd(html: string, tags: Tag[], at: number): number {
  const open = tags[at];
  if (open.selfClosing) return open.end;
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
  return withLines(html, splitRaw(html));
}

/** The split itself; {@link splitHtmlSlides} adds the line numbers. */
function splitRaw(html: string): Omit<HtmlSlide, "startLine" | "endLine">[] {
  const tags = scanTags(html);
  for (const tier of SLIDE_TIERS) {
    const hits = tags
      .map((tag, at) => ({ tag, at }))
      .filter(({ tag }) => !tag.closing && matchesTier(tag, tier));
    if (!hits.length) continue;
    return hits.map(({ tag, at }, n) => {
      const end = elementEnd(html, tags, at);
      return { index: n + 1, start: tag.start, end, html: html.slice(tag.start, end) };
    });
  }

  // No sections at all: the body is one slide, exactly as harvester.js decides.
  const body = tags.findIndex((t) => t.name === "body" && !t.closing);
  if (body >= 0) {
    const start = tags[body].start;
    const end = elementEnd(html, tags, body);
    return [{ index: 1, start, end, html: html.slice(start, end) }];
  }
  return [{ index: 1, start: 0, end: html.length, html }];
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
    if (n === from && slide.html.length > maxChars) {
      parts.push(
        `${head}${slide.html.slice(0, maxChars)}\n` +
          `[... slide ${slide.index} is ${slide.html.length} chars and was cut at ${maxChars}; ` +
          `read the rest with read_file (start_line=${slide.startLine}) ...]`,
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
  const rows = slides.map(
    (s) =>
      `${s.index}. ${slideTitle(s.html)} (lines ${s.startLine}-${s.endLine}, ` +
      `${s.html.length >= 1000 ? `${(s.html.length / 1000).toFixed(1)}k` : s.html.length} chars)`,
  );
  return [
    `This deck has ${slides.length} slide(s); the line ranges below are what rewrite_lines takes:`,
    ...rows,
  ].join("\n");
}
