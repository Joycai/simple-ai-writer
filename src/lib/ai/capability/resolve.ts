/**
 * The one verdict: model type → what it requires → thinking → the relay
 * upstream's cell → the platform's cell → the rule's families → its default.
 * Reads the tables only; never imports `platforms.ts` at runtime, so the two
 * cannot form a cycle.
 */

import { familyOf, type ProtocolFamily } from "../types";
import type { ModelType } from "../configDb";
import type { PlatformId, Wire } from "../platforms";
import type { ThinkingCategoryId } from "../reasoning";
import type { RelayUpstreamId } from "../relayUpstream";
import type { CapabilityId, CapabilityReason, CapabilityStatus, CapabilityVerdict } from "./facts";
import { CAPABILITY_RULES } from "./rules";
import { PLATFORM_CAPABILITIES, type CapabilityCell } from "./cells/platform";
import { UPSTREAM_CAPABILITIES } from "./cells/upstream";

/** What is known of the model. Every field optional: an absent one is not consulted. */
export interface CapabilityModel {
  modelId?: string;
  type?: ModelType;
  /**
   * The *resolved* category (`resolveThinkingCategory`). Consulted only by a
   * `thinkingOff` rule, where absent reads as the family default — thinking.
   */
  thinkingCategory?: ThinkingCategoryId;
  /**
   * The relay upstream behind the model, already resolved
   * (`relayUpstream.ts` → `capabilityModelOf` / `resolveRelayUpstream`).
   * Consulted only on a relay platform, and only for the models its
   * measurements cover. Absent = no upstream.
   */
  upstream?: RelayUpstreamId;
}

const verdict = (status: CapabilityStatus, reason: CapabilityReason): CapabilityVerdict => ({ status, reason });

function cellFor(platform: PlatformId, family: ProtocolFamily, id: CapabilityId): CapabilityCell | undefined {
  const families = PLATFORM_CAPABILITIES[platform]?.families;
  return families?.[family]?.[id] ?? families?.all?.[id];
}

/** Whether an upstream's measurements cover this model id. A blank id is covered by none. */
export function upstreamApplies(upstream: RelayUpstreamId, modelId: string | undefined): boolean {
  const mid = modelId?.trim().toLowerCase();
  return !!mid && UPSTREAM_CAPABILITIES[upstream].models.test(mid);
}

function upstreamCellFor(
  platform: PlatformId, family: ProtocolFamily, id: CapabilityId, model: CapabilityModel,
): boolean | undefined {
  if (!model.upstream || !PLATFORM_CAPABILITIES[platform]?.relay) return undefined;
  if (!upstreamApplies(model.upstream, model.modelId)) return undefined;
  const families = UPSTREAM_CAPABILITIES[model.upstream].families;
  return families[family]?.[id] ?? families.all?.[id];
}

/**
 * The one answer. Order is fixed: model type → what it requires → thinking →
 * the relay upstream's cell → the platform's cell (a measurement wins) → the
 * rule's families → its default.
 */
export function capabilityVerdict(id: CapabilityId, wire: Wire, model: CapabilityModel = {}): CapabilityVerdict {
  return familyVerdict(id, wire.platform, familyOf(wire.standard), model);
}

/** {@link capabilityVerdict} for a caller that already holds the family. */
export function familyVerdict(id: CapabilityId, platform: PlatformId, family: ProtocolFamily, model: CapabilityModel = {}): CapabilityVerdict {
  const rule = CAPABILITY_RULES[id];
  if (model.type && rule.modelTypes && !rule.modelTypes.includes(model.type)) return verdict("no", "model-type");
  for (const dep of rule.requires ?? []) {
    if (familyVerdict(dep, platform, family, model).status === "no") return verdict("no", "requires");
  }
  if (rule.thinkingOff?.includes(family) && model.thinkingCategory !== "off") {
    return verdict("no", "thinking");
  }

  // Behind a relay the upstream is the more specific measurement: the relay's
  // own cells hold for whatever upstream a model has, these for one.
  const up = upstreamCellFor(platform, family, id, model);
  if (up === false) return verdict("no", "upstream");
  if (up === true) return verdict("yes", "upstream");

  const cell = cellFor(platform, family, id);
  if (cell === false) return verdict("no", "platform-absent");
  if (cell === true) return verdict("yes", "measured");
  if (cell) {
    // Blank = nothing typed yet: the axis is not consulted.
    const mid = model.modelId?.trim().toLowerCase();
    if (mid && cell.refuses?.some((re) => re.test(mid))) return verdict("no", "model");
    if (cell.runs) {
      if (!mid) return verdict("yes", "measured");
      return cell.runs.some((re) => re.test(mid)) ? verdict("yes", "measured") : verdict("unknown", "model-unlisted");
    }
    // A refuses-only matcher: the ids it does not name fall to the rule below.
  }

  if (!rule.families.includes(family)) return verdict("no", "family");
  if (rule.origin === "private") {
    return rule.relay && PLATFORM_CAPABILITIES[platform]?.relay
      ? verdict(rule.relay, "relay")
      : verdict("no", "platform-unlisted");
  }
  return rule.assumed === "unknown" ? verdict("unknown", "unmeasured") : verdict("yes", "protocol");
}

/** Whether the wire has it — `unknown` counts: it is offered and sent. */
export function hasCapability(id: CapabilityId, wire: Wire, model?: CapabilityModel): boolean {
  return capabilityVerdict(id, wire, model).status !== "no";
}
