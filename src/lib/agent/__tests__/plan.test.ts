import { describe, expect, it } from "vitest";
import { checkPlan, createPlanGate, type LorePlanStep } from "../plan";
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
