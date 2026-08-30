/**
 * Paragraph tidying — the mechanical half of "give this document some shape".
 *
 * ## Why this is not an agent tool
 *
 * "Add headings and separate the paragraphs" is two jobs wearing one sentence.
 * Deciding where a section begins and what to call it needs to have read the
 * thing; putting a blank line between two paragraphs that ran together needs
 * nothing but the text, and running it through a model means paying for the
 * document twice and letting it be paraphrased on the way past. So the
 * judgement half is `insert_lines` and the mechanical half is this: a pure
 * function the author runs from the editor, costing no tokens and no round.
 *
 * ## The one rule that governs every decision here
 *
 * A wrong transformation is silent, and the author is the last person who would
 * catch it — they asked for tidying precisely because they were not reading
 * closely. So **when the text does not clearly say what it is, nothing
 * happens.** The same doctrine `lib/xlsx/cells` runs on: mis-typing a number is
 * invisible, leaving it as text is obvious, so guess toward doing nothing.
 *
 * The place that bites is inserting blank lines. Hard-wrapped prose —
 * a paragraph broken across several source lines, which is how most English
 * markdown in the wild is written — must not become one paragraph per line. The
 * discriminator is sentence-final punctuation: a hard wrap breaks mid-sentence,
 * so a line ending in 。！？. ! ? (or a closing quote after one) ended a
 * sentence deliberately, and a line that does not is left alone. That is
 * conservative in exactly the safe direction — a missed blank line is visible
 * in the preview and fixable by hand; a paragraph shredded into twelve is not
 * something anyone reconstructs.
 *
 * Everything structural is left untouched outright: frontmatter, fenced code,
 * tables, lists, quotes, headings. A list whose items are packed tight is a
 * *tight list* in markdown and renders differently from a loose one, so
 * "helpfully" spacing it out would change the output.
 */

/** Sentence-final punctuation, optionally followed by a closing quote/bracket. */
const SENTENCE_END = /[。．.！!？?…‥;；][」』"'）)\]】》”’]*$/;

/**
 * A line that belongs to markdown structure rather than to prose: heading,
 * list item, quote, table row, horizontal rule, fence, or an indented block.
 *
 * Nothing is inserted next to one of these. Each has its own spacing semantics
 * (a tight list, a multi-line table, a continued quote) and the cost of being
 * wrong about them is a rendering change the author never asked for.
 */
function isStructural(line: string): boolean {
  const t = line.trimStart();
  if (t === "") return false;
  // An indented line is a continuation or a code block — either way, not
  // something to split.
  if (/^ {4}|^\t/.test(line)) return true;
  return (
    /^#{1,6}\s/.test(t) || // heading
    /^([-*+])\s/.test(t) || // bullet
    /^\d+[.)]\s/.test(t) || // ordered item
    /^>/.test(t) || // quote
    /^\|/.test(t) || // table row
    /^(-{3,}|\*{3,}|_{3,})\s*$/.test(t) || // horizontal rule
    /^(```|~~~)/.test(t) || // fence
    /^:{3,}/.test(t) // container/directive
  );
}

/** Frontmatter's line span: 0 when the document has none. */
function frontmatterLines(lines: readonly string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return i + 1;
  }
  return 0; // unterminated — treat it as prose rather than swallowing the file
}

export interface NormalizeResult {
  text: string;
  /** Blank lines inserted between run-together paragraphs. */
  separated: number;
  /** Runs of two or more blank lines collapsed to one. */
  collapsed: number;
  /** Lines that had trailing whitespace removed. */
  trimmed: number;
}

/**
 * Tidy a document's paragraph spacing, reporting what it did.
 *
 * The counts are not decoration: this edits the whole document at once, so the
 * author needs to know whether it changed three things or three hundred before
 * they decide to keep it. A run that reports zero is how they learn the file
 * was already fine, rather than wondering whether the command did anything.
 *
 * Line terminators: the document is split on \r?\n and rejoined with \n, which
 * matches every other whole-document path in the app (`renderMarkdown`, the
 * import pipeline). A CRLF file is normalised to LF by this command, and that
 * is a deliberate, visible-in-the-diff consequence of asking for tidying, not
 * the silent mixed-terminator state that the agent's write tools take care to
 * avoid mid-file.
 */
export function normalizeParagraphs(source: string): NormalizeResult {
  const lines = source.split(/\r?\n/);
  const skip = frontmatterLines(lines);
  const out: string[] = lines.slice(0, skip);
  let separated = 0;
  let collapsed = 0;
  let trimmed = 0;

  let inFence = false;
  let blankRun = 0;

  for (let i = skip; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/[ \t]+$/, "");
    if (line !== raw) trimmed++;

    // Inside a fence nothing is touched at all — not the blank lines, not the
    // trailing spaces (which can be significant in the language being quoted).
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      blankRun = 0;
      continue;
    }
    if (inFence) {
      out.push(raw);
      if (line !== raw) trimmed--; // not counted: nothing was changed here
      continue;
    }

    if (line.trim() === "") {
      blankRun++;
      // Keep the first of a run; every further one is collapsed away.
      if (blankRun === 1) out.push("");
      else if (blankRun === 2) collapsed++;
      continue;
    }

    // A non-blank line directly after another one. Split them only when the
    // previous line visibly ended a sentence and neither side is structural.
    if (blankRun === 0 && out.length > skip) {
      const prev = out[out.length - 1];
      if (
        prev.trim() !== "" &&
        SENTENCE_END.test(prev.trimEnd()) &&
        !isStructural(prev) &&
        !isStructural(line)
      ) {
        out.push("");
        separated++;
      }
    }
    blankRun = 0;
    out.push(line);
  }

  return { text: out.join("\n"), separated, collapsed, trimmed };
}
