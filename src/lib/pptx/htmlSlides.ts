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
 * cannot import), so the invariant is held by this comment and by
 * `htmlSlides.test.ts` — keep both in step when either side changes.
 *
 * Pure and text-level rather than DOM-based: this runs in the tool layer, not
 * in a renderer, and `harvest.ts`'s offscreen frame exists to *measure* a
 * page (which needs layout). Slicing source needs no layout, and a pure
 * function is the part that can carry tests.
 */

import type { SlideRange } from "../fs/pptx";

/**
 * Selectors tried in order; the first that matches anything wins.
 * Mirrors `SLIDE_SELECTORS` in harvester.js — see the module comment.
 */
const SLIDE_TIERS = ["[data-slide]", "section.slide", ".slide", "section", "article"] as const;

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

/** 1-based line number of an offset, for the read_file hand-off below. */
function lineAt(html: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < html.length; i++) if (html[i] === "\n") line++;
  return line;
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
    const head = `## Slide ${slide.index}\n`;
    const cost = head.length + slide.html.length + 2;
    if (n > from && chars + cost > maxChars) break;

    // One slide bigger than the whole budget is usually a page the selectors
    // could not divide (so "slide 1" is the entire body). Returning it whole
    // would spend the run's context on one call, so it is cut here and handed
    // to read_file, which is the tool for reading a long file in order.
    if (n === from && slide.html.length > maxChars) {
      const line = lineAt(html, slide.start);
      parts.push(
        `${head}${slide.html.slice(0, maxChars)}\n` +
          `[... slide ${slide.index} is ${slide.html.length} chars and was cut at ${maxChars}; ` +
          `read the rest with read_file (start_line=${line}) ...]`,
      );
      chars += maxChars;
      break;
    }

    parts.push(head + slide.html);
    chars += cost;
    to = n;
  }

  return {
    markdown: parts.join("\n\n"),
    total_slides: total,
    from_slide: from,
    to_slide: to,
    next_slide: to < total ? to + 1 : null,
  };
}
