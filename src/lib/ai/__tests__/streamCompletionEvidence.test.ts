import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAI } from "../openai";
import { streamResponses } from "../responses";
import { streamGemini } from "../gemini";
import { streamAnthropic } from "../anthropic";
import type { StreamChunk, StreamOptions } from "../types";

const line = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
afterEach(() => vi.unstubAllGlobals());
const cases = [
  { name: "Chat", run: streamOpenAI, standard: "openai_compat", partial: line({ choices: [{ delta: { content: "partial" } }] }), terminal: "data: [DONE]\n\n" },
  { name: "Responses", run: streamResponses, standard: "openai_responses_compat", partial: line({ type: "response.output_text.delta", delta: "partial" }), terminal: line({ type: "response.completed", response: { usage: {} } }) },
  { name: "Gemini", run: streamGemini, standard: "gemini_compat", partial: line({ candidates: [{ content: { parts: [{ text: "partial" }] } }] }), terminal: line({ candidates: [{ finishReason: "STOP" }] }) },
  { name: "Anthropic", run: streamAnthropic, standard: "anthropic_compat", partial: line({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }), terminal: line({ type: "message_stop" }) },
] as const;

describe("completion requires protocol evidence", () => {
  for (const test of cases) {
    for (const complete of [false, true]) {
      it(`${test.name}: ${complete ? "accepts terminal evidence" : "preserves partial text but rejects bare EOF"}`, async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(test.partial + (complete ? test.terminal : ""), { status: 200 })));
        const chunks: StreamChunk[] = [];
        const opts: StreamOptions = {
          baseUrl: "https://example.test/v1", apiKey: "test", modelId: "test",
          standard: test.standard, messages: [{ role: "user", content: "Write" }],
          onChunk: (chunk) => chunks.push(chunk),
        };
        if (complete) await test.run(opts);
        else await expect(test.run(opts)).rejects.toThrow(/interrupt/i);
        expect(chunks.some((c) => "text" in c && c.text === "partial")).toBe(true);
        expect(chunks.some((c) => "done" in c)).toBe(complete);
      });
    }
  }
});
