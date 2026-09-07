/**
 * What the exporter is known to lose, found in the page's *source* — the
 * generation-side half of fidelity (pptx-plan.md §7).
 *
 * `inspect_html` reports what the browser measured, and the harvester notes
 * what it degraded. Both are silent about the constructs the exporter cannot
 * see at all: a `::before` has no box a Range can select, so a custom bullet
 * drawn with one simply is not there; an element whose entrance animation
 * starts at `opacity: 0` is measured as hidden. The model ran the check, the
 * report said clean, the deck came back with holes — which is exactly why
 * these have to be found in the text the model wrote rather than in the
 * layout it produced.
 *
 * Text-level on purpose (§7 D21): one read of the file, no DOM, knowable at
 * proposal time, testable in jsdom, and — the property that matters most — it
 * never touches `harvester.js`, so the CSP hash in tauri.conf.json stays put.
 * The price is that selectors are not resolved against elements: a finding
 * names `.card::after` and a line, not "the card on slide 3". The model wrote
 * that CSS; it knows which card. False positives are accepted (a rule inside
 * a comment, a `::before` on something `display: none`) — the cost of one is
 * a line of advice the model can ignore.
 *
 * Every rule here corresponds to a **verified** gap in the harvester, not to
 * a suspected one; the table in pptx-plan.md §7.3 is the list, and
 * `pptxLint.test.ts` holds one positive and one negative example per rule.
 * Nothing here blocks an export — the author may want the imperfect file.
 */

/** Severity, in the order findings are reported. */
export type LintLevel = "lost" | "shifted" | "approximated";

export interface LintFinding {
  rule: string;
  level: LintLevel;
  /** 1-based line in the source. */
  line: number;
  /** What the page does, quoting the construct. */
  what: string;
  /** What to write instead. */
  fix: string;
}

const LEVEL_ORDER: Record<LintLevel, number> = { lost: 0, shifted: 1, approximated: 2 };

/** Findings named in the report before the rest are counted. */
const MAX_LISTED = 12;

/**
 * Families PowerPoint on Windows or macOS has, or that name the platform's
 * own fonts. The first family in a `font-family` list is the one the browser
 * used, so it is the one that has to exist on the machine opening the deck.
 * Generic keywords resolve to *something* everywhere and pass.
 */
const SYSTEM_FAMILIES = new Set(
  [
    "arial", "helvetica", "helvetica neue", "georgia", "times new roman", "times",
    "segoe ui", "calibri", "cambria", "verdana", "tahoma", "trebuchet ms",
    "consolas", "courier new", "courier",
    "pingfang sc", "苹方", "苹方-简", "microsoft yahei", "微软雅黑", "microsoft jhenghei", "微軟正黑體",
    "simsun", "宋体", "simhei", "黑体", "kaiti", "楷体", "fangsong", "仿宋",
    "hiragino sans gb", "hiragino sans", "heiti sc", "stheiti",
    "system-ui", "-apple-system", "blinkmacsystemfont", "ui-sans-serif", "ui-serif", "ui-monospace",
    "sans-serif", "serif", "monospace", "cursive", "fantasy", "emoji",
  ],
);

const FONT_ADVICE = "use PingFang SC / Microsoft YaHei / Arial / Helvetica / Georgia";

/** A run of CSS text with the offset of its first character in the page. */
interface Fragment {
  css: string;
  start: number;
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Blank out HTML comments so nothing inside them is scanned, keeping offsets. */
function withoutComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length));
}

/** Blank out CSS comments the same way. */
function withoutCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
}

function styleBlocks(source: string): Fragment[] {
  const out: Fragment[] = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    out.push({ css: withoutCssComments(m[1]), start: m.index + m[0].indexOf(m[1]) });
  }
  return out;
}

function inlineStyles(source: string): Fragment[] {
  const out: Fragment[] = [];
  const re = /\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const css = m[2] ?? m[3] ?? "";
    out.push({ css, start: m.index + m[0].length - css.length - 1 });
  }
  return out;
}

/** One `selector { declarations }` — innermost blocks, so `@media` wrappers fall away. */
interface Rule {
  selector: string;
  body: string;
  /** Offset of the body in the page. */
  start: number;
}

function rulesOf(block: Fragment): Rule[] {
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block.css))) {
    out.push({
      selector: m[1].trim().split(/\s*[\n\r]+\s*/).pop() ?? m[1].trim(),
      body: m[2],
      start: block.start + m.index + m[1].length + 1,
    });
  }
  return out;
}

