/**
 * Streaming AI client supporting OpenAI (and compatible), Gemini, and Anthropic
 * APIs. Entry point: `streamCompletion` dispatches to the provider adapters in
 * ./openai, ./gemini and ./anthropic. Shared protocol types live in ./types.
 */

import { streamAnthropic } from "./anthropic";
import { beginApiLog } from "./apiLog";
import { streamGemini } from "./gemini";
import { streamOpenAI } from "./openai";
import { estimateMessagesTokens, estimateToolsTokens } from "./tokenEstimate";
import {
  forcedToolChoiceRefused, isForcedToolChoice, isForcedToolChoiceRejection,
  noteForcedToolChoiceRefused,
} from "./toolChoice";
import { applyPrefix, ContextSizeError, familyOf, type StreamOptions } from "./types";

export * from "./types";

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
  if (merged.contextSize && merged.contextSize > 0) {
    const estimated = estimateMessagesTokens(merged.messages) + estimateToolsTokens(merged.tools);
    if (estimated > merged.contextSize) {
      const err = new ContextSizeError(estimated, merged.contextSize);
      log.error(err);
      throw err;
    }
  }
  // Whether anything has reached the caller yet. The retry below is only ever
  // correct on a request that failed before its first chunk — which is where a
  // rejected `tool_choice` fails, the status line arriving before generation —
  // and this is what says so rather than an assumption about the adapters.
  let streamed = false;
  const wrapped: StreamOptions = {
    ...merged,
    // Wired here, not by callers: it is the log's own plumbing. An adapter that
    // sends several requests for one call reports each of them through it.
    _onRequestBody: (body) => log.requestBody(body),
    onChunk: (chunk) => {
      streamed = true;
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
      default:
        await streamOpenAI(wrapped);
    }
    log.success();
  } catch (e) {
    log.error(e);
    // The endpoint refused the forced choice. Retried once with `auto` — the
    // request cost nothing (it was rejected before generation) and both callers
    // that force already handle "the model didn't call it". The recursion ends
    // here: `auto` is not a forced choice, so this branch can't run again.
    if (!streamed && isForcedToolChoice(merged.toolChoice) && isForcedToolChoiceRejection(e)) {
      noteForcedToolChoiceRefused(merged);
      return streamCompletion({ ...base, toolChoice: "auto" });
    }
    throw e;
  }
}
