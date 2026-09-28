/**
 * The one verdict: model type → what it requires → the request's conditions →
 * the relay upstream's cell → the platform's cell → the rule's families → the
 * official standard → its default.
 * Reads the tables only; never imports `platforms.ts` at runtime, so the two
 * cannot form a cycle.
 */

import { familyOf, isCompatStandard, type ProtocolFamily } from "../types";
import type { ModelType } from "../configDb";
import type { PlatformId, Wire } from "../platforms";
import type { RelayUpstreamId } from "../relayUpstream";
import type { CapabilityId, CapabilityReason, CapabilityStatus, CapabilityVerdict } from "./facts";
import { CAPABILITY_RULES } from "./rules";
import { PLATFORM_CELLS, platformCell } from "./cells/platform";
import { UPSTREAM_CELLS } from "./cells/upstream";
import { conditionFires, temperatureHeard, type RequestContext } from "./conditions";
import type { ReasoningEffort, ThinkingCategory } from "../reasoning";
import { patternMatches, rawModelKey } from "./modelId";

/**
 * What is known of the model — and, from an adapter, of the request
 * ({@link RequestContext}: the rules' `unless` conditions read it; each
 * condition says what its absence means). Every field optional: an absent one
 * is not consulted.
 */
export interface CapabilityModel extends RequestContext {
  modelId?: string;
  type?: ModelType;
  /**
   * The relay upstream behind the model, already resolved
   * (`relayUpstream.ts` → `capabilityModelOf` / `resolveRelayUpstream`).
   * Consulted only on a relay platform, and only for the models its
   * measurements cover. Absent = no upstream.
   */
  upstream?: RelayUpstreamId;
}

const verdict = (status: CapabilityStatus, reason: CapabilityReason): CapabilityVerdict => ({ status, reason });

/** Whether an upstream's measurements cover this model id. A blank id is covered by none. */
export function upstreamApplies(upstream: RelayUpstreamId, modelId: string | undefined): boolean {
  const key = rawModelKey(modelId);
  return !!key && patternMatches(UPSTREAM_CELLS[upstream].models, key);
}

function upstreamCellFor(
  platform: PlatformId, family: ProtocolFamily, id: CapabilityId, model: CapabilityModel,
): boolean | undefined {
  if (!model.upstream || !PLATFORM_CELLS[platform]?.relay) return undefined;
  if (!upstreamApplies(model.upstream, model.modelId)) return undefined;
  const families = UPSTREAM_CELLS[model.upstream].families;
  return families[family]?.[id] ?? families.all?.[id];
}

/**
 * The one answer. Order is fixed: model type → what it requires → the
 * request's conditions → the relay upstream's cell → the platform's cell (a
 * measurement wins) → the rule's families → the official standard → its default.
 */
export function capabilityVerdict(id: CapabilityId, wire: Wire, model: CapabilityModel = {}): CapabilityVerdict {
  return familyVerdict(id, wire.platform, familyOf(wire.standard), model, !isCompatStandard(wire.standard));
}

/**
 * {@link capabilityVerdict} for a caller that holds the family rather than the
 * standard. `official` = the vendor's own standard on that family; absent
 * means compatible, which is the answer every rule but an `official` one gives
 * either way.
 */
export function familyVerdict(
  id: CapabilityId, platform: PlatformId, family: ProtocolFamily, model: CapabilityModel = {}, official = false,
): CapabilityVerdict {
  const rule = CAPABILITY_RULES[id];
  if (model.type && rule.modelTypes && !rule.modelTypes.includes(model.type)) return verdict("no", "model-type");
  for (const dep of rule.requires ?? []) {
    if (familyVerdict(dep, platform, family, model, official).status === "no") return verdict("no", "requires");
  }
  const fired = rule.unless?.[family]?.find((c) => conditionFires(c, model));
  if (fired) return verdict("no", fired.when === "temperatureIgnored" ? "thinking" : "condition");

  // Behind a relay the upstream is the more specific measurement: the relay's
  // own cells hold for whatever upstream a model has, these for one.
  const up = upstreamCellFor(platform, family, id, model);
  if (up === false) return verdict("no", "upstream");
  if (up === true) return verdict("yes", "upstream");

  // The platform's cell: a model-id row, else the block's own value. A row is a
  // measurement about that id and wins over the block (cells/platform.ts).
  const cell = platformCell(platform, family, id, model.modelId);
  if (cell?.byRow) return cell.cell ? verdict("yes", "measured") : verdict("no", "model");
  if (cell?.cell === false) return verdict("no", "platform-absent");
  if (cell?.cell === true) return verdict("yes", "measured");
  if (cell?.cell === "per-model") {
    // Blank = nothing typed yet: the platform does run it for some ids.
    return rawModelKey(model.modelId) ? verdict("unknown", "model-unlisted") : verdict("yes", "measured");
  }
  // No cell, or rows that single other ids out: the rule below decides.

  if (!rule.families.includes(family)) return verdict("no", "family");
  if (rule.official === "yes" && official) return verdict("yes", "protocol");
  if (rule.origin === "private") {
    return rule.relay && PLATFORM_CELLS[platform]?.relay
      ? verdict(rule.relay, "relay")
      : verdict("no", "platform-unlisted");
  }
  return rule.assumed === "unknown" ? verdict("unknown", "unmeasured") : verdict("yes", "protocol");
}

/** Whether the wire has it — `unknown` counts: it is offered and sent. */
export function hasCapability(id: CapabilityId, wire: Wire, model?: CapabilityModel): boolean {
  return capabilityVerdict(id, wire, model).status !== "no";
}

/**
 * Whether a declared temperature goes out — the one question the planner asks
 * before sending it and the drawer asks before showing the field, so the two
 * cannot drift. `category` resolved, `effort` as the wire takes it (the drawer
 * passes the form's: `effortOnWire` touches only the OpenAI ladders, which
 * have no temperature condition).
 */
export function temperatureReaches(
  wire: Wire, model: CapabilityModel, category: ThinkingCategory, effort: ReasoningEffort | undefined,
): boolean {
  return hasCapability("temperature", wire, { ...model, temperatureHeard: temperatureHeard(category, effort) });
}
