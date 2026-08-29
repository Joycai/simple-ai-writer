/**
 * 重整知识库组织结构的三个工具（`lib/agent/organizeTools`）和它们背后的方案门。
 *
 * 这一组工具打破了 `writeTools` 顶上那条老规矩（没有任何工具能建/改名/删分类），
 * 所以它们的每一条**授权边界**都必须有测试钉着——放松的是「谁能提议」，绝不是
 * 「谁能落地」：落地的仍然只有作者在方案卡上逐行看过的那些。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPlanGate,
  stepTarget,
  type LorePlanStep,
  type PlanGate,
} from "../agent/plan";
import {
  createLoreCategoryTool,
  fileLoreEntriesTool,
  manageCollectionTool,
} from "../agent/organizeTools";
import type { LoreOrganizer, ToolContext } from "../agent/registry";
import type { LoreEntity, LoreIndex } from "../lore";

function entity(name: string, collections: string[] = []): LoreEntity {
  return {
    id: name.toLowerCase(),
    category: "characters",
    dirPath: `/p/.ai-writer/lore/characters/${name.toLowerCase()}`,
    name,
    aliases: [],
    summary: "",
    collections,
    avatarPath: null,
    mdFiles: ["index.md"],
    images: [],
    facets: [],
  };
}

const INDEX: LoreIndex = {
  characters: [entity("Aria", ["小说A"]), entity("Bran"), entity("Cass")],
};

interface Calls {
  created: string[];
  renamed: [string, string][];
  deleted: string[];
  filed: { dirs: string[]; add: string[]; remove: string[] }[];
  categories: string[];
}

let calls: Calls;
let declared: string[];

function organizer(): LoreOrganizer {
  return {
    // getter，和真实实现一样：同一次运行里刚建的集合必须立刻查得到
    get collections() {
      return declared;
    },
    createCollection: async (n) => { declared = [...declared, n]; calls.created.push(n); },
    renameCollection: async (a, b) => { calls.renamed.push([a, b]); },
    deleteCollection: async (n) => { calls.deleted.push(n); },
    file: async (dirs, add, remove) => { calls.filed.push({ dirs, add, remove }); },
    createCategory: async (label) => { calls.categories.push(label); return "contract"; },
  };
}

function ctxWith(steps: LorePlanStep[], opts?: { organize?: boolean }): ToolContext {
  const gate: PlanGate = createPlanGate();
  gate.steps = steps;
  gate.asked = steps.length > 0;
  return {
    projectPath: "/p",
    loreIndex: INDEX,
    multimodal: false,
    lorePlan: gate,
    organize: opts?.organize === false ? undefined : organizer(),
  };
}

const collectionStep = (p: Partial<LorePlanStep> & { action: LorePlanStep["action"]; entity: string }): LorePlanStep =>
  ({ target: "collection", detail: "—", ...p });

beforeEach(() => {
  calls = { created: [], renamed: [], deleted: [], filed: [], categories: [] };
  declared = ["小说A", "小说B"];
  vi.clearAllMocks();
});

describe("方案门 · 目标维度", () => {
  it("缺省的 target 就是条目——集合出现之前的每一份方案照常工作", () => {
    expect(stepTarget({ action: "update", entity: "Aria", detail: "" })).toBe("entity");
  });

  it("条目步骤授权不了同名的集合操作", async () => {
    // 「update Aria」是一条条目步骤；哪怕恰好有个集合也叫 Aria，也不该被它放行。
    const ctx = ctxWith([{ action: "update", entity: "小说A", detail: "改正文" }]);
    const r = await manageCollectionTool("c1", { op: "delete", collection: "小说A" }, ctx);
    expect(r.content).toContain("does not cover");
    expect(calls.deleted).toEqual([]);
  });

  it("集合步骤同样授权不了条目写入", () => {
    // 反向由 checkPlan 的 target 相等判断保证——这里直接断言步骤的目标本身。
    const step = collectionStep({ action: "update", entity: "小说A" });
    expect(stepTarget(step)).toBe("collection");
  });
});

describe("manage_collection", () => {
  it("批准了才建", async () => {
    const ok = ctxWith([collectionStep({ action: "create", entity: "《雪原书》" })]);
    const r = await manageCollectionTool("c1", { op: "create", collection: "《雪原书》" }, ok);
    expect(r.content).toContain("Created collection");
    expect(calls.created).toEqual(["《雪原书》"]);
  });

  it("没有方案就拒绝", async () => {
    const r = await manageCollectionTool("c1", { op: "create", collection: "《雪原书》" }, ctxWith([]));
    expect(r.content).toContain("need an approved plan");
    expect(calls.created).toEqual([]);
  });

  it("重复 create 不报错也不重建——报错只会让模型换个名字重试，而那是最坏的结果", async () => {
    const ctx = ctxWith([collectionStep({ action: "create", entity: "小说A" })]);
    const r = await manageCollectionTool("c1", { op: "create", collection: "小说A" }, ctx);
    expect(r.content).toContain("already exists");
    expect(calls.created).toEqual([]);
  });

  it("改不存在的集合时，把现有的都列出来", async () => {
    const ctx = ctxWith([collectionStep({ action: "move", entity: "《不存在》" })]);
    const r = await manageCollectionTool("c1", { op: "rename", collection: "《不存在》", new_name: "X" }, ctx);
    expect(r.content).toContain("no collection named");
    expect(r.content).toContain("小说A");
    expect(calls.renamed).toEqual([]);
  });

  it("删除的说明里写明「没有条目被删」", async () => {
    const ctx = ctxWith([collectionStep({ action: "delete", entity: "小说B" })]);
    const r = await manageCollectionTool("c1", { op: "delete", collection: "小说B" }, ctx);
    expect(calls.deleted).toEqual(["小说B"]);
    expect(r.content).toContain("No entry was deleted");
  });

  it("surface 没有整理能力时直接说明，而不是静默无操作", async () => {
    const ctx = ctxWith([collectionStep({ action: "create", entity: "X" })], { organize: false });
    const r = await manageCollectionTool("c1", { op: "create", collection: "X" }, ctx);
    expect(r.content).toContain("cannot reorganise");
  });
});

describe("file_lore_entries", () => {
  const step = collectionStep({ action: "update", entity: "小说B", members: ["Bran", "Cass"] });

  it("一次调用搬一批", async () => {
    const r = await fileLoreEntriesTool("c1", { entities: ["Bran", "Cass"], add: ["小说B"] }, ctxWith([step]));
    expect(calls.filed).toHaveLength(1);
    expect(calls.filed[0].add).toEqual(["小说B"]);
    expect(calls.filed[0].dirs).toHaveLength(2);
    expect(r.content).toContain("Filed 2 entries");
  });

  it("**方案没列到的条目一律拒绝**——批准「归入 2 条」不等于批准归入第 3 条", async () => {
    const r = await fileLoreEntriesTool("c1", { entities: ["Bran", "Aria"], add: ["小说B"] }, ctxWith([step]));
    expect(r.content).toContain("does not cover");
    expect(calls.filed).toEqual([]);
  });

  it("归入一个不存在的集合会被拒——否则会造出只活在 frontmatter 里的集合", async () => {
    const wild = collectionStep({ action: "update", entity: "《野生》", members: ["Bran"] });
    const r = await fileLoreEntriesTool("c1", { entities: ["Bran"], add: ["《野生》"] }, ctxWith([wild]));
    expect(r.content).toContain("no collection named");
    expect(calls.filed).toEqual([]);
  });

  it("认不出的条目名把整批挡下来，而不是搬一半", async () => {
    const r = await fileLoreEntriesTool("c1", { entities: ["Bran", "Nobody"], add: ["小说B"] }, ctxWith([step]));
    expect(r.content).toContain("no entity named");
    expect(calls.filed).toEqual([]);
  });

  it("add 和 remove 都空就拒绝", async () => {
    const r = await fileLoreEntriesTool("c1", { entities: ["Bran"] }, ctxWith([step]));
    expect(r.content).toContain("at least one collection");
  });

  it("步骤没列 members 时覆盖整个集合——「把这一摊都清空」是一个正当的方案", async () => {
    const open = collectionStep({ action: "update", entity: "小说A" });
    const r = await fileLoreEntriesTool("c1", { entities: ["Aria"], remove: ["小说A"] }, ctxWith([open]));
    expect(calls.filed).toHaveLength(1);
    expect(r.content).toContain("out of");
  });
});

describe("create_lore_category", () => {
  it("批准了才建，并说明为什么没有改名/删除的对应工具", async () => {
    const ctx = ctxWith([{ target: "category", action: "create", entity: "合同", detail: "—" }]);
    const r = await createLoreCategoryTool("c1", { label: "合同" }, ctx);
    expect(calls.categories).toEqual(["合同"]);
    expect(r.content).toContain("no tool to rename or delete a category");
  });

  it("集合步骤授权不了建分类", async () => {
    const ctx = ctxWith([collectionStep({ action: "create", entity: "合同" })]);
    const r = await createLoreCategoryTool("c1", { label: "合同" }, ctx);
    expect(r.content).toContain("does not cover");
    expect(calls.categories).toEqual([]);
  });

  /**
   * 查重。真实事故的另一半（docs/feature/agent/lore-category-visibility-plan.md）：
   * 模型拿作者的中文说法（「人物」）当新分类名，而那正是 `characters` 的标签。
   * 幂等成功而不是报错——报错只会让模型换个名字重试，《人物2》恰恰是最坏的结果。
   */
  it("label 撞上现有分类的标签时幂等返回、点名该用的 id，绝不新建", async () => {
    const ctx = ctxWith([{ target: "category", action: "create", entity: "人物", detail: "—" }]);
    const r = await createLoreCategoryTool("c1", { label: "人物" }, ctx);
    expect(r.content).toContain("already exists");
    expect(r.content).toContain('"characters"');
    expect(calls.categories).toEqual([]);
  });

  it("id 与英文标签同样命中查重，忽略大小写与首尾空白", async () => {
    for (const label of ["Characters", "  CHARACTERS  ", "characters"]) {
      const ctx = ctxWith([{ target: "category", action: "create", entity: label, detail: "—" }]);
      const r = await createLoreCategoryTool("c1", { label }, ctx);
      expect(r.content).toContain("already exists");
    }
    expect(calls.categories).toEqual([]);
  });

  it("查重先于方案门——「它已存在」是只读事实，不需要方案就能说", async () => {
    const r = await createLoreCategoryTool("c1", { label: "人物" }, ctxWith([]));
    expect(r.content).toContain("already exists");
    expect(r.content).not.toContain("approved plan");
    expect(calls.categories).toEqual([]);
  });
});

describe("agent 指令与工具的说法一致", () => {
  it("指令不再宣称「分类没有增删工具」，而是指向 create_lore_category 的复用优先流程", async () => {
    const zh = (await import("../../i18n/locales/zh-CN.json")).default as {
      ai: { instructions: { agent: string } };
    };
    const en = (await import("../../i18n/locales/en.json")).default as {
      ai: { instructions: { agent: string } };
    };
    expect(zh.ai.instructions.agent).not.toContain("分类本身没有增删工具");
    expect(zh.ai.instructions.agent).toContain("create_lore_category");
    expect(en.ai.instructions.agent).not.toContain("No tool creates or deletes categories");
    expect(en.ai.instructions.agent).toContain("create_lore_category");
  });
});
