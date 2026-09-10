/**
 * `lib/roleplay/run` —— runJob 抽出来的历史准备逻辑（LLD：09-runjob-refactor-lld.md）。
 *
 * 这组测试的意义在于**编排本身**从此可测：区检索插在哪、折叠语义怎么标、
 * 账本怎么防重发，这些排序原先只存在于 zustand 闭包里，第九轮的三个高严重度
 * bug 全部出在那里。mock 风格沿用 context.test：i18n `t: k=>k`、fileio 内存表、
 * loreSelect / compact 用真的。
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../../i18n", () => ({ default: { t: (k: string) => k, language: "zh-CN" } }));

const files = new Map<string, string>();

vi.mock("../../fs/fileio", () => ({
  readFile: vi.fn(async (p: string) => {
    const v = files.get(p);
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  }),
  writeFile: vi.fn(async (p: string, c: string) => { files.set(p, c); }),
  appendFile: vi.fn(async (p: string, c: string) => { files.set(p, (files.get(p) ?? "") + c); }),
  fileExists: vi.fn(async (p: string) => files.has(p)),
  makeDir: vi.fn(),
  readDir: vi.fn(async () => []),
  renamePath: vi.fn(),
  removeFile: vi.fn(),
}));

// 区索引不走真实目录扫描（那是 area.test 的领地）——这里给 scanEntityFolder
// 固定的条目列表，让真实的 selectLore 去命中它们。
const areaEntity = (id: string, name: string) => ({
  id, category: "history",
  dirPath: `/p/.ai-writer/roleplay/areas/rp-area-x/history/${id}`,
  name, aliases: [] as string[], summary: `${name}的一句话`,
  avatarPath: null, mdFiles: ["index.md"], images: [], facets: [],
});
let areaFixture: ReturnType<typeof areaEntity>[] = [];
let scanThrows = false;

vi.mock("../../lore/entity", () => ({
  scanEntityFolder: vi.fn(async () => {
    if (scanThrows) throw new Error("area unreadable");
    return areaFixture;
  }),
  readEntityFile: vi.fn(async (dir: string, file: string) => {
    const v = files.get(`${dir}/${file}`);
    if (v === undefined) throw new Error(`ENOENT ${dir}/${file}`);
    return v;
  }),
}));

import type { StreamMessage } from "../../ai/types";
import { createRoleplayMeta } from "../context";
import { conversationReader, injectAreaRecall, loadStaticContext, compactSceneNow } from "../run";
import { recalledNames } from "../trace";
import { renderTranscript } from "../transcript";
import type { SceneTurn } from "../model";

function withTower() {
  areaFixture = [areaEntity("e001", "塔")];
  files.set(
    `${areaFixture[0].dirPath}/index.md`,
    "---\nname: 塔\n---\n\n她说雪停了就去塔下，我没有答应。",
  );
}

function baseArgs(history: StreamMessage[], meta = createRoleplayMeta()) {
  return {
    projectPath: "/p",
    areaId: "rp-area-x",
    matchText: "「塔那边有消息了吗？」",
    history,
    meta: { ...meta, boundBlock: null, memoryBlock: null },
    insertIndex: history.length,
    budgetChars: 4000,
  };
}

describe("injectAreaRecall", () => {
  it("returns null and leaves history alone when the agent has no area", async () => {
    files.clear(); withTower();
    const history: StreamMessage[] = [{ role: "system", content: "s" }];
    const out = await injectAreaRecall({ ...baseArgs(history), areaId: null });
    expect(out).toBeNull();
    expect(history).toHaveLength(1);
  });

  it("splices the carrier at insertIndex and reports what was recalled", async () => {
    files.clear(); withTower();
    const system: StreamMessage = { role: "system", content: "s" };
    const question: StreamMessage = { role: "user", content: "「塔那边有消息了吗？」" };
    const history = [system, question];
    const args = { ...baseArgs(history), insertIndex: 1 };
    const out = await injectAreaRecall(args);

    expect(recalledNames(out)).toEqual([{ name: "塔", dirPath: areaFixture[0].dirPath }]);
    expect(history).toHaveLength(3);
    expect(history[0]).toBe(system);
    expect(history[2]).toBe(question);
    const carrier = String(history[1].content);
    expect(carrier).toContain("【roleplay.section.recall】");
    expect(carrier).toContain("雪停了就去塔下");
  });

  it("marks the carrier as its own turn start when it would land in the prelude", async () => {
    files.clear(); withTower();
    const question: StreamMessage = { role: "user", content: "q" };
    const history: StreamMessage[] = [{ role: "system", content: "s" }, question];
    const args = { ...baseArgs(history), insertIndex: 1 };
    // 播种且无回放：question 是唯一的轮起点，且在插入位之后。
    args.meta.turnStarts.push(question);
    await injectAreaRecall(args);
    expect(args.meta.turnStarts).toContain(history[1]);
  });

  it("does not steal a turn start when a prior turn exists (continue path)", async () => {
    files.clear(); withTower();
    const prior: StreamMessage = { role: "user", content: "上一轮" };
    const history: StreamMessage[] = [{ role: "system", content: "s" }, prior];
    const args = baseArgs(history);
    args.meta.turnStarts.push(prior);
    await injectAreaRecall(args);
    const carrier = history[history.length - 1];
    expect(String(carrier.content)).toContain("roleplay.section.recall");
    expect(args.meta.turnStarts).not.toContain(carrier);
  });

  it("does not re-send an entry the ledger already carries", async () => {
    files.clear(); withTower();
    const history: StreamMessage[] = [{ role: "system", content: "s" }];
    const args = baseArgs(history);
    const first = await injectAreaRecall(args);
    expect(recalledNames(first)).toHaveLength(1);
    const again = await injectAreaRecall({ ...args, insertIndex: history.length });
    expect(again).toBeNull();
    expect(history).toHaveLength(2);
  });

  it("swallows an unreadable area — a missed recall must not kill the turn", async () => {
    files.clear(); withTower();
    scanThrows = true;
    try {
      const history: StreamMessage[] = [{ role: "system", content: "s" }];
      const out = await injectAreaRecall(baseArgs(history));
      expect(out).toBeNull();
      expect(history).toHaveLength(1);
    } finally {
      scanThrows = false;
    }
  });
});

describe("conversationReader", () => {
  const turn = (index: number, speaker: "author" | "agent", text: string): SceneTurn =>
    ({ index, speaker, speakerName: speaker === "agent" ? "沈砚" : "", at: 0, text });

  it("reads from disk on every call — a turn appended mid-run is visible", async () => {
    files.clear();
    const path = "/p/.ai-writer/roleplay/rp-abc-0001/transcript.md";
    files.set(path, renderTranscript("rp-abc-0001", [turn(1, "author", "「你还在等？」")]));
    const reader = conversationReader("/p", "rp-abc-0001");

    const { current } = await reader.scenes();
    const first = await reader.read(current);
    expect(first.turns).toHaveLength(1);

    files.set(path, renderTranscript("rp-abc-0001", [
      turn(1, "author", "「你还在等？」"), turn(2, "agent", "「等谁不重要。」"),
    ]));
    const second = await reader.read(current);
    expect(second.turns).toHaveLength(2);
    expect(second.turns[1].speaker).toBe("agent");
  });
});

describe("loadStaticContext", () => {
  it("reads the primary entry and the persona card", async () => {
    files.clear();
    files.set("/lore/characters/elden/index.md", "寒露之变的幸存者。");
    files.set("/p/.ai-writer/roleplay/rp-abc-0001/agent.md", "---\nid: rp-abc-0001\n---\n\n说话短。\n");
    const out = await loadStaticContext("/p", {
      id: "rp-abc-0001", kind: "character", name: "沈砚",
      primaryDirPath: "/lore/characters/elden", boundPaths: [], modelId: null,
      areaId: null, authorPersona: null, createdAt: 0, updatedAt: 0, turnCount: 0,
      contextHash: null,
    });
    expect(out.primaryText).toBe("寒露之变的幸存者。");
    expect(out.personaCard).toBe("说话短。");
  });

  it("a deleted primary entry reads as empty, not as an error", async () => {
    files.clear();
    files.set("/p/.ai-writer/roleplay/rp-abc-0001/agent.md", "---\nid: x\n---\n");
    const out = await loadStaticContext("/p", {
      id: "rp-abc-0001", kind: "character", name: "沈砚",
      primaryDirPath: "/lore/characters/gone", boundPaths: [], modelId: null,
      areaId: null, authorPersona: null, createdAt: 0, updatedAt: 0, turnCount: 0,
      contextHash: null,
    });
    expect(out.primaryText).toBe("");
  });
});

// ─── prepareSeededHistory ────────────────────────────────────────────────────

import { hashText } from "../../context/memory";
import { contextSignature } from "../context";
import { prepareSeededHistory, selectPriorTurns } from "../run";
import { NO_PERSONA, type RoleplayAgent } from "../model";

const SEED_AGENT: RoleplayAgent = {
  id: "rp-abc-0001", kind: "character", name: "沈砚",
  primaryDirPath: "/lore/characters/elden", boundPaths: [],
  modelId: null, areaId: "rp-area-x", authorPersona: null,
  createdAt: 0, updatedAt: 0, turnCount: 0, contextHash: null,
};

function seedFixture() {
  files.clear();
  withTower();
  files.set("/lore/characters/elden/index.md", "寒露之变的幸存者。");
  files.set("/p/.ai-writer/roleplay/rp-abc-0001/agent.md", "---\nid: rp-abc-0001\n---\n\n说话短。\n");
}

const seedOpts = (over: Partial<Parameters<typeof prepareSeededHistory>[0]> = {}) => ({
  projectPath: "/p",
  agent: SEED_AGENT,
  persona: NO_PERSONA,
  loreIndex: {},
  wire: "「塔那边有消息了吗？」",
  matchText: "「塔那边有消息了吗？」",
  loreBudgetChars: 4000,
  areaBudgetChars: 4000,
  currentTurns: [] as SceneTurn[],
  ...over,
});

describe("selectPriorTurns", () => {
  const t = (i: number, speaker: "author" | "agent"): SceneTurn =>
    ({ index: i, speaker, speakerName: "", at: 0, text: `t${i}` });

  it("drops the trailing author turn — it rides as firstMessage", () => {
    expect(selectPriorTurns([t(1, "author"), t(2, "agent"), t(3, "author")]))
      .toHaveLength(2);
  });

  it("keeps everything when the last turn is a reply", () => {
    expect(selectPriorTurns([t(1, "author"), t(2, "agent")])).toHaveLength(2);
  });

  it("empty stays empty", () => {
    expect(selectPriorTurns([])).toEqual([]);
  });
});

describe("prepareSeededHistory", () => {
  it("ends on the question, with the area carrier right before it", async () => {
    seedFixture();
    const out = await prepareSeededHistory(seedOpts());
    const last = out.history[out.history.length - 1];
    expect(last.content).toBe("「塔那边有消息了吗？」");
    expect(out.meta.turnStarts).toContain(last);
    const carrier = out.history[out.history.length - 2];
    expect(String(carrier.content)).toContain("roleplay.section.recall");
    expect(recalledNames(out.recall)).toEqual([{ name: "塔", dirPath: areaFixture[0].dirPath }]);
    // 两个块无条件存在（第九轮 §9.1），在 system 之后。
    expect(out.meta.boundBlock).toBe(out.history[1]);
    expect(out.meta.memoryBlock).toBe(out.history[2]);
  });

  it("computes the baseline with contextSignature over the same inputs checkBindings reads", async () => {
    seedFixture();
    const out = await prepareSeededHistory(seedOpts());
    const expected = hashText(contextSignature({
      agent: SEED_AGENT,
      persona: NO_PERSONA,
      personaCard: "说话短。",
      primaryText: "寒露之变的幸存者。",
      loreIndex: {},
      boundText: out.bound.text,
    }));
    expect(out.contextHash).toBe(expected);
  });

  it("reads summary.md only when there are turns to replay", async () => {
    seedFixture();
    files.set("/p/.ai-writer/roleplay/rp-abc-0001/summary.md", "他们在西厢见过一面。\n");

    // 只有刚落盘的这一问：没有可回放的过往，摘要不该被接上。
    const fresh = await prepareSeededHistory(seedOpts({
      currentTurns: [{ index: 1, speaker: "author", speakerName: "", at: 0, text: "「塔那边有消息了吗？」" }],
    }));
    expect(fresh.meta.summaryText).toBeNull();

    // 有过往轮：摘要接回来，回放的角色轮进 assistant。
    const restored = await prepareSeededHistory(seedOpts({
      currentTurns: [
        { index: 1, speaker: "author", speakerName: "", at: 0, text: "「你还在等？」" },
        { index: 2, speaker: "agent", speakerName: "沈砚", at: 0, text: "「等谁不重要。」" },
        { index: 3, speaker: "author", speakerName: "", at: 0, text: "「塔那边有消息了吗？」" },
      ],
    }));
    expect(restored.meta.summaryText).toBe("他们在西厢见过一面。");
    expect(restored.history.find((m) => m.content === "「等谁不重要。」")?.role).toBe("assistant");
  });
});

// ─── prepareContinuedHistory ─────────────────────────────────────────────────

import { prepareContinuedHistory } from "../run";

const NO_AREA_AGENT: RoleplayAgent = { ...SEED_AGENT, areaId: null };

/** 一段活的短历史：播种 + 一轮已答完的对话。 */
async function liveHistory(agent: RoleplayAgent = SEED_AGENT) {
  const seeded = await prepareSeededHistory(seedOpts({ agent }));
  return { history: seeded.history, meta: seeded.meta };
}