/** The value of a property inside a declaration list, or null when absent. */
function declaration(body: string, property: string): { value: string; at: number } | null {
  const re = new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]*)`, "i");
  const m = re.exec(body);
  if (!m) return null;
  return { value: m[1].trim(), at: m.index + m[0].length - m[1].length };
}

function isZero(value: string): boolean {
  return /^0*(\.0+)?\s*(!important)?$/.test(value.replace(/\s+/g, ""));
}

function firstFamily(value: string): string {
  const first = value.split(",")[0] ?? "";
  return first.replace(/!important/i, "").trim().replace(/^["']|["']$/g, "").trim();
}

function tagLine(source: string, starts: number[], re: RegExp, make: (m: RegExpExecArray) => LintFinding | null, out: LintFinding[]): void {
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const finding = make(m);
    if (finding) out.push({ ...finding, line: lineAt(starts, m.index) });
  }
}

/**
 * Every construct in the page that the exporter is known to lose, shift, or
 * approximate. Empty for a page that converts as it looks.
 */
export function lintDeckSource(html: string): LintFinding[] {
  const source = withoutComments(html);
  const starts = lineStarts(source);
  const out: LintFinding[] = [];
  const blocks = styleBlocks(source);
  const fragments = [...blocks, ...inlineStyles(source)];
  const hasKeyframes = blocks.some((b) => /@keyframes\b/i.test(b.css));

  // --- Rule blocks: what a selector does to the elements it matches ---------
  for (const block of blocks) {
    for (const rule of rulesOf(block)) {
      const sel = rule.selector;
      if (/::?(before|after)\b/i.test(sel)) {
        const content = declaration(rule.body, "content");
        if (content && !/^none$/i.test(content.value.replace(/!important/i, "").trim())) {
          out.push({
            rule: "P1", level: "lost", line: lineAt(starts, rule.start),
            what: `\`${sel}\` draws pseudo-element content — a pseudo-element has no box the exporter can measure, so it vanishes`,
            fix: "draw it with a real element (<span class=\"dot\">, <i>) or use native list-style for bullets",
          });
        }
      }
      const opacity = declaration(rule.body, "opacity");
      if (opacity && isZero(opacity.value) && !/^(from|to|\d+%)/.test(sel)) {
        const animated = /\banimation(-name)?\s*:|\btransition(-property)?\s*:/i.test(rule.body);
        if (animated || hasKeyframes) {
          out.push({
            rule: "P2", level: "lost", line: lineAt(starts, rule.start + opacity.at),
            what: `\`${sel}\` starts at opacity 0${animated ? " for an entrance animation" : " while the page has @keyframes"} — the exporter measures the page with scripts and animations off and takes opacity 0 for hidden, so the element is dropped`,
            fix: "remove the entrance animation or start at opacity 1 (animation does not enter a .pptx anyway)",
          });
        }
      }
    }
  }

  // --- Declarations, wherever they appear ---------------------------------
  for (const frag of fragments) {
    const css = frag.css;
    const at = (offset: number) => lineAt(starts, frag.start + offset);
    const each = (re: RegExp, make: (m: RegExpExecArray) => LintFinding | null) => {
      let m: RegExpExecArray | null;
      while ((m = re.exec(css))) {
        const f = make(m);
        if (f) out.push({ ...f, line: at(m.index) });
      }
    };

    each(/(?:^|[;\s{])font-family\s*:\s*([^;}]*)/gi, (m) => {
      const family = firstFamily(m[1]);
      if (!family || SYSTEM_FAMILIES.has(family.toLowerCase())) return null;
      return {
        rule: "P4", level: "shifted", line: 0,
        what: `font "${family}" is not a system font — a font cannot travel into a .pptx; PowerPoint substitutes one and the text reflows, so line counts and overflow change`,
        fix: FONT_ADVICE,
      };
    });
    each(/(?:^|[;\s{])transform\s*:\s*([^;}]*)/gi, (m) => {
      const v = m[1];
      const composite = /\b(skew|matrix)/i.test(v) || (/\brotate/i.test(v) && /\b(translate|scale)/i.test(v));
      if (!composite) return null;
      return {
        rule: "P5", level: "shifted", line: 0,
        what: `\`transform: ${v.trim()}\` — only a pure rotate() carries across; anything else is exported as its axis-aligned bounding box with the angle lost`,
        fix: "use rotate() alone and position with left/top instead of translate",
      };
    });
    each(/(?:^|[;\s{])writing-mode\s*:\s*(vertical-[a-z]+|sideways-[a-z]+)/gi, (m) => ({
      rule: "P6", level: "shifted", line: 0,
      what: `\`writing-mode: ${m[1]}\` — the box is measured right but the text is written horizontally inside it`,
      fix: "write it horizontally and rotate the element with transform: rotate(90deg)",
    }));
    each(/(?:^|[;\s{])text-shadow\s*:(?!\s*none\b)[^;}]+/gi, () => ({
      rule: "P7", level: "approximated", line: 0,
      what: "`text-shadow` is dropped",
      fix: "drop it, or use weight and contrast instead",
    }));
    each(/(?:^|[;\s{])(backdrop-filter|filter)\s*:(?!\s*none\b)[^;}]+/gi, (m) => ({
      rule: "P8", level: "approximated", line: 0,
      what: `\`${m[1]}\` is dropped${m[1] === "backdrop-filter" ? " — a frosted-glass card becomes a flat translucent one" : ""}`,
      fix: "a translucent background-color with a 1px border exports faithfully; use that for the glass look",
    }));
    each(/(?:^|[;\s{])mix-blend-mode\s*:(?!\s*normal\b)[^;}]+/gi, () => ({
      rule: "P8", level: "approximated", line: 0,
      what: "`mix-blend-mode` is dropped; the element is painted opaque over what is under it",
      fix: "pick the blended colour yourself and use it as a plain background",
    }));
    each(/(?:^|[;\s{])background(?:-image)?\s*:\s*([^;}]*)/gi, (m) => {
      const v = m[1];
      const kind = /radial-gradient\(/i.test(v) ? "a radial-gradient"
        : /conic-gradient\(/i.test(v) ? "a conic-gradient"
        : /repeating-[a-z]+-gradient\(/i.test(v) ? "a repeating gradient"
        : (v.match(/\b(?:linear-gradient|url)\(/gi)?.length ?? 0) > 1 ? "layered backgrounds"
        : /\burl\(/i.test(v) ? "a background-image: url(...)"
        : null;
      if (!kind) return null;
      return {
        rule: "P9", level: "approximated", line: 0,
        what: `${kind} becomes one average solid colour (only a plain linear-gradient is rendered faithfully)`,
        fix: "use a single linear-gradient, or put the picture in an <img>",
      };
    });
  }

  // --- Markup ---------------------------------------------------------------
  tagLine(source, starts, /@font-face\b|<link\b[^>]*fonts\.(?:googleapis|gstatic)\.com[^>]*>|@import\s+(?:url\()?["']?https?:\/\/fonts\./gi, () => ({
    rule: "P4", level: "shifted", line: 0,
    what: "the page loads a web font — it cannot travel into a .pptx; PowerPoint substitutes one and the text reflows",
    fix: FONT_ADVICE,
  }), out);
  tagLine(source, starts, /<(video|iframe|audio)\b/gi, (m) => ({
    rule: "P3", level: "lost", line: 0,
    what: `<${m[1].toLowerCase()}> is dropped`,
    fix: "replace it with a still frame in an <img>",
  }), out);
  tagLine(source, starts, /<svg\b[\s\S]*?<\/svg\s*>/gi, (m) => {
    if (!/<text\b/i.test(m[0])) return null;
    return {
      rule: "P10", level: "approximated", line: 0,
      what: "<text> inside <svg> becomes part of a picture — not editable in PowerPoint",
      fix: "keep the drawing in the SVG and put the words in HTML beside it",
    };
  }, out);

  // One finding per distinct (rule, what): a font declared eight times is one
  // font. The first occurrence keeps its line.
  const seen = new Set<string>();
  const unique = out.filter((f) => {
    const key = `${f.rule}|${f.what}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.line - b.line);
}

const LEVEL_WORD: Record<LintLevel, string> = {
  lost: "LOST",
  shifted: "SHIFTED",
  approximated: "APPROXIMATED",
};

/**
 * The findings as the model reads them, or "" for none — a clean page costs
 * not one character (`formatDeckReport`'s rule). Checked in the source, so it
 * is said to be, and stated beside the measured report, never instead of it.
 */
export function formatLintFindings(findings: readonly LintFinding[]): string {
  if (findings.length === 0) return "";
  const lines = [
    "Found in the SOURCE (not measured) — these will not carry across to .pptx as written:",
  ];
  for (const f of findings.slice(0, MAX_LISTED)) {
    lines.push(`- ${LEVEL_WORD[f.level]} line ${f.line}: ${f.what}. Fix: ${f.fix}.`);
  }
  const rest = findings.length - MAX_LISTED;
  if (rest > 0) lines.push(`- and ${rest} more.`);
  return lines.join("\n");
}
