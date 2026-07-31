/**
 * Workspace profiles — the per-project "what am I writing" declaration.
 *
 * Everything domain-specific about a project is meant to live here rather than
 * in code: the knowledge-base categories (which are also the `.ai-writer/lore/`
 * folder layout), the labels the prompt uses for each context block, and which
 * system prompt the model falls back to. Adding a new kind of writing should be
 * a new profile, not a new branch in `TaskKind`.
 *
 * A project's profile is stored at `.ai-writer/profile.json` (see ./store). The
 * novel profile is the default, so every project that predates this file keeps
 * behaving exactly as it did.
 */

/**
 * One knowledge-base category. `id` doubles as the directory name under
 * `.ai-writer/lore/`, which is why ./store validates it before anything on disk
 * is touched.
 */
export interface ProfileCategory {
  id: string;
  labelZh: string;
  labelEn: string;
}

/**
 * The context blocks a prompt is assembled from. Ids are stable; only the
 * author-facing wording varies per profile — see `DEFAULT_SECTION_LABELS` and
 * `bundleToMessages` in lib/context/rag.ts.
 */
export type SectionId =
  | "knowledge"
  | "additionalKnowledge"
  | "outline"
  | "priorAll"
  | "priorRecap"
  | "prevTail"
  | "recent"
  | "selection"
  | "requirement"
  | "currentFile";

/**
 * What shape this project's documents have — the machinery built for a novel
 * that only makes sense when the documents really are a book.
 *
 * Every flag defaults to `true`, i.e. novel behaviour, so a profile that says
 * nothing keeps the original feature set. Turning one off removes both the
 * context it injects and the UI that configures it: a half-hidden feature that
 * still spends context budget is worse than either.
 */
export interface DocModel {
  /**
   * Documents form an ordered spine of volumes and chapters
   * (`.ai-writer/outline.json`) — the outline panel and full outline view.
   * False for collections of independent pieces, where an "order" is noise.
   */
  ordered: boolean;
  /**
   * A continuation is given the preceding documents: a recap of everything
   * before (【全书前情】) plus the previous document's ending (【上一章结尾】).
   * Requires `ordered` to mean anything — "previous" needs an order.
   */
  priorContext: boolean;
  /**
   * Per-document rolling summary memory (`.ai-writer/memory/`, 【前情提要】),
   * which compacts a long document so its own earlier parts stay in context.
   * Pointless for short pieces that fit whole.
   */
  memory: boolean;
}

/**
 * Which tool set a task runs on. Resolved to a concrete preset by
 * `lib/agent/presets`; kept as a small enum here so a profile never has to
 * name a preset object.
 *
 *   - `none` — a single stateless completion. Fans out into several drafts.
 *   - `read` — may read lore, chapters and memory before writing (续写).
 *   - `full` — the whole toolset, including L1 writes and `propose_edit`.
 *
 * Anything other than `none` runs the agent loop, and therefore produces a
 * single draft: every round reports into one shared execution log, and the
 * write-capable set additionally can't have concurrent runs touching one lore
 * folder. See `draftCountFor`.
 */
export type TaskTools = "none" | "read" | "full";

/**
 * Where a task's result belongs once the author accepts it.
 *
 *   - `append`   — spliced in at the continuation anchor (续写)
 *   - `replace`  — overwrites the selected passage (润色 / 改写)
 *   - `detached` — nothing implied; the author inserts it if they want it
 */
export type TaskTarget = "append" | "replace" | "detached";

/**
 * One thing the author can ask for.
 *
 * A task is a **prompt plus a tool set**, and the rest of these fields are the
 * behaviour that used to be inferred from a hardcoded `TaskKind` union: how the
 * result lands, whether a selection is required, which controls the panel shows.
 * Expressing them as data is what lets a profile carry a different *number* and
 * *kind* of tasks — 「生成遭遇表」 for a module, 「三版标题」 for copy.
 */
