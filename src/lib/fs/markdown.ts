import MarkdownIt from "markdown-it";
// @ts-ignore — no types for markdown-it-katex
import mk from "markdown-it-katex";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
}).use(mk);

export function renderMarkdown(source: string): string {
  return md.render(source);
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

/** Strip a single layer of matching surrounding quotes and unescape inner quotes. */
/** JSON-parse an inline list; strings already carry their quotes in JSON. */
function parseInlineList(val: string): unknown[] {
  const parsed = JSON.parse(val) as unknown[];
  if (!Array.isArray(parsed)) throw new Error("not a list");
  return parsed;
}

function unquote(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
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
