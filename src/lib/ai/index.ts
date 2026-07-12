/**
 * Streaming AI client supporting OpenAI (and compatible) + Gemini APIs.
 * Entry point: `streamCompletion` dispatches to the provider adapters in
 * ./openai and ./gemini. Shared protocol types live in ./types.
 */

import { beginApiLog } from "./apiLog";
import { streamGemini } from "./gemini";
import { streamOpenAI } from "./openai";
import { estimateMessagesTokens } from "./tokenEstimate";
import { applyPrefix, ContextSizeError, type StreamOptions } from "./types";

export * from "./types";

export async function streamCompletion(opts: StreamOptions): Promise<void> {
  const merged: StreamOptions = { ...opts, messages: applyPrefix(opts.messages, opts.prefix) };
  const log = beginApiLog(merged);
  if (merged.contextSize && merged.contextSize > 0) {
    const estimated = estimateMessagesTokens(merged.messages);
    if (estimated > merged.contextSize) {
      const err = new ContextSizeError(estimated, merged.contextSize);
      log.error(err);
      throw err;
    }
  }
  const wrapped: StreamOptions = {
    ...merged,
    onChunk: (chunk) => {
      log.chunk(chunk);
      merged.onChunk(chunk);
    },
  };
  try {
    if (wrapped.standard === "gemini") {
      await streamGemini(wrapped);
    } else {
      await streamOpenAI(wrapped);
    }
    log.success();
  } catch (e) {
    log.error(e);
    throw e;
  }
}
