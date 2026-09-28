/**
 * The request plan (docs/api/capability-resolution-lld.md §3.8, P5): every
 * decision about what a request carries, made once.
 *
 * Held here: planning is a pure function of its input; an adapter handed the
 * plan `streamCompletion` made sends byte for byte what it sends planning for
 * itself (the consistency test and the live probes call adapters directly);
 * and a forced tool choice that goes out as `auto` says which of the three
 * reasons it was.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamAnthropic } from "../anthropic";
import { __resetLearned, noteLearned } from "../capability/learned";
import { planRequest, type PlanInput } from "../capability/plan";
import { streamGemini } from "../gemini";
import { streamOpenAI } from "../openai";
import { PLATFORM_IDS, platformEndpoints } from "../platforms";
import { streamResponses } from "../responses";
import { standardOf } from "../routes";
import type { ProtocolFamily, StreamOptions, ToolDefinition } from "../types";

const ADAPTERS: Record<ProtocolFamily, (o: StreamOptions) => Promise<void>> = {
  openai: streamOpenAI, responses: streamResponses, anthropic: streamAnthropic, gemini: streamGemini,
};

const TOOL: ToolDefinition = {
  type: "function",
  function: { name: "pick", description: "Pick one.", parameters: { type: "object", properties: {} } },
};

/** Declarations that exercise every plan field, on ids some table singles out. */
const DECLARED: Partial<PlanInput> = {
  temperature: 0.4, reasoningEffort: "off", thinkingBudget: 2000, maxOutput: 9000, textVerbosity: "low",
  vlHighResolution: true, serverTools: ["web_search", "web_extractor", "code_interpreter"],
  tools: [TOOL], toolChoice: "required",
};
const MODEL_IDS = ["qwen3.5-plus", "openai/gpt-6-astra", "claude-sonnet-5", "grok-4-fast-non-reasoning", "glm-5.3"];

async function bodyOf(family: ProtocolFamily, opts: StreamOptions): Promise<string> {
  let body = "";
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    body = String(init.body);
    throw new Error("captured");
  }));
  await ADAPTERS[family](opts).catch(() => {});
  return body;
}

afterEach(() => {
  vi.unstubAllGlobals();
  __resetLearned();
});

describe("planRequest", () => {
  it("is a function of its input alone", () => {
    const input: PlanInput = { standard: "openai_compat", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", modelId: "qwen3.5-plus", ...DECLARED };
    const frozen = JSON.stringify(input);
    expect(JSON.stringify(planRequest(input))).toBe(JSON.stringify(planRequest(input)));
    expect(JSON.stringify(input)).toBe(frozen);
  });

  it("is what every adapter spells, handed in or planned for itself", async () => {
    const differ: string[] = [];
    for (const platform of PLATFORM_IDS) for (const endpoint of platformEndpoints(platform)) {
      const standard = standardOf({ family: endpoint.family, official: !!endpoint.official });
      for (const modelId of MODEL_IDS) {
        const opts: StreamOptions = {
          baseUrl: "https://plan.invalid/v1", apiKey: "k", platform, standard, modelId, ...DECLARED,
          messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }], onChunk: () => {},
        };
        const planned = await bodyOf(endpoint.family, { ...opts, _plan: planRequest(opts) });
        if (planned !== (await bodyOf(endpoint.family, opts))) differ.push(`${platform}/${standard}/${modelId}`);
      }
    }
    expect(differ).toEqual([]);
  });

  /**
   * The adapters decide nothing: handed a plan that sends none of what the
   * options declare, they send none of it. An adapter that still read one
   * field off the options would put it back here.
   */
  it("is the only thing an adapter reads its decisions from", async () => {
    const leaks: string[] = [];
    for (const platform of PLATFORM_IDS) for (const endpoint of platformEndpoints(platform)) {
      const standard = standardOf({ family: endpoint.family, official: !!endpoint.official });
      const opts: StreamOptions = {
        baseUrl: "https://plan.invalid/v1", apiKey: "k", platform, standard, modelId: "qwen3.5-plus", ...DECLARED,
        messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }], onChunk: () => {},
      };
      const nothing = {
        ...planRequest(opts),
        temperature: undefined, textVerbosity: undefined, vlHighResolution: false, promptCache: false,
        serverTools: [], responsesInclude: [], toolChoice: { requested: "required" as const, sent: "auto" as const },
      };
      const body = await bodyOf(endpoint.family, { ...opts, _plan: nothing });
      const found = [
        /"temperature"/, /verbosity/, /vl_high_resolution_images/, /cache_control/, /"include":/,
        /web_search|googleSearch|urlContext|codeExecution|code_interpreter|enable_search/, /"required"|"any"|"ANY"/,
      ].filter((re) => re.test(body));
      if (found.length) leaks.push(`${platform}/${standard}: ${found.join(" ")}`);
    }
    expect(leaks).toEqual([]);
  });
});

