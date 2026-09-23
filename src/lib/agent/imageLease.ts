/**
 * Pictures in a chat's context are leased by the turn
 * (docs/feature/agent/chat-image-paste-plan.md §5).
 *
 * `trimHistory`'s caps count *messages* (the newest three with pictures) and
 * bytes. Neither notices the conversation moving on: a screenshot asked about
 * once and followed by twenty turns about something else stays one of the
 * newest three for ever, and is paid for on every tool round of every one of
 * those turns. The lease is the earlier, turn-shaped bound on top of them: a
 * picture keeps its pixels for the turn it arrived in and the next
 * {@link IMAGE_LEASE_TURNS}, then leaves — its text stays, and the 【附图】 list
 * in that text carries the path `read_image` can bring it back from.
 *
 * It runs only when a new turn opens, never inside one: the round in progress
 * is what the model is looking at (M1, window-edge-plan.md), and rewriting the
 * history's prefix mid-turn would throw away the provider's prompt cache on
 * every tool round; a turn's start is where that cache breaks anyway.
 */

import type { StreamMessage } from "../ai/types";
import { segmentHistory, type ChatSessionMeta } from "./compact";
import { contentWithoutImages, hasImageParts } from "./imageHistory";

/**
 * Turns after the one a picture arrived in that still carry its pixels.
 *
 * One, because the follow-up about a picture ("and the second one?", "what
 * does the top-left line say?") is nearly always the very next message; a
 * question further back costs one `read_image`, while every extra turn of
 * lease is paid by every conversation on every tool round.
 */
export const IMAGE_LEASE_TURNS = 1;

/** What an expired picture leaves behind; the model reads this. */
const EXPIRED_IMAGE =
  "[picture from an earlier turn dropped to save context — its path is given with it; read_image it again if it still matters]";

/**
 * Strip the pictures of every turn older than the current one and the
 * {@link IMAGE_LEASE_TURNS} before it — all of a turn's pictures together,
 * the author's attachments and the tool loop's reads alike. Call right after
 * the new turn's question is in `history` and recorded in `meta`. The
 * prelude (system, seed, summary) carries no pictures and is not touched.
 * Returns how many messages it changed.
 */
export function elideExpiredTurnImages(
  history: StreamMessage[],
  meta: ChatSessionMeta,
  lease = IMAGE_LEASE_TURNS,
): number {
  const { turns } = segmentHistory(history, meta);
  let dropped = 0;
  for (const turn of turns.slice(0, Math.max(0, turns.length - (lease + 1)))) {
    for (const m of turn.messages) {
      if (!hasImageParts(m)) continue;
      m.content = contentWithoutImages(m, EXPIRED_IMAGE);
      dropped++;
    }
  }
  return dropped;
}
