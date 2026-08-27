/**
 * 取材事实的数据管道。
 *
 * 这组测试盯的是**报告有没有活着走出 lib**——那正是这套东西原先坏掉的方式：
 * 命中事实一直在被算出来，却在半路被丢掉（续跑分支的 `inj.loreReport` 记完账
 * 就没人再看它一眼），于是界面永远问不出「它到底读到没有」。这类故障不会报错、
 * 不会崩，只会让一个功能悄悄地什么都答不上来。
 *
 * mock 风格沿用 run.test：i18n `t: k=>k`、fileio 内存表，`selectLore` 用真的。
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
  appendFile: vi.fn(),
  fileExists: vi.fn(async (p: string) => files.has(p)),
  makeDir: vi.fn(),
  readDir: vi.fn(async () => []),
  renamePath: vi.fn(),
  removeFile: vi.fn(),
  writeBinaryFile: vi.fn(),
}));

vi.mock("../../lore/entity", () => ({
  scanEntityFolder: vi.fn(async () => []),
  readEntityFile: vi.fn(async (dir: string, file: string) => {
    const v = files.get(`${dir}/${file}`);
    if (v === undefined) throw new Error(`ENOENT ${dir}/${file}`);
    return v;
  }),
}));

import type { LoreEntity, LoreIndex } from "../../lore/model";
import { BOUND_BLOCK_CHAR_CAP, blockSizes, buildBoundContent } from "../context";
import { NO_PERSONA, type RoleplayAgent } from "../model";
import { inspectAgent } from "../run";
import {
  emptyTrace, namedRefs, primaryPiece, recalledNames, residentPieces,
} from "../trace";

function entity(name: string, dirPath: string, facets: string[] = []): LoreEntity {
  return {
    id: name, category: "characters", dirPath, name, aliases: [],
    summary: `${name}的一句话`, collections: [], avatarPath: null,
    mdFiles: ["index.md"], images: [],
    facets: facets.map((file) => ({
      file, title: file.replace(/\.md$/, ""), slot: null, keys: [], group: null,
      priority: 0, mode: "manual" as const, charCount: 100,
    })),
  };
}

const ELDEN = entity("沈砚", "/p/.ai-writer/lore/characters/elden", ["outfit.md"]);
const TOWER = entity("塔", "/p/.ai-writer/lore/world/tower");
const INDEX: LoreIndex = { characters: [ELDEN], world: [TOWER] };

const AGENT: RoleplayAgent = {
  id: "rp-abc-0001", kind: "character", name: "沈砚",
  primaryDirPath: ELDEN.dirPath, boundPaths: [],
  modelId: null, areaId: null, authorPersona: null,
  createdAt: 0, updatedAt: 0, turnCount: 0, contextHash: null,
};

function seedFiles() {
  files.clear();
  files.set(`${ELDEN.dirPath}/index.md`, "寒露之变的幸存者。");
  files.set(`${ELDEN.dirPath}/outfit.md`, "一件洗得发白的外套。");
  files.set(`${TOWER.dirPath}/index.md`, "塔在城北，三百年没点过灯。");
  files.set("/p/.ai-writer/roleplay/rp-abc-0001/agent.md", "---\nid: rp-abc-0001\n---\n\n说话短。\n");
}

describe("绑定块的显示清单（pieces）", () => {
  it("整条绑定和特征绑定各自带上自己的形状", async () => {
    seedFiles();
    const bound = await buildBoundContent(INDEX, [
      TOWER.dirPath, `${ELDEN.dirPath}#outfit.md`,
    ]);
    expect(bound.pieces.map((p) => [p.kind, p.name, p.facetTitle])).toEqual([
      ["bound-core", "塔", null],
      ["bound-facet", "沈砚", "outfit"],
    ]);
    expect(bound.pieces.every((p) => p.chars > 0 && !p.unexpanded)).toBe(true);
  });

  /**
   * 这一条是 `pieces` 和 `resident` 必须是两个字段的全部理由。
   *
   * 超预算而只写了一行标题的绑定项，正文**不在**上下文里，所以它不能进
   * `resident`（进了，注入账本就当它已经在，自动检索不会再去补它——那是
   * `BoundContent.resident` 注释里写死的一条）。可作者恰恰需要在清单里看见它，
   * 并且看见它是「没展开」的那一种。把两者合成一个字段，只能二选一：要么账本
   * 出错，要么界面漏报。
   */
  it("超预算只写了标题的那一项：进清单、标未展开、不进账本", async () => {
    seedFiles();
    files.set(`${TOWER.dirPath}/index.md`, "巨".repeat(BOUND_BLOCK_CHAR_CAP));
    const bound = await buildBoundContent(INDEX, [TOWER.dirPath, `${ELDEN.dirPath}#outfit.md`]);

    const squeezed = bound.pieces.find((p) => p.name === "沈砚");
    expect(squeezed?.unexpanded).toBe(true);
    // 账本只收真的装了正文的那些。
    expect(bound.resident.facets).toEqual([]);
    expect(bound.resident.coreDirs).toEqual([TOWER.dirPath]);
    // 清单两项都在——「它在但没进去」正是要说出来的那句话。
    expect(bound.pieces).toHaveLength(2);
  });

  it("失效的绑定不进清单，进 stalePaths", async () => {
    seedFiles();
    const bound = await buildBoundContent(INDEX, ["/p/.ai-writer/lore/characters/gone"]);
    expect(bound.pieces).toEqual([]);
    expect(bound.stalePaths).toEqual(["/p/.ai-writer/lore/characters/gone"]);
  });
});

