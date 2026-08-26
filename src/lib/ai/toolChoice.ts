/**
 * Forced `tool_choice`, and the endpoints that refuse it.
 *
 * Two adapters already downgrade a forced choice *before* sending it, on the
 * one endpoint whose docs say plainly that forcing is illegal while thinking is
 * on (the `switch` dialect — see `openai.ts` `toolChoiceFor` and `anthropic.ts`
 * `toolChoiceBody`). That covers the endpoints recognisable from the config.
 * This file covers the ones that aren't.
 *
 * The sample it was written for is DeepSeek V4 (`deepseek-v4-flash`/`-pro`):
 * those models are **always** in thinking mode — nothing in the request says
 * so, so no declaration on the model could have predicted it — and thinking
 * mode there accepts `auto` and `none` only. Both `required` and the named
 * `{type:"function"}` form come back as `400 Thinking mode does not support
 * this tool_choice`, before a single token is generated. Every agent framework
 * hit this independently (deepseek-ai/DeepSeek-V3#1376).
 *
 * So the endpoint's own 400 is the declaration: it is definitive, it arrives
 * before generation, and it costs nothing to act on. `streamCompletion` retries
 * the request once with `auto` and remembers the refusal for the rest of the
 * session, so the wasted round trip happens once per endpoint+model rather than
 * once per request.
 *
 * Downgrading is safe for both callers that force, and always was — the same
 * argument `openai.ts` spells out: `agent/structured.ts` treats "the model
 * declined to call the tool" as its cue to re-run in JSON mode, and the agent
 * runtime's handoff round hands off on the round's prose when no call arrives
 * (`handoff.fallbackBrief`). Neither ever *relied* on forcing.
 *
 * The memo is deliberately in-memory and session-scoped: it is a fact about an
 * endpoint, not about the author's config, and re-learning it costs one failed
 * request. It is also deliberately not keyed by thinking effort — an endpoint
 * that refuses forcing only while thinking is on is treated as refusing it
 * always, which costs at worst the JSON fallback firing a turn early.
 */

import type { StreamOptions } from "./types";

/** Whether this request tells the model to call a tool rather than offering. */
export function isForcedToolChoice(tc: StreamOptions["toolChoice"]): boolean {
  return tc === "required" || (typeof tc === "object" && tc !== null);
}

/**
 * Whether this error is the endpoint rejecting the forced choice itself.
 *
 * Narrow on purpose — the parameter's own name has to appear. Broader
 * phrasings ("does not support", "thinking mode") also match genuine,
 * unrelated failures, and a retry there would resend the whole context only to
 * fail a second time. The messages this is written for all name it:
 * `Thinking mode does not support this tool_choice`,
 * `Invalid value for 'tool_choice'`.
 */
export function isForcedToolChoiceRejection(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return false;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /tool[_ ]?choice/i.test(msg);
}

/**
 * One endpoint+model. The standard is in the key because one host can serve
 * several protocol families and they don't have to agree.
 */
function endpointKey(opts: StreamOptions): string {
  return `${opts.standard} ${opts.baseUrl} ${opts.modelId}`;
}

const refused = new Set<string>();

/** Has this endpoint+model already answered a forced choice with a 400? */
export function forcedToolChoiceRefused(opts: StreamOptions): boolean {
  return refused.has(endpointKey(opts));
}

export function noteForcedToolChoiceRefused(opts: StreamOptions): void {
  refused.add(endpointKey(opts));
}

/** Tests only — the memo outlives a single request by design. */
export function __resetForcedToolChoiceMemo(): void {
  refused.clear();
}
