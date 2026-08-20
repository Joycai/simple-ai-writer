import { describe, expect, it } from "vitest";
import { formatStamp, parseTranscript, renderTurn, searchTurns, sliceTurns } from "../transcript";
import type { SceneTurn } from "../model";

const turn = (over: Partial<SceneTurn> = {}): SceneTurn => ({
  index: 1, speaker: "author", speakerName: "", at: 1755000000, text: "「你还在等？」", ...over,
});

function doc(...turns: SceneTurn[]): string {
  return `<!-- roleplay-transcript v1 agent=rp-a-0001 -->\n${turns.map(renderTurn).join("")}`;
}

describe("parseTranscript", () => {
  it("round-trips what renderTurn wrote", () => {
    const a = turn({ index: 1, speakerName: "林" });
    const b = turn({ index: 2, speaker: "agent", speakerName: "沈砚", text: "「等谁不重要。」" });
    const { turns, renumbered } = parseTranscript(doc(a, b));
    expect(renumbered).toBe(false);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ index: 1, speaker: "author", speakerName: "林", text: a.text });
    expect(turns[1]).toMatchObject({ index: 2, speaker: "agent", speakerName: "沈砚" });
  });

  it("keeps an author turn with no persona apart from a character turn", () => {
    const { turns } = parseTranscript(doc(turn({ speakerName: "" })));
    expect(turns[0].speaker).toBe("author");
    expect(turns[0].speakerName).toBe("");
  });

  it("renumbers by position and says so when the numbers are wrong", () => {
    const md = [
      "<!-- roleplay-transcript v1 agent=rp-a-0001 -->",
      "",
      `## [7] 我 · ${formatStamp(1755000000)}`,
      "",
      "一",
      "",
      `## [7] 沈砚 · ${formatStamp(1755000000)}`,
      "",
      "二",
    ].join("\n");
    const { turns, renumbered } = parseTranscript(md);
    expect(renumbered).toBe(true);
    expect(turns.map((t) => t.index)).toEqual([1, 2]);
  });

  // 作者手改这个文件是被允许的行为，不是错误。
  it("folds an unparsable heading into the previous turn instead of dropping it", () => {
    const md = [
      `## [1] 沈砚 · ${formatStamp(1755000000)}`,
      "",
      "「等谁不重要。」",
      "### 作者随手写的小标题",
      "还有这一句",
    ].join("\n");
    const { turns } = parseTranscript(md);
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toContain("还有这一句");
  });

  it("degrades a heading-less file to one turn rather than reporting nothing", () => {
    const { turns, renumbered } = parseTranscript("整篇都被作者改成了散文。");
    expect(turns).toHaveLength(1);
    expect(renumbered).toBe(true);
    expect(turns[0].text).toBe("整篇都被作者改成了散文。");
  });

  it("reports an empty file as no turns", () => {
    expect(parseTranscript("").turns).toEqual([]);
    expect(parseTranscript("<!-- roleplay-transcript v1 agent=rp-a-0001 -->\n").turns).toEqual([]);
  });

  it("never throws on junk", () => {
    expect(() => parseTranscript("## [ ] · · ·\n\n\n## [x]")).not.toThrow();
  });
});

describe("sliceTurns", () => {
  const turns = Array.from({ length: 5 }, (_, i) => turn({ index: i + 1, text: `t${i + 1}` }));

  it("slices an inclusive turn range", () => {
    expect(sliceTurns(turns, 2, 4).map((t) => t.index)).toEqual([2, 3, 4]);
  });

  it("clamps out-of-range bounds instead of erroring", () => {
    expect(sliceTurns(turns, -3, 99).map((t) => t.index)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns nothing for an inverted range", () => {
    expect(sliceTurns(turns, 4, 2)).toEqual([]);
  });
});

describe("searchTurns", () => {
  const turns = [
    turn({ index: 1, text: "第一行\n塔下的雪停了\n第三行" }),
    turn({ index: 2, text: "无关" }),
    turn({ index: 3, text: "又提到塔" }),
  ];

  it("returns the matching line, not the whole turn", () => {
    const hits = searchTurns(turns, "塔", 10);
    expect(hits.map((h) => h.turn.index)).toEqual([1, 3]);
    expect(hits[0].line).toBe("塔下的雪停了");
  });

  it("honours the cap and ignores an empty query", () => {
    expect(searchTurns(turns, "塔", 1)).toHaveLength(1);
    expect(searchTurns(turns, "   ", 10)).toEqual([]);
  });
});
