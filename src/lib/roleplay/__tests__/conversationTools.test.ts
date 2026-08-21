/**
 * 角色回看自己这一场对话的两个工具。
 *
 * 盯住的主要是**死胡同**这一类坏法：一个检索工具的结果必须指向一个这个 agent
 * 真的能调的读工具，而且那个读工具真的能读到那个东西。上一版的 `search_text`
 * 两条都不满足，而它在 preset 里躺了很久没人发现——因为「模型调了一个不存在
 * 的工具」这件事只会表现为「这一轮它说了句奇怪的话」。
 */

import { describe, expect, it } from "vitest";
import { readConversationTool, searchConversationTool } from "../conversationTools";
import { DEFAULT_SCENE_WINDOW, type SceneTurn } from "../model";

function turn(index: number, speaker: "author" | "agent", text: string): SceneTurn {
  return {
    index,
    speaker,
    speakerName: speaker === "author" ? "林" : "沈砚",
    at: 0,
    text,
  };
}

const TURNS: SceneTurn[] = [
  turn(1, "author", "*推开门，屋里没有点灯。*\n「你还在等？」"),
  turn(2, "agent", "「等谁不重要。」"),
  turn(3, "author", "「雪停了就去塔下，说定了。」"),
  turn(4, "agent", "「说定了。」"),
];

const reader = (turns: SceneTurn[] = TURNS, renumbered = false) => ({
  conversation: { read: async () => ({ turns, renumbered }) },
});

describe("searchConversationTool", () => {
  it("returns turn numbers pointing at read_conversation", async () => {
    const r = await searchConversationTool("c1", { query: "塔下" }, reader());
    expect(r.content).toContain("turn 3");
    // 命中必须告诉模型下一步调什么——这正是 search_text 当年缺的那一环。
    expect(r.content).toContain("read_conversation");
  });

  it("labels who said it, from this agent's point of view", async () => {
    const r = await searchConversationTool("c1", { query: "等谁" }, reader());
    expect(r.content).toContain("你");
  });

  it("says how much it searched when nothing matched", async () => {
    // 光说「没找到」会被读成「工具坏了」，于是模型再试一次，白烧一轮。
    const r = await searchConversationTool("c1", { query: "沙漠" }, reader());
    expect(r.content).toContain("4 turns");
  });

  it("refuses an empty query instead of returning everything", async () => {
    const r = await searchConversationTool("c1", { query: "  " }, reader());
    expect(r.content).toContain("non-empty");
  });

  it("says so when there is no channel, rather than looking empty", async () => {
    const r = await searchConversationTool("c1", { query: "塔" }, {});
    expect(r.content).toContain("roleplay conversation");
  });
});

describe("readConversationTool", () => {
  it("reads the range search pointed at", async () => {
    const r = await readConversationTool("c2", { from: 3, to: 3 }, reader());
    expect(r.content).toContain("雪停了就去塔下");
    expect(r.content).not.toContain("等谁不重要");
  });

  it("defaults to the most recent window", async () => {
    const many = Array.from({ length: DEFAULT_SCENE_WINDOW + 5 }, (_, i) =>
      turn(i + 1, i % 2 ? "agent" : "author", `第 ${i + 1} 轮`));
    const r = await readConversationTool("c2", {}, reader(many));
    expect(r.content).toContain(`第 ${many.length} 轮`);
    expect(r.content).not.toContain("第 1 轮\n");
  });

  it("reports an out-of-range ask with the real range", async () => {
    const r = await readConversationTool("c2", { from: 90, to: 99 }, reader());
    expect(r.content).toContain("turns 1–4");
  });

  /**
   * 超预算时按**轮**丢，不按字符切：半句台词回不来，而一整轮至少还能续读。
   * 返回的范围也要跟着缩，否则模型以为它读到了实际没给它的轮次。
   */
  it("drops whole turns when the range is too long, and says the range it actually gave", async () => {
    const fat = Array.from({ length: 12 }, (_, i) => turn(i + 1, "agent", "字".repeat(2000)));
    const r = await readConversationTool("c2", { from: 1, to: 12 }, reader(fat));
    expect(r.content).toContain("left out");
    expect(r.content).not.toContain("Returned [1–12]");
  });

  it("passes on that the record was renumbered by hand", async () => {
    const r = await readConversationTool("c2", {}, reader(TURNS, true));
    expect(r.content).toContain("edited by hand");
  });

  it("says so when there is no channel", async () => {
    const r = await readConversationTool("c2", {}, {});
    expect(r.content).toContain("roleplay conversation");
  });
});