const contOpts = (
  history: StreamMessage[], meta: Parameters<typeof prepareContinuedHistory>[0]["meta"],
  over: Partial<Parameters<typeof prepareContinuedHistory>[0]> = {},
) => ({
  projectPath: "/p",
  agent: SEED_AGENT,
  loreIndex: {},
  history, meta,
  wire: "「塔那边现在怎么样了？」",
  matchText: "「塔那边现在怎么样了？」",
  loreBudgetChars: 4000,
  areaBudgetChars: 4000,
  ceilingTokens: 1_000_000,
  summarize: async () => "到目前为止的摘要。",
  ...over,
});

/** 项目知识库里的一个条目（区条目走 areaEntity，那是另一套 mock）。 */
function loreEntity(name: string, dirPath: string) {
  return {
    id: name, category: "world", dirPath, name, aliases: [], summary: `${name}的一句话`,
    collections: [], avatarPath: null, mdFiles: ["index.md"], images: [], facets: [],
  };
}

/**
 * 检索报告要活着走出这个函数。
 *
 * 在 `ContinueOutcome.loreReport` 存在之前，`assembleTurnInjection` 的报告**在
 * 函数内部就被丢掉了**——记完账就没人再看它一眼。播种轮好歹还有
 * `SeedOutcome.report`，续跑轮什么都没有，于是第 2 轮往后的取材事实永远算不
 * 回来。这类故障不报错、不崩，只是让界面什么都答不上来。
 */
