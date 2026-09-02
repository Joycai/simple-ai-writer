/**
 * The 「将发送」 line and the list-row marks. What is guarded: the summary is
 * derived from the adapters' own body functions, so a declared field shows up
 * spelled as the wire spells it, and an undeclared model shows nothing at all.
 */
import { describe, expect, it } from "vitest";
import { declarationMarks, isMeasured, wireSummary, type WireInput } from "../ai/modelSummary";

const base: WireInput = { type: "text", modelId: "some-model" };

const keys = (items: { key: string }[]) => items.map((i) => i.key);

describe("wireSummary", () => {
  it("shows an undeclared model's one real field — the JSON mode structured tasks get by default", () => {
    // Auto resolves to the family's JSON mode (lib/ai/jsonMode.ts), and that
    // *is* sent on structured tasks — so the line says so rather than showing
    // the reassuring emptiness the author might expect. Anthropic has no such
    // field; what its adapter always sends instead is the adaptive `thinking`
    // block of the family's default category.
    expect(wireSummary(base, "openai")).toEqual([
      { key: "response_format", value: "json_object", scope: "structured" },
    ]);
    expect(wireSummary(base, "gemini")).toEqual([
      { key: "generationConfig.responseMimeType", value: "application/json", scope: "structured" },
    ]);
    expect(wireSummary(base, "anthropic")).toEqual([{ key: "thinking.type", value: "adaptive" }]);
  });

  it("spells a Qwen thinking model the way the OpenAI adapter does", () => {
    const items = wireSummary({
      ...base,
      modelId: "qwen3.8-max",
      thinkingCategory: "qwen-budget",
      reasoningEffort: "high",
      thinkingBudget: 8000,
      temperature: 0,
      serverTools: ["web_search"],
    }, "openai_compat");
    expect(items).toEqual(expect.arrayContaining([
      { key: "enable_thinking", value: "true" },
      { key: "thinking_budget", value: "8000" },
      { key: "temperature", value: "0" },
      { key: "enable_search", value: "true" },
      // Auto, lifted to json_schema by the model id — structured tasks only.
      { key: "response_format", value: "json_schema", scope: "structured" },
    ]));
  });

  it("lists the structured-output mode the row resolves to, and drops it when off", () => {
    expect(wireSummary({ ...base, structuredOutput: "json_object" }, "openai")).toEqual([
      { key: "response_format", value: "json_object", scope: "structured" },
    ]);
    expect(wireSummary({ ...base, structuredOutput: "off" }, "openai")).toEqual([]);
    expect(wireSummary({ ...base, structuredOutput: "off" }, "gemini")).toEqual([]);
    expect(wireSummary({ ...base, structuredOutput: "json_object" }, "gemini")).toEqual([
      { key: "generationConfig.responseMimeType", value: "application/json", scope: "structured" },
    ]);
  });

  it("shows the Anthropic thinking body and max_tokens, never response_format", () => {
    const items = wireSummary({
      ...base,
      thinkingCategory: "claude-adaptive",
      reasoningEffort: "high",
      maxOutput: 16_000,
      structuredOutput: "json_schema",
    }, "anthropic");
    expect(keys(items)).toEqual(expect.arrayContaining(["thinking.type", "output_config.effort", "max_tokens"]));
    expect(keys(items)).not.toContain("response_format");
    // The adapter's `display: summarized` is paired with the type and says nothing on its own.
    expect(keys(items)).not.toContain("thinking.display");
  });

  it("marks an unset extended budget as the adapter's default rather than inventing a number", () => {
    const items = wireSummary({ ...base, thinkingCategory: "claude-budget" }, "anthropic");
    expect(items).toContainEqual({ key: "thinking.budget_tokens", value: "…" });
  });

  it("drops a temperature the category's adapter would not send", () => {
    // Anthropic clamps/drops temperature while thinking is on (claude-adaptive).
    const items = wireSummary({ ...base, thinkingCategory: "claude-adaptive", temperature: 0.5 }, "anthropic");
    expect(keys(items)).not.toContain("temperature");
  });

  it("names the preamble without quoting it", () => {
    expect(wireSummary({ ...base, prefix: "你是一位编辑" }, "openai")).toContainEqual({
      key: "system", value: "", scope: "prefix",
    });
  });

  it("describes an image model by its client-side route, not a chat body", () => {
    const items = wireSummary({
      type: "image", modelId: "gemini-3-flash-image",
      thinkingCategory: "openai-generic", reasoningEffort: "high",
      caps: { edit: true, route: "gemini", dialect: "nanobanana", sizes: ["1024x1024", "1536x1024"] },
    }, "gemini");
    expect(items).toEqual([
      { key: "route", value: "gemini" },
      { key: "dialect", value: "nanobanana" },
      { key: "size", value: "1024x1024 +1" },
    ]);
  });
});

describe("declarationMarks", () => {
  it("marks only explicit declarations, in a fixed order", () => {
    expect(declarationMarks({
      type: "text", thinkingCategory: "qwen-budget", serverTools: ["web_search"], pdfInput: true, translateFormat: "sakura",
    })).toEqual(["think", "web", "pdf", "translate"]);
    // Auto thinking is not a declaration.
    expect(declarationMarks({ type: "text", reasoningEffort: "high" } as never)).toEqual([]);
  });

  it("gives image and video models no marks", () => {
    expect(declarationMarks({ type: "image", thinkingCategory: "qwen-budget" })).toEqual([]);
    expect(declarationMarks({ type: "video", pdfInput: true })).toEqual([]);
  });
});

describe("isMeasured", () => {
  it("is true only while the stored value is still the probe's", () => {
    expect(isMeasured(131_072, 131_072)).toBe(true);
    expect(isMeasured(128_000, 131_072)).toBe(false);
    expect(isMeasured(131_072, undefined)).toBe(false);
  });
});
