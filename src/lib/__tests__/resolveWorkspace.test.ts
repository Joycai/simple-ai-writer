/**
 * The pack merge (lib/profile/resolve).
 *
 * The invariant that matters most is at the top: a single-pack workspace must
 * behave exactly like the pre-pack profile did, because every existing project
 * resolves to one. Everything else is arbitration: category union, task
 * dedupe, conflicts, and who owns the non-additive dimensions.
 */
import { describe, expect, it } from "vitest";
import {
  BID_PROFILE,
  BUILTIN_PROFILES,
  DEFAULT_TASKS,
  NOVEL_PROFILE,
  TTRPG_PROFILE,
  type TaskDef,
  type WorkspaceProfile,
} from "../profile/model";
import { resolveWorkspace } from "../profile/resolve";

/** Strip the merge-added fields, leaving what the pack declared. */
const bare = <T extends { packIds?: string[]; packId?: string }>({ packIds, packId, ...rest }: T) => rest;

describe("single pack", () => {
  it("is the pack, unchanged — categories, tasks, order", () => {
    for (const pack of BUILTIN_PROFILES) {
      const w = resolveWorkspace(pack, []);
      expect(w.primary).toBe(pack);
      expect(w.enabled).toEqual([pack]);
      expect(w.categories.map(bare)).toEqual(pack.categories);
      expect(w.tasks.map(bare)).toEqual(pack.tasks);
      expect(w.tasks.every((t) => t.packId === pack.id)).toBe(true);
      expect(w.issues).toEqual([]);
    }
  });

  it("treats an enabled list repeating the primary as the same workspace", () => {
    const a = resolveWorkspace(NOVEL_PROFILE, []);
    const b = resolveWorkspace(NOVEL_PROFILE, [NOVEL_PROFILE]);
    expect(b.categories).toEqual(a.categories);
    expect(b.tasks).toEqual(a.tasks);
  });
});

describe("category union", () => {
  it("unions by id, primary first, recording every declarer", () => {
    const w = resolveWorkspace(NOVEL_PROFILE, [BID_PROFILE]);
    const ids = w.categories.map((c) => c.id);
    // Primary's categories lead, in their own order.
    expect(ids.slice(0, NOVEL_PROFILE.categories.length)).toEqual(
      NOVEL_PROFILE.categories.map((c) => c.id),
    );
    // The secondary's novel additions follow; shared ids are not repeated.
    expect(ids).toContain("qualifications");
    expect(new Set(ids).size).toBe(ids.length);
    // A shared id is the same directory: label from the first declarer, both
    // packs on record (style/custom exist in novel and bid alike).
    const style = w.categories.find((c) => c.id === "style")!;
    expect(style.labelZh).toBe("风格"); // novel's, not bid's 措辞风格
    expect(style.packIds).toEqual(["novel", "bid"]);
    const caps = w.categories.find((c) => c.id === "capabilities")!;
    expect(caps.packIds).toEqual(["bid"]);
  });

  it("never mutates the packs it merges", () => {
    const before = JSON.stringify(NOVEL_PROFILE.categories);
    resolveWorkspace(NOVEL_PROFILE, [BID_PROFILE]);
    resolveWorkspace(NOVEL_PROFILE, [BID_PROFILE]);
    expect(JSON.stringify(NOVEL_PROFILE.categories)).toBe(before);
  });

  it("dedupes case-insensitively, like parseProfile does", () => {
    const shouty: WorkspaceProfile = {
      ...TTRPG_PROFILE,
      id: "shouty",
      categories: [{ id: "Items", labelZh: "大道具", labelEn: "Items" }],
    };
    const w = resolveWorkspace(NOVEL_PROFILE, [shouty]);
    // novel's `items` already claimed the directory on Windows-insensitive
    // filesystems; the shouty variant folds into it.
    const items = w.categories.filter((c) => c.id.toLowerCase() === "items");
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("items");
    expect(items[0].packIds).toEqual(["novel", "shouty"]);
  });
});

describe("task union", () => {
  it("keeps the shared base tasks once, owned by the primary", () => {
    const w = resolveWorkspace(NOVEL_PROFILE, [BID_PROFILE, TTRPG_PROFILE]);
    for (const base of DEFAULT_TASKS) {
      const matches = w.tasks.filter((t) => t.id === base.id);
      expect(matches).toHaveLength(1);
      expect(matches[0].packId).toBe("novel");
    }
    // No conflict noise from the sharing.
    expect(w.issues).toEqual([]);
  });

  it("tags each pack's own tasks with that pack", () => {
    const w = resolveWorkspace(NOVEL_PROFILE, [BID_PROFILE, TTRPG_PROFILE]);
    expect(w.tasks.find((t) => t.id === "respond")?.packId).toBe("bid");
    expect(w.tasks.find((t) => t.id === "encounter")?.packId).toBe("ttrpg");
  });

  it("keeps the custom→agent pointer resolvable", () => {
    const w = resolveWorkspace(NOVEL_PROFILE, [BID_PROFILE]);
    const custom = w.tasks.find((t) => t.id === "custom")!;
    expect(custom.agentTaskId).toBe("agent");
    expect(w.tasks.some((t) => t.id === custom.agentTaskId)).toBe(true);
  });

  it("drops a conflicting redefinition, first declarer wins, loudly", () => {
    const rogue: TaskDef = {
      id: "respond", // bid's task id, different behaviour
      labelZh: "假应答", labelEn: "Fake",
      tools: "full", target: "replace", freeform: true,
    };
    const roguePack: WorkspaceProfile = {
      ...TTRPG_PROFILE, id: "rogue", tasks: [...TTRPG_PROFILE.tasks, rogue],
    };
    const w = resolveWorkspace(NOVEL_PROFILE, [BID_PROFILE, roguePack]);
    const respond = w.tasks.filter((t) => t.id === "respond");
    expect(respond).toHaveLength(1);
    // First declarer (bid) won; the rogue redefinition was dropped, not merged
    // — swapping whose behaviour an id means would break prompt-template
    // `scene` and `token_usage.task`, both keyed on it.
    expect(respond[0].packId).toBe("bid");
    expect(respond[0].tools).toBe(BID_PROFILE.tasks.find((t) => t.id === "respond")!.tools);
    expect(w.issues.some((i) => i.includes('"respond"') && i.includes("rogue"))).toBe(true);
  });

  it("has no id collisions among the built-in packs' own tasks", () => {
    // The conflict path above is for user packs; the built-ins must never
    // trip it, whatever combination is enabled.
    const w = resolveWorkspace(BUILTIN_PROFILES[0], BUILTIN_PROFILES.slice(1));
    expect(w.issues).toEqual([]);
  });
});

describe("primary-owned dimensions", () => {
  it("keeps the primary in charge whatever order packs enable in", () => {
    const a = resolveWorkspace(NOVEL_PROFILE, [BID_PROFILE]);
    const b = resolveWorkspace(BID_PROFILE, [NOVEL_PROFILE]);
    expect(a.primary.docModel).toBe(NOVEL_PROFILE.docModel);
    expect(b.primary.docModel).toBe(BID_PROFILE.docModel);
    // Same packs, different primary → different category order (primary first).
    expect(a.categories[0].id).toBe(NOVEL_PROFILE.categories[0].id);
    expect(b.categories[0].id).toBe(BID_PROFILE.categories[0].id);
  });
});
