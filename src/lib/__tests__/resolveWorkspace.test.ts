/**
 * The pack merge (lib/profile/resolve).
 *
 * Packs are equal, purely additive toggles now: the base task menu and the
 * `custom` category are app-level, each enabled pack contributes categories
 * and tasks on top, and the project's user-defined categories join the union.
 * The invariants that matter: the base menu always exists (even with zero
 * packs), a pack can override a base task's instruction but not remove it,
 * and the misc bucket is always last.
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
import { BASE_TASK_IDS, CUSTOM_CATEGORY, resolveWorkspace, visibleTaskGroups } from "../profile/resolve";

describe("zero packs", () => {
  it("yields the app-level baseline: base tasks, the custom bucket", () => {
    const w = resolveWorkspace([]);
    expect(w.enabled).toEqual([]);
    expect(w.categories.map((c) => c.id)).toEqual([CUSTOM_CATEGORY.id]);
    expect(w.tasks.map((t) => t.id)).toEqual(DEFAULT_TASKS.map((t) => t.id));
    expect(w.tasks.every((t) => t.packId === undefined)).toBe(true);
    expect(w.issues).toEqual([]);
  });

  it("still has a usable menu and bucket with only user categories", () => {
    const w = resolveWorkspace([], [{ id: "meetings", labelZh: "会议纪要", labelEn: "Meetings" }]);
    expect(w.categories.map((c) => c.id)).toEqual(["meetings", "custom"]);
    expect(w.categories[0].userDefined).toBe(true);
    expect(w.categories[0].packIds).toEqual([]);
  });
});

describe("single pack", () => {
  it("is the pack's categories plus the custom bucket, in order", () => {
    for (const pack of BUILTIN_PROFILES) {
      const w = resolveWorkspace([pack]);
      expect(w.enabled).toEqual([pack]);
      expect(w.categories.map((c) => c.id)).toEqual([
        ...pack.categories.map((c) => c.id),
        CUSTOM_CATEGORY.id,
      ]);
      expect(w.issues).toEqual([]);
    }
  });

  it("keeps the base menu, with the pack's overrides applied in place", () => {
    const w = resolveWorkspace([NOVEL_PROFILE]);
    // The menu is the base menu — same ids, same order.
    expect(w.tasks.map((t) => t.id)).toEqual(DEFAULT_TASKS.map((t) => t.id));
    // Novel re-points three instructions at fiction wording; those carry its
    // packId, the untouched base tasks carry none.
    expect(w.tasks.find((t) => t.id === "continue")?.instructionKey).toBe(
      "ai.instructions.continueNovel",
    );
    expect(w.tasks.find((t) => t.id === "continue")?.packId).toBe("novel");
    expect(w.tasks.find((t) => t.id === "polish")?.packId).toBeUndefined();
    expect(w.tasks.find((t) => t.id === "polish")?.instructionKey).toBe(
      "ai.instructions.polish",
    );
  });

  it("dedupes a pack repeated in the enabled list", () => {
    const a = resolveWorkspace([NOVEL_PROFILE]);
    const b = resolveWorkspace([NOVEL_PROFILE, NOVEL_PROFILE]);
    expect(b.categories).toEqual(a.categories);
    expect(b.tasks).toEqual(a.tasks);
  });
});

describe("category union", () => {
  it("unions by id in enabled order, custom last, recording every declarer", () => {
    const w = resolveWorkspace([NOVEL_PROFILE, BID_PROFILE]);
    const ids = w.categories.map((c) => c.id);
    expect(ids.slice(0, NOVEL_PROFILE.categories.length)).toEqual(
      NOVEL_PROFILE.categories.map((c) => c.id),
    );
    expect(ids).toContain("qualifications");
    expect(ids[ids.length - 1]).toBe(CUSTOM_CATEGORY.id);
    expect(new Set(ids).size).toBe(ids.length);
    // A shared id is the same directory: label from the first declarer, both
    // packs on record (style exists in novel and bid alike).
    const style = w.categories.find((c) => c.id === "style")!;
    expect(style.labelZh).toBe("文风"); // novel's, not bid's 措辞风格
    expect(style.packIds).toEqual(["novel", "bid"]);
    const caps = w.categories.find((c) => c.id === "capabilities")!;
    expect(caps.packIds).toEqual(["bid"]);
  });

  it("lets a pack's declaration win over a colliding user category", () => {
    const w = resolveWorkspace(
      [NOVEL_PROFILE],
      [{ id: "style", labelZh: "我的风格", labelEn: "My style" }],
    );
    const style = w.categories.filter((c) => c.id.toLowerCase() === "style");
    expect(style).toHaveLength(1);
    expect(style[0].labelZh).toBe("文风");
    expect(style[0].userDefined).toBeUndefined();
  });

  it("appends user categories after pack categories, before custom", () => {
    const w = resolveWorkspace([NOVEL_PROFILE], [
      { id: "meetings", labelZh: "会议纪要", labelEn: "Meetings" },
    ]);
    const ids = w.categories.map((c) => c.id);
    expect(ids[ids.length - 2]).toBe("meetings");
    expect(ids[ids.length - 1]).toBe("custom");
    expect(w.categories.find((c) => c.id === "meetings")?.userDefined).toBe(true);
  });

  it("never mutates the packs it merges", () => {
    const before = JSON.stringify(NOVEL_PROFILE.categories);
    resolveWorkspace([NOVEL_PROFILE, BID_PROFILE]);
    resolveWorkspace([NOVEL_PROFILE, BID_PROFILE]);
    expect(JSON.stringify(NOVEL_PROFILE.categories)).toBe(before);
  });

  it("dedupes case-insensitively, like parseProfile does", () => {
    const shouty: WorkspaceProfile = {
      ...TTRPG_PROFILE,
      id: "shouty",
      categories: [{ id: "Items", labelZh: "大道具", labelEn: "Items" }],
    };
    const w = resolveWorkspace([NOVEL_PROFILE, shouty]);
    // novel's `items` already claimed the directory on Windows-insensitive
    // filesystems; the shouty variant folds into it.
    const items = w.categories.filter((c) => c.id.toLowerCase() === "items");
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("items");
    expect(items[0].packIds).toEqual(["novel", "shouty"]);
  });
});

describe("task union", () => {
  it("keeps the base menu once, whatever is enabled", () => {
    const w = resolveWorkspace([NOVEL_PROFILE, BID_PROFILE, TTRPG_PROFILE]);
    for (const base of DEFAULT_TASKS) {
      const matches = w.tasks.filter((t) => t.id === base.id);
      expect(matches).toHaveLength(1);
    }
    // No conflict noise from base overrides.
    expect(w.issues).toEqual([]);
  });

  it("lets the first enabled pack win a base-task override, silently", () => {
    const rival: WorkspaceProfile = {
      ...TTRPG_PROFILE,
      id: "rival",
      tasks: [{ ...DEFAULT_TASKS.find((t) => t.id === "continue")!, instructionKey: "ai.instructions.custom" }],
    };
    const a = resolveWorkspace([NOVEL_PROFILE, rival]);
    expect(a.tasks.find((t) => t.id === "continue")?.instructionKey).toBe(
      "ai.instructions.continueNovel",
    );
    expect(a.issues).toEqual([]);
    const b = resolveWorkspace([rival, NOVEL_PROFILE]);
    expect(b.tasks.find((t) => t.id === "continue")?.instructionKey).toBe(
      "ai.instructions.custom",
    );
    expect(b.tasks.find((t) => t.id === "continue")?.packId).toBe("rival");
  });

  it("tags each pack's own tasks with that pack", () => {
    const w = resolveWorkspace([NOVEL_PROFILE, BID_PROFILE, TTRPG_PROFILE]);
    expect(w.tasks.find((t) => t.id === "respond")?.packId).toBe("bid");
    expect(w.tasks.find((t) => t.id === "encounter")?.packId).toBe("ttrpg");
  });

  it("keeps the custom→agent pointer resolvable", () => {
    const w = resolveWorkspace([NOVEL_PROFILE, BID_PROFILE]);
    const custom = w.tasks.find((t) => t.id === "custom")!;
    expect(custom.agentTaskId).toBe("agent");
    expect(w.tasks.some((t) => t.id === custom.agentTaskId)).toBe(true);
  });

  it("drops a conflicting redefinition of a pack task, first declarer wins, loudly", () => {
    const rogue: TaskDef = {
      id: "respond", // bid's task id, different behaviour
      labelZh: "假应答", labelEn: "Fake",
      tools: "full", target: "replace", freeform: true,
    };
    const roguePack: WorkspaceProfile = {
      ...TTRPG_PROFILE, id: "rogue", tasks: [...TTRPG_PROFILE.tasks, rogue],
    };
    const w = resolveWorkspace([NOVEL_PROFILE, BID_PROFILE, roguePack]);
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
    const w = resolveWorkspace(BUILTIN_PROFILES);
    expect(w.issues).toEqual([]);
  });
});

describe("visibleTaskGroups", () => {
  it("yields the base menu as one flat group with zero packs", () => {
    const groups = visibleTaskGroups(resolveWorkspace([]));
    expect(groups).toHaveLength(1);
    expect(groups[0].pack).toBeNull();
    expect(groups[0].tasks.map((t) => t.id)).toEqual(
      DEFAULT_TASKS.filter((t) => !t.hidden).map((t) => t.id),
    );
  });

  it("keeps an overridden base task in the base group, not under its pack", () => {
    const groups = visibleTaskGroups(resolveWorkspace([NOVEL_PROFILE]));
    // Novel only overrides base tasks, so it contributes no group of its own.
    expect(groups).toHaveLength(1);
    expect(groups[0].pack).toBeNull();
    expect(groups[0].tasks.some((t) => t.id === "continue")).toBe(true);
  });

  it("groups each pack's own tasks under that pack, base first", () => {
    const w = resolveWorkspace([NOVEL_PROFILE, BID_PROFILE, TTRPG_PROFILE]);
    const groups = visibleTaskGroups(w);
    expect(groups.map((g) => g.pack?.id ?? null)).toEqual([null, "bid", "ttrpg"]);
    expect(groups[0].tasks.some((t) => t.id === "continue")).toBe(true);
    expect(groups[1].tasks.map((t) => t.id)).toEqual(["respond", "deviation", "extract"]);
    expect(groups[1].tasks.every((t) => t.packId === "bid")).toBe(true);
    expect(groups[2].tasks.some((t) => t.id === "encounter")).toBe(true);
  });
});

describe("base task ids", () => {
  it("exports the base menu's ids for grouping and attribution", () => {
    expect([...BASE_TASK_IDS].sort()).toEqual(DEFAULT_TASKS.map((t) => t.id).sort());
  });
});
