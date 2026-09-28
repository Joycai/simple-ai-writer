/**
 * What an endpoint has refused, learned from its own 400
 * (docs/api/capability-resolution-lld.md §3.7, P3; kept across restarts, §9.13).
 *
 * Some refusals are not recoverable from the config. DeepSeek V4 thinks
 * unconditionally and answers a forced `tool_choice` with `400 Thinking mode
 * does not support this tool_choice`; a model may refuse strict `json_schema`,
 * a relay `response_format` altogether. The endpoint's 400 is the declaration:
 * it is definitive, it arrives before a single token is generated, and it
 * costs nothing to act on. So it is remembered, per endpoint+model, as a
 * **ceiling** on the fact it names, and every later request is sent under it.
 *
 * Two memos used to do this, one in the retired `toolChoice.ts` (a Set) and one in
 * `jsonMode.ts` (a Map), each with its own key, its own classifier and its own
 * reset. They are one store now, and adding a third learnable fact is a row in
 * {@link LEARN_RULES} plus its ceiling type in `Ceilings`.
 *
 * The table resolution (`resolve.ts`) never reads this: it stays a pure
 * function of the tables. The ceiling is applied after it — by
 * `effectiveStructuredOutput`, by the forced-choice checks, and by the facade
 * `capabilityVerdict` when it is given the endpoint's address, which is how the
 * drawer's matrix shows it (reason `learned`).
 *
 * A fact about an endpoint, not about the author's config (decision D3, as
 * revised): so it has a time and an age limit. Reads are in memory and
 * synchronous — the plan, the adapters and the drawer never wait on it. A sink
 * (`learnedDb.ts`, registered once the config database is open) writes each
 * lowering through to `config.db` and deletes what is forgotten; the table is
 * read back into memory at startup (`seedLearned`). A ceiling older than
 * {@link LEARNED_TTL_MS} is gone: endpoints and relays change, and re-learning
 * one costs a single 400 before generation. The author forgets one sooner by
 * changing the model's declaration or probing it again (`forgetLearned`).
 *
 * Not keyed by thinking effort — an endpoint that refuses forcing only while
 * thinking is treated as refusing it always, which costs at worst the JSON
 * fallback firing a turn early.
 */

import type { StructuredOutputMode } from "../jsonMode";
import type { ApiStandard } from "../types";
import type { Wire } from "../platforms";
import type { CapabilityId } from "./facts";
import { hasCapability } from "./resolve";

/**
 * One endpoint+model. The standard is in the key because one host can serve
 * several protocol families and they don't have to agree. A `ConnOptions` or
 * `StreamOptions` bag qualifies as it is.
 */
export interface EndpointKey {
  standard: ApiStandard;
  baseUrl?: string;
  modelId?: string;
}

/** Per learnable fact, what a ceiling on it holds: a switch goes to `false`, a tier to the strongest one left. */
interface Ceilings {
  forcedToolChoice: false;
  structuredOutput: StructuredOutputMode;
}
export type LearnedFact = keyof Ceilings;
type Ceiling = Ceilings[LearnedFact];
/** A fact and a ceiling of that fact's own type. */
type Learned = { [F in LearnedFact]: { fact: F; ceiling: Ceilings[F] } }[LearnedFact];

/** What one request put on the wire that an endpoint may refuse — read off its plan. */
export interface Attempt {
  /** A forced `tool_choice` went out (`RequestPlan.toolChoice.sent`), not merely was asked for. */
  forcedToolChoice?: boolean;
  /** The JSON tier actually shaped into the body (`RequestPlan.json.mode`), which can sit below the plan's tier. */
  structuredOutput?: StructuredOutputMode;
}

/** Strength order: a structured-output ceiling only ever moves *down* this list. */
export const STRUCTURED_RANK: Record<StructuredOutputMode, number> = { off: 0, json_object: 1, json_schema: 2 };

/** The next weaker mode, or undefined when there is nothing weaker than `off`. */
export function downgradeJsonMode(mode: StructuredOutputMode): StructuredOutputMode | undefined {
  return mode === "json_schema" ? "json_object" : mode === "json_object" ? "off" : undefined;
}

