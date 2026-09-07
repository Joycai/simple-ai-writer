/**
 * The deck model that sits between "what the browser measured" and "what
 * pptxgenjs writes" — and every judgement call that can be made without a DOM.
 *
 * Why this layer exists: the measuring half has to run inside the sandboxed
 * preview iframe (harvester.js, another realm, untestable without real layout)
 * and the writing half is a thin call into a library. Everything in between —
 * unit conversion, slide sizing, colour parsing, pruning, the slack that keeps
 * PowerPoint's own line breaking from overflowing a box — is pure, lives here,
 * and is the part with the bugs worth testing.
 *
 * Coordinates arrive as **CSS pixels relative to the slide's own box** and
 * leave as **inches**, which is what OOXML counts in. The conversion is one
 * number (`inchesPerPx`) because the deck is scaled uniformly: an HTML page
 * laid out at 1280×720 becomes a 13.333×7.5in slide, so 96px = 1in and the
 * author's `font-size: 32px` becomes 24pt — the size they would have picked in
 * PowerPoint anyway.
 */

/** One stretch of text with uniform formatting — a `<strong>` inside a line. */
export interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** CSS colour string as computed, e.g. "rgb(17, 24, 39)". */
  color?: string;
  /** Rendered font size in CSS px. */
  sizePx: number;
  /** `letter-spacing` in CSS px, when the page set one. */
  spacingPx?: number;
  /** The line ends after this run — a `<br>`, or a block-level child. */
  breakAfter?: boolean;
  /** First family of the computed stack — PowerPoint takes one name. */
  font?: string;
}

interface BoxPx {
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * Clockwise degrees, when the page rotated this.
   *
   * The box is the **unrotated** one, already moved so its centre sits where
   * the rotation put it — which is what PowerPoint needs, because it turns
   * every shape about its own centre.
   */
  rotate?: number;
  /**
   * The opacity this block inherits, 0–1, when it is not fully opaque.
   *
   * Every ancestor's `opacity` multiplied together: the property is not
   * inherited in CSS, it composites, so a 60% card makes everything inside it
   * 60% too. Only zero used to be honoured (as "hidden"), and everything
   * between arrived solid.
   */
  opacity?: number;
}

/** A drop shadow as OOXML states one: a distance and a direction, not a vector. */
export interface ShadowPx {
  inset: boolean;
  offsetPx: number;
  /** Degrees clockwise from the positive x axis. */
  angle: number;
  blurPx: number;
  /** Computed CSS colour, alpha included. */
  color: string;
}

/** A painted box: background, border, or both. */
export interface RectBlock extends BoxPx {
  kind: "rect";
  /** Computed CSS colour, or absent for no fill. */
  fill?: string;
  line?: { color: string; widthPx: number };
  radiusPx?: number;
  shadow?: ShadowPx | null;
}

/** A run of text, measured on the text itself rather than its container. */
export interface TextBlock extends BoxPx {
  kind: "text";
  runs: TextRun[];
  align: "left" | "center" | "right" | "justify";
  /** How many line boxes the browser used — what the shrink guard is sized on. */
  lines: number;
  /** The height of one of those line boxes, in CSS px. */
  lineHeightPx?: number;
}

/** A picture, already a data URL (the zip has no other way to carry it). */
export interface ImageBlock extends BoxPx {
  kind: "image";
  data: string;
}

export type Block = RectBlock | TextBlock | ImageBlock;

export interface HarvestedSlide {
  blocks: Block[];
  /** Human-readable notes about anything that could not be mapped faithfully. */
  degraded: string[];
}

export interface HarvestedDeck {
  /** The slide canvas in CSS px. Every block's coordinates live inside it. */
  canvas: { width: number; height: number };
  slides: HarvestedSlide[];
}

/** Slide dimensions in inches, plus the standard name when it is one. */
export interface SlideSize {
  width: number;
  height: number;
  /**
   * A pptxgenjs layout name, or null when the deck needs a custom size.
   *
   * `LAYOUT_WIDE`, not `LAYOUT_16x9`: the library's "16x9" is 10×5.625in — the
   * *old* widescreen size — while every deck PowerPoint has made by default
   * since 2013 is 13.333×7.5, which it calls WIDE. Picking the wrong one costs
   * nothing visually (the shapes scale with the slide) right up until the deck
   * is merged with a real one, where it arrives three quarters the size.
   */
  standard: "LAYOUT_WIDE" | "LAYOUT_4x3" | null;
}

