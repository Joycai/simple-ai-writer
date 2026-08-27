/**
 * 前情的纯逻辑部分。
 *
 * 模型那一半没法在单测里跑，但**喂进去什么**可以——而这正是最容易悄悄出错的
 * 地方：截错了，角色记住的就是半场戏。
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../../i18n", () => ({ default: { t: (k: string) => k, language: "zh-CN" } }));

import { recapInput } from "../recap";
import type { SceneTurn } from "../model";

function turn(index: number, speaker: "author" | "agent", text: string): SceneTurn {
  return { index, speaker, speakerName: speaker === "agent" ? "沈砚" : "", at: 1755000000, text };
}

describe("recapInput", () => {
  const many: SceneTurn[] = Array.from({ length: 8 }, (_, i) =>
    turn(i + 1, i % 2 === 0 ? "author" : "agent", `第${i + 1}轮`.padEnd(60, "x")));

  it("整轮为单位，超上限取最近的", () => {
    const out = recapInput(many, 300);
    expect(out).toContain("第8轮");
    expect(out).not.toContain("第1轮");
  });

  it("一轮就超上限时仍然给出那一轮——空手摘要等于没摘要", () => {
    const out = recapInput([turn(1, "author", "x".repeat(9999))], 100);
    expect(out.length).toBeGreaterThan(9000);
  });

  it("空场返回空串，调用方据此不跑模型", () => {
    expect(recapInput([], 1000)).toBe("");
  });

  it("保持时间顺序，不因为倒着挑就倒着输出", () => {
    const out = recapInput(many, 100000);
    expect(out.indexOf("第1轮")).toBeLessThan(out.indexOf("第8轮"));
  });
});