export interface TaskDef {
  /**
   * Stable id. Three things key off it, so renaming one is a breaking change:
   * the `scene` of a user prompt template that overrides its instruction, the
   * `task` column in `token_usage`, and the execution log's label.
   */
  id: string;
  /**
   * i18n key for the label — preferred, and what the built-ins use so their
   * existing translations keep working. A profile written by hand (in
   * `profile.json`, where new i18n keys can't be added) uses `labelZh`/`labelEn`
   * instead. `taskLabel()` is the single place that resolves the two.
   */
  labelKey?: string;
  labelZh?: string;
  labelEn?: string;
  /** Same arrangement for the one-line description shown on the segment. */
  descKey?: string;
  descZh?: string;
  descEn?: string;
  /**
   * i18n key of the built-in instruction. A user prompt template whose `scene`
   * equals this task's id overrides it. For a `freeform` task this is a briefing
   * *prefix* the author's own text is appended to (empty = no prefix).
   */
  instructionKey?: string;
  tools: TaskTools;
  target: TaskTarget;
  /** Won't run without a committed selection (润色 / 改写 / 总结). */
  needsSelection?: boolean;
  /**
   * Continuation semantics, as one switch because they are one feature: the
   * result appends at an anchor rather than replacing, prior-document context is
   * offered, and the panel shows the length, 承接/独立 and outline/knowledge
   * controls. Only meaningful with `target: "append"`.
   */
  continuation?: boolean;
  /** Shows the reference-window + extra-requirement controls (edit tasks). */
  referenceWindow?: boolean;
  /** The author types the instruction themselves (自定义). */
  freeform?: boolean;
  /**
   * Id of the task the panel's "Agent 模式" toggle switches to. Modelled as a
   * pointer rather than a boolean so the agent task stays an ordinary entry with
   * its own prompt and tool set, instead of a second meaning for this one.
   */
  agentTaskId?: string;
  /** Reachable programmatically but not offered as a segment (the agent task). */
  hidden?: boolean;
}

export interface WorkspaceProfile {
  /** Stable identifier; also the lookup key for built-in profiles. */
  id: string;
  labelZh: string;
  labelEn: string;
  /** Knowledge-base categories, in display order. Never empty. */
  categories: ProfileCategory[];
  /**
   * What the author can ask for, in display order. Never empty — a profile with
   * no tasks would render a panel that can't do anything.
   */
  tasks: TaskDef[];
  /**
   * Section-label overrides. Anything absent falls back to
   * `DEFAULT_SECTION_LABELS`, so a partial or hand-written profile still
   * produces a complete prompt.
   */
  sections: Partial<Record<SectionId, string>>;
  /** Which novel-shaped document machinery applies — see `DocModel`. */
  docModel: DocModel;
  /** i18n key of the system prompt used when no prompt is explicitly active. */
  systemPromptKey: string;
}

/** Novel behaviour: everything on. What a profile gets by saying nothing. */
export const DEFAULT_DOC_MODEL: DocModel = {
  ordered: true,
  priorContext: true,
  memory: true,
};

/**
 * The tasks every profile starts from — the four the app has always offered plus
 * the two freeform ones.
 *
 * These are shared rather than copied per profile because they are domain-neutral:
 * 续写/润色/改写/总结 mean the same thing for a chapter, a scene and a landing
 * page. A profile adds its own on top (see `COPY_PROFILE`) and can reorder or
 * drop them by declaring its own list.
 *
 * `continuation` implies `target: "append"`; `referenceWindow` goes with editing
 * an existing passage. Both mirror exactly what the hardcoded `TaskKind` branches
 * did, so the built-ins behave as they did before tasks became data.
 */
export const DEFAULT_TASKS: readonly TaskDef[] = [
  {
    id: "continue",
    labelKey: "ai.tasks.continue",
    descKey: "ai.tasks.continueDesc",
    instructionKey: "ai.instructions.continue",
    tools: "read",
    target: "append",
    continuation: true,
  },
  {
    id: "rewrite",
    labelKey: "ai.tasks.rewrite",
    descKey: "ai.tasks.rewriteDesc",
    instructionKey: "ai.instructions.rewrite",
    tools: "none",
    target: "replace",
    needsSelection: true,
    referenceWindow: true,
  },
  {
    id: "polish",
    labelKey: "ai.tasks.polish",
    descKey: "ai.tasks.polishDesc",
    instructionKey: "ai.instructions.polish",
    tools: "none",
    target: "replace",
    needsSelection: true,
    referenceWindow: true,
  },
  {
    id: "summary",
    labelKey: "ai.tasks.summary",
    descKey: "ai.tasks.summaryDesc",
    instructionKey: "ai.instructions.summary",
    tools: "none",
    // A summary is *about* the passage, so it must not overwrite it.
    target: "detached",
    needsSelection: true,
    referenceWindow: true,
  },
  {
    id: "custom",
    labelKey: "ai.tasks.customShort",
    tools: "none",
    target: "detached",
    freeform: true,
    agentTaskId: "agent",
  },
  {
    id: "agent",
    labelKey: "ai.tasks.agent",
    // A briefing prefix for the full toolset; the author's ask follows it.
    instructionKey: "ai.instructions.agent",
    tools: "full",
    target: "detached",
    freeform: true,
    // Reached through 自定义's Agent 模式 toggle, not as a segment of its own.
    hidden: true,
  },
];

