/**
 * Display-layer folding for the chat transcript (docs/feature/agent/chat-memory-plan.md §8's
 * deferred item). Pure presentation: the wire history and its compaction are
 * untouched — this only decides how many of the *rendered* turns collapse
 * behind a "show earlier" bar, keeping a long session's transcript short and
 * its DOM light (every assistant turn renders markdown plus an execution log).
 *
 * Kept apart from the component so the boundary rule is testable: the
 * component file pulls in Tauri imports that a node test can't load.
 */

/** Recent transcript entries (user + assistant each count as one) always shown. */
export const FOLD_KEEP_ENTRIES = 8;
/**
 * Entries a fold must hide to be worth a bar at all. Below this the bar reads
 * as chrome hiding nothing — two messages behind a control is worse than two
 * messages.
 */
export const FOLD_MIN_HIDDEN = 4;

/**
 * Index of the first visible entry; 0 = nothing folds.
 *
 * The cut never lands mid-exchange: it walks back to a `user` entry so the
 * visible transcript always opens with the question an answer belongs to —
 * an assistant turn with its question hidden reads as a reply to nothing.
 */
export function foldBoundary(roles: readonly ("user" | "assistant")[]): number {
  let cut = Math.max(0, roles.length - FOLD_KEEP_ENTRIES);
  while (cut > 0 && roles[cut] !== "user") cut--;
  return cut >= FOLD_MIN_HIDDEN ? cut : 0;
}
