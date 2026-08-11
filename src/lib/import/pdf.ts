/**
 * PDF → Markdown via pdfjs-dist text extraction.
 *
 * pdfjs is the one extractor with dependable CJK support (it is Firefox's PDF
 * engine), which matters because the documents this exists for — tender
 * documents — are mostly Chinese. What it cannot give back is layout: table
 * cells come out as plain lines in reading order, so tables degrade to text.
 * That is a documented limit of the format, not something to fix here.
 *
 * The line/paragraph reconstruction is pure and exported for tests; only
 * `pdfToMarkdown` touches pdfjs, lazily (the library + worker are ~2 MB).
 */

/**
 * The slice of a pdfjs text-content chunk this module consumes. Declared here
 * rather than imported: pdfjs does not re-export `TextContent` from its package
 * root, and the reconstruction only ever touches `items`.
 */
interface TextContentChunk {
  items: ReadonlyArray<
    { str: string; transform: number[]; hasEOL: boolean } | { type: string }
  >;
}

/** The slice of a pdfjs TextItem the reconstruction needs. */
export interface PdfTextItem {
  str: string;
  /** Baseline x/y from `transform[4]`/`transform[5]` (PDF user space, y-up). */
  x: number;
  y: number;
  hasEOL: boolean;
}

interface Line {
  y: number;
  text: string;
}

/**
 * Fold raw text items into visual lines. pdfjs emits items in content order
 * (reading order in practice) with `hasEOL` marking most line ends; the
 * y-jump check catches the rest (multi-column headers, items emitted out of
 * band), using a small tolerance so sub/superscripts don't split a line.
 *
 * Items on one line are concatenated without inserting spaces: pdfjs already
 * includes Latin spacing in `str`, and injected spaces would corrupt CJK text
 * — the main audience here.
 */
export function itemsToLines(items: PdfTextItem[]): Line[] {
  const lines: Line[] = [];
  let cur: Line | null = null;
  for (const item of items) {
    if (cur && Math.abs(item.y - cur.y) > 2) {
      if (cur.text.trim()) lines.push(cur);
      cur = null;
    }
    if (!cur) cur = { y: item.y, text: "" };
    cur.text += item.str;
    if (item.hasEOL) {
      if (cur.text.trim()) lines.push(cur);
      cur = null;
    }
  }
  if (cur && cur.text.trim()) lines.push(cur);
  return lines;
}

/**
 * Group lines into paragraphs by vertical gap: a gap clearly larger than the
 * page's own typical line spacing starts a new paragraph. The threshold is
 * relative (1.6× the median gap) because absolute spacing varies per document
 * and per font size.
 *
 * Within a paragraph, lines are joined with single newlines — markdown treats
 * those as soft breaks, which keeps numbered tender clauses on their own
 * editor lines without welding them into one visual paragraph.
 */
export function linesToMarkdown(lines: Line[]): string {
  if (lines.length === 0) return "";
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1].y - lines[i].y; // y-up: next line is lower
    if (gap > 0) gaps.push(gap);
  }
  // Lower median: with few gaps (short pages) the upper median can *be* the
  // one paragraph gap, which would then never exceed its own threshold.
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;

  const parts: string[] = [lines[0].text.trimEnd()];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1].y - lines[i].y;
    const paragraphBreak = median > 0 && gap > median * 1.6;
    parts.push(paragraphBreak ? "\n\n" : "\n", lines[i].text.trimEnd());
  }
  return parts.join("");
}

export async function pdfToMarkdown(data: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

  // pdfjs transfers the buffer to its worker, so it gets its own copy.
  const task = pdfjs.getDocument({ data: data.slice() });
  const doc = await task.promise;
  try {
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const items: PdfTextItem[] = [];
      // Drained through an explicit reader, not pdfjs's own `getTextContent()`.
      // That convenience wrapper is written as `for await (… of stream)`, and
      // WKWebView — the engine behind every macOS/iOS Tauri build — still ships
      // no `ReadableStream[Symbol.asyncIterator]`, so it throws "undefined is
      // not a function" before a single page is read. `streamTextContent` is
      // the same public API one layer down, and a reader loop works everywhere.
      const reader = (
        page.streamTextContent() as ReadableStream<TextContentChunk>
      ).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const raw of value.items) {
          if (!("str" in raw)) continue; // TextMarkedContent — no text payload
          items.push({
            str: raw.str,
            x: raw.transform[4],
            y: raw.transform[5],
            hasEOL: raw.hasEOL,
          });
        }
      }
      const text = linesToMarkdown(itemsToLines(items));
      // Page markers as HTML comments: invisible in the preview, but they give
      // 应答依据 a page number to cite and survive into the RAG context.
      pages.push(`<!-- page ${i} -->\n\n${text}`);
    }
    return pages.join("\n\n").trim();
  } finally {
    await task.destroy();
  }
}
