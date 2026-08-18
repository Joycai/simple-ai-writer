/**
 * Capability packs — the per-project "what can I ask for" declaration.
 *
 * A pack is purely **additive**: it contributes predefined tasks (标书应答,
 * 小说续写…) and knowledge-base categories (which are also the
 * `.ai-writer/lore/` folder layout), and may reword the 【…】 context-block
 * labels *for its own tasks*. It does not own the app's vocabulary, the
 * document model, or the AI's persona — those are app-level and uniform, so a
 * project with no packs at all is a perfectly usable "knowledge base + neutral
 * tasks" workspace. There used to be a "primary pack" that decided those
 * dimensions; it was removed because it made packs unequal and made the agent
 * assume a domain role the author never asked for. Adding a new kind of
 * writing is still a new pack, not a new branch in `TaskKind`.
 *
 * A project's pack selection (plus its user-defined categories) is stored at
 * `.ai-writer/profile.json` (see ./store). The novel pack is the default, so
 * every project that predates this file keeps its categories and task menu.
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
 * What shape a project's documents have.
 *
 * Since packs became purely additive this is **app-level and always all-on**
 * (`DEFAULT_DOC_MODEL`): every project gets the spine, the prior-document
 * bridge and rolling memory, and simply doesn't use what it doesn't need.
 * The type (and the `docModel()` accessor) survives as the seam a future
 * per-project setting would plug into — consumers keep reading flags instead
 * of assuming them.
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
 * The UI-side vocabulary — what a document, a folder of them, and the
 * knowledge base are *called* on screen and inside prompt templates.
 *
 * App-level and uniform since packs became additive: every project's knowledge
 * store is a 知识库, every file a 文档, whatever packs are enabled. Packs used
 * to override these (章节/卷/设定库 for a novel, 企业知识库 for bids), which
 * required a "primary pack" to arbitrate; uniform wording is what lets that
 * concept go.
 *
 *   - `doc`         what one document is called: 文档
 *   - `group`       what a folder of them is called: 分组
 *   - `kb`          the knowledge base's display name: 知识库
 *   - `entry`       one knowledge-base entry, in counts and chips: 条目
 *   - `filesHeader` the sidebar file-panel header
 *   - `emptyEyebrow` the decorative eyebrow on an empty document
 */
export type TermId = "doc" | "group" | "kb" | "entry" | "filesHeader" | "emptyEyebrow";

/**
 * One term, per language. English needs a plural for count contexts
 * ("3 chapters"); `enPlural` defaults to `en + "s"`. Chinese has no plural.
 */
export interface TermLabel {
  zh: string;
  en: string;
  enPlural?: string;
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
   * Offers a batch mode: run this task once per clause of the open document
   * (split by headings/numbering), assembling results into an output file.
   * Only meaningful for selection-driven tasks — the batch runner feeds each
   * clause through the selection slot. See stores/batchStore.
   */
  batch?: boolean;
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
  /**
   * The knowledge-base categories this pack contributes, in display order.
   * May be empty for a pack that only brings tasks. The app-level `custom`
   * category always exists regardless (see resolve.ts), so no pack declares it.
   */
  categories: ProfileCategory[];
  /**
   * The tasks this pack contributes, in display order. A task whose id matches
   * one of `DEFAULT_TASKS` *overrides* that base task (typically to re-point
   * its instruction at domain wording — see `NOVEL_PROFILE`); any other id is
   * appended to the menu as this pack's own entry.
   */
  tasks: TaskDef[];
  /**
   * Section-label overrides, applied only when assembling *this pack's* tasks.
   * Anything absent falls back to `DEFAULT_SECTION_LABELS`, so a partial or
   * hand-written pack still produces a complete prompt. `knowledge` is
   * deliberately never overridden by built-ins: the knowledge base is called
   * 知识库 everywhere.
   */
  sections: Partial<Record<SectionId, string>>;
}

