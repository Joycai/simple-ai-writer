/**
 * When something the author does retires what an endpoint taught
 * (docs/api/capability-resolution-lld.md §9.13, decision D3 as revised).
 *
 * A learned ceiling otherwise holds for a week (`capability/learned.ts`). Two
 * of the author's own acts end it sooner, because each is a new statement
 * about the endpoint that deserves one more try:
 *
 *   - changing the model's structured-output declaration — the author is
 *     saying what this model takes; the old refusal of a tier is not allowed
 *     to overrule that silently for the rest of the week;
 *   - probing the model — "look at this endpoint again", on the route probed.
 *
 * The key is the one requests go out under: `connOptions` puts the route's
 * standard and address and the row's model id on every request, and so do the
 * probe's own requests.
 */
import { forgetLearned, type EndpointKey } from "./capability/learned";
import type { Model, Provider } from "./configDb";
import type { ProbeReport } from "./endpointProbe";
import { activeFamily, providerFor } from "./routes";

const keyOn = (route: Provider, modelId: string): EndpointKey =>
  ({ standard: route.apiStandard, baseUrl: route.baseUrl, modelId });

/**
 * Forget the structured-output ceiling of the route whose declaration the
 * author just changed. Only when the save kept the row on the same channel
 * and route: a route switch loads that route's parked declaration, which the
 * author did not write just now.
 */
export function forgetOnDeclarationChange(prev: Model | undefined, next: Model, providers: readonly Provider[]): void {
  if (!prev || prev.structuredOutput === next.structuredOutput || prev.providerId !== next.providerId) return;
  const channel = providers.find((p) => p.id === next.providerId);
  if (!channel || activeFamily(prev, channel) !== activeFamily(next, channel)) return;
  const route = providerFor(next, providers);
  if (route) forgetLearned(keyOn(route, next.modelId), ["structuredOutput"]);
}

/**
 * Whether the probe got the endpoint to answer — only then has it been looked
 * at again. A cancelled run does not count, whatever it got to.
 */
function probeReached(report: ProbeReport): boolean {
  return report.answered && !report.warnings.some((w) => w.code === "aborted");
}

/**
 * Forget everything the probed route taught about this model, when the probe
 * reached the endpoint. `route` is the route provider the probe ran on.
 */
export function forgetOnProbe(route: Provider, modelId: string, report: ProbeReport): void {
  if (probeReached(report)) forgetLearned(keyOn(route, modelId));
}
