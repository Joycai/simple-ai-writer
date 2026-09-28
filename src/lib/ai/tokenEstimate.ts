/**
 * Rough prompt-size estimation used for the pre-flight context-window check.
 * Heuristic, not a real tokenizer: CJK characters count as ~1 token each,
 * everything else as ~4 characters per token. Good enough to catch the
 * "prompt is several times larger than the context window" failure mode
 * where servers like ollama silently truncate the head of the prompt.
 */

import type { StreamMessage, ToolDefinition } from "./types";

// CJK ideographs, kana, hangul, CJK compatibility, and fullwidth forms
// (⺀-鿿, ぀-ヿ via the ideograph range, 가-힯, 豈-﫿, ＀-￯).
const CJK_RE = /[⺀-鿿぀-ヿ가-힯豈-﫿＀-￯]/g;

/** Fixed cost assumed per attached image (vision token usage varies by model). */
const IMAGE_TOKENS = 800;

/**
 * Cost assumed for a video clip whose size could not be estimated (a WebM, an
 * unparseable MP4). Measured clips range from ~600 tokens (2 s, 480p) to
 * ~36k (60 s, 720p); pricing one as a picture would let the ceiling check
 * wave through a request forty times its estimate. This sits toward the middle
 * of what fits under the 15 MB file cap at default fps.
 */
export const VIDEO_TOKENS_UNKNOWN = 10_000;

/**
 * Per-clip cost, keyed by the part object itself: how many tokens the clip
 * costs at a given `fps` (absent = the endpoint's default), or null when its
 * size could not be read.
 *
 * Carried beside the part rather than on it because openai.ts sends parts
 * verbatim — a bookkeeping field would reach the endpoint. A WeakMap follows
 * the object through the history (trimming mutates `content` arrays but keeps
 * the parts it doesn't drop) and lets go of it once the clip is elided.
 *
 * A function of the fps rather than a number, because the fps is decided per
 * request (`RequestPlan.clipFps`): the projection writes the one this request
 * sends onto a copy of the part (`carryVideoCost`), and the estimate reads the
 * part it is handed — so the request's pre-flight counts the frames that go
 * out, not the ones the clip was attached at. A function also keeps this
 * module a leaf: the formula stays in `videoInput.ts`, which the composer calls.
 */
const videoCosts = new WeakMap<object, (fps: number | undefined) => number | null>();

/** Record how a clip part the composer just built costs, as a function of the fps it goes out at. */
export function noteVideoCost(part: object, costAt: (fps: number | undefined) => number | null): void {
  videoCosts.set(part, costAt);
}

/** Give a copy of a clip part (the projection's, with this request's fps) the original's cost. */
export function carryVideoCost(from: object, to: object): void {
  const costAt = videoCosts.get(from);
  if (costAt) videoCosts.set(to, costAt);
}

/** A clip part's estimated cost at the fps it carries. */
function videoTokens(part: { fps?: number }): number {
  const tokens = videoCosts.get(part)?.(part.fps);
  return tokens != null && Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : VIDEO_TOKENS_UNKNOWN;
}

/** Per-message protocol overhead (role markers, separators). */
const PER_MESSAGE_OVERHEAD = 4;

export function estimateTextTokens(text: string): number {
  const cjk = text.match(CJK_RE)?.length ?? 0;
  const other = text.length - cjk;
  return Math.ceil(cjk + other / 4);
}

/**
 * The agent runtime's tool schemas (name + description + JSON-schema
 * parameters) ride along on every request the same as any message, and for
 * the full toolset (lore/memory/edit/plan tools) that's several KB — enough
 * on its own to matter for the pre-flight context-window check. JSON-stringify
 * is a rough proxy for a schema's real size, same spirit as the message
 * estimate this sits next to.
 */
export function estimateToolsTokens(tools?: ToolDefinition[]): number {
  if (!tools?.length) return 0;
  return estimateTextTokens(JSON.stringify(tools));
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
        else if (part.type === "video_url") total += videoTokens(part);
        else total += IMAGE_TOKENS;
      }
    }
  }
  return total;
}