/**
 * Fallback wording for every context block.
 *
 * These are the novel labels, which is why `NOVEL_PROFILE.sections` is empty:
 * the defaults *are* the novel phrasing. Other profiles override only what
 * genuinely differs, and a malformed profile.json still renders a sane prompt.
 */
export const DEFAULT_SECTION_LABELS: Record<SectionId, string> = {
  knowledge: "设定资料",
  additionalKnowledge: "附加知识",
  outline: "大纲/写作方向",
  priorAll: "全书前情",
  priorRecap: "前情提要",
  prevTail: "上一章结尾",
  recent: "近期内容",
  selection: "选中内容",
  requirement: "额外要求",
  currentFile: "当前文件",
};

/** 小说 — the original (and default) profile. */
export const NOVEL_PROFILE: WorkspaceProfile = {
  id: "novel",
  labelZh: "小说",
  labelEn: "Novel",
  categories: [
    { id: "characters", labelZh: "人物", labelEn: "Characters" },
    { id: "world", labelZh: "世界观", labelEn: "World" },
    { id: "factions", labelZh: "势力", labelEn: "Factions" },
    { id: "items", labelZh: "道具", labelEn: "Items" },
    { id: "skills", labelZh: "技能", labelEn: "Skills" },
    { id: "style", labelZh: "风格", labelEn: "Style" },
    { id: "custom", labelZh: "自定义", labelEn: "Custom" },
  ],
  sections: {},
  docModel: DEFAULT_DOC_MODEL,
  tasks: [...DEFAULT_TASKS],
  systemPromptKey: "ai.instructions.system",
};

/**
 * 跑团模组 — a tabletop RPG scenario.
 *
 * Structurally the closest neighbour to a novel: scenes run in order, earlier
 * scenes are context for later ones, so the whole spine/memory machinery
 * carries over untouched. What differs is the cast of the knowledge base
 * (locations and rules matter as much as NPCs), the wording of the context
 * blocks ("上一场景结尾", not "上一章结尾"), and a system prompt that writes for
 * a GM at the table rather than for a reader.
 */
export const TTRPG_PROFILE: WorkspaceProfile = {
  id: "ttrpg",
  labelZh: "跑团模组",
  labelEn: "TTRPG Module",
  categories: [
    { id: "npcs", labelZh: "NPC", labelEn: "NPCs" },
    { id: "locations", labelZh: "地点", labelEn: "Locations" },
    { id: "factions", labelZh: "势力", labelEn: "Factions" },
    { id: "items", labelZh: "道具", labelEn: "Items" },
    { id: "rules", labelZh: "规则", labelEn: "Rules" },
    { id: "hooks", labelZh: "剧情钩子", labelEn: "Hooks" },
    { id: "style", labelZh: "基调", labelEn: "Tone" },
    { id: "custom", labelZh: "自定义", labelEn: "Custom" },
  ],
  sections: {
    knowledge: "模组资料",
    outline: "大纲/推进方向",
    priorAll: "全模组前情",
    prevTail: "上一场景结尾",
  },
  // Scenes run in order and earlier ones are context for later ones, so the
  // whole spine/memory machinery carries over unchanged.
  docModel: DEFAULT_DOC_MODEL,
  tasks: [
    ...DEFAULT_TASKS,
    {
      id: "encounter",
      labelKey: "ai.tasks.encounter",
      descKey: "ai.tasks.encounterDesc",
      instructionKey: "ai.instructions.ttrpgEncounter",
      // Reads the module's own NPCs, locations and factions before writing —
      // an encounter that invents a rival when the module already has one is
      // worse than useless at the table. Costs the single-draft limit.
      tools: "read",
      target: "detached",
      // The author says what the encounter is *about* ("下水道，被跟踪"); the
      // built-in text is the briefing on what a usable encounter contains.
      freeform: true,
    },
    {
      id: "randomtable",
      labelKey: "ai.tasks.randomTable",
      descKey: "ai.tasks.randomTableDesc",
      instructionKey: "ai.instructions.ttrpgRandomTable",
      // Self-contained: a table of rumours or complications needs the brief and
      // the tone, not a lore sweep. Keeping it toolless is also what lets it fan
      // out — three tables to choose between is the normal way to use this.
      tools: "none",
      target: "detached",
      freeform: true,
    },
  ],
  systemPromptKey: "ai.instructions.systemTtrpg",
};

