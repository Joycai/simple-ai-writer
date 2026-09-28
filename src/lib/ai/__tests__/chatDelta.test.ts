/**
 * The shared choice reader behind Chat Completions and DashScope's native
 * protocol. Its one invariant: how the endpoint happened to cut the stream
 * into frames does not change what the turn said — the text, the thinking,
 * the tool calls and the finish reason come out the same for every cut.
 */

import { describe, expect, it } from "vitest";
import { createChatDeltaReader, deltaText, type ChatChoice } from "../chatDelta";
import type { AccumulatedToolCall, StreamChunk, StreamOptions } from "../types";

function opts(chunks: StreamChunk[]): StreamOptions {
  return {
    baseUrl: "", apiKey: "", modelId: "m", apiStandard: "openai_compat",
    messages: [], onChunk: (c: StreamChunk) => { chunks.push(c); },
  } as unknown as StreamOptions;
}

/** A small deterministic PRNG, so a failing seed can be replayed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Cut `s` into 1..n pieces at random points. */
function cut(s: string, rand: () => number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const n = 1 + Math.floor(rand() * Math.max(1, Math.min(6, s.length - i)));
    out.push(s.slice(i, i + n));
    i += n;
  }
  return out;
}

interface Turn {
  content: string;
  reasoning: string;
  calls: { id: string; name: string; args: string }[];
  finish: string;
}

/**
 * The frames an endpoint might send for `turn`: reasoning first, then content,
 * then each call — id and name on its first fragment and `""` after it, the way
 * DashScope sends them (ref sample s2) — then a frame with the finish reason.
 */
function frames(turn: Turn, rand: () => number): ChatChoice[] {
  const out: ChatChoice[] = [];
  for (const r of cut(turn.reasoning, rand)) out.push({ delta: { reasoning_content: r } });
  for (const c of cut(turn.content, rand)) {
    // Either shape of content: a string, or DashScope's `[{text}]`.
    out.push({ delta: { content: rand() < 0.5 ? c : [{ text: c }] } });
  }
  turn.calls.forEach((call, index) => {
    cut(call.args, rand).forEach((a, k) => {
      out.push({
        delta: {
          tool_calls: [{
            index, id: k === 0 ? call.id : "",
            function: { ...(k === 0 ? { name: call.name } : {}), arguments: a },
          }],
        },
      });
    });
  });
  out.push({ delta: {}, finish_reason: turn.finish });
  return out;
}

function readAll(choices: ChatChoice[]) {
  const chunks: StreamChunk[] = [];
  const reader = createChatDeltaReader(opts(chunks));
  for (const c of choices) reader.read(c);
  const end = reader.finish();
  const bags = chunks as Array<{ text?: string; reasoning?: string; toolCalls?: AccumulatedToolCall[] }>;
  const text = bags.map((c) => c.text ?? "").join("");
  const reasoning = bags.map((c) => c.reasoning ?? "").join("");
  const calls = bags.find((c) => c.toolCalls)?.toolCalls;
  return { text, reasoning, calls, ...end };
}

describe("createChatDeltaReader", () => {
  it("reads the same turn from every cut of its frames", () => {
    const turn: Turn = {
      content: "她推开门，外面下着雨。The rain did not stop.",
      reasoning: "先想清楚人物的动机，再写动作。",
      calls: [
        { id: "call_a", name: "read_lore", args: '{"entity":"灯塔守","facet":"外貌"}' },
        { id: "call_b", name: "search", args: '{"query":"雨夜"}' },
      ],
      finish: "tool_calls",
    };
    const expected = readAll(frames(turn, rng(1)));
    expect(expected.text).toBe(turn.content);
    expect(expected.reasoning).toBe(turn.reasoning);
    expect(expected.calls?.map((c) => [c.id, c.name, c.arguments])).toEqual(
      turn.calls.map((c) => [c.id, c.name, c.args]),
    );
    expect(expected.stopReason).toBe("tool_calls");
    for (let seed = 2; seed < 200; seed++) {
      expect(readAll(frames(turn, rng(seed)))).toEqual(expected);
    }
  });

  it("splits an inline <think> block the same way for every cut", () => {
    const turn: Turn = { content: "<think>构思一下</think>正文开始。", reasoning: "", calls: [], finish: "stop" };
    for (let seed = 1; seed < 100; seed++) {
      const got = readAll(frames(turn, rng(seed)));
      expect(got.reasoning).toBe("构思一下");
      expect(got.text).toBe("正文开始。");
      expect(got.calls).toBeUndefined();
    }
  });

  it("marks a length stop as truncated and throws on the refusal family", () => {
    expect(readAll([{ delta: { content: "半句" }, finish_reason: "length" }]).truncated).toBe(true);
    for (const reason of ["content_filter", "sensitive", "network_error"]) {
      const reader = createChatDeltaReader(opts([]), "DashScope");
      expect(() => reader.read({ finish_reason: reason })).toThrow(/^DashScope: /);
    }
  });
});

describe("deltaText", () => {
  it("reads a string and a part array alike", () => {
    expect(deltaText("a")).toBe("a");
    expect(deltaText([{ text: "a" }, { image: "x" }, { text: "b" }])).toBe("ab");
    expect(deltaText(undefined)).toBe("");
  });
});
