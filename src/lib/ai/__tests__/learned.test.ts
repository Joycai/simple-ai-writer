/**
 * The learned store — what an endpoint refused this session, from its own 400
 * (docs/api/capability-resolution-lld.md §3.7, P3).
 *
 * Three things are held: each rule learns only from an error that names its
 * parameter *and* a request that used it; a ceiling only ever moves down, so
 * a retry loop built on it ends; and the drawer's verdict shows what was
 * learned, with its own reason, without the table resolution reading it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { capabilityVerdict, CAPABILITY_IDS } from "../capabilities";
import {
  __resetLearned, classify, downgradeJsonMode, learnedCeiling, noteLearned, STRUCTURED_RANK, type Attempt,
} from "../capability/learned";
import { STRUCTURED_OUTPUT_MODES } from "../jsonMode";
import type { Wire } from "../platforms";

afterEach(() => __resetLearned());

const err = (msg: string) => new Error(msg);
const FORCED: Attempt = { forcedToolChoice: true };
const SCHEMA: Attempt = { structuredOutput: "json_schema" };

describe("the forcedToolChoice rule", () => {
  it("learns from an error that names tool_choice, on a request that forced one", () => {
    for (const msg of [
      "400 Thinking mode does not support this tool_choice", // DeepSeek V4
      "Invalid value for 'tool_choice': 'required'",
      "tool choice is not supported",
    ]) {
      expect(classify(err(msg), FORCED), msg).toEqual({ fact: "forcedToolChoice", ceiling: false });
    }
  });

  it("learns nothing from a request that did not force", () => {
    const msg = err("400 Thinking mode does not support this tool_choice");
    expect(classify(msg, {})).toBeUndefined();
    expect(classify(msg, { forcedToolChoice: false })).toBeUndefined();
    // A JSON-mode request is not a forced one, whatever the error names.
    expect(classify(msg, SCHEMA)).toBeUndefined();
  });

  it("ignores phrasings that do not name the parameter, and aborts", () => {
    for (const e of [
      err("400 thinking mode is on"), err("does not support function calling"), err("context length exceeded"),
      new DOMException("Aborted", "AbortError"),
    ]) {
      expect(classify(e, FORCED)).toBeUndefined();
    }
  });
});

describe("the structuredOutput rule", () => {
  it("learns from each wire's spelling of the parameter", () => {
    for (const msg of [
      "400 Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.",
      "'messages' must contain the word 'json' in some form to use 'response_format'",
      // The Responses family's name for the same parameter (docs/api/responses.md §2.2).
      "400 Response input messages must contain the word 'json' in some form to use 'text.format' of type 'json_object'.",
      // Anthropic names the field path (as its other 400s do, `messages.1.content.0: …`).
      "Anthropic API error 400: output_config.format: Extra inputs are not permitted",
      // Gemini names the generationConfig field it did not recognise.
      "Invalid JSON payload received. Unknown name \"responseJsonSchema\" at 'generation_config': Cannot find field.",
    ]) {
      expect(classify(err(msg), SCHEMA), msg).toEqual({ fact: "structuredOutput", ceiling: "json_object" });
    }
  });

  it("ignores errors that do not name it, and aborts", () => {
    for (const e of [
      err("400 This model does not support json output"), err("401 invalid api key"),
      new DOMException("Aborted", "AbortError"),
    ]) {
      expect(classify(e, SCHEMA)).toBeUndefined();
    }
  });

  it("steps down from the tier that was shaped, and learns nothing from a request that sent none", () => {
    const msg = err("Invalid parameter: 'response_format'");
    expect(classify(msg, { structuredOutput: "json_object" })).toEqual({ fact: "structuredOutput", ceiling: "off" });
    expect(classify(msg, { structuredOutput: "off" })).toBeUndefined();
    expect(classify(msg, FORCED)).toBeUndefined();
  });

  it("belongs to the fact the request used, when an error names both", () => {
    const both = err("tool_choice cannot be combined with response_format");
    expect(classify(both, FORCED)?.fact).toBe("forcedToolChoice");
    expect(classify(both, SCHEMA)?.fact).toBe("structuredOutput");
  });
});

describe("the store", () => {
  const ds = { standard: "openai_compat" as const, baseUrl: "https://api.deepseek.example", modelId: "deepseek-v4-flash" };

  it("never raises a ceiling", () => {
    noteLearned(ds, "structuredOutput", "off");
    noteLearned(ds, "structuredOutput", "json_object");
    expect(learnedCeiling(ds, "structuredOutput")).toBe("off");
  });

  it("keys by standard, address and model, and keeps each fact apart", () => {
    noteLearned(ds, "forcedToolChoice", false);
    expect(learnedCeiling(ds, "forcedToolChoice")).toBe(false);
    expect(learnedCeiling(ds, "structuredOutput")).toBeUndefined();
    expect(learnedCeiling({ ...ds, standard: "openai_responses_compat" }, "forcedToolChoice")).toBeUndefined();
    expect(learnedCeiling({ ...ds, baseUrl: "https://other.example" }, "forcedToolChoice")).toBeUndefined();
    expect(learnedCeiling({ ...ds, modelId: "deepseek-v4-pro" }, "forcedToolChoice")).toBeUndefined();
  });

  /**
   * What makes a retry loop on the store end (§3.7): every lesson is strictly
   * lower than what the request sent, so each fact can be learned at most as
   * many times as it has tiers below the top.
   */
  it("teaches only strictly lower ceilings, so a loop that retries on each lesson ends", () => {
    const rejectAll = err("tool_choice and response_format both refused");
    for (const mode of STRUCTURED_OUTPUT_MODES) {
      const learned = classify(rejectAll, { structuredOutput: mode });
      if (learned?.fact !== "structuredOutput") {
        expect(downgradeJsonMode(mode)).toBeUndefined();
        continue;
      }
      expect(STRUCTURED_RANK[learned.ceiling]).toBeLessThan(STRUCTURED_RANK[mode]);
    }
    let mode: (typeof STRUCTURED_OUTPUT_MODES)[number] = "json_schema";
    let rounds = 0;
    for (;;) {
      const learned = classify(rejectAll, { structuredOutput: mode });
      if (learned?.fact !== "structuredOutput") break;
      noteLearned(ds, learned.fact, learned.ceiling);
      mode = learnedCeiling(ds, "structuredOutput")!;
      rounds++;
    }
    expect(rounds).toBe(2);
    expect(mode).toBe("off");
  });
});

