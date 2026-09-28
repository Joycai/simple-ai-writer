/**
 * What a request brings to a verdict, and the one definition of whether it
 * thinks (docs/api/capability-resolution-lld.md §3.5, P4).
 *
 * Some capabilities hold on a wire only under a condition of the request:
 * Anthropic takes a temperature only where it is heard; DashScope
 * runs its interpreter on Responses only while it does, and neither the
 * interpreter nor page reading beside function tools on Chat Completions.
 * Those used to be three hand-written checks in three files, each with its own
 * idea of "thinking". They are rule data now (`rules.ts` `unless`), evaluated
 * here against a {@link RequestContext}.
 *
 * Every context field may be absent: the drawer knows the category and the
 * effort but not the tools, an adapter knows everything. A condition says what to do
 * when its input is missing — `fire` (the safe answer is "not sent") or
 * `defer` (the answer without it is the table's, and the request decides).
 */

import type { ReasoningEffort, ThinkingCategory } from "../reasoning";

/** Whether a request thinks on the wire. `unknown` = the endpoint's own default, which the app cannot see. */
export type ThinkingState = "on" | "off" | "unknown";

export interface RequestContext {
  /** The request carries function tools. */
  functionTools?: boolean;
  /** {@link wireThinks} of the category and the effort as it goes on the wire (`effortOnWire`). */
  thinking?: ThinkingState;
  /** {@link temperatureHeard} of the resolved category and that effort. */
  temperatureHeard?: boolean;
}

export type Condition =
  /** Unavailable beside function tools. */
  | { when: "functionTools"; absent: "defer" }
  /**
   * Unavailable unless the endpoint heeds a temperature on this request —
   * Anthropic's rule. Missing counts as not heard: every family's default
   * category thinks, so a caller that forgot to say gets the safe answer.
   */
  | { when: "temperatureIgnored"; absent: "fire" }
  /** Unavailable while the request's thinking state `is` this; `unknown` reads as `unknownAs`. */
  | { when: "thinking"; is: "on" | "off"; unknownAs: "on" | "off"; absent: "defer" };

/**
 * Whether thinking is on in the request, from the category and the effort it
 * carries — after `effortOnWire`, which can rewrite it. The one definition;
 * the category data (`offSpelling`, `unsetThinks`) is what varies:
 *
 *   - the `off` category sends nothing, so the endpoint decides: `unknown`
 *     (火山方舟's Anthropic route thinks with nothing sent);
 *   - an unset effort: `on` where the endpoint is known to think by default,
 *     else `unknown`;
 *   - `off`: `off` where it is really switched off, `on` where the family's
 *     off is only its lowest level;
 *   - any other level: `on`.
 */
export function wireThinks(category: ThinkingCategory, effort: ReasoningEffort | undefined): ThinkingState {
  if (category.shape === "none") return "unknown";
  if (effort === undefined || effort === "default") return category.unsetThinks ? "on" : "unknown";
  if (effort === "off") return category.offSpelling === "lowest" ? "on" : "off";
  return "on";
}

/**
 * Whether a `temperature` is heeded on the Anthropic family, from the resolved
 * category and the effort as it goes on the wire. Two cases:
 *
 *   - the `off` category — nothing about thinking is sent, and a temperature
 *     always has been (the Messages API thinks only when asked);
 *   - a category whose endpoint was measured heeding it while off
 *     (`temperatureWhenOff`), and the request really is off.
 *
 * Everything else thinks, or thinks at its lowest level, or — MiniMax —
 * switches off and still ignores the value: a field nobody reads, and a
 * drawer control that would edit nothing.
 */
export function temperatureHeard(category: ThinkingCategory, effort: ReasoningEffort | undefined): boolean {
  if (category.shape === "none") return true;
  return !!category.temperatureWhenOff && wireThinks(category, effort) === "off";
}

/** A thinking state with `unknown` read one way — each caller says which way is safe for it. */
export function thinkingAs(state: ThinkingState, unknownAs: "on" | "off"): "on" | "off" {
  return state === "unknown" ? unknownAs : state;
}

/** The context field each condition reads. */
const INPUT: { [W in Condition["when"]]: keyof RequestContext } = {
  functionTools: "functionTools",
  temperatureIgnored: "temperatureHeard",
  thinking: "thinking",
};

/** Whether the condition rules the capability out for this request. A missing input answers `absent`. */
export function conditionFires(c: Condition, ctx: RequestContext): boolean {
  if (ctx[INPUT[c.when]] === undefined) return c.absent === "fire";
  switch (c.when) {
    case "functionTools":
      return ctx.functionTools === true;
    case "temperatureIgnored":
      return ctx.temperatureHeard === false;
    case "thinking":
      return thinkingAs(ctx.thinking!, c.unknownAs) === c.is;
  }
}
