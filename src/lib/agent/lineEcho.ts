/**
 * Line numbers on their way to the model, and the "here is what it looks like
 * now" a write hands back.
 *
 * Both halves of one contract (docs/feature/agent/edit-loop-plan.md §4):
 *
 *   - every `read_file` result carries line numbers, so a region can be
 *     *named* rather than quoted;
 *   - every applied write hands back the region it produced, numbered, plus
 *     the shift it caused — so naming the next region needs no second read.
 *
 * The second half is the expensive one to get wrong. Before it existed,
 * `rewrite_lines` ended with "re-read around the region before naming another
 * range", which made every region edit three round trips (read → write →
 * read) where a coding agent's is one. A round costs the whole tool schema
 * again — some 15k tokens on the assistant preset — so echoing a few dozen
 * numbered lines to avoid one is not close.
 *
 * Everything here is pure: it takes the file's text after the write and says
 * what to print. Nothing in it touches disk.
 */

/**
 * Width the line-number gutter is padded to, then a tab.
 *
 * `cat -n`'s shape, deliberately: it is the one numbering convention every
 * model has seen a great deal of, which is what makes "the number is not part
 * of the line" legible without a rule having to say so.
 */
const GUTTER = 6;

/** Lines of unchanged context shown either side of an applied region. */
const CONTEXT_LINES = 2;

/**
 * Longest region echoed in full.
 *
 * Past this only the region's ends are shown. A 400-line echo would spend the
 * round this exists to save.
 */
export const ECHO_MAX_LINES = 40;

/** Lines shown at each end of a region too long to echo whole. */
const EDGE_LINES = 3;

/**
 * Prefix each line with its 1-based number, starting at `from`.
 *
 * Uniform rather than conditional on purpose: "read_file output has line
 * numbers" is a fact the model can rely on, where "long reads have line
 * numbers" is a judgement it has to make first.
 */
export function numberLines(text: string, from: number): string {
  return text
    .split("\n")
    .map((line, i) => `${String(from + i).padStart(GUTTER)}\t${line}`)
    .join("\n");
}


/** 1-based line number of a character offset in `text`. */
export function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/**
 * The region `from`-`to` of the file **as it now stands**, numbered, with a
 * couple of lines of context around it.
 *
 * `content` must be the post-write text: the point of the echo is to show what
 * landed, and showing what was *sent* would hide exactly the case worth
 * catching — a write that did not land the way the model expected.
 */
export function echoRegion(content: string, from: number, to: number): string {
  const lines = content.split("\n");
  const top = Math.max(1, from - CONTEXT_LINES);
  const bottom = Math.min(lines.length, to + CONTEXT_LINES);
  const slice = (a: number, b: number) =>
    numberLines(lines.slice(a - 1, b).join("\n"), a);

  if (to - from + 1 <= ECHO_MAX_LINES) return slice(top, bottom);

  const headEnd = Math.min(from + EDGE_LINES - 1, bottom);
  const tailStart = Math.max(to - EDGE_LINES + 1, headEnd + 1);
  const hidden = tailStart - headEnd - 1;
  return [
    slice(top, headEnd),
    `[... ${hidden} line(s) not echoed ...]`,
    slice(tailStart, bottom),
  ].join("\n");
}

/**
 * The sentence that replaces a re-read: where the change now sits, and by how
 * much everything below it moved.
 *
 * The shift has to be exact — it is the arithmetic the model would otherwise
 * do by reading 4000 characters again, and an approximate one is worse than
 * none, because a wrong line range does not fail, it edits the wrong place.
 */
export function shiftNote(newFrom: number, newTo: number, shift: number): string {
  const delta = `${shift > 0 ? "+" : ""}${shift}`;
  if (shift === 0) {
    return `It now occupies lines ${newFrom}-${newTo}; no line number below it moved.`;
  }
  // A deletion leaves no region at all: `newTo` lands below `newFrom`, and
  // saying "lines 4-3" would be worse than saying what happened.
  if (newTo < newFrom) {
    return (
      `Those lines are gone (${delta}), so what followed them is now line ${newFrom} ` +
      `and every line after it has moved by ${delta} — no need to re-read to name the next range.`
    );
  }
  return (
    `It now occupies lines ${newFrom}-${newTo} ` +
    `(${delta} line(s), so every line after ${newTo} has moved by ${delta} — ` +
    "no need to re-read to name the next range)."
  );
}
