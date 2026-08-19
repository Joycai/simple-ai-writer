/**
 * Where an approved find/replace actually lands — the pure half of `applyEdit`.
 *
 * `propose_edit` used to require `find` to be unique in the file, and both ends
 * enforced it: the tool refused to propose an ambiguous edit, and the apply
 * step refused to write one. That rule is right for prose, where a snippet is
 * naturally unique, and wrong for everything structured. A deck's HTML is N
 * near-identical `<section class="slide">` blocks; a table has the same cell
 * text in a dozen rows. There the model could not target the third one at all,
 * and the only fallback was `rewrite_document` — re-emitting the whole file to
 * change one line, which on a long file does not fit in a single reply.
 *
 * So the edit carries a *target*: the single occurrence (as before), the Nth,
 * or all of them. The safety property that made the old uniqueness rule worth
 * having is kept by a different means — the proposal records how many times
 * `find` occurred when the author saw the card, and applying re-counts. If the
 * author kept typing while the card sat there and the count moved, the write
 * is refused rather than landing somewhere they never approved.
 */

/** Which occurrence(s) of `find` an approved edit replaces. */
export type EditTarget = number | "all" | undefined;

/**
 * Offsets of every occurrence, scanning left to right and skipping past each
 * match. Overlapping matches are therefore not counted twice — `"aa"` occurs
 * twice in `"aaaa"`, not three times — which is the count the card showed and
 * the count the model was told.
 */
export function findOccurrences(text: string, find: string): number[] {
  if (!find) return [];
  const out: number[] = [];
  for (let i = text.indexOf(find); i !== -1; i = text.indexOf(find, i + find.length)) out.push(i);
  return out;
}

/**
 * Apply an approved edit to the text as it stands *now*.
 *
 * Throws when the document has moved on, with the message the author sees —
 * refusing is always better than writing at a position they did not approve.
 */
export function applyFindReplace(
  text: string,
  find: string,
  replace: string,
  /** How many occurrences existed when the proposal was built. */
  occurrences: number,
  target: EditTarget,
): string {
  const positions = findOccurrences(text, find);
  if (positions.length === 0) {
    throw new Error("Document changed — the target text no longer matches.");
  }
  if (positions.length !== occurrences) {
    // The single-match case keeps its original wording: it is by far the most
    // common, and "too ambiguous" is what the author has been reading.
    throw new Error(
      occurrences === 1
        ? "The target text appears more than once in the document — too ambiguous to apply automatically."
        : `Document changed — the target text now appears ${positions.length} times, not the ${occurrences} shown on the card.`,
    );
  }

  const hits =
    target === "all"
      ? positions
      : [positions[(typeof target === "number" ? target : 1) - 1]];
  if (hits.some((h) => h === undefined)) {
    throw new Error("Document changed — that occurrence no longer exists.");
  }

  // Splice from the end so the earlier offsets stay valid as the text shifts.
  let out = text;
  for (const at of [...hits].reverse()) {
    out = out.slice(0, at) + replace + out.slice(at + find.length);
  }
  return out;
}

/** One line for the log/result text: which of how many this edit touched. */
export function describeEditTarget(occurrences: number, target: EditTarget): string {
  if (occurrences <= 1) return "";
  if (target === "all") return `all ${occurrences} occurrences`;
  return `occurrence ${typeof target === "number" ? target : 1} of ${occurrences}`;
}
