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
 * pseudo-tool call, which every protocol here supports natively.
 */

import { familyOf, type ApiStandard } from "./types";

/**
 * Extra top-level request fields that put the endpoint in JSON mode, or
 * undefined when the protocol has no such field.
 */
export function jsonModeExtraBody(standard: ApiStandard): Record<string, unknown> | undefined {
  switch (familyOf(standard)) {
    case "gemini":
      return { generationConfig: { responseMimeType: "application/json" } };
    case "anthropic":
      // No equivalent parameter, and sending an unrecognized one is a 400.
      // The text cue below is the whole mechanism here.
      return undefined;
    default:
      // Includes the unrecognised-DB-value case, which familyOf maps to the
      // OpenAI family — the same place the dispatch would send it.
      return { response_format: { type: "json_object" } };
  }
}

/**
 * Whether to also append a plain "output ONLY JSON" instruction to the user
 * turn.
 *
 * Belt-and-suspenders for Gemini, where some older models silently ignore
 * `responseMimeType` and need the text cue too. Load-bearing for Anthropic,
 * which has no parameter at all — without it there is nothing telling the model
 * to skip the prose and the fences.
 */
export function needsJsonTextCue(standard: ApiStandard): boolean {
  const family = familyOf(standard);
  return family === "gemini" || family === "anthropic";
}

/** The cue itself, so the two call sites can't drift in wording. */
export const JSON_ONLY_CUE =
  "Output ONLY valid JSON matching the schema in the system instructions. No markdown fences, no explanation.";
