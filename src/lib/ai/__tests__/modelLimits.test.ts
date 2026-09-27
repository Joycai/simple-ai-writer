/**
 * The built-in output-cap table. How a model's cap is resolved — the author's
 * value, the platform's row, this table, the app default — and who may act on
 * which is `values.test.ts`'s.
 */
import { describe, expect, it } from "vitest";

import { knownMaxOutput } from "../modelLimits";

describe("knownMaxOutput", () => {
  it("knows the 2026-09 千问AI平台 catalogue, dated snapshots and vendor prefixes included", () => {
    expect(knownMaxOutput("qwen3.8-flash")).toBe(131_072);
    expect(knownMaxOutput("deepseek-v4-pro-0813")).toBe(393_216);
    expect(knownMaxOutput("kimi/kimi-k3")).toBe(1_000_000);
    expect(knownMaxOutput("MiniMax-M2.5")).toBe(32_768);
    expect(knownMaxOutput("qwen3-vl-plus-2025-12-19")).toBe(32_768);
  });

  it("knows DeepSeek's own two-model catalogue, not just the relay spellings", () => {
    // `deepseek-flash` shares no prefix with deepseek-chat/-reasoner/-v4-pro,
    // so before its own row it answered null and the author's model fell back
    // to the app-wide default — a silent truncation, not a visible wrong value.
    expect(knownMaxOutput("deepseek-flash")).toBe(393_216);
    expect(knownMaxOutput("deepseek/deepseek-flash")).toBe(393_216);
    expect(knownMaxOutput("deepseek-chat")).toBe(8_192);
  });

  it("matches the longest prefix, not the first", () => {
    // gpt-4-turbo's own cap, not the gpt-4 entry's.
    expect(knownMaxOutput("gpt-4-turbo")).toBe(4_096);
    expect(knownMaxOutput("gpt-4")).toBe(8_192);
  });

  it("sees through a relay's vendor prefix and a dated model id", () => {
    expect(knownMaxOutput("openai/gpt-4o")).toBe(16_384);
    expect(knownMaxOutput("gpt-4o-2024-11-20")).toBe(16_384);
    expect(knownMaxOutput("GPT-4O")).toBe(16_384);
  });

  it("says nothing about Anthropic models on purpose", () => {
    // A max_tokens above the model's ceiling is a 400 there, so the adapter's
    // own conservative default owns that decision — see the file header.
    expect(knownMaxOutput("claude-opus-4-6")).toBeNull();
    expect(knownMaxOutput("anthropic/claude-sonnet-4-5")).toBeNull();
  });

  it("returns null for anything it has never heard of", () => {
    expect(knownMaxOutput("some-local-build-q4")).toBeNull();
    expect(knownMaxOutput("")).toBeNull();
  });
});
