import { describe, expect, it } from "vitest";
import { contextLabel, parseModelLabel, parseProviderLabel } from "../ai/modelLabel";

describe("parseModelLabel", () => {
  it("passes a plain model name through untouched", () => {
    expect(parseModelLabel("claude-opus-4-6")).toEqual({
      title: "claude-opus-4-6",
      badges: [],
      subtitle: null,
    });
  });

  it("lifts bracketed qualifiers out as badges", () => {
    expect(parseModelLabel("claude-opus-4-6-thinking [特价 kiro]")).toEqual({
      title: "claude-opus-4-6-thinking",
      badges: ["特价 kiro"],
      subtitle: null,
    });
  });

  it("handles full-width brackets and a leading qualifier", () => {
    expect(parseModelLabel("【官逆 AWS】claude-sonnet-4-6")).toEqual({
      title: "claude-sonnet-4-6",
      badges: ["官逆 AWS"],
      subtitle: null,
    });
  });

  it("collects multiple qualifiers", () => {
    const label = parseModelLabel("(企业 cli) gemini-3.5-flash [beta]");
    expect(label.title).toBe("gemini-3.5-flash");
    expect(label.badges.sort()).toEqual(["beta", "企业 cli"]);
  });

  it("treats all but the last piped segment as qualifiers", () => {
    expect(parseModelLabel("特价kiro | claude-opus-4-6-thinking")).toEqual({
      title: "claude-opus-4-6-thinking",
      badges: ["特价kiro"],
      subtitle: null,
    });
  });

  it("splits an Ollama namespace/tag into the subtitle", () => {
    expect(parseModelLabel("VladimirGav/gemma4-26b-16GB-VRAM-Uncensored:latest")).toEqual({
      title: "gemma4-26b-16GB-VRAM-Uncensored",
      badges: [],
      subtitle: "VladimirGav · latest",
    });
  });

  it("keeps a namespace with no tag", () => {
    expect(parseModelLabel("anthropic/claude-3.5-sonnet")).toEqual({
      title: "claude-3.5-sonnet",
      badges: [],
      subtitle: "anthropic",
    });
  });

  it("leaves a bare colon version alone — there is no publisher to pair it with", () => {
    expect(parseModelLabel("gpt-4:0613")).toEqual({
      title: "gpt-4:0613",
      badges: [],
      subtitle: null,
    });
  });

  it("falls back to the wire id when the name is blank", () => {
    expect(parseModelLabel("   ", "gpt-4o-mini").title).toBe("gpt-4o-mini");
  });

  it("never returns an empty title, even if the name is only a qualifier", () => {
    expect(parseModelLabel("[特价]").title).toBe("[特价]");
  });
});

describe("parseProviderLabel", () => {
  it("passes a plain provider name through untouched", () => {
    expect(parseProviderLabel("DeepSeek")).toEqual({ title: "DeepSeek", badges: [] });
  });

  it("lifts bracketed qualifiers out as badges", () => {
    expect(parseProviderLabel("[特价kiro量]沉默")).toEqual({
      title: "沉默",
      badges: ["特价kiro量"],
    });
  });

  it("handles full-width brackets and piped segments", () => {
    expect(parseProviderLabel("通义千问【PLAN】")).toEqual({
      title: "通义千问",
      badges: ["PLAN"],
    });
    expect(parseProviderLabel("官转 | aihubmix")).toEqual({
      title: "aihubmix",
      badges: ["官转"],
    });
  });

  it("never splits a slash — a provider name is not a namespaced id", () => {
    expect(parseProviderLabel("aihubmix/官转")).toEqual({
      title: "aihubmix/官转",
      badges: [],
    });
  });

  it("never returns an empty title, even if the name is only a qualifier", () => {
    expect(parseProviderLabel("[特价]").title).toBe("[特价]");
  });
});

describe("contextLabel", () => {
  it.each([
    [1_000_000, "1M"],
    [2_000_000, "2M"],
    [1_500_000, "1.5M"],
    [200_000, "200k"],
    [64_000, "64k"],
    [8_192, "8.2k"],
    [512, "512"],
  ])("formats %i as %s", (size, expected) => {
    expect(contextLabel(size)).toBe(expected);
  });

  it("returns null when unset", () => {
    expect(contextLabel(undefined)).toBeNull();
    expect(contextLabel(0)).toBeNull();
  });
});
