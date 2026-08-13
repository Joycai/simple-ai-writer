/**
 * Inline `<think>…</think>` splitting.
 *
 * The stakes are asymmetric, which is why the rules are conservative: text that
 * reaches a `{text}` chunk is inserted into the author's manuscript. Leaving a
 * stray tag visible is an annoyance; swallowing a passage the author wrote is
 * data loss.
 */

import { describe, expect, it } from "vitest";
import { createThinkTagSplitter, type StreamPiece } from "../ai/reasoning";

/** Feed a whole response through in the given chunking. */
function run(chunks: string[]): StreamPiece[] {
  const s = createThinkTagSplitter();
  const out: StreamPiece[] = [];
  for (const c of chunks) out.push(...s.push(c));
  out.push(...s.flush());
  return out;
}

const text = (pieces: StreamPiece[]) =>
  pieces.filter((p): p is { text: string } => "text" in p).map((p) => p.text).join("");
const reasoning = (pieces: StreamPiece[]) =>
  pieces.filter((p): p is { reasoning: string } => "reasoning" in p).map((p) => p.reasoning).join("");

describe("createThinkTagSplitter", () => {
  it("passes ordinary text through untouched", () => {
    const out = run(["她推开门，", "外面下着雨。"]);
    expect(text(out)).toBe("她推开门，外面下着雨。");
    expect(reasoning(out)).toBe("");
  });

  it("separates a leading think block from the answer", () => {
    const out = run(["<think>\nWeighing the options\n</think>\n\n这张图片是一张肖像。"]);
    expect(reasoning(out)).toBe("\nWeighing the options\n");
    expect(text(out)).toBe("\n\n这张图片是一张肖像。");
  });

  it("survives the opening tag arriving in pieces", () => {
    // The real stream splits wherever the network does, including mid-tag.
    const out = run(["<thi", "nk>", "hmm", "</think>", "answer"]);
    expect(reasoning(out)).toBe("hmm");
    expect(text(out)).toBe("answer");
  });

  it("survives the closing tag arriving in pieces", () => {
    const out = run(["<think>", "hmm</", "thi", "nk>ans", "wer"]);
    expect(reasoning(out)).toBe("hmm");
    expect(text(out)).toBe("answer");
  });

  it("never emits a partial tag as manuscript text", () => {
    // Mid-stream the splitter holds back anything that could still become a
    // tag; the held text must not leak into `{text}` in the meantime.
    const s = createThinkTagSplitter();
    const early = s.push("<think>reasoning so far</");
    expect(text(early)).toBe("");
    expect(reasoning(early)).toBe("reasoning so far");
  });

  it("leaves a mid-response <think> alone — that is the author's own text", () => {
    // A writing app must not eat a passage. Only a block at the very start of
    // the response is treated as the model's thinking.
    const out = run(["他写道：<think>这是我的想法</think>，然后合上本子。"]);
    expect(text(out)).toBe("他写道：<think>这是我的想法</think>，然后合上本子。");
    expect(reasoning(out)).toBe("");
  });

  it("tolerates whitespace before the opening tag", () => {
    const out = run(["\n  <think>hmm</think>answer"]);
    expect(reasoning(out)).toBe("hmm");
    expect(text(out)).toBe("answer");
  });

  it("reports an unterminated block as reasoning, not as answer text", () => {
    // The response was cut off mid-thought; the tail is not prose the author
    // asked for, so it must not land in the document.
    const out = run(["<think>thinking and then the stream di"]);
    expect(text(out)).toBe("");
    expect(reasoning(out)).toBe("thinking and then the stream di");
  });

  it("emits nothing at all for an empty response", () => {
    expect(run([])).toEqual([]);
    expect(run([""])).toEqual([]);
  });
});
