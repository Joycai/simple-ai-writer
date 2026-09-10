/**
 * The sequence half of the diff core: Myers' greedy algorithm, bounded.
 *
 * Everything here works on *indices* — it never sees a line or a character.
 * The callers in `index.ts` intern their strings first, so comparing two lines
 * is an integer compare rather than a string compare, and the same routine
 * serves the line diff and the token diff without knowing which is which.
 *
 * Two deliberate limits, both of which exist because this runs on the UI thread
 * while a card is being drawn:
 *
 *   - **Common prefix and suffix are trimmed before the search.** A one-word
 *     change in a 3000-line chapter is then a search over the handful of lines
 *     that actually differ, which is the case this feature exists for.
 *   - **The edit distance is capped** (`maxDistance`), and the function returns
 *     `null` rather than a partial answer when the cap is hit. Myers is O(ND):
 *     the pathological input is not a big file but a *completely different*
 *     one, where D ≈ N + M. That is also the input where a rendered diff is
 *     unreadable anyway — a card showing 3000 red lines above 3000 green ones
 *     has told the author nothing — so the cap and the honest UI answer
 *     ("整篇替换") are the same boundary, not two separate compromises.
 *
 * The implementation is the textbook greedy + trace: keep each round's V array,
 * then walk back through them to recover the script. Memory is O(D²) integers,
 * which the cap is what makes safe.
 */

/** What one step of the edit script does. */
export type EditType = "equal" | "del" | "add";

/**
 * One element of the edit script.
 *
 * `a` / `b` are 0-based indices into the old / new sequence, and **-1 means
 * "not present on that side"** — a deletion has no `b`, an insertion has no
 * `a`. Callers turn those into line numbers, so an explicit absent value is
 * worth more than an optional field that is easy to read as 0.
 */
export interface EditStep {
  type: EditType;
  a: number;
  b: number;
}

/**
 * Diff two index ranges with `eq` as the comparison.
 *
 * Returns the full edit script, or `null` when the edit distance exceeds
 * `maxDistance` — see the note above on why that is a refusal rather than a
 * best effort.
 */
export function diffIndices(
  aLen: number,
  bLen: number,
  eq: (i: number, j: number) => boolean,
  maxDistance: number,
): EditStep[] | null {
  let prefix = 0;
  while (prefix < aLen && prefix < bLen && eq(prefix, prefix)) prefix++;

  let suffix = 0;
  while (
    suffix < aLen - prefix &&
    suffix < bLen - prefix &&
    eq(aLen - 1 - suffix, bLen - 1 - suffix)
  ) {
    suffix++;
  }

  const n = aLen - prefix - suffix;
  const m = bLen - prefix - suffix;
  const core = search(n, m, (i, j) => eq(prefix + i, prefix + j), maxDistance);
  if (!core) return null;

  const out: EditStep[] = [];
  for (let i = 0; i < prefix; i++) out.push({ type: "equal", a: i, b: i });
  for (const step of core) {
    out.push({
      type: step.type,
      a: step.a < 0 ? -1 : step.a + prefix,
      b: step.b < 0 ? -1 : step.b + prefix,
    });
  }
  for (let i = 0; i < suffix; i++) {
    out.push({ type: "equal", a: aLen - suffix + i, b: bLen - suffix + i });
  }
  return out;
}

/** Greedy forward search over the trimmed middle, with the trace kept for backtracking. */
function search(
  n: number,
  m: number,
  eq: (i: number, j: number) => boolean,
  maxDistance: number,
): EditStep[] | null {
  if (n === 0 && m === 0) return [];
  // One side empty is the whole answer without a search — and it is the common
  // case for an inserted or deleted block, so it would be a shame to pay for it.
  if (n === 0) return range(m).map((b) => ({ type: "add" as const, a: -1, b }));
  if (m === 0) return range(n).map((a) => ({ type: "del" as const, a, b: -1 }));

  const max = Math.min(n + m, maxDistance);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    // Snapshot before this round: `trace[d]` is the state the round-`d` moves
    // started from, which is exactly what the backtrack needs to invert them.
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset]; // down — an insertion from b
      } else {
        x = v[k - 1 + offset] + 1; // right — a deletion from a
      }
      let y = x - k;
      while (x < n && y < m && eq(x, y)) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) return backtrack(trace, offset, n, m);
    }
  }
  return null;
}

/** Walk the trace backwards, emitting the script in reverse, then flip it. */
function backtrack(trace: Int32Array[], offset: number, n: number, m: number): EditStep[] {
  const reversed: EditStep[] = [];
  let x = n;
  let y = m;

  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK =
      k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset]) ? k + 1 : k - 1;
    const prevX = v[prevK + offset];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      reversed.push({ type: "equal", a: x - 1, b: y - 1 });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        reversed.push({ type: "add", a: -1, b: y - 1 });
      } else {
        reversed.push({ type: "del", a: x - 1, b: -1 });
      }
    }
    x = prevX;
    y = prevY;
  }

  reversed.reverse();
  return reversed;
}

function range(n: number): number[] {
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
}

/**
 * Intern a list of strings into integer ids.
 *
 * The point is the comparison inside the search loop: Myers compares the same
 * pair many times over, and on a long Chinese line a string compare is not
 * free. Returned as a plain array so the caller can hold both sides' ids.
 */
export function intern(values: readonly string[], table: Map<string, number>): Int32Array {
  const ids = new Int32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const seen = table.get(values[i]);
    if (seen === undefined) {
      const id = table.size;
      table.set(values[i], id);
      ids[i] = id;
    } else {
      ids[i] = seen;
    }
  }
  return ids;
}
