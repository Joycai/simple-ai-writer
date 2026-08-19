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
  /**
   * The category's **type schema**: which facets and which images entries of
   * this category are expected to have (外貌 / 组织架构 / 人设图…).
   *
   * Absent — never an empty array, see `parseCategory` — for a category with no
   * schema: every user-defined category, the `custom` bucket, and any category
   * whose declaring pack is currently disabled. That absence *is* the degraded
   * state a disabled pack falls back to, so every consumer must read "no
   * slots" as "an ordinary entry", never as an error.
   */
  slots?: FacetSlot[];
  imageSlots?: ImageSlot[];
}

/**
 * One **facet slot** of a category's schema — "外貌", "装扮", "组织架构".
 *
 * A slot is a *classification and a prompt hint*, never an injection rule: the
 * only facet fields `selectLore` reads are the file's own `keys` / `group` /
 * `priority` / `mode`, so a slot whose declaring pack got disabled costs the
 * author the grouping and the nudges — and changes what the model sees by not
 * one character. See `docs/lore-entry-type-plan.md` §4 for the invariants.
 */
export interface FacetSlot {
  /**
   * Stable id, written into a facet's `slot` frontmatter and (phase 3) offered
   * as a tool-schema enum value. Same portable slug rule as a category id
   * (`CATEGORY_ID_RE`): it has to survive as an unquoted YAML scalar and as a
   * JSON enum member.
   */
  id: string;
  labelZh: string;
  labelEn: string;
  /** What belongs in this facet — the AI checklists read it (phase 3). */
  hintZh?: string;
  hintEn?: string;
  /**
   * Entries of this category usually have this facet, so its absence is worth
   * pointing out. A nudge, never a validation — nothing refuses to save.
   */
  expected?: boolean;
  /**
   * What a *newly created* facet of this slot is pre-filled with.
   *
   * Nested rather than flattened on purpose: a flattened `mode`/`priority`
   * would read as "the slot's injection behaviour", and the whole design rests
   * on these being **materialised into the file at creation time** rather than
   * resolved from the schema at read time. Written out, the file keeps its full
   * injection semantics after the pack that suggested them is gone.
   */
  defaults?: FacetSlotDefaults;
}

/** The frontmatter a new facet of a slot starts with. See `FacetSlot.defaults`. */
export interface FacetSlotDefaults {
  mode?: "auto" | "always" | "manual";
  priority?: number;
  group?: string;
  keys?: string[];
}

/**
 * One **image slot** of a category's schema — 人设图 / 建筑图 / 概念图.
 *
 * No behaviour fields: gallery images are never conditionally injected, so a
 * slot here is only how the gallery groups them and what it asks the author for.
 */