describe("prepareContinuedHistory 的报告出口", () => {
  it("命中了什么，报告里就有什么", async () => {
    seedFixture();
    const tower = loreEntity("石塔", "/p/.ai-writer/lore/world/stone-tower");
    files.set(`${tower.dirPath}/index.md`, "---\nname: 石塔\n---\n\n石塔在城北。");
    const { history, meta } = await liveHistory(NO_AREA_AGENT);
    history.push({ role: "assistant", content: "「还没有。」" });

    const out = await prepareContinuedHistory(contOpts(history, meta, {
      agent: NO_AREA_AGENT,
      loreIndex: { world: [tower] },
      wire: "「石塔那边现在怎么样了？」",
      matchText: "「石塔那边现在怎么样了？」",
    }));
    expect(out.loreReport?.entities.map((e) => e.name)).toContain("石塔");
  });

  /**
   * 「跑了检索但一条都没命中」和「这一轮根本没跑过检索」在界面上是两句话，
   * 而只有 `null` 与非 `null` 分得清。所以报告**无条件**带出去，`inj.text`
   * 为空时也带。
   */
  it("一条都没命中时报告仍然非空——那和「没跑过」是两回事", async () => {
    seedFixture();
    const { history, meta } = await liveHistory(NO_AREA_AGENT);
    history.push({ role: "assistant", content: "「还没有。」" });

    const out = await prepareContinuedHistory(contOpts(history, meta, { agent: NO_AREA_AGENT }));
    expect(out.loreReport).not.toBeNull();
    expect(out.loreReport?.entities).toEqual([]);
  });
});

