/**
 * "Give me JSON" request shaping, per wire protocol.
 *
 * Each protocol enforces a JSON response differently, and one of them doesn't
 * offer the knob at all — so the decision lives here rather than being
 * re-derived at each call site. It used to be a two-way `standard === "gemini"`
 * ternary duplicated in lore/generator.ts and lore/splitter.ts, which meant
 * both of them sent OpenAI's `response_format` to *everything* else. That is a
 * hard 400 on Anthropic, whose Messages API rejects unknown top-level fields.
 *
 * Callers that need schema *enforcement* rather than "valid JSON, shape
 * described in prose" should use agent/structured.ts instead — it forces a
 * pseudo-tool call, which every protocol here supports natively. Note that a
 * *thinking* model may refuse a forced tool choice, so that path falls back to
 * this one; the shaping below is what keeps the fallback from being pure prose.
 */

import { familyOf, type ApiStandard } from "./types";

/** How to ask this endpoint for JSON. Both halves may be absent. */
export interface JsonModeShaping {
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
 * Whether the conversation already contains the literal word "json".
 *
 * Not a style check — a **documented precondition**. OpenAI's `json_object`
 * mode errors when it can't find the string "JSON" anywhere in the context
 * ("the model may generate an unending stream of whitespace" otherwise), and
 * DeepSeek states the same requirement in its own words. The prompts this app
 * sends are author-editable, so the word being there today is not something the
 * code may assume tomorrow.
 */
function mentionsJson(promptText: string): boolean {
  return /json/i.test(promptText);
}

/**
 * How to ask `standard` for JSON, given everything the request will say.
 *
 * `promptText` should be the prompt text the request already carries (system
 * plus user); it is only read to test the precondition above.
 */
export function jsonModeShaping(standard: ApiStandard, promptText: string): JsonModeShaping {
  switch (familyOf(standard)) {
    case "gemini":
      // The cue is belt-and-suspenders here: some models silently ignore
      // responseMimeType.
      return {
        extraBody: { generationConfig: { responseMimeType: "application/json" } },
        cue: JSON_ONLY_CUE,
      };
    case "anthropic":
      // No equivalent parameter, and sending an unrecognized one is a 400.
      // The cue is the whole mechanism here.
      return { cue: JSON_ONLY_CUE };
    default:
      // Includes the unrecognised-DB-value case, which familyOf maps to the
      // OpenAI family — the same place the dispatch would send it.
      //
      // The cue is conditional, and for a different reason than above: native
      // enforcement is real here, so the cue is not there to steer the model
      // but to satisfy the "json" precondition when the author's own prompt
      // doesn't already. Adding it unconditionally would spend tokens on every
      // request to restate what the prompt usually says already.
      return {
        extraBody: { response_format: { type: "json_object" } },
        ...(mentionsJson(promptText) ? {} : { cue: JSON_ONLY_CUE }),
      };
  }
}