/**
 * 文案 — marketing / product copy.
 *
 * The first profile that is *not* book-shaped, and the reason `docModel` exists.
 * A landing page headline and a product description are independent pieces: they
 * have no order, nothing "precedes" one, and each fits in context whole. Leaving
 * the novel machinery on would spend budget recapping unrelated documents and
 * offer an outline view over a folder that has no sequence.
 *
 * The knowledge base carries over almost unchanged in shape — brand, product,
 * audience, competitors are exactly the kind of thing the lore/facet system is
 * good at, which is why this profile is mostly subtraction.
 */
export const COPY_PROFILE: WorkspaceProfile = {
  id: "copy",
  labelZh: "文案",
  labelEn: "Copywriting",
  categories: [
    { id: "brand", labelZh: "品牌", labelEn: "Brand" },
    { id: "products", labelZh: "产品", labelEn: "Products" },
    { id: "audience", labelZh: "受众", labelEn: "Audience" },
    { id: "competitors", labelZh: "竞品", labelEn: "Competitors" },
    { id: "style", labelZh: "调性", labelEn: "Voice" },
    { id: "custom", labelZh: "自定义", labelEn: "Custom" },
  ],
  sections: {
    knowledge: "品牌资料",
    outline: "写作要求",
    recent: "当前文案",
  },
  docModel: { ordered: false, priorContext: false, memory: false },
  // 续写 is dropped: a headline has nothing to continue from. The rest of the
  // shared set still applies to a piece of copy being edited.
  tasks: [
    ...DEFAULT_TASKS.filter((t) => t.id !== "continue"),
    {
      id: "headlines",
      labelKey: "ai.tasks.headlines",
      descKey: "ai.tasks.headlinesDesc",
      instructionKey: "ai.instructions.copyHeadlines",
      // Toolless, so it can fan out: the point of this task is having options,
      // and the drafts give *sets* of angles to compare, on top of the several
      // angles each response already contains.
      tools: "none",
      target: "detached",
      // Generates from a brief ("春季新品，主打通勤"); needs no existing text.
      freeform: true,
    },
    {
      id: "channel",
      labelKey: "ai.tasks.channel",
      descKey: "ai.tasks.channelDesc",
      instructionKey: "ai.instructions.copyChannel",
      tools: "none",
      // Detached rather than replace: adapting copy for another channel produces
      // an additional piece, and overwriting the original would lose the source
      // the author is adapting *from*.
      target: "detached",
      // Transforms a passage, so it needs one — and it is the first task to need
      // a selection without wanting the reference-window controls: the channel
      // comes from the author's own line, not from surrounding context.
      needsSelection: true,
      freeform: true,
    },
  ],
  systemPromptKey: "ai.instructions.systemCopy",
};

/**
 * 周报 — a recurring status report.
 *
 * Chronological rather than book-shaped, which is a real distinction the doc
 * model already draws: reports sit in date order and **last week's is the
 * context** (what did I say I would do?), but a single report is far too short
 * for rolling memory.
 */
export const WEEKLY_PROFILE: WorkspaceProfile = {
  id: "weekly",
  labelZh: "周报",
  labelEn: "Weekly Report",
  categories: [
    { id: "projects", labelZh: "项目", labelEn: "Projects" },
    { id: "people", labelZh: "相关方", labelEn: "Stakeholders" },
    { id: "metrics", labelZh: "指标", labelEn: "Metrics" },
    { id: "style", labelZh: "风格", labelEn: "Voice" },
    { id: "custom", labelZh: "自定义", labelEn: "Custom" },
  ],
  sections: {
    knowledge: "背景资料",
    outline: "本期要点",
    priorAll: "往期回顾",
    prevTail: "上期周报",
    recent: "当前草稿",
  },
  docModel: { ordered: true, priorContext: true, memory: false },
  tasks: [
    ...DEFAULT_TASKS.filter((t) => t.id !== "continue"),
    {
      id: "digest",
      labelKey: "ai.tasks.digest",
      descKey: "ai.tasks.digestDesc",
      instructionKey: "ai.instructions.weeklyDigest",
      // Toolless: the author supplies the week's raw material, so there is
      // nothing to go and find. Fans out, which is useful — two takes on the
      // same week differ mostly in what they choose to lead with.
      tools: "none",
      target: "detached",
      freeform: true,
    },
    {
      id: "carryover",
      labelKey: "ai.tasks.carryover",
      descKey: "ai.tasks.carryoverDesc",
      instructionKey: "ai.instructions.weeklyCarryover",
      // Read tools because it has to *find* the previous report: the
      // prior-document context only reaches continuation tasks, and this one
      // appends nothing. It locates the file itself via list_files/read_file.
      tools: "read",
      target: "detached",
      // Deliberately not freeform: it is useful with no input at all, and a
      // freeform task can't run on an empty box.
    },
  ],
  systemPromptKey: "ai.instructions.systemWeekly",
};

