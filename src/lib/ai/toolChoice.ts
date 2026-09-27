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
 * The memo is the shared learned store (`capability/learned.ts`, one store
 * for every refusal an endpoint can teach, session-scoped by decision D3). The
 * two functions below keep their names for one phase as its facade
 * (docs/api/capability-resolution-lld.md P3); the classifier is its
 * `forcedToolChoice` rule.
 */

import { learnedCeiling, noteLearned, type EndpointKey } from "./capability/learned";
import type { StreamOptions } from "./types";

/** Whether this request tells the model to call a tool rather than offering. */
export function isForcedToolChoice(tc: StreamOptions["toolChoice"]): boolean {
  return tc === "required" || (typeof tc === "object" && tc !== null);
}

/** Has this endpoint+model already answered a forced choice with a 400? */
export function forcedToolChoiceRefused(opts: EndpointKey): boolean {
  return learnedCeiling(opts, "forcedToolChoice") === false;
}

export function noteForcedToolChoiceRefused(opts: EndpointKey): void {
  noteLearned(opts, "forcedToolChoice", false);
}
