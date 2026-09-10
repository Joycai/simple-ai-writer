/**
 * Tokenising for the inline (within-a-line) diff.
 *
 * This is the part a general-purpose diff library cannot do for us. The usual
 * word diff splits on whitespace, which for Chinese produces **one token per
 * paragraph**: 「她把灯笼举高了些，金发在风里散开。」 and its 银发 version share
 * no whitespace-delimited token, so the diff degrades to "the whole sentence
 * was replaced" — precisely the answer the author already gets today and the
 * reason this feature exists. A character diff has the opposite failure: on
 * English it marks `configuration` → `configurations` as one added letter
 * floating inside a word, which reads as noise.
 *
 * So the split is per script, in one pass:
 *
 *   - **CJK** (Han / Kana / Hangul) — one token per character. That *is* the
 *     word boundary for display purposes: a reader scanning 「金→银」 wants the
 *     one character marked, not the clause.
 *   - **Latin words and numbers** — one token per run, so a word changes as a
 *     word.
 *   - **Whitespace** — one token per run, so re-indenting or re-wrapping is a
 *     small number of token changes rather than one per space. This is also
 *     what lets a caller ask "was this change whitespace only?".
 *   - **Everything else** (punctuation, symbols, emoji) — one token per code
 *     point, since a comma turning into a full stop is its own change.
 *
 * Code points, not UTF-16 units: Han extension B and emoji are surrogate pairs,
 * and splitting one in half produces text that cannot be rendered.
 */

/** Scripts whose characters each stand alone as a token. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** What may sit inside a Latin "word" run. */
const WORDISH = /[\p{Letter}\p{Number}_]/u;
const SPACE = /\s/u;

/**
 * Split `text` into diff tokens. The concatenation of the result is always
 * exactly `text` — nothing is normalised away, because a diff that silently
 * drops a character cannot be trusted to say what changed.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const chars = Array.from(text);
  let i = 0;

  while (i < chars.length) {
    const ch = chars[i];

    if (SPACE.test(ch)) {
      let j = i + 1;
      while (j < chars.length && SPACE.test(chars[j])) j++;
      out.push(chars.slice(i, j).join(""));
      i = j;
      continue;
    }

    if (CJK.test(ch)) {
      out.push(ch);
      i++;
      continue;
    }

    if (WORDISH.test(ch)) {
      let j = i + 1;
      while (j < chars.length && WORDISH.test(chars[j]) && !CJK.test(chars[j])) j++;
      out.push(chars.slice(i, j).join(""));
      i = j;
      continue;
    }

    out.push(ch);
    i++;
  }

  return out;
}

