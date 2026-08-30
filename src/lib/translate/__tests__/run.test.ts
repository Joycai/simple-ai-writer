import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The wire, replaced by a scripted one. What is under test is the *ladder* and
 * the document loop — which requests get made, with what frequency penalty, and
 * what lands in the file when one of them never comes good.
 */
const calls: { freq?: number; maxOutput?: number; lineCount: number; messages: unknown[] }[] = [];
type Reply = { text: string; truncated?: boolean; outputTokens?: number } | "abort";
let script: Reply[] = [];

vi.mock("../../ai", () => ({
  streamCompletion: async (o: {
    frequencyPenalty?: number;
    maxOutput?: number;
    messages: { role: string; content: string }[];
    onChunk: (c: unknown) => void;
  }) => {
    const last = o.messages[o.messages.length - 1].content;
    const src = last.slice(last.indexOf("：") + 1);
    calls.push({
      freq: o.frequencyPenalty,
      maxOutput: o.maxOutput,
      lineCount: src.split("\n").length,
      messages: o.messages,
    });
    const reply = script.shift();
    if (reply === "abort") {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    if (!reply) throw new Error("script exhausted — the loop made more requests than expected");
    o.onChunk({ text: reply.text });
    o.onChunk({
      done: true,
      inputTokens: 10,
      outputTokens: reply.outputTokens ?? reply.text.split("\n").filter(Boolean).length * 20,
      truncated: reply.truncated ?? false,
    });
  },
}));

import { runChunk, runDocument, type DocProgress } from "../run";
import { splitDocument } from "../chunk";

const CONN = { baseUrl: "http://x/v1", apiKey: "", standard: "openai_compat", modelId: "sakura" } as never;

/** N 行日文，行 i 的内容是 `第i行です。` */
const jp = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => `第${from + i}行です。`).join("\n");
/** 同样 N 行的"译文"。 */
const zh = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => `第${from + i}行。`).join("\n");

/**
 * 一份永远不合格的回复。
 *
 * **三行**，而不是一行加一个大 token 数：切到单行之后 tok/行 判定会被跳过
 * （MIN_LINES_FOR_RATIO —— 一行长句子六十个 token 是正常的），那时只有行数
 * 校验还在工作。回复固定三行，就保证了从 4 行块一路切到单行块，每一级都判失败。
 */
const broken: Reply = { text: "壊れた\n壊れた\n壊れた", outputTokens: 900 };

beforeEach(() => {
  calls.length = 0;
  script = [];
});

describe("runChunk — 重试阶梯", () => {
  const oneChunk = (n: number) => splitDocument(jp(n)).chunks[0];

  it("一次就成时只发一次请求，用阶梯的首项", () => {
    // 首发 0.1 而不是 0：实测 100 行在 0 上退化，0.2 上完整且快一倍。
    script = [{ text: zh(5) }];
    return runChunk(oneChunk(5), { conn: CONN }).then((r) => {
      expect(r.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].freq).toBe(0.1);
    });
  });

  it("退化后按阶梯升到 0.2 重试同一块", async () => {
    // 实测：同一块 freq 0 退化、0.2 完整。这条断言守的就是那个阶梯真的走了。
    script = [
      { text: zh(3), outputTokens: 300 }, // 100 tok/行 → degenerate
      { text: zh(3) },
    ];
    const r = await runChunk(oneChunk(3), { conn: CONN });
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.freq)).toEqual([0.1, 0.2]);
    expect(r.attempts.map((a) => a.reason)).toEqual(["degenerate", undefined]);
  });

  it("阶梯走完后对半切，两半各自重走一遍", async () => {
    script = [
      { text: zh(4), outputTokens: 400 }, // 0.1 退化
      { text: zh(4), outputTokens: 400 }, // 0.2 退化
      { text: zh(2) },                    // 前半 2 行
      { text: zh(2) },                    // 后半 2 行
    ];
    const r = await runChunk(oneChunk(4), { conn: CONN });
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.lineCount)).toEqual([4, 4, 2, 2]);
    expect(r.lines).toHaveLength(4);
  });

  it("切到单行仍不合格就停 —— 不是无限递归", async () => {
    // halveChunk 对单行块返回它自己，那是唯一的终止条件。
    script = Array.from({ length: 20 }, () => broken);
    const r = await runChunk(oneChunk(2), { conn: CONN });
    expect(r.ok).toBe(false);
    expect(r.lines).toEqual([]);
    // 2 行块两次 + 前半那个单行块两次 = 4。**后半根本没发**：前半失败时
    // runChunk 立刻整块判死（半份译文配半份原文更难收拾），所以一个翻不动的
    // 块的代价是 4 次请求而不是 6 次。脚本里备了 20 条，用掉 4 条。
    expect(calls).toHaveLength(4);
  });

  it("max_tokens 按本块行数给", async () => {
    script = [{ text: zh(50) }];
    await runChunk(oneChunk(50), { conn: CONN });
    expect(calls[0].maxOutput).toBe(1600);
  });

  it("永远不带工具 —— 它没有工具调用可循环", async () => {
    script = [{ text: zh(2) }];
    await runChunk(oneChunk(2), { conn: CONN });
    expect((calls[0] as unknown as { tools?: unknown }).tools).toBeUndefined();
  });
});

