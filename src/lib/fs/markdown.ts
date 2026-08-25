import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import katex from "katex";
import katexImport from "@vscode/markdown-it-katex";
// KaTeX emits `<span class="katex">` markup that is meaningless without this
// stylesheet: it is what visually hides the `.katex-mathml` accessibility copy
// (so the formula doesn't render twice) and supplies the fraction rules, radical
// bars and font metrics. Bundled rather than linked from a CDN — the KaTeX woff2
// faces become local assets, matching the self-hosted font strategy in
// styles/fonts.ts, so math renders correctly with no network.
import "katex/dist/katex.min.css";

/**
 * @vscode/markdown-it-katex ships as a UMD bundle that sets `exports.default`.
 * esbuild can't see through the UMD wrapper when Vite pre-bundles it for dev,
 * so there the default import arrives as `{ default: fn, __esModule: true }`,
 * while the Rolldown production build and Vitest's SSR interop hand back the
 * function itself. Unwrap once here so every path agrees — calling `md.use()`
 * with the wrapper object throws "plugin.apply is not a function", and that
 * would only ever show up at runtime in `tauri dev`, never in a type-check.
 */
const katexPlugin =
  typeof katexImport === "function"
    ? katexImport
    : (katexImport as { default: typeof katexImport }).default;

// The `{ katex }` option hands the plugin our own KaTeX instance instead of
// letting it `require("katex")` itself. The plugin is CommonJS, so that require
// resolves KaTeX's UMD dist — a second, separately-bundled copy whose symbol
// tables don't survive being re-bundled, leaving every command (\frac, \alpha,
// \sum …) failing with "Undefined control sequence" while bare `x^2` still
// rendered. Injecting the ESM build we already import above fixes the rendering
// and drops the duplicate KaTeX from the bundle.
const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
}).use(katexPlugin, { katex });

// ── Lore citations ────────────────────────────────────────────────────────────
// `[[lore:目标]]` / `[[lore:目标|显示文字]]` → a clickable .lore-cite span.
// Rendering is index-free (this module stays pure): the span carries the raw
// target in CITE_ATTR; resolution, missing-marking and click navigation live
// in lib/lore/citations and the surfaces that have a project.
import { CITE_ATTR, parseCiteBody } from "../lore/citations";

const CITE_OPEN = "[[lore:";

md.inline.ruler.before("link", "lore_cite", (state, silent) => {
  const { src, pos } = state;
  if (!src.startsWith(CITE_OPEN, pos)) return false;
  const close = src.indexOf("]]", pos + CITE_OPEN.length);
  if (close < 0) return false;
  const body = src.slice(pos + CITE_OPEN.length, close);
  // A citation is one inline reference; a newline means an unclosed opener.
  if (body.includes("\n")) return false;
  const parsed = parseCiteBody(body);
  if (!parsed) return false;
  if (!silent) {
    const token = state.push("lore_cite", "", 0);
    token.meta = parsed;
  }
  state.pos = close + 2;
  return true;
});

md.renderer.rules.lore_cite = (tokens, idx) => {
  const { target, label } = tokens[idx].meta as { target: string; label: string };
  const esc = md.utils.escapeHtml;
  return `<span class="lore-cite" ${CITE_ATTR}="${esc(target)}" role="link" tabindex="0">${esc(label)}</span>`;
};

export function renderMarkdown(source: string): string {
  return md.render(source);
}

/**
 * The same configured parser's token stream, for consumers that map markdown
 * onto something other than HTML (today: `lib/docx`).
 *
 * Deliberately this instance rather than a second `MarkdownIt`: the app has
 * exactly one markdown dialect — `[[lore:…]]` citations, KaTeX, typographer —
 * and a private copy would drift from what the preview shows on the first
 * plugin change. Tokens are also what makes that layer testable at all, since
 * vitest runs on `environment: "node"` with no DOM to walk.
 */
export function parseMarkdown(source: string): Token[] {
  return md.parse(source, {});
}

export interface HeadingNode {
  level: number;
  text: string;
  id: string;
  line: number;
}

