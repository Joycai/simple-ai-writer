import { describe, expect, it } from "vitest";
import { buildCarry, CARRY_LINES } from "../context";
import { buildUserMessage } from "../sakura";

const prev = {
  source: ["一行目です。", "二行目です。", "三行目です。", "四行目です。", "五行目です。", "六行目です。"],
  translated: ["第一行。", "第二行。", "第三行。", "第四行。", "第五行。", "第六行。"],
};

describe("buildCarry", () => {
  it("没有上一块时返回空数组 —— 调用方无条件展开即可", () => {
    expect(buildCarry(null)).toEqual([]);
    expect(buildCarry(undefined)).toEqual([]);
    expect(buildCarry({ source: [], translated: [] })).toEqual([]);
  });

  it("原文和译文都带，形态是一对 user/assistant", () => {
    const msgs = buildCarry(prev, 2);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content).toBe("第五行。\n第六行。");
  });

  it("user 那一侧仍然逐字是官方模板 —— 不往模板里插「以下是上文」", () => {
    // 插一段说明会让这一轮的输入不再是模型训练时见过的形状。
    const msgs = buildCarry(prev, 2);
    expect(msgs[0].content).toBe(buildUserMessage("五行目です。\n六行目です。"));
  });

  it("回带不带术语表 —— 这一对是给它看上一轮怎么译的，不是重新提要求", () => {
    const msgs = buildCarry(prev, 1);
    expect(msgs[0].content as string).not.toContain("术语表");
  });

  it("只取尾部，且不随块大小放大", () => {
    expect(CARRY_LINES).toBe(4);
    const msgs = buildCarry(prev);
    expect((msgs[1].content as string).split("\n")).toHaveLength(4);
  });

  it("上一块比要带的行数还短时，带它全部", () => {
    const short = { source: ["一。"], translated: ["1。"] };
    expect(buildCarry(short, 4)[1].content).toBe("1。");
  });

  it("两侧对不齐就一行都不带 —— 错位的上下文比没有上下文坏", () => {
    // 它会教模型把 A 句译成 B 句的样子，而且没有任何信号说这件事发生了。
    expect(buildCarry({ source: ["一。", "二。"], translated: ["1。"] })).toEqual([]);
  });

  it("译文全是空白时不带", () => {
    expect(buildCarry({ source: ["一。"], translated: ["   "] })).toEqual([]);
  });
});
