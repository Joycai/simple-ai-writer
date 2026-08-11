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
import { applyPrefix, ContextSizeError, type StreamOptions } from "./types";

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
    onChunk: (chunk) => {
      log.chunk(chunk);
      merged.onChunk(chunk);
    },
  };
  try {
    if (wrapped.standard === "gemini") {
      await streamGemini(wrapped);
    } else if (wrapped.standard === "anthropic") {
      await streamAnthropic(wrapped);
    } else {
      await streamOpenAI(wrapped);
    }
    log.success();
  } catch (e) {
    log.error(e);
    throw e;
  }
}
