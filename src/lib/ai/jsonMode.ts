/**
 * "Give me JSON" request shaping, per wire protocol — and per model.
 *
 * Each protocol enforces a JSON response differently, and one of them doesn't
 * offer the knob at all — so the decision lives here rather than being
 * re-derived at each call site. It used to be a two-way `standard === "gemini"`
 * ternary duplicated in lore/generator.ts and lore/splitter.ts, which meant
 * both of them sent OpenAI's `response_format` to *everything* else. That is a
 * hard 400 on Anthropic, whose Messages API rejects unknown top-level fields.
 *
 * The protocol decides the *spelling*; the **model** decides the *strength*.
 * Within one family — even behind one base URL — some models accept the strict
 * `json_schema` mode, most accept only `json_object`, and a relay may reject
 * `response_format` outright. None of that is recoverable from the protocol
 * family, so it is declared on the model (`Model.structuredOutput`, same shape
 * as `thinkingCategory`) and resolved here: an explicit declaration wins,
 * otherwise the family default, lifted to `json_schema` for model ids known to
 * take it. See `docs/api/structured-output-plan.md`.
 *
 * Callers that need schema *enforcement* rather than "valid JSON, shape
 * described in prose" should use agent/structured.ts instead — it forces a
 * pseudo-tool call, which every protocol here supports natively. A *thinking*
 * model may refuse a forced tool choice, so that path falls back to this one;
 * the shaping below is what keeps the fallback from being pure prose — and,
 * when the model takes `json_schema`, what keeps the schema enforced there too.
 */

import { strictify } from "./jsonSchemaStrict";
import { normalizeModelId } from "./modelLimits";
import { familyOf, type ApiStandard } from "./types";

// ─── The author's declaration ─────────────────────────────────────────────────

/**
 * How this model is asked for JSON, in this app's own vocabulary.
 *
 *   - `off`          — send no JSON parameter at all; the text cue is the whole
 *                      mechanism. Safe on every relay, which is the point: any
 *                      field this app volunteers is a field some gateway rejects.
 *   - `json_object`  — the protocol's JSON mode (① `response_format`,
 *                      ③ `responseMimeType`): the reply is valid JSON, its shape
 *                      is whatever the prose asked for.
 *   - `json_schema`  — strict schema mode (① `response_format.json_schema`):
 *                      the reply matches the schema. Needs a schema at the call
 *                      site; without one it behaves as `json_object`.
 *
 * Absent (every model configured before this existed) means **auto** — see
 * `resolveStructuredOutput`. The `auto` state is a UI sentinel, never stored.
 */
export type StructuredOutputMode = "off" | "json_object" | "json_schema";

export const STRUCTURED_OUTPUT_MODES: StructuredOutputMode[] = ["off", "json_object", "json_schema"];

/** Narrow a stored string to the union — the DB column is free text. */
export function parseStructuredOutputMode(v: unknown): StructuredOutputMode | undefined {
  return typeof v === "string" && (STRUCTURED_OUTPUT_MODES as string[]).includes(v)
    ? (v as StructuredOutputMode)
    : undefined;
}

// ─── Auto: what an undeclared model gets ──────────────────────────────────────

/**
 * modelId prefixes documented to accept strict `json_schema` mode.
 *
 * Lifts the family default *up* only: a model not listed here stays on
 * `json_object`, which is exactly what every model got before this table
 * existed. So a stale table costs at worst a missed upgrade, never a request
 * that used to work and now fails.
 *
 * Matched after `normalizeModelId` (lower-cased, `vendor/` prefix stripped),
 * longest prefix wins — the same rule as `KNOWN_OUTPUT_CAPS`. A relay alias like
 * `特价 | qwen3.8-max` matches neither table; that model is declared by hand.
 */
const KNOWN_JSON_SCHEMA: ReadonlyArray<string> = [
  // ── Qwen (DashScope) — the platform's own list, 2026-09 ──
  "qwen3.7-plus", "qwen3.7-flash", "qwen3.7-max",
  "qwen3.8-max", "qwen3.8-flash",
  // ── OpenAI ──
  "gpt-5", "gpt-4.1", "gpt-4o",
];

/** Whether this model id is documented to accept strict `json_schema` mode. */
export function knownJsonSchemaModel(modelId: string): boolean {
  const id = normalizeModelId(modelId);
  return KNOWN_JSON_SCHEMA.some((prefix) => id.startsWith(prefix));
}

/** The transport facts the resolution reads — a subset of `ConnOptions`. */
export interface JsonModeTarget {
  standard: ApiStandard;
  modelId?: string;
  /** The endpoint, for the session memo below; absent means "unknown endpoint". */
  baseUrl?: string;
  /** The author's declaration on the model row; absent = auto. */
  structuredOutput?: StructuredOutputMode;
}

