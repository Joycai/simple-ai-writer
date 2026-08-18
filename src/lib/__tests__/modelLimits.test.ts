/**
 * The built-in output-cap table and how a model's effective cap is resolved.
 *
 * The rule worth locking down is the ORDER — author's value, then the table,
 * then the app-wide default — because two consumers read it (the request
 * adapters and the budget planner) and a disagreement between them produces a
 * "context budget" that doesn't describe what the endpoint actually did.
 */
import { describe, expect, it } from "vitest";

import { effectiveMaxOutput, knownMaxOutput } from "../ai/modelLimits";

describe("knownMaxOutput", () => {
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

describe("effectiveMaxOutput", () => {
  it("prefers what the author configured over everything else", () => {
    expect(effectiveMaxOutput({ modelId: "gpt-4o", maxOutput: 4_000 }, 99_000)).toBe(4_000);
  });

  it("falls back to the table, then to the app-wide default", () => {
    expect(effectiveMaxOutput({ modelId: "gpt-4o" }, 99_000)).toBe(16_384);
    expect(effectiveMaxOutput({ modelId: "mystery-model" }, 99_000)).toBe(99_000);
  });

  it("stays undefined when nobody has an opinion", () => {
    // Not 0: undefined means "no cap declared", and each protocol then does
    // its own thing. A 0 would read as a real ceiling to anything downstream.
    expect(effectiveMaxOutput({ modelId: "mystery-model" }, 0)).toBeUndefined();
    expect(effectiveMaxOutput({ modelId: "mystery-model" })).toBeUndefined();
  });
});