/**
 * 反馈报告 — synthesising raw user feedback into a report.
 *
 * The one domain whose main failure mode is not dullness but **overclaiming**:
 * "most users complain about X" when three of two hundred did is actively
 * harmful, and it reads exactly like a good finding. Both tasks and the system
 * prompt are built around that.
 *
 * Source material lives in a folder under `writing/` — that is the only tree
 * `list_files`/`search_text` can discover (`read_file` reaches the whole
 * project, but the model has to know a path first).
 */
export const FEEDBACK_PROFILE: WorkspaceProfile = {
  id: "feedback",
  labelZh: "反馈报告",
  labelEn: "Feedback Report",
  categories: [
    { id: "sources", labelZh: "来源", labelEn: "Sources" },
    { id: "segments", labelZh: "分群", labelEn: "Segments" },
    { id: "products", labelZh: "产品", labelEn: "Products" },
    { id: "metrics", labelZh: "指标", labelEn: "Metrics" },
    { id: "style", labelZh: "风格", labelEn: "Voice" },
    { id: "custom", labelZh: "自定义", labelEn: "Custom" },
  ],
  sections: {
    knowledge: "背景资料",
    outline: "报告要求",
    recent: "当前报告",
  },
  // Each report is independent: no order, nothing precedes one, and a report is
  // short enough to hold whole.
  docModel: { ordered: false, priorContext: false, memory: false },
  tasks: [
    ...DEFAULT_TASKS.filter((t) => t.id !== "continue"),
    {
      id: "themes",
      labelKey: "ai.tasks.themes",
      descKey: "ai.tasks.themesDesc",
      instructionKey: "ai.instructions.feedbackThemes",
      // Must actually read the corpus — a synthesis of feedback the model never
      // saw is the failure this whole profile is shaped against.
      tools: "read",
      target: "detached",
      freeform: true,
    },
    {
      id: "verify",
      labelKey: "ai.tasks.verify",
      descKey: "ai.tasks.verifyDesc",
      instructionKey: "ai.instructions.feedbackVerify",
      tools: "read",
      target: "detached",
      // Checks one claim in the draft, so it needs that claim selected. No
      // reference window: what it needs is the *sources*, not the surrounding
      // paragraphs.
      needsSelection: true,
    },
  ],
  systemPromptKey: "ai.instructions.systemFeedback",
};

/** Every built-in profile, in the order a picker should show them. */
export const BUILTIN_PROFILES: readonly WorkspaceProfile[] = [
  NOVEL_PROFILE,
  TTRPG_PROFILE,
  COPY_PROFILE,
  WEEKLY_PROFILE,
  FEEDBACK_PROFILE,
];

/** Look up a built-in profile by id, or null when the id isn't one. */
export function builtinProfile(id: string): WorkspaceProfile | null {
  return BUILTIN_PROFILES.find((p) => p.id === id) ?? null;
}

/** Category label in the active UI language. */
export function categoryLabel(cat: ProfileCategory, isZh: boolean): string {
  return isZh ? cat.labelZh : cat.labelEn;
}

/** Profile label in the active UI language. */
export function profileLabel(profile: WorkspaceProfile, isZh: boolean): string {
  return isZh ? profile.labelZh : profile.labelEn;
}

/**
 * A task's label: its i18n key when it has one, else its literal, else the id.
 *
 * `t` is passed in rather than imported so this module stays dependency-free —
 * it is also imported by the Rust-facing validation path and by tests that mock
 * i18n away. Every caller already has a translator to hand.
 */
export function taskLabel(
  task: TaskDef,
  isZh: boolean,
  t: (key: string) => string,
): string {
  if (task.labelKey) return t(task.labelKey);
  return (isZh ? task.labelZh : task.labelEn) || task.id;
}

/** Same resolution for the one-line description; empty when the task has none. */
export function taskDesc(
  task: TaskDef,
  isZh: boolean,
  t: (key: string) => string,
): string {
  if (task.descKey) return t(task.descKey);
  return (isZh ? task.descZh : task.descEn) ?? "";
}

