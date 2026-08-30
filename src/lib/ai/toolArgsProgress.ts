/**
 * "The arguments are still arriving" — the one thing an adapter can say during
 * the longest silence in the app.
 *
 * A tool call is delivered to the runtime whole, at the end of the stream
 * (`emitToolCalls` in both adapters), and it has to be: half a JSON object
 * cannot be executed, and replaying one would corrupt the history. So a model
 * writing a 3,000-word chapter into `rewrite_lines` produces a minute or two in
 * which the round is visibly alive on the wire and completely silent above it.
 * The fragments are already being concatenated in both adapters; this only
 * lets them say how much has landed.
 *
 * Shared rather than inlined twice so the rate and the semantics are written
 * down once — the two adapters must not drift into reporting at different
 * speeds for what the reader sees as the same row.
 */

import type { StreamChunk } from "./types";

/**
 * Minimum gap between two reports.
 *
 * A fast endpoint delivers argument fragments dozens of times a second and each
 * report is a store write that re-renders the log; 200ms is far above reading
 * speed for a number that only ever grows.
 */
export const TOOL_ARGS_PROGRESS_MS = 200;

/**
 * A reporter that fires at most every `TOOL_ARGS_PROGRESS_MS`.
 *
 * The clock starts **now**, at construction, which is the point: a round whose
 * tool calls stream in under one period — every `read_file`, every
 * `search_text`, the overwhelming majority of calls — reports nothing at all,
 * so no threshold has to be guessed and short rounds stay as quiet as they are
 * short.
 *
 * The payload is built by a thunk so the sum over the round's calls is computed
 * only when it is actually going to be shown.
 */
export function createToolArgsProgress(
  onChunk: (chunk: StreamChunk) => void,
): (make: () => { name: string; chars: number }) => void {
  let last = Date.now();
  return (make) => {
    const now = Date.now();
    if (now - last < TOOL_ARGS_PROGRESS_MS) return;
    last = now;
    onChunk({ toolArgs: make() });
  };
}
