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
  BUILTIN_PROFILES,
  COPY_PROFILE,
  DEFAULT_TASKS,
  NOVEL_PROFILE,
  TASK_ID_RE,
  TTRPG_PROFILE,
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
