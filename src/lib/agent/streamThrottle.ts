/**
 * Coalesce high-frequency, latest-wins streaming updates into at most one
 * store write per interval.
 *
 * A run emits a store write per network chunk — an output token, a reasoning
 * fragment — which is far above reading speed: every write re-renders the
 * whole transcript (new turns array, new turn object), so a thinking model
 * drove the chat surfaces at dozens of renders per second. The updates are
 * latest-wins (`onOutputText` hands over the whole text each time, and a
 * round's reasoning event *replaces* its earlier emission — see
 * appendAgentEventTo), so buffering the newest value and writing it on a
 * timer drops no information, only intermediate frames.
 *
 * `flush()` is the ordering barrier: call it before any write that must land
 * *after* what is buffered (a tool-step event, the run's final usage), so the
 * store never shows a later event ahead of the text that preceded it.
 */
export interface StreamThrottle {
  /** Ask for a flush soon. Applies immediately when the last one is old. */
  schedule(): void;
  /** Apply whatever is pending right now; no-op when nothing is. */
  flush(): void;
}

export const STREAM_FLUSH_MS = 80;

export function createStreamThrottle(
  apply: () => void,
  intervalMs: number = STREAM_FLUSH_MS,
): StreamThrottle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = 0;
  const run = () => {
    timer = null;
    last = Date.now();
    apply();
  };
  return {
    schedule() {
      if (timer !== null) return;
      // Leading edge when idle: the first token of a reply shows up at once
      // rather than an interval late.
      timer = setTimeout(run, Math.max(0, intervalMs - (Date.now() - last)));
    },
    flush() {
      if (timer === null) return;
      clearTimeout(timer);
      run();
    },
  };
}
