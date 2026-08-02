import { describe, it, expect } from "vitest";

import {
  calibrate,
  classifyProbeError,
  expectedPromptTokens,
  isTransient,
  judgeTruncation,
  makePadding,
  parseLimitFromMessage,
  parseOllamaParameters,
  readEntryLimits,
  suggestSettings,
  type ProbeFinding,
} from "../ai/probeAnalysis";
import { planProbeCost } from "../ai/endpointProbe";

describe("readEntryLimits", () => {
  it("reads vLLM's max_model_len", () => {
    const r = readEntryLimits({ id: "qwen", max_model_len: 32768 });
    expect(r.context).toEqual([{ path: "max_model_len", value: 32768 }]);
  });

  it("descends into OpenRouter's top_provider", () => {
    const r = readEntryLimits({
      id: "anthropic/claude",
      context_length: 200000,
      top_provider: { max_completion_tokens: 8192, context_length: 200000 },
    });
    expect(r.context.map((c) => c.value)).toContain(200000);
    expect(r.output).toEqual([
      { path: "top_provider.max_completion_tokens", value: 8192 },
    ]);
  });

  it("reads Gemini's inputTokenLimit / outputTokenLimit", () => {
    const r = readEntryLimits({
      name: "models/gemini-2.5-pro",
      inputTokenLimit: 1048576,
      outputTokenLimit: 65536,
    });
    expect(r.context[0].value).toBe(1048576);
    expect(r.output[0].value).toBe(65536);
  });

  it("matches ollama's arch-prefixed keys by their last segment", () => {
    const r = readEntryLimits({
      "general.architecture": "llama",
      "llama.context_length": 131072,
    });
    expect(r.context).toEqual([{ path: "llama.context_length", value: 131072 }]);
  });

  it("keeps LM Studio's loaded window alongside the advertised one", () => {
    const r = readEntryLimits({ max_context_length: 131072, loaded_context_length: 4096 });
    expect(r.context.map((c) => c.value).sort((a, b) => a - b)).toEqual([4096, 131072]);
  });

  it("ignores non-numeric and out-of-range values", () => {
    const r = readEntryLimits({ context_length: "unknown", max_model_len: -1, n_ctx: 0 });
    expect(r.context).toEqual([]);
  });
});

describe("parseOllamaParameters", () => {
  it("pulls num_ctx out of the parameters blob", () => {
    const params = 'stop  "<|im_end|>"\nnum_ctx    4096\ntemperature 0.7\n';
    expect(parseOllamaParameters(params)).toEqual([
      { path: "parameters.num_ctx", value: 4096 },
    ]);
  });

  it("returns nothing when the field is absent or not a string", () => {
    expect(parseOllamaParameters(undefined)).toEqual([]);
    expect(parseOllamaParameters({ num_ctx: 4096 })).toEqual([]);
  });
});

describe("parseLimitFromMessage", () => {
  it("takes the limit, not the requested size, when both appear", () => {
    const msg =
      "This model's maximum context length is 8192 tokens, however you requested 120000 tokens.";
    expect(parseLimitFromMessage(msg)).toBe(8192);
  });

  it("reads a max_tokens ceiling", () => {
    expect(parseLimitFromMessage("max_tokens must be at most 4096")).toBe(4096);
    expect(parseLimitFromMessage("This model supports at most 16384 completion tokens"))
      .toBe(16384);
  });

  it("handles thousands separators", () => {
    expect(parseLimitFromMessage("maximum is 1,048,576")).toBe(1048576);
  });

  it("returns undefined when no number is named", () => {
    expect(parseLimitFromMessage("context length exceeded")).toBeUndefined();
  });
});

describe("classifyProbeError", () => {
  it("treats a context-length 400 as conclusive", () => {
    const info = classifyProbeError(
      400,
      JSON.stringify({ error: { code: "context_length_exceeded", message: "maximum context length is 8192 tokens" } }),
    );
    expect(info.kind).toBe("context_limit");
    expect(info.limit).toBe(8192);
    expect(info.conclusive).toBe(true);
  });

  it("never reads a 429 as a ceiling", () => {
    const info = classifyProbeError(429, "Rate limit reached for gpt-4o: maximum is 30000 TPM");
    expect(info.kind).toBe("rate_limit");
    expect(info.conclusive).toBe(false);
    expect(isTransient(info.kind)).toBe(true);
  });

  it("never reads a 502 from a relay as a ceiling", () => {
    const info = classifyProbeError(502, "Bad Gateway");
    expect(info.kind).toBe("server_error");
    expect(isTransient(info.kind)).toBe(true);
  });

  it("separates a gateway body cap from a token cap", () => {
    const info = classifyProbeError(413, "Payload Too Large");
    expect(info.kind).toBe("payload_too_large");
    expect(info.conclusive).toBe(false);
  });

  it("detects the max_completion_tokens rename before reading it as an output limit", () => {
    const info = classifyProbeError(
      400,
      "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
    );
    expect(info.kind).toBe("param_name");
    expect(info.paramHint).toBe("max_completion_tokens");
  });

  it("reads an output ceiling", () => {
    const info = classifyProbeError(400, "max_tokens must be at most 8192");
    expect(info.kind).toBe("output_limit");
    expect(info.limit).toBe(8192);
  });

  it("falls through to unknown rather than guessing", () => {
    expect(classifyProbeError(400, "something went wrong").kind).toBe("unknown");
  });
});

