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
 *
 * A `[` straight after an `@` counts as lone too (`封面@[2x]` →
 * `@[封面@［2x］]`): readers take an `@[` inside a token as the start of a
 * new one (see {@link closeOf}), so the name must not contain one.
 */
export function mentionToken(label: string): string {
  const chars = [...label];
  const open: number[] = [];
  const lone = new Set<number>();
  chars.forEach((c, i) => {
    if (c === "[") {
      if (chars[i - 1] === "@") lone.add(i);
      else open.push(i);
    } else if (c === "]") {
      if (open.length > 0) open.pop();
      else lone.add(i);
    }
  });
  for (const i of open) lone.add(i);
  const body = chars.map((c, i) => (lone.has(i) ? (c === "[" ? "［" : "］") : c)).join("");
  return `@[${body}]`;
}

/** {@link closeOf}: cut short by a newline, a nested `@[` or a `stop` character. */
const CUT = -1;
/** {@link closeOf}: still open at the end of the text. */
const OPEN = -2;

/**
 * From the `@[` at `at`, count the brackets — `[` opens, `]` closes. Returns
 * the index of the `]` that brings the count back to zero; {@link CUT} when a
 * newline, a `stop` character or another `@[` comes first; {@link OPEN} when
 * the text ends first.
 *
 * A nested `@[` ends the attempt because {@link mentionToken} never writes
 * one inside a name — so it is a new token, and the `@[` before it was typed
 * by the author. Counting through it read `按@[旧稿，参考@[潮汐.md]里的写法]`
 * as one reference, swallowing the real one inside.
 */
function closeOf(text: string, at: number, stop?: (c: string) => boolean): number {
  let depth = 1;
  for (let i = at + 2; i < text.length; i++) {
    const c = text[i];
    if (c === "\n" || stop?.(c)) return CUT;
    if (c === "@" && text[i + 1] === "[") return CUT;
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return i;
  }
  return OPEN;
}

/**
 * Every token in `text`, as `[start, end)` spans in order: from each `@[` to
 * the `]` that closes it ({@link closeOf}). One cut short or left open, or an
 * empty `@[]`, is not a token: none of them is something {@link mentionToken}
 * produces, so they stay the author's typed text.
 */
function mentionSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf("@[", from);
    if (at === -1) return spans;
    const close = closeOf(text, at);
    if (close > at + 2) {
      spans.push([at, close + 1]);
      from = close + 1;
    } else {
      from = at + 1;
    }
  }
}

/**
 * Whether `text` ends inside a token still open: an `@[` whose brackets have
 * not come back to zero by the end, counted the way the readers count them —
 * so a landed `@[手稿[旧]@2x.png]` is still "inside" after its inner `@`, which
 * a pattern that merely stops at the first `]` got wrong. `stop` cuts an open
 * token short (the picker ends it at a CJK terminator; see findMention).
 */
export function endsInsideToken(text: string, stop?: (c: string) => boolean): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf("@[", from);
    if (at === -1) return false;
    const close = closeOf(text, at, stop);
    if (close === OPEN) return true;
    from = close === CUT ? at + 1 : close + 1;
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