/**
 * The mode this request will actually use.
 *
 * The Anthropic family has no JSON parameter, so it resolves to `off` whatever
 * the row says — there is nothing else it *could* send, and a declaration that
 * survived a provider change to a different family must not reach the wire.
 */
export function resolveStructuredOutput(target: JsonModeTarget): StructuredOutputMode {
  const family = familyOf(target.standard);
  if (family === "anthropic") return "off";
  if (target.structuredOutput) return target.structuredOutput;
  return family === "openai" && target.modelId && knownJsonSchemaModel(target.modelId)
    ? "json_schema"
    : "json_object";
}

// ─── Shaping ──────────────────────────────────────────────────────────────────

/** How to ask this endpoint for JSON. Both halves may be absent. */
export interface JsonModeShaping {
  /** The mode the request ended up in — for logs and tests, not for branching. */
  mode: StructuredOutputMode;
  /** Top-level request fields, or undefined when the protocol has no knob. */
  extraBody?: Record<string, unknown>;
  /**
   * Text to append to the user turn, or undefined when nothing is needed.
   * Append it verbatim; the wording is shared so call sites can't drift.
   */
  cue?: string;
}

/** The cue itself, so the call sites can't drift in wording. */
export const JSON_ONLY_CUE =
  "Output ONLY valid JSON matching the schema in the system instructions. No markdown fences, no explanation.";

/**
 * The schema a `json_schema` request enforces: the name and parameters of the
 * pseudo-tool the forced-tool path would have offered. One definition, both
 * paths — `strictify` adapts it on the way out.
 */
export interface JsonSchemaSource {
  name: string;
  parameters: Record<string, unknown>;
}

/**
 * Whether the conversation already contains the literal word "json".
 *
 * Not a style check — a **documented precondition**. OpenAI's `json_object`
 * mode errors when it can't find the string "JSON" anywhere in the context
 * ("the model may generate an unending stream of whitespace" otherwise), and
 * DeepSeek and DashScope state the same requirement in their own words. The
 * prompts this app sends are author-editable, so the word being there today is
 * not something the code may assume tomorrow. `json_schema` mode has no such
 * precondition — the platform docs say so explicitly — which is why that branch
 * sends no cue at all.
 */
function mentionsJson(promptText: string): boolean {
  return /json/i.test(promptText);
}

/**
 * How to ask for JSON, given everything the request will say.
 *
 * `target` is the transport facts (a `ConnOptions` fits; a bare `ApiStandard`
 * is accepted for callers that have nothing else, and means auto with no model
 * id — the pre-declaration behaviour). `promptText` is the prompt the request
 * already carries (system plus user), read only for the precondition above.
 * `schema` is what a `json_schema` request would enforce; without it that mode
 * degrades to `json_object`, because there is nothing to enforce.
 */
export function jsonModeShaping(
  target: ApiStandard | JsonModeTarget,
  promptText: string,
  schema?: JsonSchemaSource,
): JsonModeShaping {
  const t: JsonModeTarget = typeof target === "string" ? { standard: target } : target;
  const mode = effectiveStructuredOutput(t);

  if (mode === "off") {
    // No native enforcement anywhere — the cue is the whole mechanism. On
    // Anthropic this is the only branch; elsewhere it is the author's escape
    // hatch for a relay that rejects `response_format`.
    return { mode, cue: JSON_ONLY_CUE };
  }

  switch (familyOf(t.standard)) {
    case "gemini":
      // The cue is belt-and-suspenders here: some models silently ignore
      // responseMimeType. `json_schema` is not yet spelled for this family
      // (`responseSchema` speaks a different dialect — no additionalProperties,
      // `nullable` as a field) and rides on JSON mode until it is verified.
      return {
        mode: "json_object",
        extraBody: { generationConfig: { responseMimeType: "application/json" } },
        cue: JSON_ONLY_CUE,
      };
    default:
      // Includes the unrecognised-DB-value case, which familyOf maps to the
      // OpenAI family — the same place the dispatch would send it.
      if (mode === "json_schema" && schema) {
        return {
          mode,
          extraBody: {
            response_format: {
              type: "json_schema",
              json_schema: { name: schema.name, strict: true, schema: strictify(schema.parameters) },
            },
          },
          // No cue: strict mode has no "json" precondition, and the schema
          // itself is the shape instruction.
        };
      }
      // The cue is conditional, and for a different reason than above: native
      // enforcement is real here, so the cue is not there to steer the model
      // but to satisfy the "json" precondition when the author's own prompt
      // doesn't already. Adding it unconditionally would spend tokens on every
      // request to restate what the prompt usually says already.
      return {
        mode: "json_object",
        extraBody: { response_format: { type: "json_object" } },
        ...(mentionsJson(promptText) ? {} : { cue: JSON_ONLY_CUE }),
      };
  }
}

// ─── The endpoints that refuse a mode, learned from their own 400 ─────────────