const rankOf = (c: Ceiling): number => (c === false ? 0 : STRUCTURED_RANK[c]);

interface LearnRule<F extends LearnedFact> {
  fact: F;
  /**
   * The error names the parameter itself. Narrow on purpose: broader phrasings
   * ("does not support", "thinking mode") also match genuine, unrelated
   * failures, and a retry there would resend the whole context only to fail a
   * second time.
   */
  match: RegExp;
  /** This request did use the fact — otherwise the 400 is not about it. */
  used: (a: Attempt) => boolean;
  /** The ceiling to learn; undefined = already at the bottom, nothing to learn. */
  lower: (a: Attempt) => Ceilings[F] | undefined;
}

/** Each learnable fact, and how its refusal reads. First match wins. */
const LEARN_RULES: readonly { [F in LearnedFact]: LearnRule<F> }[LearnedFact][] = [
  // `Thinking mode does not support this tool_choice` (DeepSeek V4),
  // `Invalid value for 'tool_choice'`. Downgrading is safe for both callers
  // that force: `agent/structured.ts` treats "the model declined the tool" as
  // its cue to re-run in JSON mode, and the handoff round hands off on the
  // round's prose (`handoff.fallbackBrief`). Neither ever relied on forcing.
  {
    fact: "forcedToolChoice",
    match: /tool[_ ]?choice/i,
    used: (a) => a.forcedToolChoice === true,
    lower: () => false,
  },
  // Four spellings, because four wires: `response_format` (chat completions —
  // OpenAI's `… 'response_format' of type 'json_schema' is not supported with
  // this model`, and the `'messages' must contain the word 'json'` precondition
  // error), `text.format` (the Responses API, docs/api/responses.md §2.2), the
  // generationConfig field a Gemini endpoint names when it does not recognise
  // it (`Unknown name "responseJsonSchema"`), in either casing, and Anthropic's
  // `output_config.format` (or the retired beta `output_format`). A DashScope
  // sample is still owed (structured-output-plan.md §11.3). An endpoint that
  // ignores the field silently is the one case this cannot learn from; the
  // cue is still there to catch the fall.
  {
    fact: "structuredOutput",
    match: /response_format|text\.format|response_?json_?schema|output_config\.format|output_format/i,
    used: (a) => a.structuredOutput !== undefined && a.structuredOutput !== "off",
    lower: (a) => (a.structuredOutput ? downgradeJsonMode(a.structuredOutput) : undefined),
  },
];

/**
 * Which learnable fact this error refuses, and the ceiling to learn — or
 * undefined when it refuses nothing this request used. An abort never teaches.
 */
export function classify(err: unknown, attempt: Attempt): Learned | undefined {
  if (err instanceof DOMException && err.name === "AbortError") return undefined;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  for (const rule of LEARN_RULES) {
    if (!rule.used(attempt) || !rule.match.test(msg)) continue;
    const ceiling = rule.lower(attempt);
    if (ceiling !== undefined) return { fact: rule.fact, ceiling } as Learned;
  }
  return undefined;
}

function keyOf(k: EndpointKey): string {
  return `${k.standard} ${k.baseUrl ?? ""} ${k.modelId ?? ""}`;
}

/** How long a learned ceiling holds: a week, then the endpoint is asked again. */
export const LEARNED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Held<F extends LearnedFact> = { ceiling: Ceilings[F]; learnedAt: number };
const store = new Map<string, { [F in LearnedFact]?: Held<F> }>();
let now = () => Date.now();

/** A ceiling as it is kept on disk: one row per endpoint+model+fact. */
export type LearnedRow = { [F in LearnedFact]: EndpointKey & { fact: F; ceiling: Ceilings[F]; learnedAt: number } }[LearnedFact];

/** Where a lowering is written through to, and a forgetting deleted from. */
export interface LearnedSink {
  write(row: LearnedRow): void;
  forget(k: EndpointKey, facts: readonly LearnedFact[]): void;
}
let sink: LearnedSink | undefined;

/** Register (or, with undefined, drop) the persistence behind the store. */
export function setLearnedSink(next: LearnedSink | undefined): void {
  sink = next;
}

