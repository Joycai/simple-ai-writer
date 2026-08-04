/**
 * The profile task registry: what a task declares, how a hand-written one is
 * validated, and that the built-in set still describes the behaviour the app had
 * when tasks were a hardcoded `TaskKind` union.
 *
 * That last part is the point of most of this file. Turning behaviour into data
 * is only safe if the data reproduces it, and a silent change here would surface
 * as "续写 stopped bridging" long after the refactor.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  BID_PROFILE,
  BUILTIN_PROFILES,
  COPY_PROFILE,
  DEFAULT_TASKS,
  FEEDBACK_PROFILE,
  NOVEL_PROFILE,
  TASK_ID_RE,
  TTRPG_PROFILE,
  WEEKLY_PROFILE,
  parseProfile,
  taskDesc,
  taskLabel,
  type TaskDef,
} from "../profile/model";
import {
  defaultTask,
  findTask,
  profileTasks,
  resetActiveProfile,
  setActiveProfile,
  visibleTasks,
} from "../profile/active";
import { presetForTools, AGENT_ASSIST_PRESET, CONTINUE_PRESET } from "../agent/presets";
import { draftCountFor } from "../ai/drafts";

afterEach(() => resetActiveProfile());

/** Echoing translator — asserts *which* key a label resolves to. */
const t = (key: string) => key;

const byId = (id: string) => DEFAULT_TASKS.find((task) => task.id === id)!;

describe("built-in tasks preserve the pre-refactor behaviour", () => {
  it("keeps 续写 a read-tool continuation that appends", () => {
    const task = byId("continue");
    expect(task.tools).toBe("read");
    expect(task.target).toBe("append");
    expect(task.continuation).toBe(true);
    // No selection needed: a continuation writes at an anchor, not over a passage.
    expect(task.needsSelection).toBeUndefined();
    expect(task.instructionKey).toBe("ai.instructions.continue");
  });

  it("keeps 润色/改写 in-place edits that need a selection", () => {
    for (const id of ["polish", "rewrite"]) {
      const task = byId(id);
      expect(task.tools).toBe("none");
      expect(task.target).toBe("replace");
      expect(task.needsSelection).toBe(true);
      expect(task.referenceWindow).toBe(true);
      expect(task.continuation).toBeUndefined();
    }
  });

  it("keeps 总结 detached so it can't overwrite what it summarises", () => {
    const task = byId("summary");
    expect(task.target).toBe("detached");
    expect(task.needsSelection).toBe(true);
  });

  it("keeps 自定义 freeform, pointing at the agent task", () => {
    const custom = byId("custom");
    expect(custom.freeform).toBe(true);
    expect(custom.tools).toBe("none");
    expect(custom.agentTaskId).toBe("agent");
    // No instruction key: the author's text is the whole ask.
    expect(custom.instructionKey).toBeUndefined();
  });

  it("keeps the agent task hidden, freeform and full-toolset", () => {
    const agent = byId("agent");
    expect(agent.hidden).toBe(true);
    expect(agent.freeform).toBe(true);
    expect(agent.tools).toBe("full");
    // Its instruction is a briefing *prefix* the author's ask follows.
    expect(agent.instructionKey).toBe("ai.instructions.agent");
  });

  it("gives every built-in task a valid id and a resolvable label", () => {
    for (const profile of BUILTIN_PROFILES) {
      expect(profile.tasks.length).toBeGreaterThan(0);
      const ids = profile.tasks.map((task) => task.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const task of profile.tasks) {
        expect(task.id).toMatch(TASK_ID_RE);
        expect(taskLabel(task, true, t)).toBeTruthy();
        // A task must have something to say to the model.
        expect(task.instructionKey || task.freeform).toBeTruthy();
        // A continuation is by definition an append.
        if (task.continuation) expect(task.target).toBe("append");
        // An agentTaskId has to resolve within the same profile.
        if (task.agentTaskId) expect(ids).toContain(task.agentTaskId);
      }
    }
  });
});

