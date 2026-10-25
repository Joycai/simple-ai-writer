import { afterEach, describe, expect, it, vi } from "vitest";
import { carryScope, projectCarry } from "../carryScope";
import { streamCompletion, type StreamMessage } from "../index";

const origin = { baseUrl: "https://one.example/v1", apiKey: "secret-one", standard: "openai_responses_compat" as const, modelId: "same-name" };
const rawItems = [{ type: "reasoning", id: "rs_1", encrypted_content: "opaque-secret" },
  { type: "function_call", call_id: "c1", name: "read_file", arguments: "{}" }];
afterEach(() => vi.unstubAllGlobals());

describe("opaque history origin", () => {
  it("survives serialization, normalizes trailing slashes, and stores no credential", async () => {
    const scope = await carryScope(origin);
    expect(scope).toMatch(/^[a-f0-9]{64}$/);
    expect(await carryScope({ ...origin, baseUrl: origin.baseUrl + "/" })).toBe(scope);
    const history: StreamMessage[] = [{ role: "assistant", content: "answer", _carryScope: scope,
      _responseItems: { modelId: origin.modelId, items: rawItems } }];
    expect(projectCarry(JSON.parse(JSON.stringify(history)), scope)).toEqual(history);
  });

  for (const change of [{ baseUrl: "https://two.example/v1" }, { apiKey: "secret-two" },
    { modelId: "another-model" }, { standard: "openai_compat" as const },
    { platform: "orcarouter" as const }, { relayUpstream: "none" as const }]) {
    it(`separates ${Object.keys(change)[0]}`, async () => {
      expect(await carryScope({ ...origin, ...change })).not.toBe(await carryScope(origin));
    });
  }

  for (const standard of ["openai_compat", "openai_responses_compat", "gemini_compat", "anthropic_compat"] as const) {
    for (const changed of [false, true, "legacy"] as const) {
      it(`${standard}: ${changed === false ? "preserves same route" : "rebuilds foreign/legacy history"}`, async () => {
        const conn = { ...origin, standard };
        const message: StreamMessage = {
          role: "assistant", content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }],
          _carryScope: changed === "legacy" ? undefined : await carryScope(conn),
          _responseItems: { modelId: conn.modelId, items: rawItems },
          _geminiModelParts: [{ functionCall: { name: "read_file", args: {} }, thoughtSignature: "opaque-secret" }],
          _thinkingBlocks: { modelId: conn.modelId, blocks: [{ type: "thinking", thinking: "thought", signature: "opaque-secret" }] },
          _reasoning: { field: "reasoning_content", text: "thought", encrypted: { modelId: conn.modelId, value: "opaque-secret" } },
        };
        const before = JSON.stringify(message);
        let body: unknown;
        const terminal = standard === "openai_compat" ? "data: [DONE]\n\n"
          : 'data: ' + JSON.stringify(standard === "gemini_compat" ? { candidates: [{ finishReason: "STOP" }] }
            : standard === "anthropic_compat" ? { type: "message_stop" } : { type: "response.completed", response: {} }) + '\n\n';
        vi.stubGlobal("fetch", vi.fn(async () => new Response(terminal)));
        await streamCompletion({ ...conn, ...(changed === true ? { baseUrl: "https://two.example/v1", apiKey: "secret-two" } : {}),
          messages: [{ role: "user", content: "read" }, message, { role: "tool", tool_call_id: "c1", content: "file text" }],
          _onRequestBody: (b) => { body = b; }, onChunk: () => {},
        });
        expect(JSON.stringify(body).includes("opaque-secret")).toBe(changed === false);
        expect(JSON.stringify(body)).toContain("file text");
        expect(JSON.stringify(body)).not.toContain("_carryScope");
        if (standard === "gemini_compat" && changed !== false) expect(JSON.stringify(body)).toContain("skip_thought_signature_validator");
        expect(JSON.stringify(message)).toBe(before);
      });
    }
  }
});