export function extractHeadings(source: string): HeadingNode[] {
  const headings: HeadingNode[] = [];
  const lines = source.split("\n");
  let inFence = false;

  lines.forEach((line, idx) => {
    if (line.startsWith("```")) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      const level = match[1].length;
      const text = match[2].trim();
      const id = `heading-${idx}`;
      headings.push({ level, text, id, line: idx });
    }
  });

  return headings;
}

export function parseFrontmatter(source: string): { data: Record<string, unknown>; content: string } {
  if (!source.startsWith("---")) {
    return { data: {}, content: source };
  }
  const end = source.indexOf("\n---", 4);
  if (end === -1) return { data: {}, content: source };

  const yamlStr = source.slice(4, end);
  const content = source.slice(end + 4).trimStart();

  try {
    // Simple YAML parser for common frontmatter keys.
    // Supports inline arrays (`aliases: [a, b]`), block lists
    // (`aliases:` followed by `  - item` lines), and quoted scalars.
    const data: Record<string, unknown> = {};
    const lines = yamlStr.split("\n");
    let blockKey: string | null = null; // key currently accumulating a block list

    for (const line of lines) {
      // Block list continuation: `  - value`
      const listMatch = line.match(/^\s*-\s+(.*)$/);
      if (blockKey && listMatch) {
        (data[blockKey] as unknown[]).push(unquote(listMatch[1].trim()));
        continue;
      }

      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();

      if (val === "") {
        // Possibly the start of a block list — seed an array; if no list items
        // follow it stays empty, which round-trips fine for empty values.
        data[key] = [];
        blockKey = key;
        continue;
      }

      blockKey = null;
      if (val.startsWith("[")) {
        // Strict JSON first — the app's own serializers emit valid JSON, and
        // the naive quote rewrite would corrupt items containing apostrophes
        // (e.g. ["a, b", "Zoe's"]). Only fall back to the single-quote rewrite
        // for hand-written 'single quoted' lists, then to the raw string.
        try {
          data[key] = parseInlineList(val);
        } catch {
          try {
            data[key] = parseInlineList(val.replace(/'/g, '"'));
          } catch {
            data[key] = val;
          }
        }
      } else {
        data[key] = unquote(val);
      }
    }
    return { data, content };
  } catch {
    return { data: {}, content: source };
  }
}

/** JSON-parse an inline list; strings already carry their quotes in JSON. */
function parseInlineList(val: string): unknown[] {
  const parsed = JSON.parse(val) as unknown[];
  if (!Array.isArray(parsed)) throw new Error("not a list");
  return parsed;
}

/**
 * Undo entity.ts's yamlQuote escaping (backslash, quote, newline) in one
 * left-to-right pass. Three chained global replaces — unescape newline, then
 * quote, then backslash — looks like the obvious mirror of yamlQuote's three
 * escaping passes, but it isn't: it re-scans its own prior output, so an
 * escaped backslash sitting right before a literal "n" (e.g. the source text
 * `C:\new`, escaped to `\\new`) gets misread as a `\n` newline escape,
 * splitting "new" into a stray newline plus "ew". Track position explicitly
 * instead, so each escape sequence is decoded exactly once from the input.
 */
function unescapeDoubleQuoted(inner: string): string {
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (next === "\\" || next === '"') { out += next; i++; continue; }
      if (next === "n") { out += "\n"; i++; continue; }
    }
    out += inner[i];
  }
  return out;
}

/** Strip a single layer of matching surrounding quotes and unescape inner quotes. */
function unquote(s: string): string {
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return unescapeDoubleQuoted(s.slice(1, -1));
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1).replace(/\\"/g, '"');
  }
  return s;
}

export function countWords(text: string): number {
  // Count CJK characters as individual words, split Latin on whitespace
  const cjk = (text.match(/[一-鿿぀-ゟ゠-ヿ]/g) || []).length;
  const latin = (text.replace(/[一-鿿぀-ゟ゠-ヿ]/g, "").match(/\S+/g) || []).length;
  return cjk + latin;
}