describe("the ttrpg profile's domain tasks", () => {
  const ttrpgTask = (id: string) => TTRPG_PROFILE.tasks.find((task) => task.id === id);

  it("adds 遭遇 and 随机表 on top of the shared set", () => {
    const ids = TTRPG_PROFILE.tasks.map((task) => task.id);
    expect(ids).toContain("encounter");
    expect(ids).toContain("randomtable");
    // ...without losing the domain-neutral ones.
    expect(ids).toContain("continue");
    expect(ids).toContain("polish");
  });

  it("keeps them off the other profiles", () => {
    for (const profile of [NOVEL_PROFILE, COPY_PROFILE]) {
      const ids = profile.tasks.map((task) => task.id);
      expect(ids).not.toContain("encounter");
      expect(ids).not.toContain("randomtable");
    }
  });

  it("gives 遭遇 read tools, and therefore a single draft", () => {
    const task = ttrpgTask("encounter")!;
    // It has to consult the module's own NPCs/locations — an encounter that
    // invents a rival the module already has is worse than useless at the table.
    expect(task.tools).toBe("read");
    expect(presetForTools(task.tools)).toBe(CONTINUE_PRESET);
    expect(draftCountFor(task, 3)).toBe(1);
    // The author supplies the situation; the built-in text is the briefing.
    expect(task.freeform).toBe(true);
    expect(task.instructionKey).toBe("ai.instructions.ttrpgEncounter");
    // Detached: a generated encounter must not overwrite the open document.
    expect(task.target).toBe("detached");
    expect(task.needsSelection).toBeUndefined();
  });

  it("leaves 随机表 toolless, so it can fan out into several tables", () => {
    const task = ttrpgTask("randomtable")!;
    expect(task.tools).toBe("none");
    // Three tables to choose between is the normal way to use this.
    expect(draftCountFor(task, 3)).toBe(3);
    expect(task.freeform).toBe(true);
    expect(task.target).toBe("detached");
  });
});

describe("the copy profile's domain tasks", () => {
  const copyTask = (id: string) => COPY_PROFILE.tasks.find((task) => task.id === id);

  it("adds 标题 and 渠道改写", () => {
    const ids = COPY_PROFILE.tasks.map((task) => task.id);
    expect(ids).toContain("headlines");
    expect(ids).toContain("channel");
  });

  it("keeps them off the other profiles", () => {
    for (const profile of [NOVEL_PROFILE, TTRPG_PROFILE]) {
      const ids = profile.tasks.map((task) => task.id);
      expect(ids).not.toContain("headlines");
      expect(ids).not.toContain("channel");
    }
  });

  it("leaves 标题 toolless so it can fan out into sets of options", () => {
    const task = copyTask("headlines")!;
    expect(task.tools).toBe("none");
    expect(draftCountFor(task, 3)).toBe(3);
    // Generated from a brief, so no selection is required.
    expect(task.freeform).toBe(true);
    expect(task.needsSelection).toBeUndefined();
    expect(task.target).toBe("detached");
  });

  it("makes 渠道改写 need a selection but not a reference window", () => {
    const task = copyTask("channel")!;
    // The combination the panel used to be unable to express: it derived the
    // selection gate from `referenceWindow`, so a task like this would have run
    // on an empty selection.
    expect(task.needsSelection).toBe(true);
    expect(task.referenceWindow).toBeUndefined();
    // Detached, not replace: the adaptation is an additional piece, and
    // overwriting would lose the source being adapted from.
    expect(task.target).toBe("detached");
    expect(task.freeform).toBe(true);
  });
});

describe("the 周报 profile", () => {
  const task = (id: string) => WEEKLY_PROFILE.tasks.find((t) => t.id === id);

  it("is chronological without rolling memory", () => {
    // Reports sit in date order and last week's is genuinely the context, but a
    // single report is far too short to need compacting.
    expect(WEEKLY_PROFILE.docModel).toEqual({
      ordered: true, priorContext: true, memory: false,
    });
  });

  it("leaves 汇总 toolless — the author brings the material", () => {
    const digest = task("digest")!;
    expect(digest.tools).toBe("none");
    expect(digest.freeform).toBe(true);
    expect(draftCountFor(digest, 3)).toBe(3);
  });

  it("gives 对照上期 read tools and no freeform input", () => {
    const carryover = task("carryover")!;
    // Read tools because prior-document context only reaches *continuation*
    // tasks, and this one appends nothing — it has to find the file itself.
    expect(carryover.tools).toBe("read");
    expect(carryover.continuation).toBeUndefined();
    // Not freeform on purpose: it is useful with no input, and a freeform task
    // can't run on an empty box.
    expect(carryover.freeform).toBeUndefined();
    expect(carryover.instructionKey).toBe("ai.instructions.weeklyCarryover");
  });
});