describe("prepareContinuedHistory", () => {
  it("short history: no compaction, question lands last as a turn start", async () => {
    seedFixture();
    const { history, meta } = await liveHistory(NO_AREA_AGENT);
    history.push({ role: "assistant", content: "「还没有。」" });

    const out = await prepareContinuedHistory(
      contOpts(history, meta, { agent: NO_AREA_AGENT }),
    );
    expect(out.history).toBe(history);           // 没压缩：同一个数组
    expect(out.compactedEvent).toBeNull();
    expect(out.summaryToSave).toBeNull();
    expect(out.memoryRecords).toBeNull();
    const last = out.history[out.history.length - 1];
    expect(last.content).toBe("「塔那边现在怎么样了？」");
    expect(meta.turnStarts).toContain(last);
  });

  it("area recall rides right before the question on the continue path too", async () => {
    seedFixture();
    // 播种那次已经想起过「塔」——换一个新条目，让续跑这轮有新东西可想。
    areaFixture = [areaEntity("e001", "塔"), areaEntity("e002", "阿箬")];
    files.set(
      `${areaFixture[1].dirPath}/index.md`,
      "---\nname: 阿箬\n---\n\n阿箬说过塔下的灯是她点的。",
    );
    const { history, meta } = await liveHistory();
    history.push({ role: "assistant", content: "「还没有。」" });

    const out = await prepareContinuedHistory(contOpts(history, meta, {
      matchText: "「阿箬呢？」", wire: "「阿箬呢？」",
    }));
    expect(recalledNames(out.recall)).toEqual([{ name: "阿箬", dirPath: areaFixture[1].dirPath }]);
    const carrier = out.history[out.history.length - 2];
    expect(String(carrier.content)).toContain("阿箬说过塔下的灯");
    // 载体挂在上一轮的尾部，不偷走轮起点。
    expect(meta.turnStarts).not.toContain(carrier);
  });

  it("compaction refreshes the memory block from disk and hands back the summary", async () => {
    seedFixture();
    files.set(
      "/p/.ai-writer/roleplay/rp-abc-0001/memory.md",
      [
        "<!-- roleplay-memory v1 agent=rp-abc-0001 next=2 -->",
        "",
        "## 约定 <!-- pact -->",
        "",
        "### [m1] 雪停了一起去塔下 · open · turn 3",
        "他答应了。",
        "",
      ].join("\n"),
    );
    const { history, meta } = await liveHistory(NO_AREA_AGENT);
    const boundBlock = meta.boundBlock;
    const memoryBlock = meta.memoryBlock;
    for (let i = 0; i < 24; i++) {
      const q: StreamMessage = { role: "user", content: `第 ${i} 轮的问题。`.repeat(60) };
      history.push(q);
      meta.turnStarts.push(q);
      history.push({ role: "assistant", content: `第 ${i} 轮的回答。`.repeat(60) });
    }

    const out = await prepareContinuedHistory(contOpts(history, meta, {
      agent: NO_AREA_AGENT, ceilingTokens: 2000,
    }));
    expect(out.compactedEvent).not.toBeNull();
    expect(out.history).not.toBe(history);       // 压缩重建了数组
    expect(out.summaryToSave).toBe("到目前为止的摘要。");
    // 「压缩之后刷新记忆块」——第九轮 §9.1 的正确性边界，第一次有编排级测试。
    expect(out.memoryRecords?.map((r) => r.id)).toEqual(["m1"]);
    expect(String(memoryBlock?.content)).toContain("雪停了一起去塔下");
    // 两个块的对象身份跨压缩存活，且都还在新历史里。
    expect(meta.boundBlock).toBe(boundBlock);
    expect(meta.memoryBlock).toBe(memoryBlock);
    expect(out.history).toContain(boundBlock!);
    expect(out.history).toContain(memoryBlock!);
    // 提问仍然是最后一条。
    expect(out.history[out.history.length - 1].content).toBe("「塔那边现在怎么样了？」");
  });

  it("a summarize failure skips compaction instead of killing the turn; abort propagates", async () => {
    seedFixture();
    const { history, meta } = await liveHistory(NO_AREA_AGENT);
    for (let i = 0; i < 24; i++) {
      const q: StreamMessage = { role: "user", content: `第 ${i} 轮的问题。`.repeat(60) };
      history.push(q);
      meta.turnStarts.push(q);
      history.push({ role: "assistant", content: `第 ${i} 轮的回答。`.repeat(60) });
    }

    // 普通失败：compactChatHistory 自己吞掉（返回 null），这一问照常接上。
    const out = await prepareContinuedHistory(contOpts(history, meta, {
      agent: NO_AREA_AGENT, ceilingTokens: 2000,
      summarize: async () => { throw new Error("model down"); },
    }));
    expect(out.compactedEvent).toBeNull();
    expect(out.history[out.history.length - 1].content).toBe("「塔那边现在怎么样了？」");

    // 中止必须穿透——作者按了停止，接着组装就是违抗。
    const abort = new Error("aborted");
    abort.name = "AbortError";
    await expect(prepareContinuedHistory(contOpts(out.history, meta, {
      agent: NO_AREA_AGENT, ceilingTokens: 2000,
      summarize: async () => { throw abort; },
    }))).rejects.toThrow("aborted");
  });
});