/** Width every deck is scaled to. 13.333in is PowerPoint's own 16:9 width. */
const STANDARD_WIDTH_IN = 13.333;

/** How far an aspect ratio may sit from a standard one and still snap to it. */
const ASPECT_TOLERANCE = 0.02;

/**
 * The slide size for a canvas.
 *
 * Snapping to the standard layouts matters beyond tidiness: a deck declared
 * 13.333×7.5 opens in PowerPoint as an ordinary widescreen presentation, where
 * a custom 13.333×7.49 makes every template and every "reuse slides" operation
 * treat it as an odd size. Anything genuinely non-standard (a poster, a 1:1
 * social card) keeps its own aspect rather than being letterboxed into one.
 */
export function slideSize(canvas: { width: number; height: number }): SlideSize {
  const aspect = canvas.width / canvas.height;
  if (Math.abs(aspect - 16 / 9) < ASPECT_TOLERANCE) {
    return { width: 13.333, height: 7.5, standard: "LAYOUT_WIDE" };
  }
  if (Math.abs(aspect - 4 / 3) < ASPECT_TOLERANCE) {
    return { width: 10, height: 7.5, standard: "LAYOUT_4x3" };
  }
  return {
    width: STANDARD_WIDTH_IN,
    height: round(STANDARD_WIDTH_IN / aspect),
    standard: null,
  };
}

/** The one scale factor: CSS pixels → inches. */
export function inchesPerPx(canvas: { width: number }, size: SlideSize): number {
  return size.width / canvas.width;
}