describe("the 反馈报告 profile", () => {
  const task = (id: string) => FEEDBACK_PROFILE.tasks.find((t) => t.id === id);

  it("treats each report as independent", () => {
    expect(FEEDBACK_PROFILE.docModel).toEqual({
      ordered: false, priorContext: false, memory: false,
    });
  });

  it("gives both domain tasks read tools", () => {
    // Both have to consult the corpus: a synthesis of feedback the model never
    // read is the failure this profile is shaped against.
    for (const id of ["themes", "verify"]) {
      expect(task(id)!.tools).toBe("read");
      expect(draftCountFor(task(id)!, 3)).toBe(1);
    }
  });

  it("splits the pair on generate vs verify", () => {
    // 归纳 works from a brief over the whole corpus...
    expect(task("themes")!.freeform).toBe(true);
    expect(task("themes")!.needsSelection).toBeUndefined();
    // ...溯源 checks one claim, so it needs that claim selected — and takes no
    // reference window, since what it needs is the sources, not the paragraphs
    // around the claim.
    expect(task("verify")!.needsSelection).toBe(true);
    expect(task("verify")!.referenceWindow).toBeUndefined();
    expect(task("verify")!.freeform).toBeUndefined();
  });
});

describe("the 标书应答 profile", () => {
  const task = (id: string) => BID_PROFILE.tasks.find((t) => t.id === id);

  it("has an ordered spine but no prior-context or memory", () => {
    // A response document mirrors the tender's numbered structure, but each
    // item stands alone — nothing "precedes" one.
    expect(BID_PROFILE.docModel).toEqual({
      ordered: true, priorContext: false, memory: false,
    });
  });

  it("keeps the full shared set, including 续写", () => {
    // Unlike copy: the narrative sections of a 技术方案书 are long-form prose.
    const ids = BID_PROFILE.tasks.map((t) => t.id);
    for (const id of ["continue", "polish", "rewrite", "summary"]) {
      expect(ids).toContain(id);
    }
  });

  it("keeps its domain tasks off the other profiles", () => {
    for (const profile of BUILTIN_PROFILES.filter((p) => p !== BID_PROFILE)) {
      const ids = profile.tasks.map((t) => t.id);
      for (const id of ["respond", "deviation", "extract"]) {
        expect(ids).not.toContain(id);
      }
    }
  });

  it("makes 应答撰写 a grounded read task over the selected clause", () => {
    const respond = task("respond")!;
    // Must look the capability up — a response written from industry intuition
    // is the failure this profile is shaped against. Costs the single draft.
    expect(respond.tools).toBe("read");
    expect(presetForTools(respond.tools)).toBe(CONTINUE_PRESET);
    expect(draftCountFor(respond, 3)).toBe(1);
    // The selection is the tender clause; the reference window brings the
    // surrounding clauses plus the extra-requirement box.
    expect(respond.needsSelection).toBe(true);
    expect(respond.referenceWindow).toBe(true);
    // A tender has dozens of clauses — respond offers the batch sweep, and is
    // the only built-in task that does.
    expect(respond.batch).toBe(true);
    for (const profile of BUILTIN_PROFILES) {
      for (const other of profile.tasks) {
        if (other.id !== "respond") expect(other.batch).toBeUndefined();
      }
    }
    // Detached: a response must never overwrite the clause it answers.
    expect(respond.target).toBe("detached");
    expect(respond.freeform).toBeUndefined();
  });

  it("makes 应答核查 audit the selection without a reference window", () => {
    const deviation = task("deviation")!;
    expect(deviation.tools).toBe("read");
    // What it needs is the *entries*, not the paragraphs around the response.
    expect(deviation.needsSelection).toBe(true);
    expect(deviation.referenceWindow).toBeUndefined();
    expect(deviation.freeform).toBeUndefined();
    expect(deviation.target).toBe("detached");
  });

  it("gives 提取入库 the write-capable toolset behind the plan gate", () => {
    const extract = task("extract")!;
    expect(extract.tools).toBe("full");
    // Full tools resolve to the plan-gated preset: no lore write happens
    // without an approved propose_lore_plan card.
    expect(presetForTools(extract.tools)).toBe(AGENT_ASSIST_PRESET);
    expect(AGENT_ASSIST_PRESET.tools).toContain("propose_lore_plan");
    expect(draftCountFor(extract, 3)).toBe(1);
    // The author scopes the sweep; the built-in text is the briefing.
    expect(extract.freeform).toBe(true);
    expect(extract.needsSelection).toBeUndefined();
  });
});