/** The app-level document model: everything on, for every project. */
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
    // HTML 工件：图示/架构图/宣传页 as a self-contained .html deliverable —
    // the one-click entry the plan's 三期 promised (docs/html-artifact-plan.md).
    // Freeform + full toolset: the author describes the page, the agent reads
    // the material and proposes it via create_file (L2 approval).
    id: "htmlArtifact",
    labelKey: "ai.tasks.htmlArtifact",
    descKey: "ai.tasks.htmlArtifactDesc",
    instructionKey: "ai.instructions.htmlArtifact",
    tools: "full",
    target: "detached",
    freeform: true,
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
 * Fallback wording for every context block — deliberately domain-neutral.
 * A pack overrides only what genuinely differs for its own tasks (novel says
 * 全书前情/上一章结尾), and a malformed profile.json still renders a sane
 * prompt. `knowledge` is the uniform knowledge-base name and is not overridden.
 */
export const DEFAULT_SECTION_LABELS: Record<SectionId, string> = {
  knowledge: "知识库",
  additionalKnowledge: "附加知识",
  outline: "大纲/写作方向",
  priorAll: "前文回顾",
  priorRecap: "前情提要",
  prevTail: "上一篇结尾",
  recent: "近期内容",
  selection: "选中内容",
  requirement: "额外要求",
  currentFile: "当前文件",
};

/** The one app-level vocabulary. Uniform across projects — see `TermId`. */
export const DEFAULT_TERMS: Record<TermId, TermLabel> = {
  doc: { zh: "文档", en: "document" },
  group: { zh: "分组", en: "group" },
  kb: { zh: "知识库", en: "Knowledge Base" },
  entry: { zh: "条目", en: "entry", enPlural: "entries" },
  filesHeader: { zh: "DOCUMENTS · 文档", en: "DOCUMENTS" },
  emptyEyebrow: { zh: "新篇 · NEW DOCUMENT", en: "NEW DOCUMENT" },
};

/**
 * The terms in one UI language, plurals included. What components consume —
 * see `useTerms()` in stores/projectStore.
 */
export interface ResolvedTerms {
  doc: string;
  docs: string;
  group: string;
  groups: string;
  kb: string;
  entry: string;
  entries: string;
  filesHeader: string;
  emptyEyebrow: string;
}

/** The app vocabulary in one UI language, plurals included. */
export function appTerms(isZh: boolean): ResolvedTerms {
  const get = (id: TermId): TermLabel => DEFAULT_TERMS[id];
  const one = (id: TermId): string => (isZh ? get(id).zh : get(id).en);
  const many = (id: TermId): string => {
    const term = get(id);
    return isZh ? term.zh : term.enPlural ?? `${term.en}s`;
  };
  return {
    doc: one("doc"),
    docs: many("doc"),
    group: one("group"),
    groups: many("group"),
    kb: one("kb"),
    entry: one("entry"),
    entries: many("entry"),
    filesHeader: one("filesHeader"),
    emptyEyebrow: one("emptyEyebrow"),
  };
}

/** 小说 — the original (and default) pack. */
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
  ],
  sections: {
    priorAll: "全书前情",
    prevTail: "上一章结尾",
  },
  // Base-task overrides: the shared instructions are domain-neutral, so the
  // novel pack re-points three of them at the original fiction wording —
  // 情节、人物、世界规则 — and novel projects keep behaving as they did.
  tasks: DEFAULT_TASKS.filter((t) =>
    ["continue", "rewrite", "summary"].includes(t.id),
  ).map((t) =>
    t.id === "continue" ? { ...t, instructionKey: "ai.instructions.continueNovel" }
    : t.id === "rewrite" ? { ...t, instructionKey: "ai.instructions.rewriteNovel" }
    : { ...t, instructionKey: "ai.instructions.summaryNovel" },
  ),
};

