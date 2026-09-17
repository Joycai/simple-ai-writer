import { describe, expect, it } from "vitest";
import {
  nonWebServerTools,
  parseServerTools,
  supportsCodeInterpreter,
  supportsServerToolFor,
  summarizeServerToolResult,
} from "../serverTools";

// The code interpreter's model table is a measurement, not a guess: every id
// below was sent to DashScope on 2026-09-17 (landscape.md §7 第六个样本「代码解释器」).
describe("supportsCodeInterpreter", () => {
  it("matches what Chat Completions compat ran", () => {
    for (const id of [
      "qwen3-max", "qwen3-max-2026-01-23", "qwen3.5-plus", "qwen3.5-plus-2026-04-20", "qwen3.6-plus",
      "qwen3.7-plus", "qwen3.7-max", "qwen3.6-max-preview", "qwen3.5-flash", "qwen3.6-flash", "qwen3.5-397b-a17b",
      "Qwen3.5-Plus",
    ]) {
      expect(supportsCodeInterpreter("openai_compat", id), id).toBe(true);
    }
  });

  it("refuses what Chat Completions compat refused or silently ignored", () => {
    for (const id of [
      // 400 `does not support the code_interpreter tool`
      "qwen3.8-flash", "qwen3.8-max", "qwen3.8-27b",
      // accepted, but the prompt never grew: ignored
      "qwen-max", "qwen3-max-preview", "qwen3.5-omni-plus",
      "gpt-5.6", "",
    ]) {
      expect(supportsCodeInterpreter("openai_compat", id), id).toBe(false);
    }
  });

  it("matches what Responses compat ran", () => {
    for (const id of [
      "qwen3-max", "qwen3.5-plus", "qwen3.5-flash", "qwen3.7-plus", "qwen3.7-max", "qwen3.8-max", "qwen3.8-max-0902",
      "qwen3.8-flash", "qwen3.6-max-preview", "qwen3.5-397b-a17b", "qwen3.5-27b", "qwen3.6-35b-a3b", "qwen3.8-27b",
      "qwen3.8-2.4t-a95b", "deepseek-v4-pro", "deepseek-v4-flash-0731", "deepseek-v4.1-flash",
    ]) {
      expect(supportsCodeInterpreter("openai_responses_compat", id), id).toBe(true);
    }
  });

  it("refuses what Responses compat failed", () => {
    for (const id of [
      "qwen3.6-27b", "qwen3-max-preview", "qwen3-235b-a22b-thinking-2507", "qwen3-vl-plus", "qwen3.5-omni-plus",
      "qwen-plus", "qwen3.8-livetranslate-flash-realtime", "qwen3.7-text-embedding",
    ]) {
      expect(supportsCodeInterpreter("openai_responses_compat", id), id).toBe(false);
    }
  });

  it("is a DashScope compat tool only", () => {
    for (const standard of ["openai", "openai_responses", "anthropic_compat", "gemini"] as const) {
      expect(supportsCodeInterpreter(standard, "qwen3.5-plus"), standard).toBe(false);
      expect(supportsServerToolFor(standard, "code_interpreter", "qwen3.5-plus"), standard).toBe(false);
    }
  });

  it("gates only the code interpreter by model id", () => {
    expect(supportsServerToolFor("openai_compat", "web_search", "anything")).toBe(true);
    expect(supportsServerToolFor("openai_compat", "code_interpreter", "anything")).toBe(false);
    expect(supportsServerToolFor("openai_compat", "code_interpreter", "qwen3.5-plus")).toBe(true);
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