describe("profile task lists", () => {
  it("drops 续写 from the copy profile", () => {
    // A headline has nothing to continue from; the rest of the shared set does
    // still apply to a piece of copy being edited.
    expect(COPY_PROFILE.tasks.map((task) => task.id)).not.toContain("continue");
    expect(COPY_PROFILE.tasks.map((task) => task.id)).toContain("polish");
  });

  it("resolves tasks against the active profile", () => {
    expect(findTask("continue")).not.toBeNull();
    setActiveProfile(COPY_PROFILE);
    // Not a defensive branch — panel state can outlive the profile that had it.
    expect(findTask("continue")).toBeNull();
    expect(findTask("polish")).not.toBeNull();
  });

  it("hides the agent task from the pickable list but keeps it resolvable", () => {
    setActiveProfile(NOVEL_PROFILE);
    expect(visibleTasks().map((task) => task.id)).not.toContain("agent");
    expect(profileTasks().map((task) => task.id)).toContain("agent");
    expect(findTask("agent")).not.toBeNull();
  });

  it("opens on the first visible task", () => {
    setActiveProfile(NOVEL_PROFILE);
    expect(defaultTask().id).toBe("continue");
    setActiveProfile(COPY_PROFILE);
    expect(defaultTask().id).toBe("rewrite");
  });
});

describe("taskLabel / taskDesc", () => {
  it("prefers the i18n key, then the literal, then the id", () => {
    expect(taskLabel(byId("continue"), true, t)).toBe("ai.tasks.continue");
    const literal: TaskDef = {
      id: "headlines", labelZh: "三版标题", labelEn: "Headlines",
      tools: "none", target: "detached", freeform: true,
    };
    expect(taskLabel(literal, true, t)).toBe("三版标题");
    expect(taskLabel(literal, false, t)).toBe("Headlines");
    const bare: TaskDef = { id: "bare", tools: "none", target: "detached", freeform: true };
    expect(taskLabel(bare, true, t)).toBe("bare");
    expect(taskDesc(bare, true, t)).toBe("");
  });
});

describe("presetForTools", () => {
  it("maps a task's declared tools to the preset that implements it", () => {
    // `none` is null rather than an empty preset: such a task never enters the
    // tool loop at all, and the null is what tells runTask to stream directly.
    expect(presetForTools("none")).toBeNull();
    expect(presetForTools("read")).toBe(CONTINUE_PRESET);
    expect(presetForTools("full")).toBe(AGENT_ASSIST_PRESET);
  });

  it("gives the read preset no write tools", () => {
    // 续写 runs the loop but must not be able to touch disk.
    const writeish = CONTINUE_PRESET.tools.filter(
      (id) => /^(create|update|delete|move|propose)_/.test(id),
    );
    expect(writeish).toEqual([]);
  });
});