/**
 * 跑团模组 — a tabletop RPG scenario.
 *
 * Structurally the closest neighbour to a novel: scenes run in order, earlier
 * scenes are context for later ones. What differs is the cast of the knowledge
 * base (locations and rules matter as much as NPCs), the wording of the
 * context blocks ("上一场景结尾", not "上一章结尾"), and tasks that write for
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
  ],
  sections: {
    outline: "大纲/推进方向",
    priorAll: "全模组前情",
    prevTail: "上一场景结尾",
  },
  tasks: [
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
};

/**
 * 文案 — marketing / product copy.
 *
 * The knowledge base carries over almost unchanged in shape — brand, product,
 * audience, competitors are exactly the kind of thing the lore/facet system is
 * good at — so this pack is categories plus two option-generating tasks.
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
  ],
  sections: {
    outline: "写作要求",
    recent: "当前文案",
  },
  tasks: [
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
};

/**
 * 周报 — a recurring status report.
 *
 * Reports sit in date order and **last week's is the context** (what did I
 * say I would do?), which is what the 对照上期 task is for.
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
  ],
  sections: {
    outline: "本期要点",
    priorAll: "往期回顾",
    prevTail: "上期周报",
    recent: "当前草稿",
  },
  tasks: [
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
};

/**
 * 反馈报告 — synthesising raw user feedback into a report.
 *
 * The one domain whose main failure mode is not dullness but **overclaiming**:
 * "most users complain about X" when three of two hundred did is actively
 * harmful, and it reads exactly like a good finding. Both tasks are built
 * around that.
 *
 * Source material lives in any folder in the workspace —
 * `list_files`/`search_text` discover the whole project tree (only the app's
 * `.ai-writer` data is off-limits).
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
  ],
  sections: {
    outline: "报告要求",
    recent: "当前报告",
  },
  tasks: [
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
};

/**
 * 标书应答 — a point-by-point bid/tender response for SaaS or software.
 *
 * Like 反馈报告, the domain's failure mode is overclaiming — but here a
 * fabricated capability doesn't just mislead, it goes into a contract and
 * becomes an acceptance criterion. So the domain tasks are built around
 * grounding: every response states its deviation verdict (正/负偏差), cites
 * the knowledge-base entries it rests on, and marks what the knowledge base
 * cannot support instead of writing it as compliant.
 *
 * The knowledge base is also the *product* of the work, not just its input:
 * 提取入库 runs the full write-capable toolset (plan-gated) to fold what a bid
 * taught us — requirements, confirmed capability wording, boundaries — back
 * into lore for the next bid.
 */
export const BID_PROFILE: WorkspaceProfile = {
  id: "bid",
  labelZh: "标书应答",
  labelEn: "Bid Response",
  categories: [
    { id: "capabilities", labelZh: "业务能力", labelEn: "Capabilities" },
    { id: "implementation", labelZh: "技术实现", labelEn: "Implementation" },
    { id: "architecture", labelZh: "架构说明", labelEn: "Architecture" },
    { id: "boundaries", labelZh: "技术边界", labelEn: "Boundaries" },
    { id: "cases", labelZh: "项目案例", labelEn: "Cases" },
    { id: "qualifications", labelZh: "资质证书", labelEn: "Qualifications" },
    { id: "style", labelZh: "措辞风格", labelEn: "Voice" },
  ],
  sections: {
    outline: "应答大纲",
    recent: "当前应答",
  },
  tasks: [
    {
      id: "respond",
      labelKey: "ai.tasks.respond",
      descKey: "ai.tasks.respondDesc",
      instructionKey: "ai.instructions.bidRespond",
      // Must actually look the capability up — a response written from industry
      // intuition is the failure this whole profile is shaped against.
      tools: "read",
      target: "detached",
      // The selection is the tender clause being answered; the reference window
      // brings the surrounding clauses plus the extra-requirement box for
      // format/length constraints from the tender's response rules.
      needsSelection: true,
      referenceWindow: true,
      // A tender has dozens of clauses; batch mode answers them all in one
      // sweep (one full pipeline run per clause) into an output document.
      batch: true,
    },
    {
      id: "deviation",
      labelKey: "ai.tasks.deviation",
      descKey: "ai.tasks.deviationDesc",
      instructionKey: "ai.instructions.bidDeviation",
      tools: "read",
      target: "detached",
      // Audits one response passage against the knowledge base, so it needs
      // that passage selected. No reference window: what it needs is the
      // *entries*, not the surrounding paragraphs.
      needsSelection: true,
    },
    {
      id: "extract",
      labelKey: "ai.tasks.extract",
      descKey: "ai.tasks.extractDesc",
      instructionKey: "ai.instructions.bidExtract",
      // The knowledge-base write path: reads the material, then goes through
      // propose_lore_plan before any entry is touched.
      tools: "full",
      target: "detached",
      // The author scopes the sweep ("把标书第3章的技术要求提炼入库") — with no
      // scope the agent would have to guess which file is the material.
      freeform: true,
    },
  ],
};

