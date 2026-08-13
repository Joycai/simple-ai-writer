/**
 * JSON-mode request shaping. Two things are being protected here:
 *
 *   1. The right knob per protocol — sending OpenAI's `response_format` to
 *      Anthropic is a hard 400, which is the bug this module was extracted to
 *      prevent.
 *   2. The "json" precondition. OpenAI's `json_object` mode errors when it
 *      can't find the string "JSON" anywhere in the context, and DeepSeek
 *      documents the same requirement. The prompts this app sends are
 *      author-editable, so satisfying it cannot be left to whatever the prompt
 *      happens to say.
 */

import { describe, expect, it } from "vitest";
import { JSON_ONLY_CUE, jsonModeShaping } from "../ai/jsonMode";

const WITH = "Return the entry as strict JSON.";
const WITHOUT = "Return the entry using the shape described above.";

describe("jsonModeShaping", () => {
  it("uses each protocol's own knob", () => {
    expect(jsonModeShaping("openai", WITH).extraBody).toEqual({
      response_format: { type: "json_object" },
    });
    expect(jsonModeShaping("gemini", WITH).extraBody).toEqual({
      generationConfig: { responseMimeType: "application/json" },
    });
    // Anthropic has no such parameter and rejects unknown top-level fields.
    expect(jsonModeShaping("anthropic", WITH).extraBody).toBeUndefined();
  });

  it("applies to the compat half of each family too", () => {
    expect(jsonModeShaping("openai_compat", WITH).extraBody).toEqual({
      response_format: { type: "json_object" },
    });
    expect(jsonModeShaping("anthropic_compat", WITH).extraBody).toBeUndefined();
  });

  it("adds the cue on the OpenAI family only when the prompt lacks the word", () => {
    // Present: native enforcement carries it, and restating costs tokens on
    // every request.
    expect(jsonModeShaping("openai", WITH).cue).toBeUndefined();
    // Absent: the request would otherwise be rejected outright.
    expect(jsonModeShaping("openai", WITHOUT).cue).toBe(JSON_ONLY_CUE);
  });

  it("matches the word case-insensitively", () => {
    expect(jsonModeShaping("openai", "output json only").cue).toBeUndefined();
    expect(jsonModeShaping("openai", "OUTPUT JSON ONLY").cue).toBeUndefined();
  });

  it("always cues the protocols whose enforcement is weak or absent", () => {
    // Anthropic has no parameter; Gemini's is ignored by some models. Neither
    // depends on what the prompt already says.
    expect(jsonModeShaping("anthropic", WITH).cue).toBe(JSON_ONLY_CUE);
    expect(jsonModeShaping("gemini", WITH).cue).toBe(JSON_ONLY_CUE);
  });
});