/**
 * 绑定粒度在**续跑**这条路上（PR-3）。播种那条路由 context.test 守着；这里守的是
 * 「第一句能想起特征、之后就不行」那种只在续跑分支漏掉一个入参的坏法。
 */
describe("prepareContinuedHistory — 绑定粒度", () => {
  const ELDEN_DIR = "/lore/characters/elden";
  const TOWER_DIR = "/lore/world/tower";

  const HERO_IDX = {
    characters: [{
      id: "elden", category: "characters", dirPath: ELDEN_DIR, name: "沈砚",
      aliases: [], summary: "沈砚的一句话", collections: [],
      avatarPath: null, mdFiles: ["index.md"], images: [],
      facets: [{
        file: "scar.md", title: "伤疤", slot: null, keys: ["伤疤"],
        group: null, priority: 0, mode: "auto", charCount: 100,
      }],
    }],
    world: [{
      id: "tower", category: "world", dirPath: TOWER_DIR, name: "塔",
      aliases: [], summary: "塔的一句话", collections: [],
      avatarPath: null, mdFiles: ["index.md"], images: [], facets: [],
    }],
  } as unknown as Parameters<typeof prepareContinuedHistory>[0]["loreIndex"];

  async function live() {
    seedFixture();
    files.set(`${ELDEN_DIR}/scar.md`, "那道疤是寒露之变留下的。");
    files.set(`${TOWER_DIR}/index.md`, "塔在城北，夜里亮着一盏灯。");
    const seeded = await prepareSeededHistory(seedOpts({
      agent: NO_AREA_AGENT, loreIndex: HERO_IDX,
      wire: "「你还在等？」", matchText: "「你还在等？」",
    }));
    seeded.history.push({ role: "assistant", content: "「还在。」" });
    return { history: seeded.history, meta: seeded.meta };
  }

  it("主角恒参与匹配：不写名字也能补进特征，正文不重发", async () => {
    const { history, meta } = await live();
    const out = await prepareContinuedHistory(contOpts(history, meta, {
      agent: NO_AREA_AGENT, loreIndex: HERO_IDX,
      wire: "「你那道伤疤呢？」", matchText: "「你那道伤疤呢？」",
    }));
    const injected = String(out.history[out.history.length - 2].content);
    expect(injected).toContain("那道疤是寒露之变留下的。"); // pin 进候选 → keys 激活
    expect(injected).not.toContain("寒露之变的幸存者。");    // 正文在 system 层
  });

  it("`@` 引用过的条目，这一轮不再被检索送第二份", async () => {
    // A/B：同样一句话，只差 refDirs。
    const a = await live();
    const withoutRefs = await prepareContinuedHistory(contOpts(a.history, a.meta, {
      agent: NO_AREA_AGENT, loreIndex: HERO_IDX,
      wire: "「塔那边呢？」", matchText: "「塔那边呢？」",
    }));
    expect(String(withoutRefs.history[withoutRefs.history.length - 2].content))
      .toContain("塔在城北");

    const b = await live();
    const withRefs = await prepareContinuedHistory(contOpts(b.history, b.meta, {
      agent: NO_AREA_AGENT, loreIndex: HERO_IDX,
      wire: "「塔那边呢？」", matchText: "「塔那边呢？」",
      refDirs: [TOWER_DIR],
    }));
    const last = withRefs.history[withRefs.history.length - 1];
    expect(last.content).toBe("「塔那边呢？」");
    expect(String(withRefs.history[withRefs.history.length - 2].content))
      .not.toContain("塔在城北");
    // 记在问句上：那一轮折叠掉，它才会重新注入。
    expect(b.meta.injected.get(TOWER_DIR)?.coreCarrier).toBe(last);
  });
});