describe("a forced tool choice sent as auto", () => {
  const forced = (o: Partial<PlanInput> & Pick<PlanInput, "standard" | "modelId">) =>
    planRequest({ baseUrl: "https://x.invalid", tools: [TOOL], toolChoice: "required", ...o }).toolChoice;

  it("names the category's dialect", () => {
    expect(forced({ standard: "anthropic_compat", platform: "minimax", modelId: "MiniMax-M3", thinkingCategory: "minimax" }))
      .toEqual({ requested: "required", sent: "auto", downgradedBy: "category" });
  });

  it("names the table's cell", () => {
    expect(forced({ standard: "openai_compat", platform: "zhipu", modelId: "glm-5.3" }))
      .toEqual({ requested: "required", sent: "auto", downgradedBy: "cell" });
  });

  it("names the endpoint's own 400, learned", () => {
    const ds = { standard: "openai_compat" as const, baseUrl: "https://api.deepseek.example", modelId: "deepseek-v4-flash" };
    expect(forced(ds)?.sent).toBe("required");
    noteLearned(ds, "forcedToolChoice", false);
    expect(forced(ds)).toEqual({ requested: "required", sent: "auto", downgradedBy: "learned" });
  });

  it("is absent without function tools, and passes an unforced choice through", () => {
    expect(planRequest({ standard: "openai", baseUrl: "", modelId: "gpt-5" }).toolChoice).toBeUndefined();
    expect(forced({ standard: "openai", modelId: "gpt-5", toolChoice: "none" })).toEqual({ requested: "none", sent: "none" });
  });
});

describe("the JSON shaping", () => {
  afterEach(() => __resetLearned());
  const SCHEMA = { name: "pick", parameters: { type: "object", properties: {} } };
  const qwen = { standard: "openai_compat" as const, platform: "dashscope" as const, baseUrl: "https://relay/v1", modelId: "qwen3.8-max" };

  it("is planned only when the request asks for JSON", () => {
    expect(planRequest(qwen).json).toBeUndefined();
    expect(planRequest({ ...qwen, structured: { schema: SCHEMA } }).json?.mode).toBe("json_schema");
  });

  it("sits below the tier without a schema to enforce, and under what the endpoint refused", () => {
    const noSchema = planRequest({ ...qwen, structured: {} });
    expect(noSchema.structured).toBe("json_schema");
    expect(noSchema.json?.mode).toBe("json_object");
    noteLearned(qwen, "structuredOutput", "off");
    expect(planRequest({ ...qwen, structured: { schema: SCHEMA } }).json?.mode).toBe("off");
  });

  it("reads the messages for the json precondition", () => {
    const unknown = { ...qwen, modelId: "some-unknown-model", structured: {} };
    expect(planRequest({ ...unknown, messages: [{ role: "user", content: "Answer in JSON." }] }).json?.cue).toBeUndefined();
    expect(planRequest({ ...unknown, messages: [{ role: "user", content: "Answer." }] }).json?.cue).toBeDefined();
  });
});