describe("calibrate", () => {
  it("cancels the fixed template overhead out of the ratio", () => {
    // 4 chars/token plus a constant 20-token chat template.
    const cal = calibrate({ chars: 600, tokens: 170 }, { chars: 6000, tokens: 1520 });
    expect(cal).not.toBeNull();
    expect(cal!.charsPerToken).toBeCloseTo(4, 5);
    expect(cal!.overheadTokens).toBe(20);
  });

  it("measures a CJK-style ratio far from the ASCII assumption", () => {
    const cal = calibrate({ chars: 600, tokens: 360 }, { chars: 6000, tokens: 3360 });
    expect(cal!.charsPerToken).toBeCloseTo(1.8, 5);
  });

  it("refuses a slope that cannot be a tokenizer", () => {
    expect(calibrate({ chars: 600, tokens: 10 }, { chars: 6000, tokens: 20 })).toBeNull();
    expect(calibrate({ chars: 600, tokens: 100 }, { chars: 600, tokens: 100 })).toBeNull();
  });

  it("round-trips through expectedPromptTokens", () => {
    const cal = calibrate({ chars: 600, tokens: 170 }, { chars: 6000, tokens: 1520 })!;
    expect(expectedPromptTokens(6000, cal)).toBe(1520);
  });
});

describe("judgeTruncation", () => {
  it("flags an ollama-style silent cap", () => {
    const r = judgeTruncation(32000, 4096);
    expect(r.verdict).toBe("truncated");
    expect(r.cap).toBe(4096);
  });

  it("accepts tokenizer noise as agreement", () => {
    expect(judgeTruncation(8192, 8050).verdict).toBe("not-detected");
  });

  it("does not trip on small prompts where the gap is tiny", () => {
    expect(judgeTruncation(500, 380).verdict).toBe("not-detected");
  });

  it("reports unknown when the server sends no usage", () => {
    expect(judgeTruncation(8192, undefined).verdict).toBe("unknown");
    expect(judgeTruncation(8192, 0).verdict).toBe("unknown");
  });
});

describe("makePadding", () => {
  it("is deterministic for a given seed and roughly the requested size", () => {
    const a = makePadding(2000);
    const b = makePadding(2000);
    expect(a).toBe(b);
    expect(a.length).toBe(2000);
  });

  it("differs by seed, so successive probes are not cache hits of each other", () => {
    expect(makePadding(2000, 1)).not.toBe(makePadding(2000, 2));
  });

  it("has no long repeated run that a tokenizer could collapse", () => {
    const pad = makePadding(4000);
    // A 60-char window should never occur twice in text meant to cost real tokens.
    const window = pad.slice(500, 560);
    expect(pad.indexOf(window)).toBe(pad.lastIndexOf(window));
  });

  it("returns empty for a non-positive size", () => {
    expect(makePadding(0)).toBe("");
  });
});

describe("suggestSettings", () => {
  const finding = (over: Partial<ProbeFinding>): ProbeFinding => ({
    source: "models-endpoint",
    detail: "context_length",
    confidence: "medium",
    ...over,
  });

  it("keeps the tightest declared window and reports the disagreement", () => {
    const s = suggestSettings([
      finding({ contextWindow: 131072, detail: "llama.context_length" }),
      finding({ contextWindow: 4096, detail: "parameters.num_ctx", source: "ollama-show" }),
    ]);
    expect(s.contextWindow).toBe(4096);
    expect(s.conflicts.join()).toContain("131,072");
  });

  it("lets a measured truncation cap override a larger declared window", () => {
    const s = suggestSettings(
      [finding({ contextWindow: 131072 })],
      { verdict: "truncated", expectedTokens: 32000, reportedTokens: 4096, cap: 4096 },
    );
    expect(s.contextWindow).toBe(4096);
  });

  it("ignores a truncation cap above the declared window", () => {
    const s = suggestSettings(
      [finding({ contextWindow: 8192 })],
      { verdict: "truncated", expectedTokens: 40000, reportedTokens: 16000, cap: 16000 },
    );
    expect(s.contextWindow).toBe(8192);
  });

  it("keeps the smallest output limit", () => {
    const s = suggestSettings([
      finding({ maxOutput: 65536, detail: "outputTokenLimit" }),
      finding({ maxOutput: 8192, detail: "error.max_tokens", source: "error-message" }),
    ]);
    expect(s.maxOutput).toBe(8192);
  });

  it("returns nothing rather than a guess when there are no findings", () => {
    const s = suggestSettings([]);
    expect(s.contextWindow).toBeUndefined();
    expect(s.maxOutput).toBeUndefined();
  });
});

describe("planProbeCost", () => {
  it("keeps a quick probe cheap even on a 1M-token model", () => {
    const cost = planProbeCost({ claimedContext: 1_048_576, priceIn: 3, priceOut: 15 });
    expect(cost.inputTokens).toBeLessThan(20_000);
    expect(cost.usd!).toBeLessThan(0.1);
  });

  it("scales the deep probe with the declared window", () => {
    const quick = planProbeCost({ claimedContext: 131_072, priceIn: 1, priceOut: 1 });
    const deep = planProbeCost({ claimedContext: 131_072, deep: true, priceIn: 1, priceOut: 1 });
    expect(deep.inputTokens).toBeGreaterThan(quick.inputTokens * 10);
  });

  it("bills output tokens only when the generation test is requested", () => {
    const without = planProbeCost({ claimedContext: 8192, priceIn: 1, priceOut: 1 });
    const withTest = planProbeCost({
      claimedContext: 8192, claimedMaxOutput: 8192, measureOutput: true, priceIn: 1, priceOut: 1,
    });
    expect(without.outputTokens).toBeLessThan(10);
    expect(withTest.outputTokens).toBeGreaterThan(8000);
  });

  it("omits a dollar figure when the model has no prices", () => {
    expect(planProbeCost({ claimedContext: 8192, priceIn: 0, priceOut: 0 }).usd).toBeUndefined();
  });
});
