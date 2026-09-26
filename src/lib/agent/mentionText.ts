/**
 * The `@[名称]` reference token — its one definition, for both ends.
 *
 * Writers: the composer splices a picked mention into the draft
 * (components/common/MentionPicker `spliceMention`) and the file tree's
 * 发送到助手 appends one; both build it with {@link mentionToken}. Readers: the
 * transcript renders it in the accent color so a sent bubble shows *what was
 * cited* the way the chips above the input did ({@link splitMentions}), and the
 * lore generator drops it from the author's description ({@link stripMentions}).
 * The attachment itself travels as a ref picked at selection time — nothing
 * resolves the token back into an entity or file at send time.
 *
 * Mention segments keep the literal `@[名称]` text — the design highlights the
 * whole token, brackets included, and reproducing the exact sent text is what
 * makes the bubble trustworthy as a record.
 */

interface MentionSegment {
  kind: "text" | "mention";
  text: string;
}

/**
 * The token for `label`: `@[` + the label + `]`, where brackets inside the
 * label must pair up — that is what lets a reader find the closing `]`.
 * Paired ones stay as they are (`潮汐[旧]` → `@[潮汐[旧]]`, the common case,
 * and the name reads back unchanged); a lone one becomes its full-width twin
 * (`夜航]` → `@[夜航］]`), which costs one glyph of the name and is the only
 * way it can be read back at all. A backslash escape was the other option,
 * and it would show in the draft and reach the model on every paired name
 * too, which never needed it.
 */
export function mentionToken(label: string): string {
  const chars = [...label];
  const open: number[] = [];
  const lone = new Set<number>();
  chars.forEach((c, i) => {
    if (c === "[") open.push(i);
    else if (c === "]") {
      if (open.length > 0) open.pop();
      else lone.add(i);
    }
  });
  for (const i of open) lone.add(i);
  const body = chars.map((c, i) => (lone.has(i) ? (c === "[" ? "［" : "］") : c)).join("");
  return `@[${body}]`;
}

/**
 * Every token in `text`, as `[start, end)` spans in order. From each `@[` the
 * brackets are counted — `[` opens, `]` closes — and the token ends where the
 * count returns to zero. A newline before that, an end of text before that,
 * or an empty `@[]` is not a token: none of them is something
 * {@link mentionToken} produces, so they stay the author's typed text.
 */
function mentionSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf("@[", from);
    if (at === -1) return spans;
    let depth = 1;
    let i = at + 2;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === "\n") break;
      if (c === "[") depth++;
      else if (c === "]" && --depth === 0) break;
    }
    if (depth === 0 && i > at + 2) {
      spans.push([at, i + 1]);
      from = i + 1;
    } else {
      from = at + 1;
    }
  }
}

/** Split `text` into plain and mention segments, in order. Never drops a char. */
export function splitMentions(text: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let last = 0;
  for (const [start, end] of mentionSpans(text)) {
    if (start > last) segments.push({ kind: "text", text: text.slice(last, start) });
    segments.push({ kind: "mention", text: text.slice(start, end) });
    last = end;
  }
  if (last < text.length || segments.length === 0) {
    segments.push({ kind: "text", text: text.slice(last) });
  }
  return segments;
}

/** `text` with every token removed — the prose around them, as typed. */
export function stripMentions(text: string): string {
  return splitMentions(text)
    .filter((s) => s.kind === "text")
    .map((s) => s.text)
    .join("");
}
