import { describe, expect, it } from "vitest";
import { belongsToSurface, cardsForSurface } from "../approvalRouting";

describe("belongsToSurface", () => {
  // 默认必须是「显示」：藏起一张卡片等于让那次运行永久挂起。
  it("gives an untagged card to the default surfaces", () => {
    expect(belongsToSurface({}, null)).toBe(true);
    expect(belongsToSurface({ surface: undefined }, null)).toBe(true);
  });

  it("keeps a tagged card away from the default surfaces", () => {
    expect(belongsToSurface({ surface: "rp-a-0001" }, null)).toBe(false);
  });

  it("gives a tagged card only to the surface named", () => {
    expect(belongsToSurface({ surface: "rp-a-0001" }, "rp-a-0001")).toBe(true);
    expect(belongsToSurface({ surface: "rp-a-0002" }, "rp-a-0001")).toBe(false);
  });

  // 一个带标识的界面不该顺手把默认卡片也收走——那会让对话助手的卡片
  // 出现在扮演面板里，正是这条规则要消灭的那种错位。
  it("does not hand an untagged card to a named surface", () => {
    expect(belongsToSurface({}, "rp-a-0001")).toBe(false);
  });
});

describe("cardsForSurface", () => {
  const items = [
    { id: "chat" },
    { id: "a", surface: "rp-a-0001" },
    { id: "b", surface: "rp-a-0002" },
    { id: "a2", surface: "rp-a-0001" },
  ];

  it("splits one queue across three surfaces without overlap or loss", () => {
    const def = cardsForSurface(items, null).map((i) => i.id);
    const a = cardsForSurface(items, "rp-a-0001").map((i) => i.id);
    const b = cardsForSurface(items, "rp-a-0002").map((i) => i.id);
    expect(def).toEqual(["chat"]);
    expect(a).toEqual(["a", "a2"]);
    expect(b).toEqual(["b"]);
    expect(def.length + a.length + b.length).toBe(items.length);
  });
});
