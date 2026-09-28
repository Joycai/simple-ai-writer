/**
 * A refused request's body, read by the one shared reader (`refusal.ts`) in
 * every streaming adapter's non-2xx branch — called on the real adapters, with
 * `globalThis.fetch` answering the refusal, so what is asserted is the message
 * the author and the API log actually get (docs/api/refusal-plan.md).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { streamCompletion, type StreamOptions } from "../index";
import { __resetLearned, classify } from "../capability/learned";
import { isSafetyBlockMessage } from "../modelHealth";
import { streamOpenAI } from "../openai";
import { streamResponses } from "../responses";
import { streamAnthropic } from "../anthropic";
import { streamGemini } from "../gemini";
import { streamDashscope } from "../dashscope";
import type { ApiStandard, ToolDefinition } from "../types";

afterEach(() => {
  vi.unstubAllGlobals();
  __resetLearned();
});

interface Adapter {
  name: string;
  /** What the adapter's error starts with, before the status. */
  label: string;
  stream: (opts: StreamOptions) => Promise<void>;
  standard: ApiStandard;
  baseUrl: string;
  platform?: StreamOptions["platform"];
}

const ADAPTERS: Adapter[] = [
  { name: "Chat Completions", label: "OpenAI API error", stream: streamOpenAI, standard: "openai_compat", baseUrl: "https://relay.example/v1" },
  { name: "Responses", label: "OpenAI Responses API error", stream: streamResponses, standard: "openai_responses_compat", baseUrl: "https://relay.example/v1" },
  { name: "Anthropic", label: "Anthropic API error", stream: streamAnthropic, standard: "anthropic_compat", baseUrl: "https://relay.example" },
  { name: "Gemini", label: "Gemini API error", stream: streamGemini, standard: "gemini_compat", baseUrl: "https://relay.example/v1beta" },
  {
    name: "DashScope native", label: "DashScope API error", stream: streamDashscope, standard: "dashscope_compat",
    baseUrl: "https://maas.qianwenaiapi.com/api/v1", platform: "dashscope",
  },
];

/** The error `adapter` throws when the endpoint answers `status` with `body`, and the address it asked. */
async function refusal(adapter: Adapter, body: string, status = 400): Promise<{ message: string; url: string }> {
  let url = "";
  vi.stubGlobal("fetch", vi.fn(async (u: string) => {
    url = String(u);
    return new Response(body, { status });
  }));
  const err = await adapter.stream({
    baseUrl: adapter.baseUrl, apiKey: "k", standard: adapter.standard, platform: adapter.platform, modelId: "m",
    messages: [{ role: "user", content: "hi" }], onChunk: () => {},
  }).then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  return { message: (err as Error).message, url };
}

const TOOL_CHOICE_THINKING = "The tool_choice parameter does not support being set to required or object in thinking mode";

/** One refusal shape: the body the endpoint sends, and what the author reads after `(<url>): `. */
interface Shape { name: string; body: string; status?: number; reads: string }

