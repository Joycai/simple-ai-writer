import { describe, expect, it } from "vitest";
import {
  buildUserMessage,
  FREQ_LADDER,
  judgeChunk,
  maxTokensFor,
  SAKURA_SAMPLING,
  SAKURA_SYSTEM,
} from "../sakura";

describe("提示词模板", () => {
  it("system 是训练时那句话，逐字", () => {
    // 改动这个断言等于改动模型的输入分布。它固定在这里就是为了让那件事必须
    // 是一个决定，而不是一次顺手的润色。
    expect(SAKURA_SYSTEM).toBe(
      "你是一个轻小说翻译模型，可以流畅通顺地以日本轻小说的风格将日文翻译成简体中文，" +
        "并联系上下文正确使用人称代词，不擅自添加原文中没有的代词。",
    );
  });

  it("无术语表时走短模板", () => {
    expect(buildUserMessage("彼は扉を開けた。")).toBe("将下面的日文文本翻译成中文：彼は扉を開けた。");
  });

  it("空白术语表也走短模板，而不是留一个空清单", () => {
    // 传一个只有空白的表进去，长模板会告诉模型"参考以下对应关系"然后什么都不给。
    expect(buildUserMessage("彼は扉を開けた。", "   \n  ")).toBe(
      "将下面的日文文本翻译成中文：彼は扉を開けた。",
    );
  });

  it("有术语表时走长模板，表在原文之前", () => {
    const msg = buildUserMessage("文香は扉を開けた。", "文香->芙美香 #主人公");
    expect(msg).toBe(
      "根据以下术语表（可以为空）：\n文香->芙美香 #主人公\n" +
        "将下面的日文文本根据对应关系和备注翻译成中文：文香は扉を開けた。",
    );
  });
});

describe("采样参数", () => {
  it("温度与 top_p 是实测那一组", () => {
    expect(SAKURA_SAMPLING).toEqual({ temperature: 0.1, topP: 0.3 });
  });

  it("重试阶梯从 0.1 起步，不是官方文档里的 0", () => {
    // 实测 100 行在 0 上退化、在 0.2 上完整且快一倍，所以首发就付这点保守。
    expect(FREQ_LADDER).toEqual([0.1, 0.2]);
  });

  it("max_tokens 按行数给，短块有下限", () => {
    expect(maxTokensFor(50)).toBe(1600);
    expect(maxTokensFor(2)).toBe(256);
  });
});

describe("judgeChunk", () => {
  const ok = (lines: number, tokens: number) =>
    judgeChunk({
      srcLineCount: lines,
      outText: Array.from({ length: lines }, (_, i) => `第${i}行`).join("\n"),
      truncated: false,
      completionTokens: tokens,
    });

  it("正常的一块通过，并交回拆好的行", () => {
    // 实测 60 行 / 1295 tok ≈ 21.6 tok/行。
    const v = ok(60, 1295);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.lines).toHaveLength(60);
  });

  it("空行不算行", () => {
    const v = judgeChunk({
      srcLineCount: 2,
      outText: "一\n\n  \n二\n",
      truncated: false,
      completionTokens: 10,
    });
    expect(v.ok).toBe(true);
  });

  it("撞满输出上限报 truncated", () => {
    // 实测 60 行 / max_tokens 512：27 行，19 tok/行 —— 没有退化，就是块太大。
    const v = judgeChunk({
      srcLineCount: 60,
      outText: Array.from({ length: 27 }, (_, i) => `第${i}行`).join("\n"),
      truncated: true,
      completionTokens: 512,
    });
    expect(v).toMatchObject({ ok: false, reason: "truncated" });
  });

  it("退化时报 degenerate 而不是 truncated —— 两者同时成立，原因才是有用的那个", () => {
    // 实测 100 行 / freq 0：4096 tok 只译出 63 行 = 65 tok/行，同时 finish=length。
    // 报成 truncated 会把作者引向"调大 max_tokens"，而实测那正是错的处方。
    const v = judgeChunk({
      srcLineCount: 100,
      outText: Array.from({ length: 63 }, (_, i) => `第${i}行`).join("\n"),
      truncated: true,
      completionTokens: 4096,
    });
    expect(v).toMatchObject({ ok: false, reason: "degenerate" });
  });

  it("行数不符报 line-mismatch —— 实测三次失败它全都抓到了", () => {
    const v = judgeChunk({
      srcLineCount: 10,
      outText: "一\n二\n三",
      truncated: false,
      completionTokens: 30,
    });
    expect(v).toMatchObject({ ok: false, reason: "line-mismatch" });
  });

  it("什么都没返回时报 line-mismatch 而不是崩在除零上", () => {
    const v = judgeChunk({ srcLineCount: 5, outText: "  \n\n", completionTokens: 0 });
    expect(v).toMatchObject({ ok: false, reason: "line-mismatch" });
  });

  it("整行完全重复但 tok/行 正常 —— 必须判通过", () => {
    // 不变量 4 的守卫。实测两次退化的「重复整行」计数都是 0（复读发生在一行
    // 之内），所以谁要是回头加一条"重复行检测"，它会在这里红：那个检测抓不到
    // 真正的退化，却会误杀合法的重复台词。
    const line = "「……」";
    const v = judgeChunk({
      srcLineCount: 6,
      outText: Array.from({ length: 6 }, () => line).join("\n"),
      truncated: false,
      completionTokens: 60,
    });
    expect(v.ok).toBe(true);
  });

  it("行数太少时不做 tok/行 判定 —— 一行长句子六十个 token 是正常的", () => {
    const v = judgeChunk({
      srcLineCount: 1,
      outText: "他推开门，看见窗外正下着今年的第一场雪，街上没有一个人。",
      truncated: false,
      completionTokens: 60,
    });
    expect(v.ok).toBe(true);
  });

  it("端点不报 token 数时，另外两个信号照常工作", () => {
    const v = judgeChunk({ srcLineCount: 3, outText: "一\n二", truncated: false });
    expect(v).toMatchObject({ ok: false, reason: "line-mismatch" });
  });
});