// ─── Validation ──────────────────────────────────────────────────────────────
// profile.json is hand-editable data that decides *directory names*, so it is
// parsed defensively rather than trusted: a bad entry is dropped with an issue
// recorded, and a file that survives nothing at all falls back to a built-in.
// The Rust side re-validates before creating anything (scaffold_project) — this
// layer is convenience, not the security boundary.

/**
 * Category ids become folder names, so keep them to a portable slug.
 *
 * Exported so tests can assert against the rule itself rather than a copy that
 * could drift from it. `valid_category` in `src-tauri/src/commands.rs` mirrors
 * this deliberately — that side is the boundary, and the two must agree or a
 * category is created on disk and then dropped from the profile.
 */
export const CATEGORY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
/** i18n keys are dotted identifiers; anything else is a typo or worse. */
const PROMPT_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.]{0,79}$/;
const MAX_CATEGORIES = 24;
const MAX_LABEL_CHARS = 40;
/** Section labels are rendered inside 【】 in the prompt — keep them short. */
const MAX_SECTION_LABEL_CHARS = 20;

const SECTION_IDS = Object.keys(DEFAULT_SECTION_LABELS) as SectionId[];
const DOC_MODEL_KEYS = Object.keys(DEFAULT_DOC_MODEL) as (keyof DocModel)[];

function cleanLabel(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

/**
 * Validate one category. Returns null when it can't be used at all — an
 * unusable *label* falls back to the id, but an unusable *id* has no fallback
 * because it is the folder name.
 */
function parseCategory(raw: unknown, issues: string[]): ProfileCategory | null {
  if (!raw || typeof raw !== "object") {
    issues.push("category entry is not an object");
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  if (!CATEGORY_ID_RE.test(id)) {
    issues.push(`category id ${JSON.stringify(rec.id)} is not a valid folder name`);
    return null;
  }
  return {
    id,
    labelZh: cleanLabel(rec.labelZh, MAX_LABEL_CHARS) ?? id,
    labelEn: cleanLabel(rec.labelEn, MAX_LABEL_CHARS) ?? id,
  };
}

/**
 * Task ids are used as prompt-template `scene` keys and as the `task` column in
 * `token_usage`, so keep them to the same portable slug as categories.
 */
export const TASK_ID_RE = CATEGORY_ID_RE;
const MAX_TASKS = 16;
const TASK_TOOLS: TaskTools[] = ["none", "read", "full"];
const TASK_TARGETS: TaskTarget[] = ["append", "replace", "detached"];

function optionalFlag(value: unknown, name: string, issues: string[]): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value || undefined;
  issues.push(`task ${name} must be true or false`);
  return undefined;
}

/**
 * Validate one task. Null when it can't be used at all.
 *
 * `tools` is the field to be strict about: it decides whether a task can reach
 * the write tools, so an unrecognised value must not quietly widen access. It
 * has no safe default either — guessing `none` would silently break a task the
 * author meant to be agentic, and guessing `full` would hand it disk writes. So
 * the whole task is dropped.
 */
function parseTask(raw: unknown, issues: string[]): TaskDef | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    issues.push("task entry is not an object");
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  if (!TASK_ID_RE.test(id)) {
    issues.push(`task id ${JSON.stringify(rec.id)} is not a valid identifier`);
    return null;
  }
  const tools = rec.tools;
  if (!TASK_TOOLS.includes(tools as TaskTools)) {
    issues.push(`task "${id}" has an unknown tools value ${JSON.stringify(tools)}`);
    return null;
  }
  const target = rec.target;
  if (!TASK_TARGETS.includes(target as TaskTarget)) {
    issues.push(`task "${id}" has an unknown target ${JSON.stringify(target)}`);
    return null;
  }

  const task: TaskDef = { id, tools: tools as TaskTools, target: target as TaskTarget };

  for (const key of ["labelKey", "descKey", "instructionKey"] as const) {
    const value = rec[key];
    if (value === undefined) continue;
    if (typeof value === "string" && PROMPT_KEY_RE.test(value.trim())) task[key] = value.trim();
    else issues.push(`task "${id}" has an invalid ${key}`);
  }
  for (const key of ["labelZh", "labelEn", "descZh", "descEn"] as const) {
    const label = cleanLabel(rec[key], MAX_LABEL_CHARS);
    if (label) task[key] = label;
  }

  const continuation = optionalFlag(rec.continuation, "continuation", issues);
  if (continuation && task.target !== "append") {
    // Continuation *is* appending at an anchor; with any other target the panel
    // would offer bridge/length controls for a result that overwrites or floats.
    issues.push(`task "${id}" is a continuation but its target is "${task.target}" — ignoring`);
  } else if (continuation) {
    task.continuation = true;
  }

  const needsSelection = optionalFlag(rec.needsSelection, "needsSelection", issues);
  if (needsSelection) task.needsSelection = true;
  const referenceWindow = optionalFlag(rec.referenceWindow, "referenceWindow", issues);
  if (referenceWindow) task.referenceWindow = true;
  const freeform = optionalFlag(rec.freeform, "freeform", issues);
  if (freeform) task.freeform = true;
  const hidden = optionalFlag(rec.hidden, "hidden", issues);
  if (hidden) task.hidden = true;

  if (typeof rec.agentTaskId === "string" && TASK_ID_RE.test(rec.agentTaskId.trim())) {
    task.agentTaskId = rec.agentTaskId.trim();
  } else if (rec.agentTaskId !== undefined) {
    issues.push(`task "${id}" has an invalid agentTaskId`);
  }

  // A task with no instruction key and no freeform input has nothing to say to
  // the model — it would send context and an empty ask.
  if (!task.instructionKey && !task.freeform) {
    issues.push(`task "${id}" has neither an instructionKey nor freeform input`);
    return null;
  }
  return task;
}

