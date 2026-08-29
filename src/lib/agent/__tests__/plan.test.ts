import { describe, expect, it } from "vitest";
import {
  checkPlan,
  createPlanGate,
  planLoadsEntityWrites,
  planLoadsOrganize,
  type LorePlanStep,
} from "../plan";
import type { LoreIndex } from "../../lore";

const emptyIndex: LoreIndex = {};

function gateWith(steps: LorePlanStep[]) {
  const gate = createPlanGate();
  gate.steps.push(...steps);
  return gate;
}

describe("checkPlan", () => {
  it("passes an update call against a matching update step", () => {
    const gate = gateWith([{ action: "update", entity: "Ava", file: "index.md", detail: "d" }]);
    const check = checkPlan(gate, emptyIndex, "update", "Ava", "index.md");
    expect(check.ok).toBe(true);
  });

  // update_lore_file is the only tool that lands a file, including a brand-new
  // facet on an entity that already exists — create_lore_entity refuses that
  // (it only makes whole new entities), so the tool always gates itself as
  // "update". A plan author has no way to spell "new facet" except "create",
  // so a file-scoped update call must also accept a "create" step for the same
  // file — otherwise a perfectly sensible plan can never be fulfilled by any
  // tool call at all.
  it("lets an update_lore_file call for a new facet satisfy a 'create' plan step", () => {
    const gate = gateWith([
      { action: "create", entity: "早乙女文香", file: "outfit_battle.md", detail: "new facet" },
    ]);
    const check = checkPlan(gate, emptyIndex, "update", "早乙女文香", "outfit_battle.md");
    expect(check.ok).toBe(true);
  });

  it("does not let a 'create' step satisfy an update call for a different file", () => {
    const gate = gateWith([
      { action: "create", entity: "早乙女文香", file: "outfit_battle.md", detail: "new facet" },
    ]);
    const check = checkPlan(gate, emptyIndex, "update", "早乙女文香", "outfit_casual.md");
    expect(check.ok).toBe(false);
  });

  // The fallback is deliberately one-directional and file-scoped only: a
  // create_lore_entity call (no file — it only ever creates a whole entity)
  // must still require an exact "create" step, not accept "update".
  it("does not let an entity-level create call satisfy an 'update' step", () => {
    const gate = gateWith([{ action: "update", entity: "Ava", detail: "d" }]);
    const check = checkPlan(gate, emptyIndex, "create", "Ava");
    expect(check.ok).toBe(false);
  });

  it("does not let an entity-level create call satisfy an 'update' step even without a gate file", () => {
    const gate = gateWith([{ action: "update", entity: "Ava", detail: "d" }]);
    const check = checkPlan(gate, emptyIndex, "create", "Ava", undefined);
    expect(check.ok).toBe(false);
  });

  it("still refuses an update call with no covering step at all", () => {
    const gate = gateWith([{ action: "move", entity: "Ava", detail: "d" }]);
    const check = checkPlan(gate, emptyIndex, "update", "Ava", "index.md");
    expect(check.ok).toBe(false);
  });
});

// update_facet_meta and delete_lore_file are the other two facet-level write
// tools (writeTools.ts) — both gate through this same checkPlan, with the same
// (entity.name, file) shape update_lore_file uses. These pin down that each
// gets the outcome its own gate() call actually needs, not just that the
// fallback exists in the abstract.
describe("checkPlan — update_facet_meta and delete_lore_file's own gate() calls", () => {
  // update_facet_meta gates as "update" (writeTools.ts) exactly like
  // update_lore_file, so a plan step for a facet the author approved as
  // "create" must also let the model set that facet's slot/keys/etc.
  // afterwards — without this it could write the facet's body but never
  // classify it.
  it("lets update_facet_meta's gate() call satisfy a 'create' plan step", () => {
    const gate = gateWith([
      { action: "create", entity: "早乙女文香", file: "outfit_battle.md", detail: "new facet" },
    ]);
    const check = checkPlan(gate, emptyIndex, "update", "早乙女文香", "outfit_battle.md");
    expect(check.ok).toBe(true);
  });

  // delete_lore_file gates as "delete" — there is no create/update naming
  // ambiguity to paper over here (a plan author has no reason to call removing
  // a facet "create"), so it must NOT pick up the fallback: a plan that only
  // approved creating/updating this file still must not authorise deleting it.
  it("does NOT let delete_lore_file's gate() call ride the create/update fallback", () => {
    const gate = gateWith([
      { action: "create", entity: "早乙女文香", file: "outfit_battle.md", detail: "new facet" },
      { action: "update", entity: "早乙女文香", file: "outfit_battle.md", detail: "later edit" },
    ]);
    const check = checkPlan(gate, emptyIndex, "delete", "早乙女文香", "outfit_battle.md");
    expect(check.ok).toBe(false);
  });

  it("still passes delete_lore_file's gate() call against a matching 'delete' step", () => {
    const gate = gateWith([
      { action: "delete", entity: "早乙女文香", file: "outfit_old.md", detail: "superseded" },
    ]);
    const check = checkPlan(gate, emptyIndex, "delete", "早乙女文香", "outfit_old.md");
    expect(check.ok).toBe(true);
  });
});