const SHAPES: Shape[] = [
  {
    // landscape.md §7 第二十二个样本, verbatim.
    name: "DashScope compatible-mode: one SSE data line",
    body: `data: {"error":{"code":"invalid_parameter_error","param":null,"message":"${TOOL_CHOICE_THINKING}","type":"invalid_request_error"}}`,
    reads: `invalid_parameter_error: ${TOOL_CHOICE_THINKING}`,
  },
  {
    name: "the same object as a plain JSON body, with a top-level request_id",
    body: JSON.stringify({
      error: { code: "invalid_parameter_error", param: null, message: TOOL_CHOICE_THINKING, type: "invalid_request_error" },
      request_id: "a1b2",
    }),
    reads: `invalid_parameter_error: ${TOOL_CHOICE_THINKING} (request_id a1b2)`,
  },
  {
    // The message does not name the field; only `param` does.
    name: "an OpenAI error whose param names the refused field",
    body: JSON.stringify({
      error: { message: "Invalid value: 'required'. Supported values are: 'none' and 'auto'.", type: "invalid_request_error", param: "tool_choice", code: "invalid_value" },
    }),
    reads: "invalid_value: Invalid value: 'required'. Supported values are: 'none' and 'auto'. (param tool_choice)",
  },
  {
    name: "an OpenAI error with no code falls back to its type",
    body: JSON.stringify({ error: { message: "Incorrect API key provided.", type: "invalid_request_error", param: null, code: null } }),
    status: 401,
    reads: "invalid_request_error: Incorrect API key provided.",
  },
  {
    name: "Anthropic's envelope, request id beside it",
    body: JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "`temperature` and `top_p` cannot both be specified for this model." },
      request_id: "req_0123",
    }),
    reads: "invalid_request_error: `temperature` and `top_p` cannot both be specified for this model. (request_id req_0123)",
  },
  {
    name: "Gemini's envelope: a numeric code, the status names it",
    body: JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }),
    reads: "INVALID_ARGUMENT: API key not valid. Please pass a valid API key.",
  },
  {
    name: "Gemini's envelope in a one-item array",
    body: JSON.stringify([{ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }]),
    reads: "INVALID_ARGUMENT: API key not valid. Please pass a valid API key.",
  },
  {
    name: "a bare string error",
    body: JSON.stringify({ error: "model 'm' not found, try pulling it first" }),
    status: 404,
    reads: "model 'm' not found, try pulling it first",
  },
  {
    name: "DashScope native: the bare object in an SSE error frame",
    body: `id:1\nevent:error\n:HTTP_STATUS/400\ndata:${JSON.stringify({ code: "InvalidParameter", message: "Range of max_tokens should be [1, 65536]", request_id: "r1" })}\n\n`,
    reads: "InvalidParameter: Range of max_tokens should be [1, 65536] (request_id r1)",
  },
  {
    name: "a bare message with a type",
    body: JSON.stringify({ message: "invalid api-key", type: "authentication_error" }),
    status: 403,
    reads: "authentication_error: invalid api-key",
  },
  {
    name: "a relay's placeholder with the upstream's body under metadata.raw",
    body: JSON.stringify({
      error: {
        message: "Provider returned error", code: 400,
        metadata: {
          provider_name: "Upstream",
          raw: JSON.stringify({ error: { message: "Thinking mode does not support this tool_choice", type: "invalid_request_error", param: null, code: "invalid_request_error" } }),
        },
      },
    }),
    reads: "Provider returned error — Upstream: invalid_request_error: Thinking mode does not support this tool_choice",
  },
  {
    name: "a content filter's code",
    body: JSON.stringify({
      error: { message: "The prompt was filtered by the content management policy.", type: null, param: "prompt", code: "content_filter", status: 400 },
    }),
    reads: "content_filter: The prompt was filtered by the content management policy. (param prompt)",
  },
];

describe.each(ADAPTERS)("$name: a refused request's body", (adapter) => {
  it.each(SHAPES)("reads $name", async ({ body, status = 400, reads }) => {
    const { message, url } = await refusal(adapter, body, status);
    expect(message).toBe(`${adapter.label} ${status} (${url}): ${reads}`);
    // None of the wrapping reaches the author.
    expect(message).not.toMatch(/data:|event:|HTTP_STATUS|"\w+":/);
  });

  it("reads the same line off a CRLF frame with an indented data line", async () => {
    const framed = `id:1\r\nevent:error\r\n  data: ${SHAPES[1].body}\r\n\r\n`;
    expect((await refusal(adapter, framed)).message).toMatch(new RegExp(`\\): ${SHAPES[1].reads.replace(/[()]/g, "\\$&")}$`));
  });

  it.each([
    ["a gateway's HTML", "<html><body>502 Bad Gateway</body></html>", 502],
    ["an object with no message", '{"status":"busy"}', 503],
    ["an empty body", "", 500],
  ])("falls back to the raw text for %s", async (_name, body, status) => {
    const { message, url } = await refusal(adapter, body, status);
    expect(message).toBe(`${adapter.label} ${status} (${url}): ${body}`);
  });

  it("leaves the learned fallback and the safety memory reading what they read in the raw body", async () => {
    // Four refusals of a forced choice: named in the message, in `param` only, and by the upstream behind a relay.
    for (const shape of [SHAPES[0], SHAPES[1], SHAPES[2], SHAPES[10]]) {
      const { message } = await refusal(adapter, shape.body);
      expect(classify(new Error(message), { forcedToolChoice: true })).toEqual({ fact: "forcedToolChoice", ceiling: false });
    }
    expect(isSafetyBlockMessage((await refusal(adapter, SHAPES[11].body)).message)).toBe(true);
  });
});

describe("Chat Completions on 百炼: the framed forced-choice 400, end to end", () => {
  it("is learned and re-sent as auto", async () => {
    const tool: ToolDefinition = {
      type: "function",
      function: { name: "emit", description: "d", parameters: { type: "object", properties: {} } },
    };
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      sent.push((JSON.parse(String(init.body)) as Record<string, unknown>).tool_choice);
      return sent.length === 1
        ? new Response(SHAPES[0].body, { status: 400, headers: { "content-type": "text/event-stream" } })
        : new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200 });
    }));
    await streamCompletion({
      baseUrl: "https://maas.qianwenaiapi.com/compatible-mode/v1", apiKey: "k", standard: "openai_compat", platform: "dashscope",
      modelId: "qwen3.8-flash", messages: [{ role: "user", content: "hi" }], tools: [tool], toolChoice: "required", onChunk: () => {},
    });
    expect(sent).toEqual(["required", "auto"]);
  });
});