const live = <F extends LearnedFact>(held: Held<F> | undefined): Held<F> | undefined =>
  held && now() - held.learnedAt < LEARNED_TTL_MS ? held : undefined;

/** The ceiling this endpoint+model has taught for one fact, or undefined when it refused nothing (lately). */
export function learnedCeiling<F extends LearnedFact>(k: EndpointKey, fact: F): Ceilings[F] | undefined {
  return live(store.get(keyOf(k))?.[fact] as Held<F> | undefined)?.ceiling;
}

/** Put a ceiling in memory unless a lower one is already held. True when it went in. */
function hold<F extends LearnedFact>(k: EndpointKey, fact: F, ceiling: Ceilings[F], learnedAt: number): boolean {
  const key = keyOf(k);
  const entry = store.get(key) ?? {};
  const current = live(entry[fact] as Held<F> | undefined);
  if (current !== undefined && rankOf(current.ceiling) <= rankOf(ceiling)) return false;
  (entry as Record<LearnedFact, Held<LearnedFact>>)[fact] = { ceiling, learnedAt };
  store.set(key, entry);
  return true;
}

/** Remember a refusal. Only ever lowers: a weaker refusal learned earlier is never lifted by a later one. */
export function noteLearned<F extends LearnedFact>(k: EndpointKey, fact: F, ceiling: Ceilings[F]): void {
  const learnedAt = now();
  if (!hold(k, fact, ceiling, learnedAt)) return;
  sink?.write({ standard: k.standard, baseUrl: k.baseUrl, modelId: k.modelId, fact, ceiling, learnedAt } as LearnedRow);
}

/**
 * Take in ceilings read back from disk. The lower of disk and memory wins —
 * a request may have learned something while the table was loading — and an
 * expired row is not taken. Nothing is written back.
 */
export function seedLearned(rows: readonly LearnedRow[]): void {
  for (const r of rows) hold(r, r.fact, r.ceiling, r.learnedAt);
}

/** Every learnable fact. */
const LEARNED_FACTS: readonly LearnedFact[] = ["forcedToolChoice", "structuredOutput"];

/** Forget what this endpoint+model taught — every fact, or just these — in memory and on disk. */
export function forgetLearned(k: EndpointKey, facts: readonly LearnedFact[] = LEARNED_FACTS): void {
  const entry = store.get(keyOf(k));
  if (entry) for (const f of facts) delete entry[f];
  sink?.forget(k, facts);
}

/** Forget everything in memory — the app reset, which empties the table itself. */
export function clearLearned(): void {
  store.clear();
}

/**
 * The capabilities a ceiling takes away, and the weakest tier on this wire
 * that still keeps each. A strict-tier refusal takes `jsonSchema`; it takes
 * `structuredOutput` too where the wire has no JSON-object tier to fall to
 * (Anthropic: the cue alone is what is left), and a JSON-mode refusal takes
 * it everywhere.
 */
const TAKES_AWAY: Partial<Record<CapabilityId, { fact: LearnedFact; keeps?: (wire: Wire) => StructuredOutputMode }>> = {
  forcedToolChoice: { fact: "forcedToolChoice" },
  structuredOutput: {
    fact: "structuredOutput",
    keeps: (wire) => (hasCapability("jsonObjectTier", wire) ? "json_object" : "json_schema"),
  },
  jsonSchema: { fact: "structuredOutput", keeps: () => "json_schema" },
};

/** Whether this endpoint+model has refused the capability (within the age limit). */
export function learnedRefuses(id: CapabilityId, wire: Wire, k: EndpointKey): boolean {
  const takes = TAKES_AWAY[id];
  if (!takes) return false;
  const ceiling = learnedCeiling(k, takes.fact);
  if (ceiling === undefined) return false;
  return ceiling === false || (takes.keeps !== undefined && STRUCTURED_RANK[ceiling] < STRUCTURED_RANK[takes.keeps(wire)]);
}

/** Tests only — the store outlives a single request by design. Also restores the real clock. */
export function __resetLearned(): void {
  store.clear();
  now = () => Date.now();
}

/** Tests only: the clock ages are measured by. */
export function __setLearnedClock(clock: () => number): void {
  now = clock;
}