describe("the drawer's verdict", () => {
  const wire: Wire = { platform: "deepseek", standard: "openai_compat" };
  const base = "https://api.deepseek.com";
  const model = { modelId: "deepseek-v4-flash" };
  const key = { standard: wire.standard, baseUrl: base, modelId: model.modelId };

  it("is the table's until the endpoint refuses something", () => {
    for (const id of CAPABILITY_IDS) {
      expect(capabilityVerdict(id, wire, model, base), id).toEqual(capabilityVerdict(id, wire, model));
    }
  });

  it("reads no / learned once a forced choice was refused", () => {
    noteLearned(key, "forcedToolChoice", false);
    expect(capabilityVerdict("forcedToolChoice", wire, model, base)).toEqual({ status: "no", reason: "learned" });
    // Without the address the tables alone answer: resolution never reads the store.
    expect(capabilityVerdict("forcedToolChoice", wire, model).reason).not.toBe("learned");
    // Another model behind the same address learned nothing.
    expect(capabilityVerdict("forcedToolChoice", wire, { modelId: "deepseek-chat" }, base).reason).not.toBe("learned");
  });

  it("takes the strict tier away on a schema refusal, and JSON mode too on a JSON-mode refusal", () => {
    noteLearned(key, "structuredOutput", "json_object");
    expect(capabilityVerdict("jsonSchema", wire, model, base)).toEqual({ status: "no", reason: "learned" });
    expect(capabilityVerdict("structuredOutput", wire, model, base)).toEqual(capabilityVerdict("structuredOutput", wire, model));
    noteLearned(key, "structuredOutput", "off");
    expect(capabilityVerdict("structuredOutput", wire, model, base)).toEqual({ status: "no", reason: "learned" });
    // Nothing else moves.
    for (const id of CAPABILITY_IDS.filter((i) => i !== "jsonSchema" && i !== "structuredOutput")) {
      expect(capabilityVerdict(id, wire, model, base), id).toEqual(capabilityVerdict(id, wire, model));
    }
  });

  it("takes JSON output away altogether on a wire with no tier below strict", () => {
    const anth: Wire = { platform: "anthropic", standard: "anthropic" };
    const url = "https://api.anthropic.com";
    const claude = { modelId: "claude-sonnet-5" };
    noteLearned({ standard: anth.standard, baseUrl: url, modelId: claude.modelId }, "structuredOutput", "json_object");
    // The cue alone is what is left there, so the drawer says so for both rows.
    expect(capabilityVerdict("jsonSchema", anth, claude, url)).toEqual({ status: "no", reason: "learned" });
    expect(capabilityVerdict("structuredOutput", anth, claude, url)).toEqual({ status: "no", reason: "learned" });
  });

  it("keeps a table no under its own reason", () => {
    const zhipu: Wire = { platform: "zhipu", standard: "openai_compat" };
    const glm = { standard: zhipu.standard, baseUrl: "https://open.bigmodel.cn/api/paas/v4", modelId: "glm-5.3" };
    noteLearned(glm, "forcedToolChoice", false);
    expect(capabilityVerdict("forcedToolChoice", zhipu, { modelId: glm.modelId }, glm.baseUrl))
      .toEqual({ status: "no", reason: "platform-absent" });
  });
});
