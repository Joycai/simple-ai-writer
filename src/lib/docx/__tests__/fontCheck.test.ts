/**
 * 字体探测：这里只能测「没有 canvas 时的答案」——vitest 跑在 node 环境，没有
 * DOM，也就没有真正的字体表。测的是**失败方向**，而那恰恰是这个模块最要紧的
 * 一条：探测不了就说「装了」，绝不在一台其实装了字体的机器上到处挂警告。
 */

import { describe, expect, it } from "vitest";
import { isFontInstalled, missingFonts } from "../fontCheck";

describe("探测不了的时候", () => {
  it("一律回答「装了」，不误报", () => {
    expect(isFontInstalled("仿宋_GB2312")).toBe(true);
    expect(missingFonts(["仿宋_GB2312", "黑体"])).toEqual([]);
  });

  it("空字体名不算缺失", () => {
    expect(isFontInstalled("")).toBe(true);
    expect(isFontInstalled("   ")).toBe(true);
  });
});
