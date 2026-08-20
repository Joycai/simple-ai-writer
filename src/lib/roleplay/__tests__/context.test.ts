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
import { seedRoleplayHistory, type RoleplaySessionMeta } from "../context";
import type { RoleplayAgent } from "../model";

function entity(name: string, dirPath: string): LoreEntity {
  return {
    id: name, category: "characters", dirPath, name, aliases: [], summary: `${name}的一句话`,
    avatarPath: null, mdFiles: ["index.md"], images: [], facets: [],
  };
}

const ELDEN = entity("沈砚", "/p/.ai-writer/lore/characters/elden");
const TOWER = entity("塔", "/p/.ai-writer/lore/world/tower");
const INDEX: LoreIndex = { characters: [ELDEN], world: [TOWER] };

const AGENT: RoleplayAgent = {
  id: "rp-a-0001", kind: "character", name: "沈砚",
  primaryDirPath: ELDEN.dirPath,
  boundPaths: [ELDEN.dirPath],
  modelId: null, authorPersona: null, taskId: null,
  createdAt: 0, updatedAt: 0, turnCount: 0,
};

async function seed(firstMessage = "「你还在等？」") {
  return seedRoleplayHistory({
    agent: AGENT,
    persona: { mode: "none", dirPath: null, prompt: "" },
    personaCard: "说话短，从不解释动机。",
    primaryText: "寒露之变的幸存者。",
    loreIndex: INDEX,
    firstMessage,
    matchText: firstMessage,
    loreBudgetChars: 4000,
  });
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

describe("不变量二 · 压缩之后", () => {
  it("keeps the bound block and drops the seed block", async () => {
    // 首句提到「塔」，好让自动命中真的产出一个 seed 块可供丢弃。
    const { messages, meta } = await seed("「塔那边有消息了？」");
    const history: StreamMessage[] = [...messages];
    const boundBlock = meta.boundBlock;
    expect(boundBlock).not.toBeNull();

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

    // 绑定块还在，而且 meta 仍然指着历史里的同一个对象。
    expect(next).toContain(boundBlock!);
    expect((meta as RoleplaySessionMeta).boundBlock).toBe(boundBlock);
    // seed 块正确地消失了——它是检索输出，可复现。
    expect(meta.seedContext).toBeNull();
    // 并且绑定块仍然在 prelude 里，不会在下一次折叠时被当成一轮对话。
    expect(segmentHistory(next, meta).prelude).toContain(boundBlock!);
  });
});
