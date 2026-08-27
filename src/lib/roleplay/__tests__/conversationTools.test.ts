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

/** 上一场（已封存，可读）。 */
const PAST: SceneTurn[] = [
  turn(1, "author", "「雪原上冷得很。」"),
  turn(2, "agent", "「我记得。」"),
];

const reader = (turns: SceneTurn[] = TURNS, renumbered = false) => ({
  conversation: {
    scenes: async () => ({ current: 1, past: [] }),
    read: async () => ({ turns, renumbered }),
  },
});

/**
 * 一个转过场的角色：当前是第 3 场，第 1 场可读，**第 2 场被作者作废**——
 * 它压根不出现在 `past` 里，所以工具够不到它。
 */
const multiScene = () => ({
  conversation: {
    scenes: async () => ({ current: 3, past: [1] }),
    read: async (scene: number) => ({
      turns: scene === 3 ? TURNS : PAST,
      renumbered: false,
    }),
  },
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

/**
 * 转场之后，「你还记得我们在雪原上说的话吗」问的多半**不是这一场**。这一组钉的
 * 是：角色够得到自己的旧场次，而且**只有自己的**、**不含作废的**。
 */
describe("自己的旧场次", () => {
  it("省略 scene 时搜自己的每一场", async () => {
    const r = await searchConversationTool("c1", { query: "雪原" }, multiScene());
    expect(r.content).toContain("scene 1");
    expect(r.content).toContain("turn 1");
  });

  it("当前这一场的命中不加场次前缀", async () => {
    const r = await searchConversationTool("c1", { query: "塔下" }, multiScene());
    expect(r.content).toContain("turn 3");
    expect(r.content).not.toContain("scene 3 ·");
  });

  it("能按场号读回旧场次的原文", async () => {
    const r = await readConversationTool("c2", { scene: 1 }, multiScene());
    expect(r.content).toContain("雪原上冷得很");
    expect(r.content).toContain("Scene 1 (an earlier one of yours)");
  });

  it("省略 scene 读的是当前这一场", async () => {
    const r = await readConversationTool("c2", {}, multiScene());
    expect(r.content).toContain("等谁不重要");
  });

  /**
   * 作废的场次**连显式点名都够不到**：它不在 `scenes().past` 里，所以工具只能
   * 回一句「你没有第 2 场」。对角色来说那一场确实没有发生过——多说一句「你不能
   * 读它」反而是在告诉它有一段它不该知道的历史。
   */
  it("作废的那一场不存在，而不是「不能读」", async () => {
    const r = await readConversationTool("c2", { scene: 2 }, multiScene());
    expect(r.content).toContain("no scene 2");
    expect(r.content).toContain("1, 3");
    expect(r.content).not.toContain("雪原");
  });

  it("搜索也够不到作废的那一场", async () => {
    const r = await searchConversationTool("c1", { query: "雪原", scene: 2 }, multiScene());
    expect(r.content).toContain("no scene 2");
  });

  it("场号完全不存在时报出自己有哪几场", async () => {
    const r = await readConversationTool("c2", { scene: 99 }, multiScene());
    expect(r.content).toContain("no scene 99");
    expect(r.content).toContain("3 is the one you are in now");
  });
});