export interface ImageSlot {
  id: string;
  labelZh: string;
  labelEn: string;
  hintZh?: string;
  hintEn?: string;
  expected?: boolean;
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
  // The novel pack is the only one carrying a type schema so far, on purpose:
  // the format proves itself on one real domain first, and the other packs get
  // their slot tables in phase 3 together with the prompts that consume them —
  // a checklist nothing reads yet is a half-built thing to show an author.
  // See docs/lore-entry-type-plan.md §6.
  categories: [
    {
      id: "characters",
      labelZh: "人物",
      labelEn: "Characters",
      slots: [
        {
          id: "appearance",
          labelZh: "外貌",
          labelEn: "Appearance",
          hintZh: "身形、发色、五官、气质——不随场景变化的那部分",
          hintEn: "Build, hair, features, bearing — the part that doesn't change per scene",
          expected: true,
        },
        {
          id: "outfit",
          labelZh: "装扮",
          labelEn: "Outfit",
          hintZh: "一套造型一条：便装、战甲、礼服。同组只会注入一套",
          hintEn: "One look per facet: casual, armour, formal. Only one of a group is injected",
          // Looks are mutually exclusive by nature, so a new one starts in the
          // group rather than needing the author to remember it.
          defaults: { group: "outfit" },
        },
        {
          id: "relations",
          labelZh: "人物关系",
          labelEn: "Relationships",
          hintZh: "与谁是什么关系、怎么称呼、有什么恩怨——写关系，不是写对方",
          hintEn: "Who they are to each other, how they address them, what stands between them",
          expected: true,
        },
        {
          id: "backstory",
          labelZh: "往事",
          labelEn: "Backstory",
          hintZh: "出身、转折、旧伤；只写会影响当下言行的部分",
          hintEn: "Origin, turning points, old wounds — only what still shapes present behaviour",
        },
        {
          id: "ability",
          labelZh: "能力",
          labelEn: "Abilities",
          hintZh: "战力、专长、限制；招式细节留给技能条目",
          hintEn: "Strength, specialities, limits — leave move-level detail to a skill entry",
        },
        {
          id: "voice",
          labelZh: "说话方式",
          labelEn: "Voice",
          hintZh: "口癖、语气、常用词——只要这个人物出场就该守住",
          hintEn: "Verbal tics, register, pet words — due whenever the character is on the page",
          // Voice has no trigger word of its own: it applies whenever the
          // character does, which is exactly what `always` means.
          defaults: { mode: "always" },
        },
      ],
      imageSlots: [
        {
          id: "portrait",
          labelZh: "人设图",
          labelEn: "Character sheet",
          hintZh: "全身或半身定妆，作为这个人物的基准形象",
          hintEn: "Full- or half-body reference — the baseline look",
          expected: true,
        },
        {
          id: "expression",
          labelZh: "表情",
          labelEn: "Expressions",
          hintZh: "情绪参考，一张一种",
          hintEn: "Emotion reference, one per image",
        },
        {
          id: "outfit",
          labelZh: "服装设定",
          labelEn: "Outfit design",
          hintZh: "造型三视或细节图，与「装扮」特征对应",
          hintEn: "Turnarounds or detail sheets, paired with the Outfit facet",
        },
      ],
    },
    {
      id: "world",
      labelZh: "世界观",
      labelEn: "World",
      slots: [
        {
          id: "geography",
          labelZh: "地理位置",
          labelEn: "Geography",
          hintZh: "在哪、周边有什么、气候、怎么进出",
          hintEn: "Where it is, what surrounds it, climate, how you get in and out",
          expected: true,
        },
        {
          id: "structure",
          labelZh: "结构布局",
          labelEn: "Layout",
          hintZh: "内部怎么分区、谁在哪一层——建筑与城邦都用它",
          hintEn: "How the inside is divided and who sits where — buildings and cities alike",
        },
        {
          id: "history",
          labelZh: "历史沿革",
          labelEn: "History",
          hintZh: "谁建的、发生过什么、留下了什么痕迹",
          hintEn: "Who built it, what happened here, what marks are left",
        },
        {
          id: "rules",
          labelZh: "运作规则",
          labelEn: "Rules",
          hintZh: "这地方的规矩、禁忌、日常秩序",
          hintEn: "Local rules, taboos, the order of an ordinary day",
        },
      ],
      imageSlots: [
        {
          id: "scene",
          labelZh: "场景概念图",
          labelEn: "Concept art",
          hintZh: "气氛与视角，一眼看出这是什么地方",
          hintEn: "Mood and vantage point — what the place feels like at a glance",
          expected: true,
        },
        {
          id: "building",
          labelZh: "建筑图",
          labelEn: "Architecture",
          hintZh: "平面/剖面/立面，说清空间关系",
          hintEn: "Plan, section, elevation — whatever makes the space legible",
        },
        {
          id: "map",
          labelZh: "地图",
          labelEn: "Map",
          hintZh: "位置与路线，标注比精美重要",
          hintEn: "Positions and routes; labels matter more than polish",
        },
      ],
    },
    {
      id: "factions",
      labelZh: "势力",
      labelEn: "Factions",
      slots: [
        {
          id: "structure",
          labelZh: "组织架构",
          labelEn: "Structure",
          hintZh: "层级、席位、谁向谁负责",
          hintEn: "Tiers, seats, who answers to whom",
          expected: true,
        },
        {
          id: "members",
          labelZh: "核心成员",
          labelEn: "Key members",
          hintZh: "关键人物与各自位置；人物细节留给人物条目",
          hintEn: "Who matters and where they sit — personal detail belongs to their own entry",
        },
        {
          id: "territory",
          labelZh: "势力范围",
          labelEn: "Territory",
          hintZh: "地盘、据点、影响力到哪为止",
          hintEn: "Ground held, strongholds, where the influence stops",
        },
        {
          id: "agenda",
          labelZh: "目标与手段",
          labelEn: "Agenda",
          hintZh: "要什么、怎么拿、底线在哪",
          hintEn: "What they want, how they take it, where the line is",
        },
      ],
      imageSlots: [
        {
          id: "emblem",
          labelZh: "徽记",
          labelEn: "Emblem",
          hintZh: "旗帜、纹章、制服上的识别标",
          hintEn: "Banner, crest, the mark on a uniform",
        },
        {
          id: "chart",
          labelZh: "组织架构图",
          labelEn: "Org chart",
          hintZh: "把层级画出来，比文字快",
          hintEn: "The hierarchy drawn — faster to read than prose",
        },
      ],
    },
    {
      id: "items",
      labelZh: "道具",
      labelEn: "Items",
      slots: [
        {
          id: "appearance",
          labelZh: "外形",
          labelEn: "Appearance",
          hintZh: "看上去什么样、拿在手里什么感觉",
          hintEn: "What it looks like and what it feels like in hand",
          expected: true,
        },
        {
          id: "effect",
          labelZh: "效果",
          labelEn: "Effect",
          hintZh: "能做什么、代价与限制",
          hintEn: "What it does, at what cost, within what limits",
        },
        {
          id: "origin",
          labelZh: "来历",
          labelEn: "Provenance",
          hintZh: "谁造的、经过谁的手、现在在哪",
          hintEn: "Who made it, whose hands it passed through, where it is now",
        },
      ],
      imageSlots: [
        {
          id: "concept",
          labelZh: "概念图",
          labelEn: "Concept art",
          hintZh: "外形与比例参考",
          hintEn: "Shape and scale reference",
        },
      ],
    },
    {
      id: "skills",
      labelZh: "技能",
      labelEn: "Skills",
      slots: [
        {
          id: "effect",
          labelZh: "效果",
          labelEn: "Effect",
          hintZh: "打出去是什么样、判定与范围",
          hintEn: "What it does on the page, its reach and its resolution",
          expected: true,
        },
        {
          id: "cost",
          labelZh: "代价",
          labelEn: "Cost",
          hintZh: "消耗、冷却、反噬——限制比威力更常被用到",
          hintEn: "Drain, cooldown, backlash — limits get used more often than power",
        },
        {
          id: "progression",
          labelZh: "进阶",
          labelEn: "Progression",
          hintZh: "怎么练上去、各阶段的差别",
          hintEn: "How it is trained up and how the stages differ",
        },
      ],
    },
    // 风格 is a bucket for tone samples, not a thing with parts — no schema.
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
  // Slots on the four categories whose entries are long enough to be worth
  // splitting; 规则/剧情钩子/基调 entries are single-purpose and stay plain.
  categories: [
    {
      id: "npcs",
      labelZh: "NPC",
      labelEn: "NPCs",
      slots: [
        {
          id: "appearance", labelZh: "外貌", labelEn: "Appearance",
          hintZh: "第一眼看到什么——给 GM 一句能直接念出来的描述",
          hintEn: "What the party sees first — one line the GM can read aloud",
          expected: true,
        },
        {
          id: "attitude", labelZh: "态度与动机", labelEn: "Attitude",
          hintZh: "想要什么、对玩家的初始态度、什么能说服他",
          hintEn: "What they want, how they start toward the party, what persuades them",
          expected: true,
        },
        {
          id: "stats", labelZh: "数据块", labelEn: "Stat block",
          hintZh: "战斗数值与特殊能力；只在真会打起来时才需要",
          hintEn: "Combat numbers and special abilities — only if a fight is possible",
          // A stat block is dead weight until the table rolls initiative.
          defaults: { mode: "auto", keys: ["战斗", "先手", "combat", "initiative"] },
        },
        {
          id: "knowledge", labelZh: "掌握的情报", labelEn: "What they know",
          hintZh: "能透露什么、要什么代价、什么绝不说",
          hintEn: "What they can reveal, at what price, and what they never say",
        },
      ],
      imageSlots: [
        { id: "portrait", labelZh: "立绘", labelEn: "Portrait", hintZh: "给玩家看的一张脸", hintEn: "A face to show the players", expected: true },
      ],
    },
    {
      id: "locations",
      labelZh: "地点",
      labelEn: "Locations",
      slots: [
        {
          id: "position", labelZh: "位置", labelEn: "Position",
          hintZh: "在哪、怎么到、路上多久",
          hintEn: "Where it is, how you get there, how long it takes",
          expected: true,
        },
        {
          id: "layout", labelZh: "布局", labelEn: "Layout",
          hintZh: "分区与通路——玩家会问「还能往哪走」",
          hintEn: "Areas and connections — the party will ask what else leads where",
          expected: true,
        },
        {
          id: "encounters", labelZh: "遭遇", labelEn: "Encounters",
          hintZh: "这里会遇到什么，含触发条件",
          hintEn: "What happens here, and what sets it off",
        },
        {
          id: "clues", labelZh: "线索", labelEn: "Clues",
          hintZh: "能在这里拿到的信息与物件",
          hintEn: "Information and objects available here",
        },
      ],
      imageSlots: [
        { id: "map", labelZh: "地图", labelEn: "Map", hintZh: "标注比精美重要", hintEn: "Labels matter more than polish", expected: true },
        { id: "scene", labelZh: "场景图", labelEn: "Scene art", hintZh: "推到桌上的那张气氛图", hintEn: "The mood shot you slide across the table" },
      ],
    },
    {
      id: "factions",
      labelZh: "势力",
      labelEn: "Factions",
      slots: [
        {
          id: "structure", labelZh: "组织架构", labelEn: "Structure",
          hintZh: "谁说话算数、层级、加入方式",
          hintEn: "Who speaks for it, the tiers, how one joins",
          expected: true,
        },
        {
          id: "stance", labelZh: "阵营态度", labelEn: "Stance",
          hintZh: "对玩家与其他势力的态度，以及什么会改变它",
          hintEn: "How it regards the party and the other factions, and what changes that",
          expected: true,
        },
        {
          id: "territory", labelZh: "势力范围", labelEn: "Territory",
          hintZh: "地盘、据点、影响力到哪为止",
          hintEn: "Ground held, strongholds, where the influence stops",
        },
      ],
    },
    {
      id: "items",
      labelZh: "道具",
      labelEn: "Items",
      slots: [
        {
          id: "appearance", labelZh: "外形", labelEn: "Appearance",
          hintZh: "拿到手上看到什么——玩家鉴定前就能知道的部分",
          hintEn: "What it looks like in hand — what the party knows before identifying it",
          expected: true,
        },
        {
          id: "effect", labelZh: "效果与规则", labelEn: "Effect",
          hintZh: "机制、判定、次数限制",
          hintEn: "Mechanics, rolls, uses per rest",
          expected: true,
        },
        {
          id: "origin", labelZh: "来历", labelEn: "Provenance",
          hintZh: "谁造的、怎么流落到这里",
          hintEn: "Who made it and how it ended up here",
        },
      ],
    },
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
    {
      id: "brand",
      labelZh: "品牌",
      labelEn: "Brand",
      slots: [
        {
          id: "story", labelZh: "品牌故事", labelEn: "Story",
          hintZh: "来历与主张——文案要引用的那几句",
          hintEn: "Origin and claim — the few lines copy quotes",
        },
        {
          id: "forbidden", labelZh: "禁区", labelEn: "Off-limits",
          hintZh: "不能说的话、不能碰的词、法务红线",
          hintEn: "Words and claims that are off the table, legal red lines",
          // A red line is due on every piece of copy, not only when it is
          // mentioned — which is exactly what `always` means.
          defaults: { mode: "always" },
        },
      ],
      imageSlots: [
        { id: "visual", labelZh: "视觉规范", labelEn: "Visual", hintZh: "标志、配色、版式示例", hintEn: "Logo, palette, layout samples" },
      ],
    },
    {
      id: "products",
      labelZh: "产品",
      labelEn: "Products",
      slots: [
        {
          id: "selling", labelZh: "卖点", labelEn: "Selling points",
          hintZh: "一条一句，按说服力排序",
          hintEn: "One line each, strongest first",
          expected: true,
        },
        {
          id: "spec", labelZh: "规格参数", labelEn: "Specs",
          hintZh: "能被核对的事实：尺寸、成分、兼容性",
          hintEn: "Checkable facts: size, materials, compatibility",
        },
        {
          id: "pricing", labelZh: "价格与套餐", labelEn: "Pricing",
          hintZh: "档位、优惠、有效期",
          hintEn: "Tiers, discounts, validity",
        },
      ],
      imageSlots: [
        { id: "product", labelZh: "产品图", labelEn: "Product shot", hintZh: "主图与细节图", hintEn: "Hero shot and details" },
      ],
    },
    {
      id: "audience",
      labelZh: "受众",
      labelEn: "Audience",
      slots: [
        {
          id: "profile", labelZh: "画像", labelEn: "Profile",
          hintZh: "是谁、在什么场景下看到这条文案",
          hintEn: "Who they are and where they meet this copy",
          expected: true,
        },
        {
          id: "pain", labelZh: "痛点", labelEn: "Pain points",
          hintZh: "他们自己会怎么说这个问题——用他们的词",
          hintEn: "How they would phrase the problem — in their words",
          expected: true,
        },
        {
          id: "objection", labelZh: "异议", labelEn: "Objections",
          hintZh: "不买的理由，以及能回应的事实",
          hintEn: "Reasons not to buy, and the facts that answer them",
        },
      ],
    },
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
    {
      id: "capabilities",
      labelZh: "业务能力",
      labelEn: "Capabilities",
      // 标书应答按点抽取，一个条目常常几千字：拆成面之后，一条应答只带它真正
      // 要引用的那一面，而不是把整份能力说明塞进上下文。
      slots: [
        {
          id: "scope", labelZh: "功能范围", labelEn: "Scope",
          hintZh: "做到什么程度，按招标条目的说法组织",
          hintEn: "What is covered, phrased the way the tender asks",
          expected: true,
        },
        {
          id: "integration", labelZh: "接口与集成", labelEn: "Integration",
          hintZh: "对外接口、协议、可对接的系统",
          hintEn: "Interfaces, protocols, systems it connects to",
        },
        {
          id: "compliance", labelZh: "合规与安全", labelEn: "Compliance",
          hintZh: "等保/密评/信创等可核验的结论与编号",
          hintEn: "Verifiable certifications and their reference numbers",
        },
        {
          id: "metrics", labelZh: "度量", labelEn: "Metrics",
          hintZh: "容量、性能、SLA——能写进承诺的数字",
          hintEn: "Capacity, performance, SLA — numbers you can commit to",
        },
      ],
    },
    { id: "implementation", labelZh: "技术实现", labelEn: "Implementation" },
    { id: "architecture", labelZh: "架构说明", labelEn: "Architecture" },
    { id: "boundaries", labelZh: "技术边界", labelEn: "Boundaries" },
    {
      id: "cases",
      labelZh: "项目案例",
      labelEn: "Cases",
      slots: [
        {
          id: "client", labelZh: "客户与规模", labelEn: "Client",
          hintZh: "行业、体量、合同年份——评标先看这些",
          hintEn: "Sector, size, contract year — what a reviewer checks first",
          expected: true,
        },
        {
          id: "delivery", labelZh: "交付范围", labelEn: "Delivery",
          hintZh: "实际交付的内容与周期",
          hintEn: "What was actually delivered, and over how long",
        },
        {
          id: "outcome", labelZh: "成效数据", labelEn: "Outcome",
          hintZh: "可引用的结果数字及其来源",
          hintEn: "Quotable result figures and where they come from",
        },
      ],
    },
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
    {
      id: "account",
      labelZh: "账号定位",
      labelEn: "Account",
      slots: [
        {
          id: "positioning", labelZh: "定位", labelEn: "Positioning",
          hintZh: "写给谁、解决什么、和同类号的差别",
          hintEn: "Who it is for, what it solves, how it differs",
          expected: true,
        },
        {
          id: "compliance", labelZh: "合规红线", labelEn: "Compliance",
          hintZh: "广告法用词、诱导分享、行业禁忌——每篇都要守",
          hintEn: "Ad-law wording, share-baiting, industry taboos — due on every article",
          // Not keyword-triggered: a red line applies to every draft.
          defaults: { mode: "always" },
        },
        {
          id: "columns", labelZh: "固定栏目", labelEn: "Columns",
          hintZh: "常设系列与各自的格式",
          hintEn: "Recurring series and the format each uses",
        },
      ],
    },
    {
      id: "audience",
      labelZh: "读者画像",
      labelEn: "Audience",
      slots: [
        {
          id: "profile", labelZh: "画像", labelEn: "Profile",
          hintZh: "是谁、什么时候刷到、读完想干什么",
          hintEn: "Who they are, when they scroll past, what they want next",
          expected: true,
        },
        {
          id: "language", labelZh: "他们的说法", labelEn: "Their words",
          hintZh: "读者自己的用词与梗——标题要用的就是这些",
          hintEn: "The words and in-jokes they use — headlines live here",
        },
      ],
    },
    {
      id: "topics",
      labelZh: "选题库",
      labelEn: "Topics",
      slots: [
        {
          id: "angle", labelZh: "切入角度", labelEn: "Angle",
          hintZh: "同一个题材可以怎么写，一条一个角度",
          hintEn: "Ways into the same subject, one per facet",
          expected: true,
        },
        {
          id: "evidence", labelZh: "素材与依据", labelEn: "Evidence",
          hintZh: "数据、案例、引文及其出处",
          hintEn: "Figures, cases, quotes — with where each came from",
        },
      ],
    },
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
/** Schema size caps — a category schema is a checklist, not a database. */
const MAX_SLOTS = 12;
const MAX_IMAGE_SLOTS = 8;
/** Suggested trigger words per slot, capped like a facet's own key list. */
const MAX_SLOT_KEYS = 8;
/** Slot hints are pasted into prompts, so they pay per character. */
const MAX_HINT_CHARS = 120;
const FACET_MODES = ["auto", "always", "manual"] as const;
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
 * The id + labels every slot has. Null when unusable: like a category, a bad
 * *label* falls back to the id, but a bad *id* has no fallback — it is what
 * ends up in a facet's frontmatter and in a tool-schema enum.
 */
function parseSlotBase(
  raw: unknown,
  what: string,
  issues: string[],
): Omit<FacetSlot, "defaults"> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    issues.push(`${what} entry is not an object`);
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  if (!CATEGORY_ID_RE.test(id)) {
    issues.push(`${what} id ${JSON.stringify(rec.id)} is not a valid slot id`);
    return null;
  }
  // The base shape is exactly an `ImageSlot`; a facet slot adds `defaults`.
  const slot: Omit<FacetSlot, "defaults"> = {
    id,
    labelZh: cleanLabel(rec.labelZh, MAX_LABEL_CHARS) ?? id,
    labelEn: cleanLabel(rec.labelEn, MAX_LABEL_CHARS) ?? id,
  };
  // Hints and `expected` are omitted when absent or unusable rather than
  // defaulted, so a schema-less category and a schema whose optional fields
  // were left out serialise (and compare) identically.
  const hintZh = cleanLabel(rec.hintZh, MAX_HINT_CHARS);
  if (hintZh) slot.hintZh = hintZh;
  const hintEn = cleanLabel(rec.hintEn, MAX_HINT_CHARS);
  if (hintEn) slot.hintEn = hintEn;
  if (rec.expected === true) slot.expected = true;
  else if (rec.expected !== undefined && rec.expected !== false) {
    issues.push(`${what} "${id}" expected must be true or false`);
  }
  return slot;
}

/**
 * `FacetSlot.defaults` — what a new facet of this slot is pre-filled with.
 * Undefined when nothing usable was declared, which is also what an entirely
 * absent `defaults` yields: there is no such thing as an empty default set.
 */
function parseSlotDefaults(
  raw: unknown,
  slotId: string,
  issues: string[],
): FacetSlotDefaults | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    issues.push(`facet slot "${slotId}" defaults is not an object`);
    return undefined;
  }
  const rec = raw as Record<string, unknown>;
  const out: FacetSlotDefaults = {};

