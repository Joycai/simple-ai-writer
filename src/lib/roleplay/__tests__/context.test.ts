/**
 * 不变量二的回归测试。
 *
 * 「绑定的设定永远在上下文里」这件事没有任何显式机制守着它——它成立，仅仅
 * 因为绑定块被放在 prelude 里、且不是 `meta.seedContext`。所以这里跑的是
 * **真的** `planFold` + `buildCompactedHistory`，不是它们的替身：这条不变量
 * 会不会被破坏，取决于 lib/agent/compact 将来怎么改，而那正是这个测试要盯住
 * 的东西。症状（聊到第四十轮角色忘了自己是谁）要几十轮之后才出现，靠人工是
 * 发现不了的。
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../../i18n", () => ({ default: { t: (k: string) => k, language: "zh-CN" } }));
vi.mock("../../fs/fileio", () => ({
  readFile: vi.fn(async (p: string) => `正文：${p}`),
  writeFile: vi.fn(),
  appendFile: vi.fn(),
  fileExists: vi.fn(async () => true),
  makeDir: vi.fn(),
  readDir: vi.fn(async () => []),
  renamePath: vi.fn(),
  removeFile: vi.fn(),
  writeBinaryFile: vi.fn(),
}));
vi.mock("../../lore/entity", () => ({
  readEntityFile: vi.fn(async (dir: string, file: string) => `${dir}/${file} 的正文`),
}));

import { buildCompactedHistory, planFold, segmentHistory } from "../../agent/compact";
import type { StreamMessage } from "../../ai/types";
import type { LoreEntity, LoreIndex } from "../../lore/model";
import {
  buildBoundContent, refreshMemoryBlock, seedRoleplayHistory, selectReplayTurns,
  type RoleplaySessionMeta,
} from "../context";
import type { MemoryRecord, RoleplayAgent, SceneTurn } from "../model";

function entity(name: string, dirPath: string, facets: string[] = []): LoreEntity {
  return {
    id: name, category: "characters", dirPath, name, aliases: [], summary: `${name}的一句话`,
    avatarPath: null, mdFiles: ["index.md"], images: [],
    facets: facets.map((file) => ({
      file, title: file.replace(/\.md$/, ""), slot: null, keys: [], group: null,
      priority: 0, mode: "manual" as const, charCount: 100,
    })),
  };
}

const ELDEN = entity("沈砚", "/p/.ai-writer/lore/characters/elden", ["speech.md"]);
const TOWER = entity("塔", "/p/.ai-writer/lore/world/tower");
const INDEX: LoreIndex = { characters: [ELDEN], world: [TOWER] };

const AGENT: RoleplayAgent = {
  id: "rp-a-0001", kind: "character", name: "沈砚",
  primaryDirPath: ELDEN.dirPath,
  boundPaths: [ELDEN.dirPath],
  modelId: null, authorPersona: null,
  createdAt: 0, updatedAt: 0, turnCount: 0, boundHash: null,
};

async function seed(firstMessage = "「你还在等？」", memory: MemoryRecord[] = []) {
  return seedRoleplayHistory({
    agent: AGENT,
    persona: { mode: "none", dirPath: null, prompt: "" },
    personaCard: "说话短，从不解释动机。",
    primaryText: "寒露之变的幸存者。",
    loreIndex: INDEX,
    firstMessage,
    matchText: firstMessage,
    loreBudgetChars: 4000,
    memory,
  });
}

function turn(index: number, speaker: "author" | "agent", text: string): SceneTurn {
  return { index, speaker, speakerName: speaker === "author" ? "" : "沈砚", at: 0, text };
}

describe("seedRoleplayHistory", () => {
  it("lays the history out in the invariant-two shape", async () => {
    const { messages, meta } = await seed();
    expect(messages[0].role).toBe("system");
    // [1] 绑定块：prelude 里的一条独立消息，meta 按身份持有它。
    expect(meta.boundBlock).toBe(messages[1]);
    expect(meta.boundBlock).not.toBe(meta.seedContext);
    // 最后一条是作者的话，且它是本轮的起点。
    expect(meta.turnStarts[0]).toBe(messages[messages.length - 1]);
  });

  it("puts the primary entry's text in the system layer, not the bound block", async () => {
    const { messages } = await seed();
    expect(String(messages[0].content)).toContain("寒露之变的幸存者");
    expect(String(messages[0].content)).toContain("说话短，从不解释动机");
  });

  it("records the bound entities in the injection ledger so they are not re-sent", async () => {
    const { meta } = await seed();
    expect(meta.injected.has(ELDEN.dirPath)).toBe(true);
    expect(meta.injected.get(ELDEN.dirPath)?.carrier).toBe(meta.boundBlock);
  });

  it("keeps the bound block out of the auto-match pass", async () => {
    // 提到自己的名字也不该把绑定条目再注入一遍。
    const { meta } = await seed("沈砚，你还在等？");
    const seedText = meta.seedContext ? String(meta.seedContext.content) : "";
    expect(seedText).not.toContain(`${ELDEN.dirPath}/index.md`);
  });
});

const PACT: MemoryRecord = {
  id: "m1", kind: "pact", title: "雪停了一起去塔下", body: "他答应了。",
  status: "open", turn: 12, subject: null, updatedAt: 0,
};

describe("记忆块（不变量四）", () => {
  it("sits in the prelude between the bound block and the seed block", async () => {
    const { messages, meta } = await seed("「塔那边有消息了？」", [PACT]);
    expect(meta.boundBlock).toBe(messages[1]);
    expect(meta.memoryBlock).toBe(messages[2]);
    expect(meta.seedContext).toBe(messages[3]);
    expect(String(meta.memoryBlock?.content)).toContain("雪停了一起去塔下");
  });

  it("is absent entirely when the agent has recorded nothing", async () => {
    const { meta } = await seed("「你还在等？」", []);
    expect(meta.memoryBlock).toBeNull();
  });

  it("keeps only what is still live", async () => {
    const { meta } = await seed("「你还在等？」", [
      PACT,
      { ...PACT, id: "m2", title: "早就兑现了", status: "done" },
    ]);
    const text = String(meta.memoryBlock?.content);
    expect(text).toContain("雪停了一起去塔下");
    expect(text).not.toContain("早就兑现了");
  });

  it("refreshes in place so the meta keeps pointing at the same message", async () => {
    const { meta } = await seed("「你还在等？」", [PACT]);
    const block = meta.memoryBlock;
    refreshMemoryBlock(meta, [{ ...PACT, id: "m2", title: "后来又说定了一件事" }]);
    expect(meta.memoryBlock).toBe(block);
    expect(String(block?.content)).toContain("后来又说定了一件事");
    expect(String(block?.content)).not.toContain("雪停了一起去塔下");
  });

  // 块从「有」变「没有」时不删消息：删一条 prelude 会让稳定前缀变短，白白作废
  // 一次 prompt 缓存，而它只是一行字。
  it("degrades to a placeholder rather than vanishing", async () => {
    const { messages, meta } = await seed("「你还在等？」", [PACT]);
    const before = messages.length;
    refreshMemoryBlock(meta, []);
    expect(meta.memoryBlock).not.toBeNull();
    expect(messages).toHaveLength(before);
  });
});

describe("不变量二 · 压缩之后", () => {
  it("keeps the bound block and drops the seed block", async () => {
    // 首句提到「塔」，好让自动命中真的产出一个 seed 块可供丢弃。
    const { messages, meta } = await seed("「塔那边有消息了？」", [PACT]);
    const history: StreamMessage[] = [...messages];
    const boundBlock = meta.boundBlock;
    const memoryBlock = meta.memoryBlock;
    expect(boundBlock).not.toBeNull();
    expect(memoryBlock).not.toBeNull();

    // 攒出足够长的对话去触发折叠：每一轮都记进 turnStarts，和真实会话一样。
    for (let i = 0; i < 24; i++) {
      const q: StreamMessage = { role: "user", content: `第 ${i} 轮的问题。`.repeat(60) };
      history.push(q);
      meta.turnStarts.push(q);
      history.push({ role: "assistant", content: `第 ${i} 轮的回答。`.repeat(60) });
    }

    const plan = planFold(history, meta, 2000);
    expect(plan).not.toBeNull();
    expect(plan!.dropSeed).toBe(true);

    const next = buildCompactedHistory(history, meta, plan!, "到目前为止的摘要。");

    // 绑定块和记忆块都还在，而且 meta 仍然指着历史里的同一个对象。
    // 「他答应了雪停一起去塔下」被折进摘要就等于失效——摘要会被再次摘要，三轮
    // 之后它就变成「他们聊了一些计划」。这条断言是那件事不会发生的唯一保证。
    expect(next).toContain(boundBlock!);
    expect(next).toContain(memoryBlock!);
    expect((meta as RoleplaySessionMeta).boundBlock).toBe(boundBlock);
    expect((meta as RoleplaySessionMeta).memoryBlock).toBe(memoryBlock);
    // seed 块正确地消失了——它是检索输出，可复现。
    expect(meta.seedContext).toBeNull();
    // 并且两块仍然在 prelude 里，不会在下一次折叠时被当成一轮对话。
    const prelude = segmentHistory(next, meta).prelude;
    expect(prelude).toContain(boundBlock!);
    expect(prelude).toContain(memoryBlock!);
  });
});

describe("buildBoundContent", () => {
  it("resolves an entity pin and a facet pin to their file bodies", async () => {
    const bound = await buildBoundContent(INDEX, [ELDEN.dirPath, `${ELDEN.dirPath}#speech.md`]);
    expect(bound.stalePaths).toEqual([]);
    expect(bound.text).toContain("index.md 的正文");
    expect(bound.text).toContain("speech.md 的正文");
    // 条目只记一次账，即使它被两个 pin 引用。
    expect(bound.entities).toEqual([ELDEN]);
  });

  it("reports a pin to a deleted entity as stale instead of skipping it silently", async () => {
    const bound = await buildBoundContent(INDEX, ["/p/.ai-writer/lore/characters/gone"]);
    expect(bound.stalePaths).toEqual(["/p/.ai-writer/lore/characters/gone"]);
    expect(bound.text).toBe("");
  });

  /**
   * 这条是安全性质的：一个指向已删特征的 pin **绝不能**退化成「整条都注入」。
   * 作者当初挑了一段特征，正意味着其余的他不想让这个角色知道；悄悄升级成整条
   * 会把他刻意排除的内容送进上下文，而界面上什么都不会显示。
   */
  it("never degrades a dead facet pin into a whole-entity injection", async () => {
    const bound = await buildBoundContent(INDEX, [`${ELDEN.dirPath}#deleted-facet.md`]);
    expect(bound.stalePaths).toEqual([`${ELDEN.dirPath}#deleted-facet.md`]);
    expect(bound.text).toBe("");
    expect(bound.entities).toEqual([]);
  });

  // 「设定已更新」靠对这段文字取哈希来判断，所以同样的输入必须给同样的输出。
  it("is deterministic for the same pins", async () => {
    const pins = [`${ELDEN.dirPath}#speech.md`, TOWER.dirPath];
    const a = await buildBoundContent(INDEX, pins);
    const b = await buildBoundContent(INDEX, pins);
    expect(a.text).toBe(b.text);
  });
});

