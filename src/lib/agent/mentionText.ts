/**
 * Splitting a sent message's text around its `@[名称]` references.
 *
 * The composer splices a picked mention into the draft as the literal text
 * `@[label]` (components/common/MentionPicker `accept`), and the wire side
 * resolves those against the attached refs (chatRefs). This is the third
 * reader: the transcript, which renders the reference in the accent color so a
 * sent bubble shows *what was cited* the way the chips above the input did.
 *
 * Mention segments keep the literal `@[名称]` text — the design highlights the
 * whole token, brackets included, and reproducing the exact sent text is what
 * makes the bubble trustworthy as a record.
 */

export interface MentionSegment {
  kind: "text" | "mention";
  text: string;
}

/**
 * The same shape the picker splices in: `@[` + a label without brackets or
 * newlines + `]`. An unclosed `@[`, an empty `@[]`, or brackets in the label
 * never match — they were not produced by `accept` and stay plain text.
 */
const MENTION_RE = /@\[([^\][\n]+)\]/g;

/** Split `text` into plain and mention segments, in order. Never drops a char. */
export function splitMentions(text: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    const at = m.index ?? 0;
    if (at > last) segments.push({ kind: "text", text: text.slice(last, at) });
    segments.push({ kind: "mention", text: m[0] });
    last = at + m[0].length;
  }
  if (last < text.length || segments.length === 0) {
    segments.push({ kind: "text", text: text.slice(last) });
  }
  return segments;
}
