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

import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetJsonModeMemo, downgradeJsonMode, isJsonModeRejection, JSON_ONLY_CUE, jsonModeCeiling,
  jsonModeShaping, knownJsonSchemaModel, noteJsonModeRefused, parseStructuredOutputMode,
  resolveStructuredOutput, withJsonModeFallback,
} from "../ai/jsonMode";

const WITH = "Return the entry as strict JSON.";
const WITHOUT = "Return the entry using the shape described above.";

const SCHEMA = {
  name: "emit_entry",
  parameters: {
    type: "object",
    properties: { name: { type: "string" }, note: { type: "string" } },
    required: ["name"],
  },
};

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

// ─── Per-model strength (docs/api/structured-output-plan.md) ──────────────────

describe("resolveStructuredOutput", () => {
  it("defaults an undeclared model to the family's JSON mode", () => {
    expect(resolveStructuredOutput({ standard: "openai", modelId: "qwen-plus" })).toBe("json_object");
    expect(resolveStructuredOutput({ standard: "openai_compat", modelId: "deepseek-v4-flash" })).toBe("json_object");
    expect(resolveStructuredOutput({ standard: "gemini", modelId: "gemini-2.5-pro" })).toBe("json_object");
  });

  it("lifts a model id documented to take strict mode to json_schema, on the OpenAI family only", () => {
    expect(resolveStructuredOutput({ standard: "openai_compat", modelId: "qwen3.8-max" })).toBe("json_schema");
    expect(resolveStructuredOutput({ standard: "openai", modelId: "gpt-5" })).toBe("json_schema");
    // The Gemini spelling of strict mode is a different dialect, not yet sent.
    expect(resolveStructuredOutput({ standard: "gemini", modelId: "gpt-5" })).toBe("json_object");
  });

  it("lets the author's declaration win over the table", () => {
    expect(resolveStructuredOutput({ standard: "openai", modelId: "qwen3.8-max", structuredOutput: "off" })).toBe("off");
    expect(resolveStructuredOutput({ standard: "openai", modelId: "qwen-plus", structuredOutput: "json_schema" })).toBe("json_schema");
  });

  it("resolves the Anthropic family to off whatever the row says", () => {
    // No JSON parameter exists there; a declaration that survived a provider
    // change to this family must not reach the wire.
    expect(resolveStructuredOutput({ standard: "anthropic", modelId: "gpt-5", structuredOutput: "json_schema" })).toBe("off");
    expect(resolveStructuredOutput({ standard: "anthropic_compat" })).toBe("off");
  });
});

describe("knownJsonSchemaModel", () => {
  it("matches the platform's documented prefixes through a vendor path and a date suffix", () => {
    for (const id of ["qwen3.8-max", "Qwen3.8-Max-2026-08", "org/qwen3.7-plus", "qwen3.7-flash", "gpt-4.1-mini"]) {
      expect(knownJsonSchemaModel(id)).toBe(true);
    }
  });

  it("does not match older Qwen tiers or a relay alias", () => {
    for (const id of ["qwen-plus", "qwen3-max", "qwen-turbo", "特价 | qwen3.8-max", "deepseek-v4-pro"]) {
      expect(knownJsonSchemaModel(id)).toBe(false);
    }
  });
});

describe("parseStructuredOutputMode", () => {
  it("admits the three modes and nothing else", () => {
    expect(parseStructuredOutputMode("off")).toBe("off");
    expect(parseStructuredOutputMode("json_schema")).toBe("json_schema");
    expect(parseStructuredOutputMode("auto")).toBeUndefined();
    expect(parseStructuredOutputMode(null)).toBeUndefined();
  });
});

describe("jsonModeShaping · per-model modes", () => {
  it("sends strict json_schema, without a cue, when the model takes it and a schema is given", () => {
    const s = jsonModeShaping({ standard: "openai_compat", modelId: "qwen3.8-max" }, WITHOUT, SCHEMA);
    expect(s.mode).toBe("json_schema");
    expect(s.cue).toBeUndefined();
    expect(s.extraBody).toEqual({
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "emit_entry",
          strict: true,
          schema: {
            type: "object",
            properties: { name: { type: "string" }, note: { type: ["string", "null"] } },
            required: ["name", "note"],
            additionalProperties: false,
          },
        },
      },
    });
    // The caller's definition is untouched.
    expect(SCHEMA.parameters.required).toEqual(["name"]);
  });

  it("degrades json_schema to JSON mode when no schema is given", () => {
    const s = jsonModeShaping({ standard: "openai", modelId: "qwen3.8-max" }, WITHOUT);
    expect(s.mode).toBe("json_object");
    expect(s.extraBody).toEqual({ response_format: { type: "json_object" } });
    expect(s.cue).toBe(JSON_ONLY_CUE);
  });

  it("keeps a json_object declaration on JSON mode even with a schema in hand", () => {
    const s = jsonModeShaping({ standard: "openai", modelId: "qwen3.8-max", structuredOutput: "json_object" }, WITH, SCHEMA);
    expect(s.extraBody).toEqual({ response_format: { type: "json_object" } });
  });

  it("sends nothing but the cue when the author turned it off", () => {
    for (const standard of ["openai", "openai_compat", "gemini"] as const) {
      const s = jsonModeShaping({ standard, modelId: "qwen3.8-max", structuredOutput: "off" }, WITH, SCHEMA);
      expect(s.mode).toBe("off");
      expect(s.extraBody).toBeUndefined();
      expect(s.cue).toBe(JSON_ONLY_CUE);
    }
  });

  it("rides json_schema on JSON mode for the Gemini family until its dialect is verified", () => {
    const s = jsonModeShaping({ standard: "gemini", modelId: "x", structuredOutput: "json_schema" }, WITH, SCHEMA);
    expect(s.mode).toBe("json_object");
    expect(s.extraBody).toEqual({ generationConfig: { responseMimeType: "application/json" } });
  });

  it("is byte-identical to the pre-declaration behaviour for an undeclared, unlisted model", () => {
    expect(jsonModeShaping({ standard: "openai", modelId: "qwen-plus" }, WITH, SCHEMA)).toEqual(
      jsonModeShaping("openai", WITH),
    );
  });
});

