/**
 * Streaming AI client supporting OpenAI Chat Completions (and compatible),
 * OpenAI Responses (and compatible), Gemini, Anthropic and DashScope's native
 * protocol. Entry point: `streamCompletion` dispatches to the provider adapters
 * in ./openai, ./responses, ./gemini, ./anthropic and ./dashscope. Shared protocol types live in ./types.
 */

import { streamAnthropic } from "./anthropic";
import { streamDashscope } from "./dashscope";
import { beginApiLog } from "./apiLog";
import { streamGemini } from "./gemini";
import { streamOpenAI } from "./openai";
import { streamResponses } from "./responses";
import { estimateMessagesTokens, estimateToolsTokens } from "./tokenEstimate";
import { carried, trusted } from "./capability/intent";
import { classify, noteLearned } from "./capability/learned";
import { isForcedToolChoice, planRequest, type RequestPlan } from "./capability/plan";
import type { StructuredOutputMode } from "./jsonMode";
import {
  applyPrefix, ContextSizeError, familyOf, ImagePayloadError, StreamStallError,
  type MessageContent, type StreamMessage, type StreamOptions,
} from "./types";
import { imagePayload, MAX_REQUEST_IMAGE_CHARS } from "./imagePart";

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

/** What a finished call reports back beyond its chunks. */
interface StreamResult {
  /** The JSON tier the request that went through was shaped with; absent without `structured`. */
  structured?: StructuredOutputMode;
}

/**
 * The one entry point, and the one fallback executor
 * (docs/api/capability-resolution-lld.md §3.7, P7).
 *
 * Some refusals are not recoverable from the config: DeepSeek V4 answers a
 * forced `tool_choice` with a 400 while it thinks, a relay rejects
 * `response_format`, a model refuses strict `json_schema`. The endpoint's 400
 * says so before generating anything, so each is learned (./capability/learned)
 * and the request is planned again under the lowered ceiling and re-sent.
 * A refusal is only learned about a fact the request carried, as
 * a ceiling strictly below what it carried (`LEARN_RULES`), and the next plan
 * is capped by it — so every retry sends strictly less, and with forcing on two
 * levels and JSON on three the loop ends within three retries.
 */
export async function streamCompletion(opts: StreamOptions): Promise<StreamResult> {
  const merged: StreamOptions = { ...opts, messages: applyPrefix(opts.messages, opts.prefix) };
  for (;;) {
    // What the request carries, decided once per attempt for whichever adapter
    // spells it — the forced choice and the JSON tier read the learned store.
    const plan = planRequest(merged);
    if (!(await sendOnce(shape(merged, plan.json), plan))) return plan.json ? { structured: plan.json.mode } : {};
  }
}

/**
 * The JSON shaping put on the request: its fields merged into `extraBody`, its
 * cue appended to the last user turn — inside that turn rather than as a turn
 * of its own, since some local chat templates reject two user turns in a row.
 */
function shape(req: StreamOptions, json: RequestPlan["json"]): StreamOptions {
  if (!json) return req;
  return {
    ...req,
    ...(json.extraBody ? { extraBody: { ...req.extraBody, ...json.extraBody } } : {}),
    ...(json.cue ? { messages: withCue(req.messages, json.cue) } : {}),
  };
}

function withCue(messages: StreamMessage[], cue: string): StreamMessage[] {
  let at = messages.length - 1;
  while (at >= 0 && messages[at].role !== "user") at--;
  if (at < 0) return [...messages, { role: "user", content: cue }];
  const turn = messages[at] as { role: "user"; content: MessageContent };
  const content: MessageContent = typeof turn.content === "string"
    ? `${turn.content}\n\n${cue}`
    : [...turn.content, { type: "text", text: cue }];
  return messages.map((m, i) => (i === at ? { ...turn, content } : m));
}

/**
 * One request. Resolves false when it went through; true when the endpoint
 * refused something the request carried and a ceiling went down, so it is
 * worth planning again. Any other failure is thrown as it came.
 */
async function sendOnce(req: StreamOptions, plan: RequestPlan): Promise<boolean> {
  const log = beginApiLog(req);
  const estimated = estimateMessagesTokens(req.messages) + estimateToolsTokens(req.tools);
  // Only the author's window refuses a request: a table's may be wrong for this
  // endpoint, and a wrong one here means nothing is sent at all (TRUST.contextGate).
  const gate = trusted(carried(req.contextSize, req.provenance?.contextSize), "contextGate");
  if (gate && estimated > gate) {
    const err = new ContextSizeError(estimated, gate);
    log.error(err);
    throw err;
  }
  const images = imagePayload(req.messages);
  if (images.chars > MAX_REQUEST_IMAGE_CHARS) {
    const err = new ImagePayloadError(images.count, images.chars, MAX_REQUEST_IMAGE_CHARS);
    log.error(err);
    throw err;
  }
  // Whether anything has reached the caller yet. A retry is only ever correct
  // on a request that failed before its first chunk — which is where a refused
  // parameter fails, the status line arriving before generation — and this is
  // what says so rather than an assumption about the adapters.
  let streamed = false;
  const watch = createStallWatch(req.signal, firstChunkDeadlineMs(estimated), STREAM_IDLE_MS);
  const wrapped: StreamOptions = {
    ...req,
    _plan: plan,
    signal: watch.signal,
    // Wired here, not by callers: it is the log's own plumbing. An adapter that
    // sends several requests for one call reports each of them through it.
    // A caller's own hook still runs: the live probes read the bodies they sent
    // through it, and replacing it left them asserting on nothing.
    _onRequestBody: (body) => {
      log.requestBody(body);
      req._onRequestBody?.(body);
    },
    onChunk: (chunk) => {
      streamed = true;
      watch.alive();
      log.chunk(chunk);
      req.onChunk(chunk);
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
      case "dashscope":
        await streamDashscope(wrapped);
        break;
      default:
        await streamOpenAI(wrapped);
    }
    log.success();
    return false;
  } catch (e) {
    // Whatever the adapter threw on the watchdog's abort (an AbortError, the
    // reason itself, a network error), the truth is that the stream stalled.
    const err = watch.stalled() ?? e;
    log.error(err);
    // Both callers that force a tool already handle "the model didn't call
    // it", and a JSON tier stepped down still carries the cue — so neither
    // retry changes what the caller has to cope with.
    const learned = streamed
      ? undefined
      : classify(err, { forcedToolChoice: isForcedToolChoice(plan.toolChoice?.sent), structuredOutput: plan.json?.mode });
    if (!learned) throw err;
    // Retried whether or not this call is the one that lowered the ceiling: a
    // parallel request to the same endpoint may have learned it first, and the
    // next plan is capped either way.
    noteLearned(req, learned.fact, learned.ceiling);
    return true;
  } finally {
    watch.done();
  }
}
