/**
 * Rough prompt-size estimation used for the pre-flight context-window check.
 * Heuristic, not a real tokenizer: CJK characters count as ~1 token each,
 * everything else as ~4 characters per token. Good enough to catch the
 * "prompt is several times larger than the context window" failure mode
 * where servers like ollama silently truncate the head of the prompt.
 */

import type { StreamMessage } from "./aiClient";

// CJK ideographs, kana, hangul, CJK compatibility, and fullwidth forms
// (⺀-鿿, ぀-ヿ via the ideograph range, 가-힯, 豈-﫿, ＀-￯).
const CJK_RE = /[⺀-鿿぀-ヿ가-힯豈-﫿＀-￯]/g;

/** Fixed cost assumed per attached image (vision token usage varies by model). */
const IMAGE_TOKENS = 800;

/** Per-message protocol overhead (role markers, separators). */
const PER_MESSAGE_OVERHEAD = 4;

export function estimateTextTokens(text: string): number {
  const cjk = text.match(CJK_RE)?.length ?? 0;
  const other = text.length - cjk;
  return Math.ceil(cjk + other / 4);
}

export function estimateMessagesTokens(messages: StreamMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += PER_MESSAGE_OVERHEAD;
    if ("tool_calls" in m && m.tool_calls) {
      for (const tc of m.tool_calls) {
        total += estimateTextTokens(tc.function.name + tc.function.arguments);
      }
    }
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") {
      total += estimateTextTokens(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === "text") total += estimateTextTokens(part.text);
        else total += IMAGE_TOKENS;
      }
    }
  }
  return total;
}
