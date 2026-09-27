/**
 * Capability gating — one table, one verdict.
 *
 * "Can this model do X on this wire" used to be answered once per asker (the
 * model drawer, the adapter, the 将发送 summary, the chat surface), each with
 * its own function and its own idea of which layer decides. A platform's
 * private field gated by protocol family — DashScope's
 * `vl_high_resolution_images` showing up on 智谱 — is what that shape
 * produces. Plan and reasoning: docs/api/capability-gating-plan.md.
 *
 * Two tables, both data:
 *
 *   - {@link CAPABILITY_RULES}: what the *protocol* says about a capability —
 *     which families spell it at all, and what to assume of a platform that
 *     has said nothing.
 *   - {@link PLATFORM_CELLS}: what each *platform* was measured to do,
 *     keyed platform × family × capability, with an optional model-id matcher
 *     as the third axis. Endpoint-run tools live here too: which tool a wire
 *     runs is a fact about the platform and the model id, like any other.
 *   - {@link UPSTREAM_CELLS}: on a relay, what each upstream behind it
 *     was measured to do — the same cells, consulted before the relay's own
 *     when the model's upstream is known (`relayUpstream.ts` resolves it).
 *
 * Every asker — the adapters, the 将发送 summary, the drawers, the chat
 * surface — calls {@link capabilityVerdict} or {@link hasCapability} here
 * directly; there are no per-capability wrappers to drift apart (the tables
 * are exported for the tests that walk them). This file never imports
 * `platforms.ts` at runtime, so the two cannot form a cycle.
 *
 * This file is the facade: the tables and the verdict live under
 * `capability/` (`facts` · `rules` · `cells/platform` · `cells/upstream` ·
 * `resolve`, docs/api/capability-resolution-lld.md P1) and are re-exported
 * here, so every caller keeps importing from `capabilities`. What stays in
 * this file is what is built on the verdict: the effort ladder and the
 * server-tool section gate — and the one place the session's learned
 * refusals meet the tables (`capability/learned.ts`).
 */

import { familyOf } from "./types";
import type { Wire } from "./platforms";
import type { ReasoningEffort } from "./reasoning";
import type { CapabilityId } from "./capability/facts";
import { SERVER_TOOL_CAPABILITIES } from "./capability/facts";
import type { CapabilityVerdict } from "./capability/facts";
import { learnedRefuses } from "./capability/learned";
import { capabilityVerdict as tableVerdict, hasCapability, type CapabilityModel } from "./capability/resolve";

export { CAPABILITY_IDS, CAPABILITY_REASONS, SERVER_TOOL_CAPABILITIES, type CapabilityId } from "./capability/facts";
export { CAPABILITY_RULES } from "./capability/rules";
export { PLATFORM_CELLS, platformModelCalibration, platformResponsesInclude } from "./capability/cells/platform";
export { UPSTREAM_CELLS } from "./capability/cells/upstream";
export { familyVerdict, hasCapability, upstreamApplies } from "./capability/resolve";
export { carried, TRUST, trusted, type Source, type Sourced } from "./capability/intent";
export { modelValue, resolveThinkingCategory, thinkingCategoryOf } from "./capability/values";
export { canonicalModelId } from "./capability/modelId";

/**
 * The one answer, from the tables (`capability/resolve.ts`) — and, given the
 * endpoint's address, capped by what that endpoint+model refused this session
 * (reason `learned`). The resolution itself stays a pure function of the
 * tables; the cap is laid on here, after it, so a table `no` keeps its own
 * reason. Only the drawer passes the address: the request path reads the same
 * store through `effectiveStructuredOutput` and the forced-choice checks.
 */
export function capabilityVerdict(id: CapabilityId, wire: Wire, model: CapabilityModel = {}, baseUrl?: string): CapabilityVerdict {
  const v = tableVerdict(id, wire, model);
  if (baseUrl === undefined || v.status === "no") return v;
  return learnedRefuses(id, wire, { standard: wire.standard, baseUrl, modelId: model.modelId })
    ? { status: "no", reason: "learned" }
    : v;
}

/** The two OpenAI wires — the only ones whose effort ladder the two effort cells speak about. */
function effortLadderWire(wire: Wire): boolean {
  const family = familyOf(wire.standard);
  return family === "openai" || family === "responses";
}

/**
 * The effort a request actually carries on this wire, from the one the model
 * row holds. Two cells can change it, and only on the OpenAI wires:
 *
 *   - `effortWithTools` is `no` and the request carries function tools → `off`,
 *     whatever the row says. OpenAI's Chat Completions refuses any other
 *     effort beside tools, the model's own default included, so an agent run
 *     would fail on its first round; thinking is what gives way.
 *   - `reasoningOff` is `no` and the row says `off` → `low`, the least thinking
 *     the model takes (the gateway rewrites `minimal` to `low` anyway).
 *   - `effortMax` is `no` and the row says `max` → `xhigh`, the ladder's next
 *     rung down; `effortMinimal` is `no` and it says `minimal` → `low`, the
 *     next rung up. The nearest level keeps what the author asked for as
 *     close as the model allows.
 */
export function effortOnWire(
  effort: ReasoningEffort | undefined,
  wire: Wire,
  model: CapabilityModel,
  withTools: boolean,
): ReasoningEffort | undefined {
  if (!effortLadderWire(wire)) return effort;
  if (withTools && !hasCapability("effortWithTools", wire, model)) return "off";
  if (effort === "off" && !hasCapability("reasoningOff", wire, model)) return "low";
  if (effort === "max" && !hasCapability("effortMax", wire, model)) return "xhigh";
  if (effort === "minimal" && !hasCapability("effortMinimal", wire, model)) return "low";
  return effort;
}

/** Each ladder level a cell can take away, and the cell that says so. */
const LEVEL_CELLS: readonly [ReasoningEffort, CapabilityId][] = [
  ["off", "reasoningOff"],
  ["max", "effortMax"],
  ["minimal", "effortMinimal"],
];

/**
 * A category's effort menu as this wire takes it — the category's own list,
 * less each level the model refuses (`reasoningOff`, `effortMax`,
 * `effortMinimal`). Every dial that lists levels reads this, so the drawer and
 * the panel cannot disagree.
 */
export function effortMenuOnWire(
  menu: readonly ReasoningEffort[],
  wire: Wire | undefined,
  model: CapabilityModel,
): ReasoningEffort[] {
  if (!wire || !effortLadderWire(wire)) return [...menu];
  const refused = new Set(LEVEL_CELLS.filter(([, id]) => !hasCapability(id, wire, model)).map(([level]) => level));
  return menu.filter((e) => !refused.has(e));
}

/**
 * Whether this wire has any endpoint-run tool at all — the drawer's section gate.
 *
 * Asked of the **platform and family**, never of the standard alone. The
 * standard used to be the whole answer, and `openai_compat` quietly meant
 * "DashScope": every DeepSeek, New API, OrcaRouter or Ollama row could declare
 * 联网搜索 and sent DashScope's private `enable_search` to a server that had
 * never heard of it (docs/feature/channel-model-route-plan.md §1). Offering
 * the setting where the adapter would drop it is the failure this guards
 * against — a control that does nothing is worse than no control.
 */
export function hasAnyServerTool(wire: Wire): boolean {
  return SERVER_TOOL_CAPABILITIES.some((id) => hasCapability(id, wire));
}