/** Inches → points, the unit OOXML measures type in. */
function pt(inches: number): number {
  return round(inches * 72);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** A colour ready for OOXML: 6-digit hex plus a transparency percentage. */
export interface PptxColor {
  hex: string;
  /** 0 = opaque, 100 = invisible. pptxgenjs calls this `transparency`. */
  transparency: number;
}

const NAMED: Record<string, string> = {
  black: "000000",
  white: "FFFFFF",
  red: "FF0000",
  green: "008000",
  blue: "0000FF",
  gray: "808080",
  grey: "808080",
  transparent: "",
};

/**
 * A computed CSS colour → OOXML, or null when there is nothing to paint.
 *
 * Null rather than a white fill for the transparent cases: every element in a
 * page has a `background-color`, and `rgba(0, 0, 0, 0)` is what almost all of
 * them say. Treating that as a colour would paint the whole DOM as a stack of
 * opaque black rectangles.
 */
export function cssColor(css: string | undefined): PptxColor | null {
  if (!css) return null;
  const value = css.trim().toLowerCase();
  if (!value || value === "none" || value === "transparent") return null;

  const named = NAMED[value];
  if (named !== undefined) return named ? { hex: named, transparency: 0 } : null;

  const rgb = value.match(
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/,
  );
  if (rgb) {
    const alpha = parseAlpha(rgb[4]);
    if (alpha <= 0) return null;
    return {
      hex: hex2(rgb[1]) + hex2(rgb[2]) + hex2(rgb[3]),
      transparency: Math.round((1 - alpha) * 100),
    };
  }

  const short = value.match(/^#([0-9a-f]{3})$/);
  if (short) {
    const [r, g, b] = short[1].split("");
    return { hex: `${r}${r}${g}${g}${b}${b}`.toUpperCase(), transparency: 0 };
  }
  const long = value.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/);
  if (long) {
    const alpha = long[2] === undefined ? 1 : parseInt(long[2], 16) / 255;
    if (alpha <= 0) return null;
    return { hex: long[1].toUpperCase(), transparency: Math.round((1 - alpha) * 100) };
  }
  return null;
}

/**
 * Fold an inherited `opacity` into a colour's own alpha.
 *
 * They compose in the page — a 40%-opaque panel painted in a 50%-alpha colour
 * shows 20% — and OOXML has only the one transparency per fill to say it with.
 */
export function fade(color: PptxColor | null, opacity: number | undefined): PptxColor | undefined {
  if (!color) return undefined;
  if (opacity === undefined || opacity >= 1) return color;
  const visible = (1 - color.transparency / 100) * Math.max(0, opacity);
  return { hex: color.hex, transparency: Math.round((1 - visible) * 100) };
}

/** An inherited opacity as the percentage pptxgenjs calls `transparency`. */
function transparencyOf(opacity: number | undefined): number | undefined {
  if (opacity === undefined || opacity >= 1) return undefined;
  return Math.round((1 - Math.max(0, opacity)) * 100);
}

/** pptxgenjs clamps neither of these, and PowerPoint reads past the range as zero. */
function clamp(value: number, high: number): number {
  return Math.min(high, Math.max(0, value));
}

/**
 * A measured shadow in PowerPoint's units, or undefined for none.
 *
 * `spread` is gone: OOXML's outer shadow has no counterpart for it. A shadow
 * slightly the wrong size is a different class of wrong from the card that
 * used to arrive with no elevation at all.
 */
function toShadow(
  shadow: ShadowPx | null | undefined,
  scale: number,
  opacity: number | undefined,
): PptxShadow | undefined {
  if (!shadow) return undefined;
  const color = cssColor(shadow.color);
  if (!color) return undefined;
  const visible = (1 - color.transparency / 100) * (opacity === undefined ? 1 : Math.max(0, opacity));
  if (visible <= 0) return undefined;
  return {
    type: shadow.inset ? "inner" : "outer",
    angle: Math.round(((shadow.angle % 360) + 360) % 360),
    blur: clamp(pt(shadow.blurPx * scale), 100),
    offset: clamp(pt(shadow.offsetPx * scale), 200),
    color: color.hex,
    opacity: Math.round(visible * 100) / 100,
  };
}

function parseAlpha(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const n = raw.endsWith("%") ? parseFloat(raw) / 100 : parseFloat(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
}

function hex2(raw: string): string {
  const n = Math.min(255, Math.max(0, Math.round(parseFloat(raw))));
  return n.toString(16).padStart(2, "0").toUpperCase();
}

/** Smallest box worth emitting, in px. Below this it is a layout artefact. */
const MIN_SIZE_PX = 1;

/**
 * Drop what would only add noise to the shape list.
 *
 * The harvester already skips invisible elements, but a page still yields
 * hairline separators and empty text nodes. The real reason this exists is
 * editability rather than file size: a deck whose layer list runs to three
 * hundred entries is one nobody will open twice, which defeats the whole point
 * of emitting real shapes instead of a screenshot.
 */
export function pruneBlocks(blocks: Block[]): Block[] {
  return blocks.filter((b) => {
    if (b.w < MIN_SIZE_PX || b.h < MIN_SIZE_PX) return false;
    if (b.kind === "rect") return Boolean(b.fill || b.line);
    if (b.kind === "text") return b.runs.some((r) => r.text.trim().length > 0);
    return Boolean(b.data);
  });
}

/** What the writer consumes: one shape, positioned in inches. */
export type Shape =
  | {
      kind: "rect";
      x: number; y: number; w: number; h: number;
      fill?: PptxColor;
      line?: { color: PptxColor; ptWidth: number };
      /** Clockwise degrees; PowerPoint turns the shape about its own centre. */
      rotate?: number;
      shadow?: PptxShadow;
      /**
       * Corner radius **in inches**, which is the unit pptxgenjs's
       * `rectRadius` is in — it divides by the shape's shorter side itself to
       * reach OOXML's fraction. Passing a fraction here (the shape the OOXML
       * attribute has) silently produces a barely-rounded corner instead.
       */
      radius: number;
    }
  | {
      kind: "text";
      x: number; y: number; w: number; h: number;
      runs: {
        text: string;
        bold?: boolean;
        italic?: boolean;
        underline?: boolean;
        color?: string;
        ptSize: number;
        /** Tracking in points, absent when the page set none. */
        ptSpacing?: number;
        /** End the line after this run. */
        breakLine?: boolean;
        font?: string;
      }[];
      align: TextBlock["align"];
      /** Whether PowerPoint may shrink the type to keep it inside the box. */
      shrink: boolean;
      /** Exact line spacing in points, or absent to leave PowerPoint's own. */
      lineSpacing?: number;
      rotate?: number;
      /** Whole-shape transparency, 0–100, from the page's `opacity`. */
      transparency?: number;
    }
  | {
      kind: "image";
      x: number; y: number; w: number; h: number;
      data: string;
      rotate?: number;
      transparency?: number;
    };

/** A shadow in the units pptxgenjs takes: points and degrees. */
export interface PptxShadow {
  type: "outer" | "inner";
  angle: number;
  blur: number;
  offset: number;
  color: string;
  /** 0–1, where 1 is fully opaque. */
  opacity: number;
}

/**
 * Slack added around a measured text box, as a fraction of its size.
 *
 * The single most likely way this export goes wrong is not an exotic CSS
 * property — it is that PowerPoint's line breaking is not the browser's. Same
 * font, same width, and a paragraph that fits in three lines on screen can
 * take four in PowerPoint and spill out of the shape. The box is therefore
 * grown symmetrically (so centred and right-aligned text stays put) and, for
 * anything that already wraps, PowerPoint is allowed to shrink the type as a
 * last resort.
 */
const TEXT_SLACK = 0.06;

/** Multi-line text gets the shrink guard; a single line has nowhere to reflow to. */
function needsShrink(block: TextBlock): boolean {
  return block.lines > 1;
}

/**
 * The exact line spacing to hand PowerPoint, or undefined to leave its own.
 *
 * The browser's line box is not PowerPoint's. A `line-height: 1.7` paragraph
 * stands a third taller on the page than the ~1.2 PowerPoint uses by default,
 * so a three-line paragraph arrived visibly compressed against everything
 * measured beside it — 112px of page in 79px of slide.
 *
 * Only where one number can be right, which is why this is a decision and not
 * a passthrough:
 *
 * - **A single line** is centred in its box either way, and pinning its
 *   spacing only risks clipping it.
 * - **Runs of different sizes** are not one paragraph the page ever laid out —
 *   a big number above a small caption arrives as one block (they share a
 *   container that owns the text), and one exact spacing would set both lines
 *   the same distance apart, which is further from the page than PowerPoint's
 *   own per-line default.
 */
function lineSpacingPt(block: TextBlock, scale: number): number | undefined {
  if (block.lines < 2 || !block.lineHeightPx) return undefined;
  const size = block.runs[0]?.sizePx;
  if (!block.runs.every((run) => run.sizePx === size)) return undefined;
  return pt(block.lineHeightPx * scale);
}

/** Map one slide's blocks into positioned shapes. */
export function toShapes(deck: HarvestedDeck, slideIndex: number): Shape[] {
  const slide = deck.slides[slideIndex];
  if (!slide) return [];
  const size = slideSize(deck.canvas);
  const scale = inchesPerPx(deck.canvas, size);

  const shapes: Shape[] = [];
  for (const block of pruneBlocks(slide.blocks)) {
    const x = round(block.x * scale);
    const y = round(block.y * scale);
    const w = round(block.w * scale);
    const h = round(block.h * scale);
    // Rotation is an angle, not a length: it survives the scale untouched.
    const rotate = block.rotate ? round(block.rotate) : undefined;

    if (block.kind === "image") {
      shapes.push({
        kind: "image", x, y, w, h, data: block.data, rotate,
        transparency: transparencyOf(block.opacity),
      });
      continue;
    }

    if (block.kind === "rect") {
      const fill = fade(cssColor(block.fill), block.opacity);
      const lineColor = block.line ? fade(cssColor(block.line.color), block.opacity) : undefined;
      const line = block.line && lineColor
        ? { color: lineColor, ptWidth: Math.max(0.25, pt(block.line.widthPx * scale)) }
        : undefined;
      if (!fill && !line) continue;
      // Capped at half the shorter side: past that OOXML's adjustment is out
      // of range, and the shape stops being a rectangle with rounded corners.
      const radius = block.radiusPx
        ? Math.min(round(block.radiusPx * scale), round(Math.min(w, h) / 2))
        : 0;
      shapes.push({
        kind: "rect", x, y, w, h, fill, line, radius, rotate,
        shadow: toShadow(block.shadow, scale, block.opacity),
      });
      continue;
    }

    const padX = round(w * TEXT_SLACK);
    const padY = round(h * TEXT_SLACK);
    shapes.push({
      kind: "text",
      x: round(x - padX / 2),
      y: round(y - padY / 2),
      w: round(w + padX),
      h: round(h + padY),
      align: block.align,
      shrink: needsShrink(block),
      lineSpacing: lineSpacingPt(block, scale),
      rotate,
      transparency: transparencyOf(block.opacity),
      runs: block.runs.map((run) => ({
        text: run.text,
        bold: run.bold,
        italic: run.italic,
        underline: run.underline,
        color: cssColor(run.color)?.hex,
        ptSize: pt(run.sizePx * scale),
        ptSpacing: run.spacingPx ? pt(run.spacingPx * scale) : undefined,
        breakLine: run.breakAfter,
        font: run.font,
      })),
    });
  }
  return shapes;
}

/** One line per slide about what did not survive, for the author-facing report. */
export function degradedSummary(deck: HarvestedDeck): string[] {
  const out: string[] = [];
  deck.slides.forEach((slide, i) => {
    for (const note of slide.degraded) out.push(`Slide ${i + 1}: ${note}`);
  });
  return out;
}
