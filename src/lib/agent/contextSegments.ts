/**
 * Bar segments, in wire order. `system` folds the tool schemas in with the
 * system message: neither is recoverable by compaction, and splitting a fixed
 * cost in two says nothing the author can act on.
 */
export type ContextSegmentKey =
  | "system"
  | "summary"
  | "seed"
  | "injected"
  | "conversation"
  | "free";

/** Ordered once here so the bar, the legend and the tooltips can't disagree. */
export const CONTEXT_SEGMENT_ORDER: readonly ContextSegmentKey[] = [
  "system",
  "summary",
  "seed",
  "injected",
  "conversation",
  "free",
];