/**
 * 微信公众号 — articles for a WeChat Official Account.
 *
 * What is genuinely different about the domain is that the *packaging* is half
 * the work. A WeChat article lives or dies on two numbers the author can
 * actually move — 打开率 (the title) and 完读率 (the opening) — so those get
 * tasks of their own rather than being left to 自定义. And 合规 is not optional
 * decoration: 广告法 absolute superlatives, medical/financial claims and
 * 诱导分享 get articles deleted or the account restricted, which is why 合规红线
 * is a knowledge-base category and the audit is a task that reads it.
 */
export const WECHAT_PROFILE: WorkspaceProfile = {
  id: "wechat",
  labelZh: "微信公众号",
  labelEn: "WeChat Article",
  categories: [
    { id: "account", labelZh: "账号定位", labelEn: "Account" },
    { id: "audience", labelZh: "读者画像", labelEn: "Audience" },
    { id: "topics", labelZh: "选题库", labelEn: "Topics" },
    { id: "products", labelZh: "产品服务", labelEn: "Products" },
    { id: "references", labelZh: "对标爆款", labelEn: "References" },
    { id: "style", labelZh: "文风", labelEn: "Voice" },
    // Not a nicety: an article that trips 广告法 or 诱导分享 gets deleted, so
    // the red lines are material the audit task has to be able to look up.
    { id: "compliance", labelZh: "合规红线", labelEn: "Compliance" },
  ],
  sections: {
    outline: "写作要求",
    recent: "当前文章",
  },
  tasks: [
    {
      id: "topic",
      labelKey: "ai.tasks.topic",
      descKey: "ai.tasks.topicDesc",
      instructionKey: "ai.instructions.wechatTopic",
      // Read tools because the failure mode is proposing an angle the account
      // already published: it has to list the existing articles and the 选题库
      // itself, which no amount of injected context can substitute for. Costs
      // the fan-out, but one run already returns a spread of angles.
      tools: "read",
      target: "detached",
      // The author gives the direction ("聊远程办公，偏职场向"); with no scope
      // the task would have to guess what the account is about this week.
      freeform: true,
    },
    {
      id: "titles",
      labelKey: "ai.tasks.titles",
      descKey: "ai.tasks.titlesDesc",
      instructionKey: "ai.instructions.wechatTitles",
      // Toolless, so it fans out: the point is having options, and the drafts
      // give *sets* of angles to compare on top of the several in each response.
      tools: "none",
      target: "detached",
      // Deliberately not freeform: by the time you need titles the article is
      // written and sits in 【当前文章】, and a freeform task can't run on an
      // empty box — it would force the author to retype the gist.
    },
    {
      id: "hook",
      labelKey: "ai.tasks.hook",
      descKey: "ai.tasks.hookDesc",
      instructionKey: "ai.instructions.wechatHook",
      tools: "none",
      // Detached rather than replace: the author compares openings and inserts
      // one, so overwriting the existing opening would lose what it's competing
      // against.
      target: "detached",
    },
    {
      id: "compliance",
      labelKey: "ai.tasks.compliance",
      descKey: "ai.tasks.complianceDesc",
      instructionKey: "ai.instructions.wechatCompliance",
      // Must actually read the 合规红线 entries — a check run from general
      // memory of 广告法 flags the wrong words and misses the account's own
      // accumulated rules.
      tools: "read",
      target: "detached",
      // Not freeform and no selection: it audits the whole open article, which
      // is the only useful scope for this — a red line missed in the paragraph
      // you didn't select is exactly as fatal.
    },
  ],
};

