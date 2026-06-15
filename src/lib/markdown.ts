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
    // Simple YAML parser for common frontmatter keys
    const data: Record<string, unknown> = {};
    yamlStr.split("\n").forEach((line) => {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) return;
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();
      if (val.startsWith("[")) {
        try {
          data[key] = JSON.parse(val.replace(/'/g, '"'));
        } catch {
          data[key] = val;
        }
      } else {
        data[key] = val;
      }
    });
    return { data, content };
  } catch {
    return { data: {}, content: source };
  }
}

export function countWords(text: string): number {
  // Count CJK characters as individual words, split Latin on whitespace
  const cjk = (text.match(/[一-鿿぀-ゟ゠-ヿ]/g) || []).length;
  const latin = (text.replace(/[一-鿿぀-ゟ゠-ヿ]/g, "").match(/\S+/g) || []).length;
  return cjk + latin;
}