describe("runDocument", () => {
  const DOC = [jp(3, 0), "", "https://example.test/x", jp(3, 3)].join("\n");

  it("整篇译完，空行与 URL 原位不动", async () => {
    script = [{ text: zh(6) }];
    const r = await runDocument(DOC, { conn: CONN });
    expect(r.failed).toEqual([]);
    expect(r.aborted).toBe(false);
    expect(r.text.split("\n")).toEqual([
      "第0行。", "第1行。", "第2行。", "", "https://example.test/x", "第3行。", "第4行。", "第5行。",
    ]);
  });

  it("逐块报进度，且开跑前先报一次 0", async () => {
    // 那个 0 不是凑数：第一块要几十秒才回来，作者在那几十秒里唯一能看到的
    // 就是它——总量在，进度条就有底。
    script = [{ text: zh(2) }, { text: zh(2) }, { text: zh(2) }];
    const seen: string[] = [];
    await runDocument(DOC, {
      conn: CONN,
      linesPerChunk: 2,
      onProgress: (p) => seen.push(`${p.done}/${p.total}·${p.failed}`),
    });
    expect(seen).toEqual(["0/3·0", "1/3·0", "2/3·0", "3/3·0"]);
  });

  it("进度的行/字分母只数送进模型的行", async () => {
    // 空行和 URL 根本不进请求，算进分母进度条就永远到不了头。
    script = [{ text: zh(2) }, { text: zh(2) }, { text: zh(2) }];
    const seen: DocProgress[] = [];
    await runDocument(DOC, { conn: CONN, linesPerChunk: 2, onProgress: (p) => seen.push(p) });
    const last = seen[seen.length - 1];
    expect(last.totalLines).toBe(6);          // 文档 8 行，其中 2 行没有日文
    expect(last.lines).toBe(6);
    expect(last.totalChars).toBe(jp(6).split("\n").join("").length);
    expect(last.chars).toBe(last.totalChars);
    expect(seen[0]).toMatchObject({ done: 0, lines: 0, chars: 0, totalLines: 6 });
  });

  it("失败的块也算处理完——它的等待确实结束了", async () => {
    script = Array.from({ length: 6 }, () => broken);
    const seen: DocProgress[] = [];
    await runDocument(jp(2), { conn: CONN, onProgress: (p) => seen.push(p) });
    const last = seen[seen.length - 1];
    expect(last).toMatchObject({ done: 1, total: 1, failed: 1, lines: 2, totalLines: 2 });
  });

  it("失败的块保留原文，并在它前面留一行标记", async () => {
    // 不变量 3。写进文件的绝不是模型那次的输出。
    script = Array.from({ length: 6 }, () => broken);
    const { chunks } = splitDocument(jp(2));
    expect(chunks).toHaveLength(1);
    const r = await runDocument(jp(2), { conn: CONN });
    expect(r.failed).toHaveLength(1);
    const lines = r.text.split("\n");
    expect(lines[0]).toMatch(/^<!-- 翻译失败（第 1\/1 块/);
    // 原文，逐字。不是 "壊れた"，也不是空。
    expect(lines.slice(1)).toEqual(["第0行です。", "第1行です。"]);
  });

  it("一份文档里有成功也有失败时，标记不会错位", async () => {
    script = [
      { text: zh(2) },                                   // 块 1 成功
      ...Array.from({ length: 4 }, () => broken), // 块 2 全败（4 次，见上）
      { text: zh(2, 4) },                                // 块 3 成功
    ];
    const r = await runDocument(jp(6), { conn: CONN, linesPerChunk: 2 });
    const lines = r.text.split("\n");
    // 标记插在块 2 的首行之前，块 1 与块 3 的译文都在自己的位置上。
    expect(lines[0]).toBe("第0行。");
    expect(lines[2]).toMatch(/^<!-- 翻译失败（第 2\/3 块/);
    expect(lines.slice(3, 5)).toEqual(["第2行です。", "第3行です。"]);
    expect(lines.slice(5)).toEqual(["第4行。", "第5行。"]);
  });

  it("中断保留已完成的块，并把 aborted 说出来", async () => {
    script = [{ text: zh(2) }, "abort"];
    const r = await runDocument(jp(6), { conn: CONN, linesPerChunk: 2 });
    expect(r.aborted).toBe(true);
    const lines = r.text.split("\n");
    expect(lines.slice(0, 2)).toEqual(["第0行。", "第1行。"]);
    // 没轮到的行原样留下 —— 花掉的时间不该跟着一起丢。
    expect(lines.slice(2)).toEqual(["第2行です。", "第3行です。", "第4行です。", "第5行です。"]);
  });

  it("上一块的尾巴回带给下一块，失败的块不进 carry", async () => {
    script = [
      { text: zh(2) },                                    // 块 1 成功
      ...Array.from({ length: 4 }, () => broken), // 块 2 全败（4 次）
      { text: zh(2, 4) },                                 // 块 3
    ];
    await runDocument(jp(6), { conn: CONN, linesPerChunk: 2 });
    // 块 3 那次请求（脚本里的最后一次）带的上文应当是**块 1** 的译文，
    // 而不是块 2 那段没译出来的东西。
    const lastMsgs = calls[calls.length - 1].messages as { role: string; content: string }[];
    expect(lastMsgs).toHaveLength(4); // system + carry 一对 + 本轮提问
    expect(lastMsgs[2].content).toBe("第0行。\n第1行。");
  });

  it("累加所有请求的 token，包括失败的那些", async () => {
    script = Array.from({ length: 6 }, () => broken);
    const r = await runDocument(jp(2), { conn: CONN });
    // 失败的请求也真的发出去了，也真的要记在账上。四次，见阶梯那一节。
    expect(r.usage.inputTokens).toBe(40);
    expect(r.usage.outputTokens).toBe(3600);
  });
});
