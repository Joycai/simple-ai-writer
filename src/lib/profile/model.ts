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
  | "requirement";

export interface WorkspaceProfile {
  /** Stable identifier; also the lookup key for built-in profiles. */
  id: string;
  labelZh: string;
  labelEn: string;
  /** Knowledge-base categories, in display order. Never empty. */
  categories: ProfileCategory[];
  /**
   * Section-label overrides. Anything absent falls back to
   * `DEFAULT_SECTION_LABELS`, so a partial or hand-written profile still
   * produces a complete prompt.
   */
  sections: Partial<Record<SectionId, string>>;
  /** i18n key of the system prompt used when no prompt is explicitly active. */
  systemPromptKey: string;
}

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
  systemPromptKey: "ai.instructions.systemTtrpg",
};

/** Every built-in profile, in the order a picker should show them. */
export const BUILTIN_PROFILES: readonly WorkspaceProfile[] = [
  NOVEL_PROFILE,
  TTRPG_PROFILE,
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

// ─── Validation ──────────────────────────────────────────────────────────────
// profile.json is hand-editable data that decides *directory names*, so it is
// parsed defensively rather than trusted: a bad entry is dropped with an issue
// recorded, and a file that survives nothing at all falls back to a built-in.
// The Rust side re-validates before creating anything (scaffold_project) — this
// layer is convenience, not the security boundary.

/** Category ids become folder names, so keep them to a portable slug. */
const CATEGORY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
/** i18n keys are dotted identifiers; anything else is a typo or worse. */
const PROMPT_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.]{0,79}$/;
const MAX_CATEGORIES = 24;
const MAX_LABEL_CHARS = 40;
/** Section labels are rendered inside 【】 in the prompt — keep them short. */
const MAX_SECTION_LABEL_CHARS = 20;

const SECTION_IDS = Object.keys(DEFAULT_SECTION_LABELS) as SectionId[];

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
      sections,
      systemPromptKey,
    },
    issues,
  };
}
