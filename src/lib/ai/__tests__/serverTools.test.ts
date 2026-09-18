import { describe, expect, it } from "vitest";
import {
  nonWebServerTools,
  parseServerTools,
  effectiveServerTools,
  serverToolsSent,
  supportsServerToolFor,
  summarizeServerToolResult,
} from "../serverTools";
import { wireOf } from "../platforms";

const DS = { platform: "dashscope", standard: "openai_compat" } as const;

describe("supportsServerToolFor", () => {
  it("is a DashScope tool only, whatever the standard", () => {
    // A row still labelled dashscope, switched to an official standard or to
    // a family DashScope has no interpreter on (wireOf resolves the official
    // ones to their vendor).
    for (const standard of ["openai", "openai_responses", "anthropic_compat", "gemini_compat"] as const) {
      const wire = wireOf({ platform: "dashscope", baseUrl: "", standard });
      expect(supportsServerToolFor(wire, "code_interpreter", "qwen3.5-plus"), standard).toBe(false);
    }
    // Same standard, another platform: the bug this table exists to fix.
    for (const platform of ["deepseek", "newapi", "orcarouter", "ollama", "custom"] as const) {
      expect(supportsServerToolFor({ platform, standard: "openai_compat" }, "web_search", "qwen3.5-plus"), platform).toBe(false);
      expect(supportsServerToolFor({ platform, standard: "openai_compat" }, "code_interpreter", "qwen3.5-plus"), platform).toBe(false);
    }
  });

  it("gates only the code interpreter by model id", () => {
    expect(supportsServerToolFor(DS, "web_search", "anything")).toBe(true);
    expect(supportsServerToolFor(DS, "code_interpreter", "anything")).toBe(false);
    expect(supportsServerToolFor(DS, "code_interpreter", "qwen3.5-plus")).toBe(true);
  });
});

describe("effectiveServerTools", () => {
  it("cuts a declaration to what the wire can say, canonically, absent when nothing is left", () => {
    const all = ["image_search", "web_extractor", "web_search", "code_interpreter"] as const;
    expect(effectiveServerTools({ platform: "dashscope", standard: "openai_responses_compat" }, all, "qwen3.5-plus"))
      .toEqual(["web_search", "web_extractor", "image_search", "code_interpreter"]);
    expect(effectiveServerTools({ platform: "xai", standard: "openai_responses_compat" }, all, "grok-4.6"))
      .toEqual(["web_search"]);
    expect(effectiveServerTools({ platform: "deepseek", standard: "openai_compat" }, all, "deepseek-flash"))
      .toBeUndefined();
    // Extraction survives only beside search.
    expect(effectiveServerTools(DS, ["web_extractor"], "qwen3.5-plus")).toBeUndefined();
  });
});

describe("serverToolsSent", () => {
  const model = { providerId: "p", modelId: "deepseek-flash", serverTools: ["web_search"] as ["web_search"] };
  const provider = (baseUrl: string) => ({ id: "p", name: "P", baseUrl, apiStandard: "openai_compat" as const, createdAt: 0 });

  it("answers what the provider's platform sends, the declaration only without a provider list", () => {
    expect(serverToolsSent(model, [provider("https://dashscope.aliyuncs.com/compatible-mode/v1")])).toEqual(["web_search"]);
    expect(serverToolsSent(model, [provider("https://api.deepseek.com")])).toBeUndefined();
    expect(serverToolsSent(model, [])).toBeUndefined();
    expect(serverToolsSent(model)).toEqual(["web_search"]);
  });
});

describe("code_interpreter declarations", () => {
  it("round-trips through storage and stands alone", () => {
    expect(parseServerTools('["code_interpreter","web_search"]')).toEqual(["web_search", "code_interpreter"]);
    expect(parseServerTools('["code_interpreter"]')).toEqual(["code_interpreter"]);
  });

  it("keeps only the non-web ids for a main model whose web belongs to the search subagent", () => {
    expect(nonWebServerTools(["web_search", "web_extractor", "image_search", "code_interpreter"])).toEqual(["code_interpreter"]);
    expect(nonWebServerTools(["web_search"])).toBeUndefined();
    expect(nonWebServerTools(undefined)).toBeUndefined();
  });
});

describe("summarizeServerToolResult", () => {
  const result = (output: string | undefined) => ({
    phase: "result" as const, id: "x", name: "code_interpreter", results: [], output,
  });

  it("shows the last line a code run printed — the exception's line after a traceback", () => {
    expect(summarizeServerToolResult(result("77269364466549865653073473388030061522211723"))).toBe(
      "77269364466549865653073473388030061522211723",
    );
    expect(summarizeServerToolResult(result(
      "----\nZeroDivisionError                         Traceback (most recent call last)\n----> 1 1/0\n\nZeroDivisionError: division by zero\n",
    ))).toBe("ZeroDivisionError: division by zero");
    expect(summarizeServerToolResult(result("x".repeat(200)))).toBe(`${"x".repeat(160)}…`);
  });

  it("falls back to a search's hits when there is no output", () => {
    expect(summarizeServerToolResult({
      phase: "result", id: "s", name: "web_search",
      results: [{ title: "Rust", url: "https://www.rust-lang.org/" }],
    })).toBe("Rust");
  });
});