/**
 * 分类步骤：一张「把这 12 条归到势力」的卡，替掉十二行「move Ava」。
 *
 * 这一组守的是两件在真机上**不报错**的事：卡上写的是作者读得懂的分类名（「势力」），
 * 工具收的是文件夹 id（`factions`），两边对不上就是「刚批准完就被拒绝」；以及
 * `members` 的授权边界——批准 12 条不是批准第 13 条。
 */
describe("checkPlan — category steps", () => {
  const categoryStep = (members: string[]): LorePlanStep => ({
    action: "move",
    target: "category",
    entity: "势力",
    members,
    detail: "把这几条归到势力",
  });

  it("认得同一个分类的标签与文件夹 id", () => {
    const gate = gateWith([categoryStep(["Ava", "Kael"])]);
    // 卡上是「势力」，move_lore_entity 传的是它的 enum 值 factions。
    const byId = checkPlan(gate, emptyIndex, "move", "factions", undefined, {
      target: "category", member: "Ava",
    });
    expect(byId.ok).toBe(true);
    // 英文界面写下的 "Factions" 同样是它。
    const byEnLabel = checkPlan(gate, emptyIndex, "move", "Factions", undefined, {
      target: "category", member: "Kael",
    });
    expect(byEnLabel.ok).toBe(true);
  });

  it("只放行 members 列出的条目", () => {
    const gate = gateWith([categoryStep(["Ava", "Kael"])]);
    const listed = checkPlan(gate, emptyIndex, "move", "factions", undefined, {
      target: "category", member: "Ava",
    });
    expect(listed.ok).toBe(true);
    const thirteenth = checkPlan(gate, emptyIndex, "move", "factions", undefined, {
      target: "category", member: "Mira",
    });
    expect(thirteenth.ok).toBe(false);
  });

  it("不同的分类不互认", () => {
    const gate = gateWith([categoryStep(["Ava"])]);
    const other = checkPlan(gate, emptyIndex, "move", "items", undefined, {
      target: "category", member: "Ava",
    });
    expect(other.ok).toBe(false);
  });

  it("分类步骤不认条目调用，反之亦然", () => {
    // 否则「move 势力」会顺手授权改一个恰好也叫「势力」的条目。
    const gate = gateWith([categoryStep(["Ava"])]);
    expect(checkPlan(gate, emptyIndex, "move", "Ava").ok).toBe(false);

    const entityGate = gateWith([{ action: "move", entity: "势力", detail: "改名" }]);
    expect(
      entityGate && checkPlan(entityGate, emptyIndex, "move", "势力", undefined, {
        target: "category", member: "Ava",
      }).ok,
    ).toBe(false);
  });
});

/**
 * 哪一种步骤装载哪一组延迟工具。
 *
 * 这一组存在，是因为给分类补上「搬入」这条路时踩过一次：只改了 target 那一侧，于是
 * 一份只有一条 category/move 步骤的方案会把 `lore_organize` 装上、却不装
 * `move_lore_entity`——作者批准了，模型却拿不到兑现它的工具，而且**不报错**。
 */
describe("planLoadsEntityWrites / planLoadsOrganize", () => {
  const entityStep: LorePlanStep = { action: "update", entity: "Ava", detail: "d" };
  const collectionStep: LorePlanStep = {
    action: "update", target: "collection", entity: "《雪原书》", members: ["Ava"], detail: "d",
  };
  const categoryMove: LorePlanStep = {
    action: "move", target: "category", entity: "势力", members: ["Ava"], detail: "d",
  };
  const categoryCreate: LorePlanStep = {
    action: "create", target: "category", entity: "会议纪要", detail: "d",
  };

  it("搬进分类的步骤要的是条目写工具（move_lore_entity 在那一组里）", () => {
    expect(planLoadsEntityWrites([categoryMove])).toBe(true);
    // 而它不需要集合那一组——那里没有任何工具能兑现它。
    expect(planLoadsOrganize([categoryMove])).toBe(false);
  });

  it("新建分类要的是组织结构工具", () => {
    expect(planLoadsOrganize([categoryCreate])).toBe(true);
    expect(planLoadsEntityWrites([categoryCreate])).toBe(false);
  });

  it("两组互不牵连：改正文的方案不该顺手拿到集合工具，反过来也一样", () => {
    expect(planLoadsEntityWrites([entityStep])).toBe(true);
    expect(planLoadsOrganize([entityStep])).toBe(false);
    expect(planLoadsOrganize([collectionStep])).toBe(true);
    expect(planLoadsEntityWrites([collectionStep])).toBe(false);
  });

  it("空方案两组都不装", () => {
    expect(planLoadsEntityWrites([])).toBe(false);
    expect(planLoadsOrganize([])).toBe(false);
  });
});
