/**
 * Where a value came from, and who may act on it
 * (docs/api/capability-resolution-hld.md §4.3, LLD §3.9, P6).
 *
 * A value fact the author left unset is answered by the tables — a platform's
 * measurement, the model catalog, the protocol's default. Those answers are
 * good enough to plan with and not always good enough to send: a catalog cap
 * above what an endpoint takes is a 400 on every Anthropic request, where on
 * the budget planner it only costs a slightly generous plan. So a value
 * travels with its source, and each consumer names the sources it trusts —
 * the rule `modelLimits.ts`'s header used to state in a comment, as data.
 */

/**
 * `author`: on the model row — typed, prefilled and saved, or written by the
 * probe (a measurement of this very endpoint, stored in the author's field;
 * provider-layering 偏离三). The rest are the tables, most specific first,
 * then the app-wide default the author set in Settings.
 */
export type Source = "author" | "platform" | "catalog" | "protocol" | "default";

export interface Sourced<V> {
  value: V;
  source: Source;
}

/** Where a request's numeric model values came from — `ConnOptions.provenance`. */
export interface Provenance {
  contextSize?: Source;
  maxOutput?: Source;
}

/** Everything that reads a numeric value fact and has its own stake in a wrong one. */
type Consumer = "planner" | "contextGate" | "anthropicMaxTokens";

export const TRUST: Record<Consumer, readonly Source[]> = {
  // Guessing low plans conservatively; guessing high costs nothing the
  // truncation recovery does not already handle.
  planner: ["author", "platform", "catalog", "protocol", "default"],
  // A wrong window refuses a request before it is sent (`ContextSizeError`).
  contextGate: ["author"],
  // Above the model's own ceiling is a 400 on every request (D2); untrusted
  // falls to the adapter's own default (`modelLimits.ts`).
  anthropicMaxTokens: ["author"],
};

/** The value, if `consumer` trusts where it came from. */
export function trusted<V>(v: Sourced<V> | undefined, consumer: Consumer): V | undefined {
  return v && TRUST[consumer].includes(v.source) ? v.value : undefined;
}

/**
 * A number a request carries, with the source `connOptions()` recorded for it.
 * A hand-built option bag records none: its number is the caller's own, as
 * trusted as the author's (the translation engine sizes `maxOutput` per chunk).
 */
export function carried(value: number | undefined, source: Source | undefined): Sourced<number> | undefined {
  return value && value > 0 ? { value, source: source ?? "author" } : undefined;
}