describe("常驻层的装配", () => {
  it("主角那一份排在绑定块之前——顺序就是模型看到的顺序", async () => {
    seedFiles();
    const bound = await buildBoundContent(INDEX, [TOWER.dirPath]);
    const list = residentPieces(
      primaryPiece(INDEX, ELDEN.dirPath, "寒露之变的幸存者。"),
      bound.pieces,
    );
    expect(list.map((p) => p.kind)).toEqual(["primary", "bound-core"]);
  });

  /**
   * 条目读不出来时 system 层里根本没有它。报一个不存在的常驻项，等于把「这个
   * 角色没有人设」这件事藏起来——而那正是作者会来查的问题。
   */
  it("主角正文读不出来就没有这一项，不报一个空壳", () => {
    expect(primaryPiece(INDEX, ELDEN.dirPath, "")).toBeNull();
    expect(primaryPiece(INDEX, ELDEN.dirPath, "   ")).toBeNull();
    expect(primaryPiece(INDEX, null, "有正文也没用")).toBeNull();
    // 条目已经从知识库里删掉了。
    expect(primaryPiece(INDEX, "/p/.ai-writer/lore/characters/gone", "x")).toBeNull();
  });
});

describe("名字解析", () => {
  it("`@` 引用取条目名，索引里没有就退回目录名而不是吞掉这一项", () => {
    expect(namedRefs(INDEX, [TOWER.dirPath, "/p/lore/gone"])).toEqual([
      { name: "塔", dirPath: TOWER.dirPath },
      { name: "/p/lore/gone", dirPath: "/p/lore/gone" },
    ]);
    expect(namedRefs(INDEX, undefined)).toEqual([]);
  });

  it("没有记忆区报告时「想起了…」是空的，不是崩", () => {
    expect(recalledNames(null)).toEqual([]);
    expect(emptyTrace().area).toBeNull();
  });
});

describe("首轮预估", () => {
  /**
   * 预估和真实请求必须由同一段代码算出来。`blockSizes` 用的就是
   * `buildSystemPrompt` / `boundBlockContent` / `memoryBlockContent` 本身，所以
   * 这条守的是「有人在别处照着拼了一遍块的形状」——那种失准无法被任何测试发现，
   * 因为估值本来就不精确。
   */
  it("三块的字符数来自真正的构造函数，含块头", async () => {
    seedFiles();
    const bound = await buildBoundContent(INDEX, [TOWER.dirPath]);
    const sizes = blockSizes({
      system: {
        agent: AGENT, persona: NO_PERSONA, personaCard: "说话短。",
        primaryText: "寒露之变的幸存者。", loreIndex: INDEX,
      },
      boundText: bound.text,
      memory: [],
    });
    // 绑定块比它包着的正文长——块头那一行也要占位置。
    expect(sizes.boundChars).toBeGreaterThan(bound.text.length);
    expect(sizes.systemChars).toBeGreaterThan("寒露之变的幸存者。".length);
    // 一条记忆都没有时是占位行，不是 0：那一块无条件存在（第九轮 §9.1）。
    expect(sizes.memoryChars).toBeGreaterThan(0);
  });

  it("inspectAgent 一次读完，签名和预估同源", async () => {
    seedFiles();
    const out = await inspectAgent({
      projectPath: "/p",
      agent: { ...AGENT, boundPaths: [TOWER.dirPath] },
      persona: NO_PERSONA,
      loreIndex: INDEX,
    });
    expect(out.signature).toContain("塔在城北");
    expect(out.preflight.boundChars).toBeGreaterThan(0);
    expect(out.preflight.resident.map((p) => p.kind)).toEqual(["primary", "bound-core"]);
    expect(out.preflight.stalePaths).toEqual([]);
  });

  /**
   * 还没开过口的 agent（`contextHash === null`）**恰恰是最需要预估的那一个**：
   * 上下文构成条这时只画得出工具 schema。`inspectAgent` 因此不看基线——把跳过
   * 留给调用方，是这个函数签名的全部意思。
   */
  it("没有基线的 agent 照样拿得到预估", async () => {
    seedFiles();
    const out = await inspectAgent({
      projectPath: "/p", agent: AGENT, persona: NO_PERSONA, loreIndex: INDEX,
    });
    expect(AGENT.contextHash).toBeNull();
    expect(out.preflight.systemChars).toBeGreaterThan(0);
    expect(out.preflight.resident).toHaveLength(1);
  });
});