describe("parseProfile — tasks", () => {
  const base = { id: "weekly", categories: [{ id: "projects", labelZh: "项目", labelEn: "Projects" }] };

  it("accepts a hand-written task", () => {
    const { profile, issues } = parseProfile(
      {
        ...base,
        tasks: [{
          id: "headlines", labelZh: "三版标题", labelEn: "Headlines",
          instructionKey: "ai.instructions.summary", tools: "none", target: "detached",
        }],
      },
      NOVEL_PROFILE,
    );
    expect(issues).toEqual([]);
    expect(profile.tasks.map((task) => task.id)).toEqual(["headlines"]);
  });

  it("inherits the fallback's tasks when none are declared", () => {
    const { profile, issues } = parseProfile({ id: "ttrpg" }, TTRPG_PROFILE);
    expect(profile.tasks).toEqual(TTRPG_PROFILE.tasks);
    expect(issues).toEqual([]);
  });

  it("replaces rather than merges a declared list", () => {
    // A task list is an ordered menu: merging would put a new entry somewhere
    // arbitrary and leave no way to remove one.
    const { profile } = parseProfile(
      { ...base, tasks: [{ id: "only", tools: "none", target: "detached", freeform: true }] },
      NOVEL_PROFILE,
    );
    expect(profile.tasks.map((task) => task.id)).toEqual(["only"]);
  });

  it("drops a task whose tools value is unrecognised", () => {
    // No safe default exists: guessing "none" breaks a task meant to be agentic,
    // and guessing "full" hands it the write tools.
    const { profile, issues } = parseProfile(
      {
        ...base,
        tasks: [
          { id: "good", tools: "none", target: "detached", freeform: true },
          { id: "sneaky", tools: "everything", target: "detached", freeform: true },
        ],
      },
      NOVEL_PROFILE,
    );
    expect(profile.tasks.map((task) => task.id)).toEqual(["good"]);
    expect(issues.join(" ")).toContain("unknown tools");
  });

  it("drops tasks that are unusable for other reasons", () => {
    const { profile, issues } = parseProfile(
      {
        ...base,
        tasks: [
          { id: "keep", tools: "none", target: "detached", freeform: true },
          { id: "bad target", tools: "none", target: "sideways", freeform: true },
          { id: "silent", tools: "none", target: "detached" }, // no prompt, not freeform
          { id: "../escape", tools: "none", target: "detached", freeform: true },
          { id: "keep", tools: "none", target: "detached", freeform: true }, // duplicate
          "not-an-object",
        ],
      },
      NOVEL_PROFILE,
    );
    expect(profile.tasks.map((task) => task.id)).toEqual(["keep"]);
    expect(issues.length).toBe(5);
  });

  it("refuses continuation on a task that doesn't append", () => {
    const { profile, issues } = parseProfile(
      {
        ...base,
        tasks: [{
          id: "odd", tools: "none", target: "replace", continuation: true,
          instructionKey: "ai.instructions.polish",
        }],
      },
      NOVEL_PROFILE,
    );
    expect(profile.tasks[0].continuation).toBeUndefined();
    expect(issues.join(" ")).toContain("continuation");
  });

  it("drops an agentTaskId that points nowhere", () => {
    const { profile, issues } = parseProfile(
      {
        ...base,
        tasks: [{
          id: "ask", tools: "none", target: "detached", freeform: true,
          agentTaskId: "missing",
        }],
      },
      NOVEL_PROFILE,
    );
    expect(profile.tasks[0].agentTaskId).toBeUndefined();
    expect(issues.join(" ")).toContain("agentTaskId");
  });

  it("caps the task count", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `t${i}`, tools: "none", target: "detached", freeform: true,
    }));
    const { profile, issues } = parseProfile({ ...base, tasks: many }, NOVEL_PROFILE);
    expect(profile.tasks.length).toBe(16);
    expect(issues.join(" ")).toContain("16");
  });
});

// ── Every declared flag is consumed somewhere ────────────────────────────────

/**
 * Source text, keyed by repo-relative path (Vite's glob — the project's tsconfig
 * has no `@types/node`, so a `node:fs` walk would fail `tsc --noEmit`).
 */
const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw",
  eager: true,
  import: "default",
}) as Record<string, string>;

/**
 * A `TaskDef` field that nothing outside the model reads is a feature that looks
 * declared, is validated, is covered by the built-in assertions above — and does
 * nothing. That is exactly how `needsSelection` shipped inert: the panel derived
 * the gate from `referenceWindow` instead, which happened to coincide on every
 * built-in, so no behavioural test could see the difference.
 *
 * This proves only that *something* reads each flag, not that it reads it
 * correctly. That is a weaker guarantee than a behavioural test — but it is
 * precisely the one that was missing, and it costs nothing to keep.
 */
describe("TaskDef flags", () => {
  const OPTIONAL_FLAGS = [
    "needsSelection", "continuation", "referenceWindow", "freeform",
    "agentTaskId", "hidden", "instructionKey", "tools", "target",
  ];

  it("has a consumer outside the model for every flag", () => {
    const consumers = Object.entries(SOURCES).filter(
      ([path]) =>
        !path.includes("/__tests__/") &&
        !path.endsWith("/lib/profile/model.ts"), // declaration + validation
    );
    // Guard the guard: a broken glob would make every flag look consumed.
    expect(consumers.length).toBeGreaterThan(20);

    const unread = OPTIONAL_FLAGS.filter(
      (flag) => !consumers.some(([, text]) => text.includes(`.${flag}`)),
    );
    expect(
      unread,
      "These TaskDef fields are declared but nothing reads them — either wire " +
        "them up or drop them from the model.",
    ).toEqual([]);
  });
});
