/**
 * `@` picks whose file is still being read, and reads that failed — kept per
 * draft slot at module level, outside any component: the instance that
 * started a read may be gone (the chat composer remounts per conversation,
 * the roleplay one per character), and the stores must be able to drop the
 * failures when every draft goes (`composerStore.resetAll`) without
 * importing a component file. The React side is `useMentionReads` in
 * components/common/MentionPicker.tsx.
 */

/**
 * Drafts with a pick's file still being read, by slot (one per draft: the
 * chat key, the roleplay character, a lore modal's own id). Such a draft must
 * not be sent: the message would leave as `@潮` without the attachment, and
 * the read, finishing, would put the attachment into the emptied composer to
 * ride along with the next one. Module state, as chatStash's `pasting`, for
 * the same reason: the instance that started the read may be gone — the chat
 * composer remounts per conversation — and the one on screen now must still
 * see the draft is not ready.
 */
const reads = new Map<string, number>();
const readListeners = new Set<() => void>();

function markMentionRead(slot: string, on: boolean): void {
  const n = (reads.get(slot) ?? 0) + (on ? 1 : -1);
  if (n > 0) reads.set(slot, n);
  else reads.delete(slot);
  for (const l of readListeners) l();
}

export function isMentionReading(slot: string): boolean {
  return reads.has(slot);
}

export function subscribeMentionReads(listener: () => void): () => void {
  readListeners.add(listener);
  return () => { readListeners.delete(listener); };
}

/**
 * Count `pick` against `slot` until it settles, resolved or rejected; its
 * outcome passes through. `pick` is the whole pick — the read *and* the
 * landing — not the read alone (see useMentionReads).
 */
export async function trackMentionRead<T>(slot: string, pick: () => Promise<T>): Promise<T> {
  markMentionRead(slot, true);
  try {
    return await pick();
  } finally {
    markMentionRead(slot, false);
  }
}

/** A pick's read that failed — the refusal to show, in the author's words. */
export interface MentionReadFailure {
  readonly message: string;
}

/**
 * The last failed read of each draft, until an instance showing that draft
 * takes it. Beside the count, for the same reason: the instance that started
 * the read may be gone, and the one on screen now — or the next one mounted
 * on this draft — must still drop a send queued around the attachment and
 * say why no chip came. Kept until taken: a failure while no instance shows
 * the draft is shown once when one does, next to the `@潮` still in it.
 */
const failures = new Map<string, MentionReadFailure>();

export function failMentionRead(slot: string, message: string): void {
  failures.set(slot, { message });
  for (const l of readListeners) l();
}

export function mentionReadFailure(slot: string): MentionReadFailure | null {
  return failures.get(slot) ?? null;
}

/** Take `failure` off `slot` — only if it is still the one there, so taking an older one never drops a newer. */
export function takeMentionReadFailure(slot: string, failure: MentionReadFailure): void {
  if (failures.get(slot) !== failure) return;
  failures.delete(slot);
  for (const l of readListeners) l();
}

/**
 * Drop every recorded failure — for when every draft is dropped with it
 * (`composerStore.resetAll`, a project closing or opening). A failure
 * explains the `@潮` left in its draft; with the draft gone, shown later it
 * explains nothing. Counts are left alone: a read still running settles and
 * uncounts itself.
 */
export function clearMentionReadFailures(): void {
  if (failures.size === 0) return;
  failures.clear();
  for (const l of readListeners) l();
}
