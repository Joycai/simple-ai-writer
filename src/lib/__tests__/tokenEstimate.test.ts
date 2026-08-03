import { describe, it, expect } from "vitest";
import { estimateTextTokens, estimateMessagesTokens, estimateToolsTokens } from "../ai/tokenEstimate";
import type { StreamMessage, ToolDefinition } from "../ai/types";

describe("estimateTextTokens", () => {
  it("counts CJK characters as ~1 token each", () => {
    expect(estimateTextTokens("你好世界")).toBe(4);
  });

  it("counts other characters as ~4 per token", () => {
    expect(estimateTextTokens("abcdefgh")).toBe(2);
  });

  it("handles mixed text", () => {
    // 4 CJK + 8 latin → 4 + 2 = 6
    expect(estimateTextTokens("你好世界abcdefgh")).toBe(6);
  });
});

describe("estimateMessagesTokens", () => {
  it("sums string-content messages with per-message overhead", () => {
    const messages: StreamMessage[] = [
      { role: "system", content: "abcdefgh" }, // 2 + 4 overhead
      { role: "user", content: "你好世界" },   // 4 + 4 overhead
    ];
    expect(estimateMessagesTokens(messages)).toBe(14);
  });

  it("charges a fixed cost per image part", () => {
    const messages: StreamMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "abcd" }, // 1
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }, // 800
        ],
      },
    ];
    expect(estimateMessagesTokens(messages)).toBe(4 + 1 + 800);
  });

  it("includes assistant tool-call arguments", () => {
    const messages: StreamMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "1", type: "function", function: { name: "read", arguments: "{\"path\":1}" } },
        ],
      },
    ];
    // overhead 4 + ceil(("read" + "{\"path\":1}").length / 4) = 4 + ceil(14/4) = 8
    expect(estimateMessagesTokens(messages)).toBe(8);
  });
});

describe("estimateToolsTokens", () => {
  it("is zero for no tools", () => {
    expect(estimateToolsTokens(undefined)).toBe(0);
    expect(estimateToolsTokens([])).toBe(0);
  });

  it("scales with a tool schema's stringified size", () => {
    const tools: ToolDefinition[] = [
      {
        type: "function",
        function: { name: "read", description: "x".repeat(400), parameters: { type: "object", properties: {} } },
      },
    ];
    expect(estimateToolsTokens(tools)).toBe(estimateTextTokens(JSON.stringify(tools)));
    expect(estimateToolsTokens(tools)).toBeGreaterThan(90); // ~400 chars of description alone
  });
});