  if (rec.mode !== undefined) {
    if (typeof rec.mode === "string" && (FACET_MODES as readonly string[]).includes(rec.mode)) {
      out.mode = rec.mode as FacetSlotDefaults["mode"];
    } else {
      issues.push(`facet slot "${slotId}" defaults.mode must be one of ${FACET_MODES.join(" / ")}`);
    }
  }
  if (rec.priority !== undefined) {
    const priority = Number(rec.priority);
    if (Number.isFinite(priority)) out.priority = priority;
    else issues.push(`facet slot "${slotId}" defaults.priority must be a number`);
  }
  if (rec.group !== undefined) {
    const group = cleanLabel(rec.group, MAX_LABEL_CHARS);
    if (group) out.group = group;
    else issues.push(`facet slot "${slotId}" defaults.group is not a usable group name`);
  }
  if (rec.keys !== undefined) {
    if (Array.isArray(rec.keys)) {
      // Cleaned and deduped *before* the cap, so the cap counts keys that will
      // actually be written rather than being eaten by repeats and blanks.
      const keys: string[] = [];
      for (const entry of rec.keys) {
        const key = cleanLabel(entry, MAX_LABEL_CHARS);
        if (key && !keys.includes(key)) keys.push(key);
      }
      if (keys.length > MAX_SLOT_KEYS) {
        issues.push(`facet slot "${slotId}" declares more than ${MAX_SLOT_KEYS} default keys — the rest were ignored`);
        keys.length = MAX_SLOT_KEYS;
      }
      if (keys.length > 0) out.keys = keys;
    } else {
      issues.push(`facet slot "${slotId}" defaults.keys is not an array`);
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function parseFacetSlot(raw: unknown, issues: string[]): FacetSlot | null {
  const base = parseSlotBase(raw, "facet slot", issues);
  if (!base) return null;
  const defaults = parseSlotDefaults((raw as Record<string, unknown>).defaults, base.id, issues);
  return defaults ? { ...base, defaults } : base;
}

function parseImageSlot(raw: unknown, issues: string[]): ImageSlot | null {
  return parseSlotBase(raw, "image slot", issues);
}

/**
 * One slot list of a category schema. Case-insensitive duplicate ids are
 * rejected for the same reason category ids are (Windows-proof matching, and a
 * facet's `slot` is resolved case-insensitively).
 */
function parseSlotList<T extends { id: string }>(
  raw: unknown,
  what: string,
  max: number,
  parseOne: (raw: unknown, issues: string[]) => T | null,
  issues: string[],
): T[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push(`${what}s is not an array`);
    return [];
  }
  const out: T[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (out.length >= max) {
      issues.push(`more than ${max} ${what}s — the rest were ignored`);
      break;
    }
    const slot = parseOne(entry, issues);
    if (!slot) continue;
    const key = slot.id.toLowerCase();
    if (seen.has(key)) {
      issues.push(`duplicate ${what} id "${slot.id}"`);
      continue;
    }
    seen.add(key);
    out.push(slot);
  }
  return out;
}

/**
 * Validate one category. Returns null when it can't be used at all — an
 * unusable *label* falls back to the id, but an unusable *id* has no fallback
 * because it is the folder name.
 *
 * The type schema (`slots` / `imageSlots`) is only attached when non-empty:
 * "has no schema" must be the *absence* of the key, so a plain category still
 * compares and serialises exactly as it did before schemas existed (and old
 * builds, whose parser drops keys it doesn't know, keep reading these files).
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
  const category: ProfileCategory = {
    id,
    labelZh: cleanLabel(rec.labelZh, MAX_LABEL_CHARS) ?? id,
    labelEn: cleanLabel(rec.labelEn, MAX_LABEL_CHARS) ?? id,
  };
  const slots = parseSlotList(rec.slots, "facet slot", MAX_SLOTS, parseFacetSlot, issues);
  if (slots.length > 0) category.slots = slots;
  const imageSlots = parseSlotList(rec.imageSlots, "image slot", MAX_IMAGE_SLOTS, parseImageSlot, issues);
  if (imageSlots.length > 0) category.imageSlots = imageSlots;
  return category;
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
