/**
 * Recovering from the model's OUTPUT cap — the limit a big deliverable runs
 * into, and the one the loop used to have no answer for.
 *
 * Two casualties, two recoveries. Cut prose is resumed (ask for the rest, join
 * it on). A cut *tool call* cannot be resumed at all — half a JSON object is
 * not executable, and putting it in the history would break every later round,
 * since the Anthropic and Gemini adapters re-serialise past tool calls — so it
 * is dropped unexecuted and the model is told to write in pieces instead.
 *
 * Both are silent for the first few tries and then become the author's
 * decision: every retry is another paid request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamOptions, StreamMessage } from "../ai/types";
import type { AgentEvent } from "../agent/events";
import type { TaskPreset } from "../agent/presets";
import { runAgent, type AgentRuntimeOptions } from "../agent/runtime";
import type { LoreIndex } from "../lore";

vi.mock("../ai", () => ({ streamCompletion: vi.fn() }));
import { streamCompletion } from "../ai";
const mockStream = vi.mocked(streamCompletion);

const LORE_INDEX = { characters: [], world: [] } as unknown as LoreIndex;

const PRESET: TaskPreset = {
  id: "test",
  tools: ["list_lore_entities", "read_file"],
  maxRounds: 12,
  finishPolicy: "force-text",
};

const sent: StreamMessage[][] = [];

function queueRound(chunks: Array<Record<string, unknown>>): void {
  mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
    sent.push([...opts.messages]);
    for (const c of chunks) opts.onChunk(c as never);
  });
}

/** A round cut off mid-sentence. */
const truncatedText = (text: string) => [
  { text },
  { done: true, inputTokens: 5, outputTokens: 5, truncated: true, stopReason: "length" },
];

/** A round whose tool call was cut off mid-arguments — the JSON never closes. */
const truncatedCall = (name: string) => [
  {
    toolCalls: [
      { index: 0, id: `c-${name}`, name, arguments: '{"path":"/p/page.html","content":"<html' },
    ],
  },
  { done: true, inputTokens: 5, outputTokens: 5, truncated: true, stopReason: "length" },
];

function makeOptions(overrides: Partial<AgentRuntimeOptions> = {}) {
  const events: AgentEvent[] = [];
  const output: string[] = [];
  return {
    baseUrl: "http://localhost",
    apiKey: "k",
    standard: "openai" as const,
    modelId: "m",
    preset: PRESET,
    messages: [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "写一个很大的页面" },
    ],
    toolContext: { projectPath: "/p", loreIndex: LORE_INDEX, multimodal: false },
    signal: new AbortController().signal,
    onEvent: (e: AgentEvent) => void events.push(e),
    onOutputText: (t: string) => void output.push(t),
    events,
    output,
    ...overrides,
  } as AgentRuntimeOptions & { events: AgentEvent[]; output: string[] };
}

const truncations = (events: AgentEvent[]) =>
  events.filter((e): e is Extract<AgentEvent, { kind: "output-truncated" }> =>
    e.kind === "output-truncated");

beforeEach(() => {
  mockStream.mockReset();
  sent.length = 0;
});

describe("truncated prose", () => {
  it("asks for the rest and joins the halves into one answer", async () => {
    queueRound(truncatedText("第一段。"));
    queueRound([{ text: "第二段。" }, { done: true, inputTokens: 5, outputTokens: 5 }]);
    const opts = makeOptions();

    const result = await runAgent(opts);

    expect(opts.output[opts.output.length - 1]).toBe("第一段。第二段。");
    expect(result.rounds).toBe(2);
    // The nudge STAYS in the history: dropping it would leave two assistant
    // messages side by side, which the Anthropic protocol rejects.
    const roles = opts.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "user", "assistant"]);
    expect(truncations(opts.events)[0].recovery).toEqual({ kind: "text", attempt: 1 });
  });

  it("stops asking after three tries and puts it to the author", async () => {
    for (let i = 0; i < 4; i++) queueRound(truncatedText(`片段${i}`));
    const decisions: number[] = [];
    const opts = makeOptions({
      onTruncationLimit: async (recoveries) => {
        decisions.push(recoveries);
        return { action: "stop" };
      },
    });

    await runAgent(opts);

    // Three silent recoveries, then one question — not four questions, and not
    // an unbounded retry loop.
    expect(decisions).toEqual([3]);
    expect(truncations(opts.events).filter((e) => e.recovery)).toHaveLength(3);
    expect(opts.events.some((e) => e.kind === "truncation-limit")).toBe(true);
  });

  it("keeps going when the author says so, and re-arms the allowance", async () => {
    for (let i = 0; i < 5; i++) queueRound(truncatedText(`片段${i}`));
    queueRound([{ text: "收尾。" }, { done: true, inputTokens: 1, outputTokens: 1 }]);
    const asked: number[] = [];
    const opts = makeOptions({
      onTruncationLimit: async (n) => {
        asked.push(n);
        return { action: "continue" };
      },
    });

    await runAgent(opts);

    expect(asked).toEqual([3]);
    expect(opts.output[opts.output.length - 1]).toContain("收尾。");
  });

  it("stops rather than looping when no surface can show the card", async () => {
    for (let i = 0; i < 4; i++) queueRound(truncatedText(`片段${i}`));
    const opts = makeOptions(); // no onTruncationLimit — e.g. a lore modal

    const result = await runAgent(opts);

    expect(result.outcome).toBe("completed");
    expect(result.rounds).toBe(4);
  });
});

describe("truncated tool call", () => {
  it("drops the call, keeps it out of the history, and says what to do instead", async () => {
    queueRound(truncatedCall("read_file"));
    queueRound([{ text: "好的，我分段写。" }, { done: true, inputTokens: 1, outputTokens: 1 }]);
    const opts = makeOptions();

    await runAgent(opts);

    // Nothing unparseable reached the wire history — that is what would break
    // every subsequent round rather than just this one.
    const toolCallMessages = opts.messages.filter((m) => m.tool_calls?.length);
    expect(toolCallMessages).toHaveLength(0);
    expect(opts.messages.some((m) => m.role === "tool")).toBe(false);

    // The model was told, in a message it can act on.
    const guidance = opts.messages.filter(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("read_file"),
    );
    expect(guidance).toHaveLength(1);
    expect(truncations(opts.events)[0].recovery).toEqual({ kind: "tool-args", attempt: 1 });

    // And the author sees a failed step rather than a silent omission.
    const step = opts.events.find(
      (e): e is Extract<AgentEvent, { kind: "tool-step" }> =>
        e.kind === "tool-step" && e.step.name === "read_file",
    );
    expect(step?.step.status).toBe("error");
  });

  it("keeps the calls that did survive the same round", async () => {
    queueRound([
      {
        toolCalls: [
          { index: 0, id: "ok", name: "list_lore_entities", arguments: "{}" },
          { index: 1, id: "cut", name: "read_file", arguments: '{"path":"/p/a.md' },
        ],
      },
      { done: true, inputTokens: 5, outputTokens: 5, truncated: true, stopReason: "length" },
    ]);
    queueRound([{ text: "继续。" }, { done: true, inputTokens: 1, outputTokens: 1 }]);
    const opts = makeOptions();

    await runAgent(opts);

    const call = opts.messages.find((m) => m.tool_calls?.length);
    expect(call?.tool_calls?.map((c) => c.id)).toEqual(["ok"]);
    // Every surviving call still has its paired reply — the protocol rule that
    // makes a broken history permanent if it is ever violated.
    expect(opts.messages.filter((m) => m.role === "tool")).toHaveLength(1);
  });
});
