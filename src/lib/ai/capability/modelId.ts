/**
 * The model-id axis: one pattern type, and one way to find the row that
 * answers a question about an id (docs/api/capability-resolution-lld.md §3.1–§3.2).
 *
 * Seven tables used to key facts by model id, matching four ways — exact ids,
 * longest normalised prefix, any normalised prefix, raw-id regexes. Each now
 * holds rows of `{ match: ModelPattern, … }`, sorted once by
 * {@link bySpecificity} and searched by {@link rowSetting}. What differs between
 * tables is only which *key* they match against:
 *
 *   - platform and relay-upstream cells match {@link rawModelKey} — the id as
 *     the endpoint names it, namespace and all (OrcaRouter's `openai/gpt-6-astra`);
 *   - the global catalog matches {@link canonicalModelId} — the model's own
 *     name, so `openai/gpt-4o` and a dated `gpt-4o-2024-11-20` find `gpt-4o`.
 *
 * Stripping a relay's `[CC量]`-style prefix before matching is a later phase
 * (P6b), deliberately not this one: it widens which ids the catalog answers.
 */

/**
 * `eq`: the whole key. `prefix`: a plain `startsWith` — `glm-5` is meant to
 * cover `glm-5v-turbo` and `gpt-5` to cover `gpt-5.6-sol`, so there is no
 * segment boundary. A `RegExp` is tested as written (never with the `g` flag —
 * `test` would then carry state between calls).
 */
export type ModelPattern = { eq: string } | { prefix: string } | RegExp;

export const eq = (id: string): ModelPattern => ({ eq: id });
export const prefix = (p: string): ModelPattern => ({ prefix: p });

/** Trimmed and lower-cased — what platform and upstream rows match. Empty for a blank id. */
export function rawModelKey(modelId: string | undefined): string {
  return modelId?.trim().toLowerCase() ?? "";
}

/**
 * The model's own name: {@link rawModelKey} less a `vendor/` namespace, the way
 * relays and aggregators spell ids (`openai/gpt-4o`). A date suffix is left on —
 * a prefix row steps over it.
 */
export function canonicalModelId(modelId: string | undefined): string {
  const id = rawModelKey(modelId);
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

export function patternMatches(p: ModelPattern, key: string): boolean {
  if (p instanceof RegExp) return p.test(key);
  return "eq" in p ? key === p.eq : key.startsWith(p.prefix);
}

const rank = (p: ModelPattern): number => (p instanceof RegExp ? 2 : "eq" in p ? 0 : 1);
const prefixLength = (p: ModelPattern): number => (p instanceof RegExp || "eq" in p ? 0 : p.prefix.length);

/**
 * Rows in the order they are consulted: exact ids, then prefixes longest first,
 * then regexes in the order written. Stable, so equal prefixes keep their order.
 */
export function bySpecificity<R extends { match: ModelPattern }>(rows: readonly R[]): readonly R[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) =>
      rank(a.row.match) - rank(b.row.match)
      || prefixLength(b.row.match) - prefixLength(a.row.match)
      || a.i - b.i)
    .map(({ row }) => row);
}

/**
 * The first row — in {@link bySpecificity} order — that says something about
 * the fact being asked (`sets`) and matches the key. A row that matches but is
 * silent on the fact is stepped over, so a narrow row can carry one fact
 * without hiding what a wider row says about the others.
 */
export function rowSetting<R extends { match: ModelPattern }>(
  rows: readonly R[] | undefined,
  key: string,
  sets: (row: R) => boolean,
): R | undefined {
  if (!key || !rows) return undefined;
  return rows.find((row) => sets(row) && patternMatches(row.match, key));
}