describe("compactSceneNow（作者的「立即归纳」）", () => {
  const MEMORY_MD = [
    "<!-- roleplay-memory v1 agent=rp-abc-0001 next=2 -->",
    "",
    "## 约定 <!-- pact -->",
    "",
    "### [m1] 雪停了一起去塔下 · open · turn 3",
    "他答应了。",
    "",
  ].join(String.fromCharCode(10));

  async function longLive() {
    seedFixture();
    files.set("/p/.ai-writer/roleplay/rp-abc-0001/memory.md", MEMORY_MD);
    const { history, meta } = await liveHistory(NO_AREA_AGENT);
    for (let i = 0; i < 24; i++) {
      const q: StreamMessage = { role: "user", content: `第 ${i} 轮的问题。`.repeat(60) };
      history.push(q);
      meta.turnStarts.push(q);
      history.push({ role: "assistant", content: `第 ${i} 轮的回答。`.repeat(60) });
    }
    return { history, meta };
  }

  it("folds regardless of the trigger and runs the same after-step as the automatic path", async () => {
    const { history, meta } = await longLive();
    const memoryBlock = meta.memoryBlock;
    const out = await compactSceneNow({
      projectPath: "/p", agent: NO_AREA_AGENT, history, meta,
      // A ceiling the automatic trigger would never reach — force ignores it.
      ceilingTokens: 1_000_000,
      summarize: async () => "到目前为止的摘要。",
    });
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.history).not.toBe(history);
    expect(out.summaryToSave).toBe("到目前为止的摘要。");
    // 「压缩之后刷新记忆块」——手动路径不许漏掉这一步（漏掉的症状是沉默的）。
    expect(out.memoryRecords.map((r) => r.id)).toEqual(["m1"]);
    expect(String(memoryBlock?.content)).toContain("雪停了一起去塔下");
    expect(out.history).toContain(memoryBlock!);
  });

  it("reports nothing to fold on a short history, and a failed summary as failed", async () => {
    seedFixture();
    const short = await liveHistory(NO_AREA_AGENT);
    const nothing = await compactSceneNow({
      projectPath: "/p", agent: NO_AREA_AGENT, history: short.history, meta: short.meta,
      ceilingTokens: 1_000_000, summarize: async () => "x",
    });
    expect(nothing.status).toBe("nothing");

    const { history, meta } = await longLive();
    const before = history.length;
    const failed = await compactSceneNow({
      projectPath: "/p", agent: NO_AREA_AGENT, history, meta,
      ceilingTokens: 1_000_000, summarize: async () => { throw new Error("model down"); },
    });
    expect(failed.status).toBe("failed");
    expect(history.length).toBe(before); // 历史原样
  });

  it("autoCompact off skips the automatic fold on the continue path", async () => {
    const { history, meta } = await longLive();
    const out = await prepareContinuedHistory(contOpts(history, meta, {
      agent: NO_AREA_AGENT, ceilingTokens: 2000, autoCompact: false,
    }));
    expect(out.compactedEvent).toBeNull();
    expect(out.summaryToSave).toBeNull();
  });
});
