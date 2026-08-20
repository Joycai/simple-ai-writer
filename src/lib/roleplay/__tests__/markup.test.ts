import { describe, expect, it } from "vitest";
import { classifySegment, parseScript, scriptPreview } from "../markup";

describe("parseScript", () => {
  it("splits the four markers, in any order, in one message", () => {
    const segs = parseScript(
      "*推开门，屋里没有点灯。*\n「你还在等？」\n油灯没点。\n[让他更冷一点]",
    );
    expect(segs.map((s) => s.kind)).toEqual(["action", "speech", "scene", "meta"]);
    expect(segs[0].plain).toBe("推开门，屋里没有点灯。");
    expect(segs[3].plain).toBe("让他更冷一点");
  });

  it("keeps the quote marks as their own runs so they can be muted", () => {
    const [speech] = parseScript("「你还在等？」");
    expect(speech.runs.map((r) => r.kind)).toEqual(["mark", "text", "mark"]);
    expect(speech.runs.map((r) => r.text).join("")).toBe("「你还在等？」");
  });

  it("drops blank lines — the manuscript expresses them as spacing", () => {
    expect(parseScript("「一」\n\n\n「二」")).toHaveLength(2);
  });

  // 流式回复总是处在未闭合状态，所以稿面必须当场就把它当台词。
  it("treats an unclosed quote as speech while streaming", () => {
    const [seg] = parseScript("「不办。等天亮");
    expect(seg.kind).toBe("speech");
    expect(seg.runs).toHaveLength(2);
  });

  // 输入框相反：打字过程中满屏跳色比晚一点着色糟得多。
  it("leaves an unclosed marker uncoloured when requireClosed", () => {
    expect(parseScript("「不办。等天亮", { requireClosed: true })[0].kind).toBe("scene");
    expect(parseScript("*他站起来", { requireClosed: true })[0].kind).toBe("scene");
    expect(parseScript("[让他冷", { requireClosed: true })[0].kind).toBe("scene");
  });

  it("accepts straight double quotes as speech too", () => {
    expect(parseScript('"are you still waiting?"')[0].kind).toBe("speech");
  });

  it("does not read a mid-line asterisk as an action", () => {
    expect(parseScript("2 * 3 = 6")[0].kind).toBe("scene");
  });
});

describe("classifySegment", () => {
  it("agrees with parseScript line for line", () => {
    const text = "*动作*\n「台词」\n场景\n[元指令]";
    const viaParse = parseScript(text).map((s) => s.kind);
    const viaLines = text.split("\n").map((l) => classifySegment(l)?.kind);
    expect(viaLines).toEqual(viaParse);
  });

  it("returns null for a blank line so the mirror can keep it", () => {
    expect(classifySegment("   ")).toBeNull();
  });
});

describe("scriptPreview", () => {
  // 一条回复常常以动作开场、以台词收尾，而列表里要认出的是那句话。
  it("previews the last segment, keeping its markup", () => {
    expect(scriptPreview("*他合上册子。*\n「等谁不重要。」", 40)).toBe("「等谁不重要。」");
    expect(scriptPreview("「先别问。」\n*他没有回头。*", 40)).toBe("*他没有回头。*");
  });

  it("truncates with an ellipsis", () => {
    expect(scriptPreview("屋里没有点灯，窗纸透着街市那一点红。", 6)).toBe("屋里没有点灯…");
  });

  it("is empty for empty input", () => {
    expect(scriptPreview("", 40)).toBe("");
  });
});