export interface ParsedProfile {
  profile: WorkspaceProfile;
  /** Human-readable problems found while parsing; empty when the file was clean. */
  issues: string[];
}

/**
 * Turn parsed-JSON data into a usable profile.
 *
 * The file is read as a **patch on top of `fallback`**: any field it omits is
 * inherited. That is what lets `{"id":"ttrpg"}` be a complete, correct profile —
 * callers pass the built-in matching `data.id` when there is one (see
 * ./store), so a file naming a built-in and changing nothing resolves back to
 * that built-in exactly, section labels and all.
 */
export function parseProfile(data: unknown, fallback: WorkspaceProfile): ParsedProfile {
  const issues: string[] = [];
  // Arrays are objects in JS, and one here means the file is not a profile at all.
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { profile: fallback, issues: ["profile is not an object"] };
  }
  const rec = data as Record<string, unknown>;

  // Categories: drop the bad ones, and reject case-insensitive duplicates —
  // Windows would map "Items" and "items" onto one directory.
  //
  // Omitting `categories` entirely is not an error: it means "inherit", which is
  // what makes `{"id":"ttrpg"}` a complete profile. Only a list that was
  // *provided* and yielded nothing usable is worth complaining about — treating
  // the two alike would log a warning on every open of a perfectly good file.
  const categories: ProfileCategory[] = [];
  const seen = new Set<string>();
  const declaresCategories = rec.categories !== undefined;
  const rawCategories = Array.isArray(rec.categories) ? rec.categories : [];
  if (declaresCategories && !Array.isArray(rec.categories)) {
    issues.push("`categories` is not an array");
  }
  for (const raw of rawCategories) {
    if (categories.length >= MAX_CATEGORIES) {
      issues.push(`more than ${MAX_CATEGORIES} categories — the rest were ignored`);
      break;
    }
    const cat = parseCategory(raw, issues);
    if (!cat) continue;
    const key = cat.id.toLowerCase();
    if (seen.has(key)) {
      issues.push(`duplicate category id "${cat.id}"`);
      continue;
    }
    seen.add(key);
    categories.push(cat);
  }
  if (categories.length === 0) {
    if (declaresCategories) {
      issues.push(`no usable categories — falling back to the "${fallback.id}" profile`);
    }
    // Inherit the fallback's categories but keep this file's other fields, so a
    // profile can override just the section labels and leave the layout alone.
    categories.push(...fallback.categories);
  }

  // Tasks: same contract as categories — a declared-but-unusable list warns and
  // inherits, an omitted one inherits silently. Replacing rather than layering,
  // because a task list is an *ordered menu*: merging one entry into the
  // fallback's would put it in an arbitrary place, and there would be no way to
  // remove a task you don't want.
  const tasks: TaskDef[] = [];
  const seenTasks = new Set<string>();
  const declaresTasks = rec.tasks !== undefined;
  const rawTasks = Array.isArray(rec.tasks) ? rec.tasks : [];
  if (declaresTasks && !Array.isArray(rec.tasks)) issues.push("`tasks` is not an array");
  for (const raw of rawTasks) {
    if (tasks.length >= MAX_TASKS) {
      issues.push(`more than ${MAX_TASKS} tasks — the rest were ignored`);
      break;
    }
    const task = parseTask(raw, issues);
    if (!task) continue;
    if (seenTasks.has(task.id)) {
      issues.push(`duplicate task id "${task.id}"`);
      continue;
    }
    seenTasks.add(task.id);
    tasks.push(task);
  }
  // An `agentTaskId` pointing at a task this profile doesn't have would give the
  // panel a toggle that can't resolve — drop the pointer, keep the task.
  for (const task of tasks) {
    if (task.agentTaskId && !seenTasks.has(task.agentTaskId)) {
      issues.push(`task "${task.id}" points at unknown agentTaskId "${task.agentTaskId}"`);
      delete task.agentTaskId;
    }
  }
  if (tasks.length === 0) {
    if (declaresTasks) {
      issues.push(`no usable tasks — inheriting the "${fallback.id}" profile's`);
    }
    tasks.push(...fallback.tasks);
  }

  // Sections layer *over* the fallback's rather than replacing them, so a file
  // overriding one label keeps that profile's wording for the rest.
  //
  // Replacing wholesale looked defensible ("an author editing this block states
  // the full set they want") but wasn't: an unnamed section does not come out
  // blank, it falls through `sectionLabel` to `DEFAULT_SECTION_LABELS` — which
  // *are* the novel labels. So `{"id":"ttrpg","sections":{"outline":"…"}}`
  // prompted a TTRPG author with 【上一章结尾】/【设定资料】, exactly the
  // mislabelling profiles exist to prevent. An author who does want the shared
  // default for one section can still say so by setting it explicitly.
  const sections: Partial<Record<SectionId, string>> = { ...fallback.sections };
  if (rec.sections && typeof rec.sections === "object" && !Array.isArray(rec.sections)) {
    const rawSections = rec.sections as Record<string, unknown>;
    for (const key of Object.keys(rawSections)) {
      if (!SECTION_IDS.includes(key as SectionId)) {
        issues.push(`unknown section "${key}"`);
        continue;
      }
      const label = cleanLabel(rawSections[key], MAX_SECTION_LABEL_CHARS);
      if (!label) {
        issues.push(`section "${key}" has an unusable label`);
        continue;
      }
      sections[key as SectionId] = label;
    }
  } else if (rec.sections !== undefined) {
    issues.push("`sections` is not an object");
  }

  // docModel layers over the fallback's for the same reason sections do: a file
  // turning one flag off must keep that profile's answer for the other two.
  // Only real booleans count — a truthy string like "false" flipping a feature on
  // is the kind of thing a hand-edited JSON file produces.
  const docModel: DocModel = { ...fallback.docModel };
  if (rec.docModel && typeof rec.docModel === "object" && !Array.isArray(rec.docModel)) {
    const rawDoc = rec.docModel as Record<string, unknown>;
    for (const key of Object.keys(rawDoc)) {
      if (!DOC_MODEL_KEYS.includes(key as keyof DocModel)) {
        issues.push(`unknown docModel flag "${key}"`);
        continue;
      }
      const value = rawDoc[key];
      if (typeof value !== "boolean") {
        issues.push(`docModel.${key} must be true or false`);
        continue;
      }
      docModel[key as keyof DocModel] = value;
    }
  } else if (rec.docModel !== undefined) {
    issues.push("`docModel` is not an object");
  }
  // "Previous document" has no meaning without an order, and a profile asking
  // for one without the other would inject a bridge the outline can't resolve.
  if (docModel.priorContext && !docModel.ordered) {
    issues.push("docModel.priorContext needs ordered — disabling it");
    docModel.priorContext = false;
  }

  let systemPromptKey = fallback.systemPromptKey;
  if (typeof rec.systemPromptKey === "string") {
    const key = rec.systemPromptKey.trim();
    if (PROMPT_KEY_RE.test(key)) systemPromptKey = key;
    else issues.push(`systemPromptKey ${JSON.stringify(rec.systemPromptKey)} is not a valid i18n key`);
  }

  // Labels: inherit the fallback's when this file *is* that profile, otherwise
  // fall back to the id. Inheriting unconditionally would label a project named
  // "weekly" as 小说 just because the novel profile was the fallback.
  const id = cleanLabel(rec.id, MAX_LABEL_CHARS) ?? fallback.id;
  const inherits = id === fallback.id;
  return {
    profile: {
      id,
      labelZh: cleanLabel(rec.labelZh, MAX_LABEL_CHARS) ?? (inherits ? fallback.labelZh : id),
      labelEn: cleanLabel(rec.labelEn, MAX_LABEL_CHARS) ?? (inherits ? fallback.labelEn : id),
      categories,
      tasks,
      sections,
      docModel,
      systemPromptKey,
    },
    issues,
  };
}
