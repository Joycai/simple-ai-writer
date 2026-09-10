/**
 * Which section of a document a line is in.
 *
 * A line number says where in the file; a heading says where in the *book*, and
 * that is the coordinate an author actually navigates by — which is why every
 * card's locator carries one when the file has any.
 *
 * Fences are tracked because a `# comment` inside a code block is not a
 * section, and a locator that names one is worse than a locator that names
 * nothing: the author would go looking for it.
 */

export interface Heading {
  /** 1-based line the heading sits on. */
  line: number;
  /** The heading's text, without its `#`s. */
  title: string;
}

/** Every heading in the file, in document order. */
export function headingsOf(text: string, maxLines = Number.MAX_SAFE_INTEGER): Heading[] {
  const out: Heading[] = [];
  const lines = text.split("\n");
  let inFence = false;
  for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
    const line = lines[i].replace(/\r$/, "");
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) out.push({ line: i + 1, title: heading[2].trim() });
  }
  return out;
}

/** The last heading at or above `line`. */
export function sectionAt(headings: readonly Heading[], line: number): string | undefined {
  let found: string | undefined;
  for (const heading of headings) {
    if (heading.line > line) break;
    found = heading.title;
  }
  return found;
}
