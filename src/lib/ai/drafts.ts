/**
 * The draft vocabulary: what one generated result is, how many a run may
 * produce, and what a run cost in total.
 *
 * Its own module, free of both stores, because the two ends of the feature would
 * otherwise import each other: `appStore` owns the author's draft-count setting
 * and needs the ceiling, while `aiTaskStore` owns the run and reads the setting.
 * Keeping these here also means the pure parts are testable without dragging in
 * a store that touches `localStorage` and `document` at module load.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number; // USD
}

/**
 * One generated result.
 *
 * A run produces one or more — a plain task makes a single draft, and asking for
 * several (三版标题) fans out into independent completions of the same prompt.
 * Modelling the single case as "a run with one draft" rather than as a separate
 * shape is what keeps the two paths from drifting.
 *
 * Errors and usage are per-draft because the drafts are separate API calls: one
 * being refused or filtered must not discard the others' text.
 */
export interface Draft {
  /** Stable across the run — the React key and what the insert actions target. */
  id: string;
  /**
   * 1-based, for labelling ("版本 2"). The position in `drafts` is the same
   * number today, but carrying it keeps the label correct independently of any
   * later filtering or reordering of the array.
   */
  index: number;
  text: string;
  usage: TokenUsage | null;
  /** This draft's own failure; the store's run-level `error` is separate. */
  error: string | null;
  /** False while still streaming. */
  done: boolean;
}

/**
 * Ceiling on how many drafts one task may produce.
 *
 * Five because each draft is a full, separately-billed request: past a handful
 * the author is spending real money on results they won't read.
 */
export const MAX_DRAFTS = 5;

/** Sum of every draft's usage — what the run as a whole cost. */
export function totalUsage(drafts: Draft[]): TokenUsage | null {
  const counted = drafts.filter((d) => d.usage);
  if (counted.length === 0) return null;
  return counted.reduce<TokenUsage>(
    (acc, d) => ({
      inputTokens: acc.inputTokens + d.usage!.inputTokens,
      outputTokens: acc.outputTokens + d.usage!.outputTokens,
      cost: acc.cost + d.usage!.cost,
    }),
    { inputTokens: 0, outputTokens: 0, cost: 0 },
  );
}
