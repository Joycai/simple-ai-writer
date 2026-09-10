/**
 * Pure scheduling decisions for a store that runs several conversations at
 * once — the semaphore + FIFO queue behind both the roleplay roster and the
 * chat assistant's open sessions (docs/feature/agent/chat-sessions-plan.md §4.3).
 *
 * Generic over the job shape: each store keeps its own queue type and hands in
 * the accessor that names a job's owner (an agent id, a chat key). The two
 * stores do not share slots — see the plan for why not yet — but they share
 * this one definition of "who may start next", so the queue behaves the same
 * way on both surfaces.
 */

/** 同时最多几段对话在生成。信号量，不是三个分支——改成 5 就是改这个数。 */
export const MAX_CONCURRENT_RUNS = 3;

export function hasQueuedJob<J>(
  queue: readonly J[],
  owner: string,
  ownerOf: (job: J) => string,
): boolean {
  return queue.some((job) => ownerOf(job) === owner);
}

/**
 * Pick the first queued job whose owner holds neither a generation slot nor a
 * manual-compaction slot. Both operations replace or extend the same wire
 * history, so they must never run together for one owner. Skips rather than
 * blocks: a job behind a busy owner does not hold up an idle one's.
 */
export function nextRunnableJobIndex<J>(
  queue: readonly J[],
  running: readonly string[],
  compacting: readonly string[],
  ownerOf: (job: J) => string,
): number {
  return queue.findIndex((job) => {
    const owner = ownerOf(job);
    return !running.includes(owner) && !compacting.includes(owner);
  });
}

/** Whether an owner may start new exclusive work right now. */
export function ownerBusy(
  owner: string,
  running: readonly string[],
  compacting: readonly string[],
  queue: readonly { key: string }[],
): boolean {
  return running.includes(owner)
    || compacting.includes(owner)
    || queue.some((job) => job.key === owner);
}
