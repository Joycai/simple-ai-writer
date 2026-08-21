import { describe, expect, it } from "vitest";
import {
  formatStamp, parseTranscript, renderTranscript, renderTurn, searchTurns, sliceTurns,
  truncateTurns,
} from "../transcript";
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

/**
 * 回退（`rewind`）依赖的两个函数。
 *
 * 这里最要紧的是**往返**：截断之后重写出来的文件必须还能被 `parseTranscript`
 * 读回同样的轮次。这条路径上一旦出错，作者丢的是已经写下的字。
 */
describe("truncateTurns / renderTranscript", () => {
  const many: SceneTurn[] = [
    { index: 1, speaker: "author", speakerName: "桐谷萤", at: 1755000000, text: "*我推开门。*" },
    { index: 2, speaker: "agent", speakerName: "沈砚", at: 1755000060, text: "「你来晚了。」" },
    { index: 3, speaker: "author", speakerName: "", at: 1755000120, text: "「塔那边怎么样？」" },
    { index: 4, speaker: "agent", speakerName: "沈砚", at: 1755000180, text: "「还在烧。」" },
  ];

  it("只留轮号小于目标的部分", () => {
    expect(truncateTurns(many, 3).map((t) => t.index)).toEqual([1, 2]);
    expect(truncateTurns(many, 1)).toEqual([]);
    expect(truncateTurns(many, 99)).toHaveLength(4);
  });

  it("截断后重写的文件能被原样读回来", () => {
    const kept = truncateTurns(many, 3);
    const { turns, renumbered } = parseTranscript(renderTranscript("rp-a-0001", kept));
    expect(renumbered).toBe(false);
    expect(turns).toEqual(kept);
  });

  it("空记录也写出一个合法的文件头", () => {
    const md = renderTranscript("rp-a-0001", []);
    expect(md).toContain("agent=rp-a-0001");
    expect(parseTranscript(md).turns).toEqual([]);
  });
});

/**
 * 无名角色轮的往返。它真实存在：整篇认不出标题时的兜底轮就是一个
 * （speaker: "agent", speakerName: ""），回退触发的整文件重写会把它固化。
 * renderTurn 曾把空名角色轮兜底成 `我`——读回来就成了作者轮，说话人翻转。
 */
describe("无名角色轮", () => {
  it("round-trips as an agent turn, never flips into an author turn", () => {
    const anonymous = turn({ speaker: "agent", speakerName: "", text: "……" });
    const { turns } = parseTranscript(doc(anonymous));
    expect(turns).toHaveLength(1);
    expect(turns[0].speaker).toBe("agent");
    expect(turns[0].speakerName).toBe("");
    expect(turns[0].text).toBe("……");
  });

  it("renders with the stamp only — no borrowed author token", () => {
    const rendered = renderTurn(turn({ speaker: "agent", speakerName: "" }));
    expect(rendered).toContain(`## [1] ${formatStamp(1755000000)}`);
    expect(rendered).not.toContain("我 ·");
  });
});