/** Every built-in profile, in the order a picker should show them. */
export const BUILTIN_PROFILES: readonly WorkspaceProfile[] = [
  NOVEL_PROFILE,
  TTRPG_PROFILE,
  COPY_PROFILE,
  WECHAT_PROFILE,
  WEEKLY_PROFILE,
  FEEDBACK_PROFILE,
  BID_PROFILE,
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
export const MAX_CATEGORIES = 24;
const MAX_LABEL_CHARS = 40;
/** Section labels are rendered inside 【】 in the prompt — keep them short. */
const MAX_SECTION_LABEL_CHARS = 20;

const SECTION_IDS = Object.keys(DEFAULT_SECTION_LABELS) as SectionId[];
/**
 * Fields a pack used to carry before packs became purely additive. A file
 * declaring one is old (or copied from an old example), not wrong — the field
 * is ignored with a note rather than an error.
 */
const RETIRED_PROFILE_KEYS = ["terms", "docModel", "systemPromptKey"] as const;

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
 * Derive a usable category id (a folder name) from an author-typed label.
 *
 * A latin label slugs down to itself ("Meeting Notes" → "meeting-notes"); a
 * CJK label has nothing the folder-name rule can keep, so it falls back to a
 * neutral `kb` stem. Either way the result is numbered past anything in
 * `taken` (case-insensitive, matching the merge's Windows-proof dedupe).
 */
export function suggestCategoryId(label: string, taken: Iterable<string>): string {
  const existing = new Set<string>();
  for (const id of taken) existing.add(id.toLowerCase());
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 32);
  const base = CATEGORY_ID_RE.test(slug) ? slug : "kb";
  if (!existing.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!existing.has(id)) return id;
  }
}

/**
 * Validate a standalone category list — the project's user-defined categories
 * in a v3 profile.json (a top-level `categories`, not part of any pack). Bad
 * entries are dropped with an issue; case-insensitive duplicates are rejected
 * for the same Windows reason as in `parseProfile`.
 */
export function parseCategoryList(raw: unknown, issues: string[]): ProfileCategory[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push("`categories` is not an array");
    return [];
  }
  const categories: ProfileCategory[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (categories.length >= MAX_CATEGORIES) {
      issues.push(`more than ${MAX_CATEGORIES} categories — the rest were ignored`);
      break;
    }
    const cat = parseCategory(entry, issues);
    if (!cat) continue;
    const key = cat.id.toLowerCase();
    if (seen.has(key)) {
      issues.push(`duplicate category id "${cat.id}"`);
      continue;
    }
    seen.add(key);
    categories.push(cat);
  }
  return categories;
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
  const batch = optionalFlag(rec.batch, "batch", issues);
  if (batch) task.batch = true;

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
  // Omitting `categories` entirely means "inherit", which is what makes
  // `{"id":"ttrpg"}` a complete pack. A declared empty list is *valid* now that
  // packs are additive — a pack may bring only tasks. Only a list that was
  // provided non-empty and yielded nothing usable is worth complaining about.
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
  // A declared, well-formed, empty list is deliberate (a tasks-only pack);
  // anything else that yielded nothing — omitted, malformed, or all-dropped —
  // inherits the fallback's.
  const deliberatelyEmptyCategories =
    Array.isArray(rec.categories) && rec.categories.length === 0;
  if (categories.length === 0 && !deliberatelyEmptyCategories) {
    if (declaresCategories) {
      issues.push(`no usable categories — inheriting the "${fallback.id}" pack's`);
    }
    // Inherit the fallback's categories but keep this file's other fields, so a
    // pack can override just the section labels and leave the layout alone.
    categories.push(...fallback.categories);
  }

  // Tasks: same contract as categories — omitted inherits silently, a declared
  // empty list is valid (a categories-only pack), and a declared list that
  // yielded nothing usable warns and inherits. Replacing rather than layering,
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
  const deliberatelyEmptyTasks = Array.isArray(rec.tasks) && rec.tasks.length === 0;
  if (tasks.length === 0 && !deliberatelyEmptyTasks) {
    if (declaresTasks) {
      issues.push(`no usable tasks — inheriting the "${fallback.id}" pack's`);
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

  // Fields packs no longer carry (vocabulary, doc model, persona) are ignored
  // with a note: the app owns those dimensions now, and silently eating the
  // field would leave the author wondering why their wording never shows up.
  for (const key of RETIRED_PROFILE_KEYS) {
    if (rec[key] !== undefined) {
      issues.push(`\`${key}\` is no longer part of a pack — packs only add tasks and categories; ignored`);
    }
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
    },
    issues,
  };
}