/**
 * `session.json` 丢了之后的重建。
 *
 * 这一组存在的理由是一次真实的误判：设计文档写着「反序列化失败 = 从 transcript
 * 重建」，实现里 `seedRoleplayHistory` 却只接一个 `firstMessage`，从不回放过往
 * 轮次。症状极难自查——**稿面完好、模型失忆**：作者看着满屏的对话记录，角色说
 * 它不知道之前发生过什么。显示层派生自 transcript，所以看上去一切正常。
 */
describe("从 transcript 重建", () => {
  const PRIOR: SceneTurn[] = [
    turn(1, "author", "*我推开门。*"),
    turn(2, "agent", "「你来晚了。」"),
    turn(3, "author", "「塔那边怎么样？」"),
    turn(4, "agent", "*他没有回头。*「还在烧。」"),
  ];

  it("回放的作者轮进 user、角色轮进 assistant，且每个作者轮都是一个轮起点", async () => {
    const { messages, meta } = await seedRoleplayHistory({
      agent: AGENT,
      persona: { mode: "none", dirPath: null, prompt: "" },
      personaCard: "", primaryText: "", loreIndex: INDEX,
      firstMessage: "「那我们走。」", matchText: "「那我们走。」",
      loreBudgetChars: 4000, memory: [], priorTurns: PRIOR,
    });
    const texts = messages.map((m) => String(m.content));
    expect(texts).toContain("*我推开门。*");
    expect(texts).toContain("「你来晚了。」");
    expect(messages.find((m) => String(m.content) === "「你来晚了。」")?.role).toBe("assistant");
    // 两个回放的作者轮 + 这一问
    expect(meta.turnStarts).toHaveLength(3);
    expect(String(meta.turnStarts[0].content)).toBe("*我推开门。*");
    expect(meta.turnStarts[2].content).toBe("「那我们走。」");
  });

  it("回放之后绑定块仍在 prelude 里——压缩照样够不着它", async () => {
    const { messages, meta } = await seedRoleplayHistory({
      agent: AGENT,
      persona: { mode: "none", dirPath: null, prompt: "" },
      personaCard: "", primaryText: "", loreIndex: INDEX,
      firstMessage: "「那我们走。」", matchText: "「那我们走。」",
      loreBudgetChars: 4000, memory: [], priorTurns: PRIOR,
    });
    const { prelude } = segmentHistory(messages, meta);
    expect(prelude).toContain(meta.boundBlock as StreamMessage);
    // 回放的轮次落在 turns 一侧，不在 prelude 里——否则压缩永远折不掉它们。
    expect(prelude.map((m) => String(m.content))).not.toContain("*我推开门。*");
  });

  it("接回 summary.md，并把 summaryText 留给下一次压缩", async () => {
    const { meta } = await seedRoleplayHistory({
      agent: AGENT,
      persona: { mode: "none", dirPath: null, prompt: "" },
      personaCard: "", primaryText: "", loreIndex: INDEX,
      firstMessage: "「那我们走。」", matchText: "「那我们走。」",
      loreBudgetChars: 4000, memory: [], priorTurns: PRIOR,
      priorSummary: "他们在西厢见过一面。",
    });
    expect(meta.summaryText).toBe("他们在西厢见过一面。");
    expect(meta.summary).not.toBeNull();
  });

  it("没有过往轮次时形状与全新会话完全一致", async () => {
    const fresh = await seed("「你还在等？」");
    const restored = await seedRoleplayHistory({
      agent: AGENT,
      persona: { mode: "none", dirPath: null, prompt: "" },
      personaCard: "说话短，从不解释动机。", primaryText: "寒露之变的幸存者。",
      loreIndex: INDEX, firstMessage: "「你还在等？」", matchText: "「你还在等？」",
      loreBudgetChars: 4000, memory: [], priorTurns: [], priorSummary: "",
    });
    expect(restored.messages.map((m) => m.role)).toEqual(fresh.messages.map((m) => m.role));
  });
});

describe("selectReplayTurns", () => {
  it("绝不以角色轮打头——那条 assistant 会落进 prelude，压缩够不着", () => {
    const picked = selectReplayTurns([
      turn(1, "agent", "「你来晚了。」"),
      turn(2, "author", "「塔那边怎么样？」"),
      turn(3, "agent", "「还在烧。」"),
    ]);
    expect(picked[0].speaker).toBe("author");
    expect(picked).toHaveLength(2);
  });

  it("按字符封顶，留最近的", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      turn(i + 1, i % 2 === 0 ? "author" : "agent", "x".repeat(100)));
    const picked = selectReplayTurns(many, 250);
    expect(picked.length).toBeLessThan(10);
    expect(picked[picked.length - 1]).toBe(many[many.length - 1]);
  });

  it("一轮都超上限时仍然回放那一轮——空手重建等于没重建", () => {
    const picked = selectReplayTurns([turn(1, "author", "x".repeat(9999))], 100);
    expect(picked).toHaveLength(1);
  });

  it("没有作者轮就什么都不回放", () => {
    expect(selectReplayTurns([turn(1, "agent", "「你来晚了。」")])).toEqual([]);
  });
});
