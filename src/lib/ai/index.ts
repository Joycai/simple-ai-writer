/**
 * Streaming AI client supporting OpenAI Chat Completions (and compatible),
 * OpenAI Responses (and compatible), Gemini, and Anthropic APIs. Entry point:
 * `streamCompletion` dispatches to the provider adapters in ./openai,
 * ./responses, ./gemini and ./anthropic. Shared protocol types live in ./types.
 */

import { streamAnthropic } from "./anthropic";
import { beginApiLog } from "./apiLog";
import { streamGemini } from "./gemini";
import { streamOpenAI } from "./openai";
import { streamResponses } from "./responses";
import { estimateMessagesTokens, estimateToolsTokens } from "./tokenEstimate";
import {
  forcedToolChoiceRefused, isForcedToolChoice, isForcedToolChoiceRejection,
  noteForcedToolChoiceRefused,
} from "./toolChoice";
import { applyPrefix, ContextSizeError, familyOf, StreamStallError, type StreamOptions } from "./types";

export * from "./types";

// ── Stream watchdog (docs/feature/agent/window-edge-plan.md D7) ─────────────
//
// Without one, a stream the endpoint stops feeding — a relay that drops the
// upstream but keeps the socket open, a local server whose model failed to
// load — is awaited forever. The round timer in the execution log keeps
// ticking, the chat keeps its slot in the run queue, and nothing ever says why.
//
// Both limits are deliberately long, because on a local server long silences
// are normal. Measured on LM Studio (qwen3.8-27b, 32k): prefill runs ~1.5k
// tokens/s with nothing on the wire, and a tool call's arguments arrive in one
// piece at the end — 2,826 characters of `create_file` content were 32.6 s of
// total silence after the call's name, i.e. a 15k-character chapter is minutes.
// The watchdog is for streams that have died, not ones that are slow.

/** Base wait for the first chunk: model load, a queue, the first tokens. */
export const FIRST_CHUNK_BASE_MS = 120_000;
/** Prefill speed the first-chunk deadline assumes — slow local hardware, on purpose. */
const PREFILL_TOKENS_PER_SECOND = 150;
/**
 * Longest silence between two chunks once output has started. Ten minutes:
 * about 50k characters of buffered tool arguments at the speed measured above,
 * more than any single call the runtime asks for.
 */
export const STREAM_IDLE_MS = 600_000;

/** The first-chunk deadline for a request of this estimated size. */
export function firstChunkDeadlineMs(estimatedInputTokens: number): number {
  return FIRST_CHUNK_BASE_MS + Math.ceil((Math.max(0, estimatedInputTokens) / PREFILL_TOKENS_PER_SECOND) * 1000);
}

/**
 * The caller's signal plus the two deadlines.
 *
 * One timer, re-armed only when it fires early, rather than a clearTimeout and
 * setTimeout per chunk — a reasoning stream delivers chunks per token. Not
 * `AbortSignal.any`: this runs in a webview whose Chromium is whatever the OS
 * shipped (the same reason as `image.ts` `withDeadline`).
 */
function createStallWatch(outer: AbortSignal | undefined, firstMs: number, idleMs: number) {
  const ctrl = new AbortController();
  let stall: StreamStallError | null = null;
  let phase: StreamStallError["phase"] = "first-chunk";
  let limit = firstMs;
  let deadline = Date.now() + firstMs;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = () => {
    const left = deadline - Date.now();
    if (left > 0) {
      timer = setTimeout(tick, left);
      return;
    }
    stall = new StreamStallError(phase, limit);
    ctrl.abort(stall);
  };
  timer = setTimeout(tick, firstMs);

  const onAbort = () => ctrl.abort(outer?.reason);
  if (outer?.aborted) ctrl.abort(outer.reason);
  else outer?.addEventListener("abort", onAbort, { once: true });

  return {
    signal: ctrl.signal,
    /** A chunk arrived: the stream is alive, and from here the idle limit applies. */
    alive() {
      deadline = Date.now() + idleMs;
      if (phase === "first-chunk") {
        phase = "idle";
        limit = idleMs;
        // The pending timer was set for the first-chunk limit, which can be the
        // later of the two on a huge prompt; re-arm so the idle limit holds.
        clearTimeout(timer);
        timer = setTimeout(tick, idleMs);
      }
    },
    stalled: () => stall,
    done() {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    },
  };
}

export async function streamCompletion(opts: StreamOptions): Promise<void> {
  // Some endpoints answer a forced `tool_choice` with a 400 rather than
  // honouring or quietly ignoring it, and nothing in the config predicts which
  // (DeepSeek V4 thinks unconditionally, and forcing is illegal while it does).
  // Once one has said so, stop asking — see ./toolChoice.
  const base: StreamOptions =
    isForcedToolChoice(opts.toolChoice) && forcedToolChoiceRefused(opts)
      ? { ...opts, toolChoice: "auto" }
      : opts;
  const merged: StreamOptions = { ...base, messages: applyPrefix(base.messages, base.prefix) };
  const log = beginApiLog(merged);
  const estimated = estimateMessagesTokens(merged.messages) + estimateToolsTokens(merged.tools);
  if (merged.contextSize && merged.contextSize > 0 && estimated > merged.contextSize) {
    const err = new ContextSizeError(estimated, merged.contextSize);
    log.error(err);
    throw err;
  }
  // Whether anything has reached the caller yet. The retry below is only ever
  // correct on a request that failed before its first chunk — which is where a
  // rejected `tool_choice` fails, the status line arriving before generation —
  // and this is what says so rather than an assumption about the adapters.
  let streamed = false;
  const watch = createStallWatch(merged.signal, firstChunkDeadlineMs(estimated), STREAM_IDLE_MS);
  const wrapped: StreamOptions = {
    ...merged,
    signal: watch.signal,
    // Wired here, not by callers: it is the log's own plumbing. An adapter that
    // sends several requests for one call reports each of them through it.
    _onRequestBody: (body) => log.requestBody(body),
    onChunk: (chunk) => {
      streamed = true;
      watch.alive();
      log.chunk(chunk);
      merged.onChunk(chunk);
    },
  };
  try {
    // Dispatch on the protocol family, not the standard: the official and
    // compat halves of a family share an adapter, and branching on the standard
    // would drop every new `_compat` value into the OpenAI branch.
    switch (familyOf(wrapped.standard)) {
      case "gemini":
        await streamGemini(wrapped);
        break;
      case "anthropic":
        await streamAnthropic(wrapped);
        break;
      case "responses":
        await streamResponses(wrapped);
        break;
      default:
        await streamOpenAI(wrapped);
    }
    log.success();
  } catch (e) {
    // Whatever the adapter threw on the watchdog's abort (an AbortError, the
    // reason itself, a network error), the truth is that the stream stalled.
    const err = watch.stalled() ?? e;
    log.error(err);
    watch.done();
    // The endpoint refused the forced choice. Retried once with `auto` — the
    // request cost nothing (it was rejected before generation) and both callers
    // that force already handle "the model didn't call it". The recursion ends
    // here: `auto` is not a forced choice, so this branch can't run again.
    if (!streamed && isForcedToolChoice(merged.toolChoice) && isForcedToolChoiceRejection(err)) {
      noteForcedToolChoiceRefused(merged);
      return streamCompletion({ ...base, toolChoice: "auto" });
    }
    throw err;
  } finally {
    watch.done();
  }
}