// ─── The session memo: refusals learned from the endpoint's 400 ──────────────

describe("json-mode refusal memo", () => {
  beforeEach(() => __resetJsonModeMemo());

  const qwen = { standard: "openai_compat" as const, baseUrl: "https://relay/v1", modelId: "qwen3.8-max" };

  it("steps a refused mode down one level and caps later shaping", () => {
    expect(jsonModeShaping(qwen, WITH, SCHEMA).mode).toBe("json_schema");
    noteJsonModeRefused(qwen, "json_schema");
    expect(jsonModeCeiling(qwen)).toBe("json_object");
    expect(jsonModeShaping(qwen, WITH, SCHEMA).mode).toBe("json_object");
    noteJsonModeRefused(qwen, "json_object");
    expect(jsonModeShaping(qwen, WITH, SCHEMA)).toEqual({ mode: "off", cue: JSON_ONLY_CUE });
  });

  it("caps an explicit declaration too — a wrong pick costs the mode, not the feature", () => {
    noteJsonModeRefused(qwen, "json_schema");
    expect(jsonModeShaping({ ...qwen, structuredOutput: "json_schema" }, WITH, SCHEMA).mode).toBe("json_object");
  });

  it("keys the memo by endpoint and model, not by model alone", () => {
    noteJsonModeRefused(qwen, "json_schema");
    expect(jsonModeShaping({ ...qwen, baseUrl: "https://other/v1" }, WITH, SCHEMA).mode).toBe("json_schema");
    expect(jsonModeShaping({ ...qwen, modelId: "qwen3.7-plus" }, WITH, SCHEMA).mode).toBe("json_schema");
  });

  it("never raises a ceiling", () => {
    noteJsonModeRefused(qwen, "json_object");
    noteJsonModeRefused(qwen, "json_schema");
    expect(jsonModeCeiling(qwen)).toBe("off");
    expect(downgradeJsonMode("off")).toBeUndefined();
  });

  it("recognises only errors that name the parameter", () => {
    expect(isJsonModeRejection(new Error(
      "400 Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.",
    ))).toBe(true);
    expect(isJsonModeRejection(new Error("'messages' must contain the word 'json' in some form to use 'response_format'"))).toBe(true);
    expect(isJsonModeRejection(new Error("400 This model does not support json output"))).toBe(false);
    expect(isJsonModeRejection(new Error("401 invalid api key"))).toBe(false);
    expect(isJsonModeRejection(new DOMException("Aborted", "AbortError"))).toBe(false);
  });
});

describe("withJsonModeFallback", () => {
  beforeEach(() => __resetJsonModeMemo());

  const qwen = { standard: "openai_compat" as const, baseUrl: "https://relay/v1", modelId: "qwen3.8-max" };
  const refusal = (mode: string) =>
    new Error(`400 Invalid parameter: 'response_format' of type '${mode}' is not supported with this model.`);

  it("re-runs one level down per refusal and remembers where it landed", async () => {
    const seen: string[] = [];
    const result = await withJsonModeFallback(qwen, WITH, SCHEMA, async (s) => {
      seen.push(s.mode);
      if (s.mode !== "off") throw refusal(s.mode);
      return "done";
    });
    expect(result).toBe("done");
    expect(seen).toEqual(["json_schema", "json_object", "off"]);
    // The next call starts where the last one ended — no wasted round trips.
    expect(jsonModeShaping(qwen, WITH, SCHEMA).mode).toBe("off");
  });

  it("surfaces an error that is not about the parameter, without touching the memo", async () => {
    await expect(withJsonModeFallback(qwen, WITH, SCHEMA, async () => {
      throw new Error("429 rate limited");
    })).rejects.toThrow("429");
    expect(jsonModeCeiling(qwen)).toBeUndefined();
  });

  it("does not retry a request that carried no JSON parameter", async () => {
    let calls = 0;
    await expect(withJsonModeFallback({ ...qwen, structuredOutput: "off" }, WITH, SCHEMA, async () => {
      calls++;
      throw refusal("json_object");
    })).rejects.toThrow("response_format");
    expect(calls).toBe(1);
  });
});
