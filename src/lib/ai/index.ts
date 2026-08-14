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
import { applyPrefix, ContextSizeError, familyOf, type StreamOptions } from "./types";

export * from "./types";

export async function streamCompletion(opts: StreamOptions): Promise<void> {
  const merged: StreamOptions = { ...opts, messages: applyPrefix(opts.messages, opts.prefix) };
  const log = beginApiLog(merged);
  if (merged.contextSize && merged.contextSize > 0) {
    const estimated = estimateMessagesTokens(merged.messages) + estimateToolsTokens(merged.tools);
    if (estimated > merged.contextSize) {
      const err = new ContextSizeError(estimated, merged.contextSize);
      log.error(err);
      throw err;
    }
  }
  const wrapped: StreamOptions = {
    ...merged,
    // Wired here, not by callers: it is the log's own plumbing. An adapter that
    // sends several requests for one call reports each of them through it.
    _onRequestBody: (body) => log.requestBody(body),
    onChunk: (chunk) => {
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
    throw e;
  }
}
