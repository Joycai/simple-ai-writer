import { afterEach, describe, expect, it, vi } from "vitest";
import { streamCompletion, type StreamChunk, type StreamOptions } from "../index";
import { planRequest } from "../capability/plan";
import { jsonModeShaping } from "../jsonMode";

const baseUrl = "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
const target = { baseUrl, modelId: "qwen4-max" };
const sse = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`;

function mockFetch(reply: string) {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(reply);
  }));
  return bodies;
}

function run(opts: Partial<StreamOptions> & Pick<StreamOptions, "standard">) {
  return streamCompletion({
    ...target, apiKey: "test", messages: [{ role: "user", content: "Hi" }], onChunk: () => {},
    ...opts,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("Qwen4-Max on Bailian", () => {
  it.each(["openai_compat", "dashscope_compat", "openai_responses_compat", "anthropic_compat"] as const)(
    "resolves the native effort ladder on %s",
    (standard) => {
      const plan = planRequest({ ...target, standard });
      expect(plan.wire.platform).toBe("dashscope");
      expect(plan.thinking.category.menu).toEqual(["off", "low", "high", "xhigh"]);
      expect(plan.thinking.state).toBe("on");
    },
  );

  it("requests a default-depth summary on Chat and echoes a separate ciphertext frame on the next turn", async () => {
    const bodies = mockFetch([
      sse({ choices: [{ delta: { encrypted_content: "opaque-chat" } }] }),
      sse({ choices: [{ delta: { content: "Hello" }, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ].join(""));
    const chunks: StreamChunk[] = [];
    await run({ standard: "openai_compat", onChunk: (chunk) => chunks.push(chunk) });
    const done = chunks.find((chunk) => "done" in chunk);
    expect(done?._reasoning?.encrypted?.value).toBe("opaque-chat");
    expect(bodies[0]).toMatchObject({
      enable_thinking: true, thinking_display: "summarized", preserve_thinking: true,
    });
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");

    await run({
      standard: "openai_compat", reasoningEffort: "medium",
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello", _reasoning: done?._reasoning, _carryScope: done?._carryScope },
        { role: "user", content: "Continue" },
      ],
    });
    expect(bodies[1]).toMatchObject({
      reasoning_effort: "high", messages: [{}, { encrypted_content: "opaque-chat" }, {}],
    });
  });

  it("nests native DashScope controls in parameters", async () => {
    const bodies = mockFetch(sse({ output: { choices: [{ message: { content: "Hi" }, finish_reason: "stop" }] } }));
    await run({ standard: "dashscope_compat", reasoningEffort: "xhigh" });
    expect(bodies[0]).toMatchObject({
      parameters: {
        enable_thinking: true, reasoning_effort: "xhigh", thinking_display: "summarized", preserve_thinking: true,
      },
    });
  });

  it("requests a Responses summary at default depth and recovers ciphertext from the terminal item", async () => {
    const summary = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Summary" }] };
    const encrypted = { ...summary, encrypted_content: "opaque-response" };
    const bodies = mockFetch([
      sse({ type: "response.reasoning_summary_text.delta", delta: "Summary" }),
      sse({ type: "response.output_item.done", item: summary, output_index: 0 }),
      sse({ type: "response.completed", response: { output: [encrypted] } }),
    ].join(""));
    const chunks: StreamChunk[] = [];
    await run({ standard: "openai_responses_compat", onChunk: (chunk) => chunks.push(chunk) });
    expect(bodies[0].reasoning).toEqual({ summary: "auto" });
    expect(chunks.filter((chunk) => "reasoning" in chunk)).toEqual([{ reasoning: "Summary" }]);
    expect(chunks.find((chunk) => "done" in chunk)?._responseItems?.items).toEqual([encrypted]);
  });

  it("uses Bailian's nested Responses schema and allowed_tools for forced choice with multiple tools", async () => {
    const standard = "openai_responses_compat";
    const schema = { name: "answer", parameters: { type: "object", properties: {} } };
    const json = jsonModeShaping({ ...target, standard }, "Hi", schema);
    expect(json.extraBody).toMatchObject({
      text: { format: { type: "json_schema", json_schema: { name: "answer", strict: true } } },
    });
    const bodies = mockFetch(sse({ type: "response.completed", response: {} }));
    await run({
      standard, reasoningEffort: "off", toolChoice: "required",
      tools: ["a", "b"].map((name) => ({
        type: "function", function: { name, description: name, parameters: {} },
      })),
    });
    expect(bodies[0]).toMatchObject({
      reasoning: { effort: "none" },
      tool_choice: {
        type: "allowed_tools", mode: "required",
        tools: [{ type: "function", name: "a" }, { type: "function", name: "b" }],
      },
    });
  });

  it("sends Messages thinking and output_config.effort together, and disables both on Off", async () => {
    const bodies = mockFetch(sse({ type: "message_stop" }));
    const standard = "anthropic_compat";
    await run({ standard, reasoningEffort: "max" });
    await run({ standard, reasoningEffort: "off" });
    expect(bodies[0]).toMatchObject({
      thinking: { type: "enabled", display: "summarized" }, output_config: { effort: "xhigh" },
    });
    expect(bodies[1].thinking).toEqual({ type: "disabled" });
    expect(bodies[1]).not.toHaveProperty("output_config");
  });

  it("replays the Messages signature from an ordinary answer on the next turn", async () => {
    const bodies = mockFetch([
      sse({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Summary" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque-signature" } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "message_stop" }),
    ].join(""));
    const chunks: StreamChunk[] = [];
    const standard = "anthropic_compat";
    await run({ standard, onChunk: (chunk) => chunks.push(chunk) });
    const done = chunks.find((chunk) => "done" in chunk);
    const messages: StreamOptions["messages"] = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello", _thinkingBlocks: done?._thinkingBlocks, _carryScope: done?._carryScope },
      { role: "user", content: "Continue" },
    ];
    await run({ standard, messages });
    await run({ standard, messages, apiKey: "other-key" });
    expect(JSON.stringify(bodies[2].messages)).not.toContain("opaque-signature");
    expect(bodies[1]).toMatchObject({
      messages: [
        { role: "user" },
        { role: "assistant", content: [
          { type: "thinking", thinking: "Summary", signature: "opaque-signature" },
          { type: "text", text: "Hello" },
        ] },
        { role: "user" },
      ],
    });
  });

  it("does not assume Bailian's wire behavior on a relay with the same model id", () => {
    const plan = planRequest({ ...target, baseUrl: "https://relay.example/v1", standard: "openai_compat" });
    expect(plan.thinking.category.id).toBe("openai-generic");
  });
});