/**
 * Same shape as `toolChoice.ts`, for the same reason. Which models take strict
 * `json_schema` — and which relays reject `response_format` outright — is not
 * recoverable from the config, but the endpoint's 400 says so definitively,
 * arrives before a single token is generated, and costs nothing to act on. So
 * a refusal is remembered for the session, per endpoint+model, as a **ceiling**
 * on the mode: `json_schema` refused → `json_object` from now on; `json_object`
 * refused → `off` (the cue is the whole mechanism). The memo is in-memory and
 * session-scoped on purpose: it is a fact about an endpoint, not about the
 * author's config, and re-learning it costs one failed request.
 *
 * An author's explicit declaration is capped too (§5.4 of the plan): picking a
 * mode the endpoint rejects should cost "that mode didn't take", not "lore
 * generation is broken until I find the setting".
 */

/** Strength order: the memo only ever moves a mode *down* this list. */
const MODE_RANK: Record<StructuredOutputMode, number> = { off: 0, json_object: 1, json_schema: 2 };

/** The next weaker mode, or undefined when there is nothing weaker than `off`. */
export function downgradeJsonMode(mode: StructuredOutputMode): StructuredOutputMode | undefined {
  return mode === "json_schema" ? "json_object" : mode === "json_object" ? "off" : undefined;
}

function capJsonMode(mode: StructuredOutputMode, ceiling: StructuredOutputMode | undefined): StructuredOutputMode {
  return ceiling && MODE_RANK[ceiling] < MODE_RANK[mode] ? ceiling : mode;
}

/**
 * The mode a request to this endpoint+model will actually use: what the config
 * says (`resolveStructuredOutput`), capped by what the endpoint has refused this
 * session. The one answer the shaping, the 「将发送」 line and the "is the forced
 * tool attempt worth making" check all read — so they cannot disagree.
 */
export function effectiveStructuredOutput(t: JsonModeTarget): StructuredOutputMode {
  return capJsonMode(resolveStructuredOutput(t), jsonModeCeiling(t));
}

/**
 * Whether this error is the endpoint rejecting the JSON-mode parameter itself.
 *
 * Narrow on purpose, like `isForcedToolChoiceRejection`: the parameter's own
 * name has to appear. The messages this is written for all name it — OpenAI's
 * `Invalid parameter: 'response_format' of type 'json_schema' is not supported
 * with this model`, and the `'messages' must contain the word 'json' … to use
 * 'response_format'` precondition error. A DashScope sample is still owed
 * (`docs/api/structured-output-plan.md` §11.3); until it arrives this is the
 * OpenAI spelling, which the compatible endpoints have so far reproduced.
 */
export function isJsonModeRejection(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return false;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /response_format/i.test(msg);
}

/** One endpoint+model; the standard is in the key because one host can serve several families. */
function endpointKey(t: JsonModeTarget): string {
  return `${t.standard} ${t.baseUrl ?? ""} ${t.modelId ?? ""}`;
}

const ceilings = new Map<string, StructuredOutputMode>();

/** The strongest mode this endpoint+model is still allowed, or undefined when nothing was refused. */
export function jsonModeCeiling(t: JsonModeTarget): StructuredOutputMode | undefined {
  return ceilings.get(endpointKey(t));
}

/** Remember that `refused` was rejected: from now on this endpoint gets the next weaker mode. */
export function noteJsonModeRefused(t: JsonModeTarget, refused: StructuredOutputMode): void {
  const next = downgradeJsonMode(refused);
  if (!next) return;
  const current = ceilings.get(endpointKey(t));
  if (!current || MODE_RANK[next] < MODE_RANK[current]) ceilings.set(endpointKey(t), next);
}

/** Tests only — the memo outlives a single request by design. */
export function __resetJsonModeMemo(): void {
  ceilings.clear();
}

/**
 * Run `attempt` under the strongest JSON mode this endpoint is known to take,
 * downgrading once per refusal.
 *
 * The attempt receives the shaping (fields + cue) and builds its own request
 * from it — the two callers assemble their messages differently, and the cue's
 * position is part of that. On a 400 that names `response_format`, the refusal
 * is recorded and the loop re-shapes one level down; a request in `off` mode
 * carries no JSON parameter, so nothing there is retried and the loop ends.
 * Every other error is the caller's, surfaced as-is.
 */
export async function withJsonModeFallback<T>(
  target: JsonModeTarget,
  promptText: string,
  schema: JsonSchemaSource | undefined,
  attempt: (shaping: JsonModeShaping) => Promise<T>,
): Promise<T> {
  for (;;) {
    const shaping = jsonModeShaping(target, promptText, schema);
    try {
      return await attempt(shaping);
    } catch (err) {
      if (shaping.mode === "off" || !isJsonModeRejection(err)) throw err;
      noteJsonModeRefused(target, shaping.mode);
    }
  }
}
