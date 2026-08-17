/**
 * profile.json parsing — the file format behind ./store, kept pure so the
 * v1 → v2 → v3 normalisation is testable without a filesystem.
 *
 * Three generations of the file exist:
 *
 *   - **v1** (no `version`, or `version: 1`): the whole object *is* one
 *     profile, read as a patch over the built-in named by its `id`. Every
 *     project created before packs existed has one of these — or none at all.
 *   - **v2** (`version: 2`): a selection with a **primary** pack —
 *     `{ version, primary, enabled: [ids], packs: [custom profiles] }`. The
 *     primary owned the non-additive dimensions (vocabulary, doc model,
 *     persona); those are app-level now, so on read the primary is simply the
 *     first enabled pack and nothing more.
 *   - **v3** (`version: 3`): the current format — packs are equal toggles and
 *     the project's user-defined knowledge-base categories ride along:
 *     `{ version, enabled: [ids], packs: [custom profiles], categories: […] }`.
 *
 * Old files are normalised on read and only rewritten (as v3) when the author
 * actually changes the selection (see ./store), so old projects remain
 * readable by old builds until they opt in.
 */

import {
  builtinProfile,
  NOVEL_PROFILE,
  parseCategoryList,
  parseProfile,
  type ProfileCategory,
  type WorkspaceProfile,
} from "./model";

/** What profile.json describes once parsed: the project's pack selection. */
export interface ProfileSelection {
  /** Every enabled pack, in file order. May be empty (a packs-free project). */
  enabled: WorkspaceProfile[];
  /**
   * The hand-written packs this file carries — what `saveProfileFile` must
   * persist. Built-ins are not repeated here; they serialise as bare ids.
   */
  customPacks: WorkspaceProfile[];
  /** The project's user-defined knowledge-base categories, in file order. */
  customCategories: ProfileCategory[];
  /** Human-readable problems found while parsing; empty when the file is clean. */
  issues: string[];
}

/** The keys of a v1 file that do not make it a customisation. */
const V1_META_KEYS = new Set(["id", "version"]);

/**
 * Parse the JSON of a profile.json of any generation.
 *
 * Never throws, and always yields a usable selection: like `parseProfile`,
 * malformed input degrades toward the novel defaults with issues recorded,
 * because this runs inside the project-open path.
 */
export function parseProfileFile(data: unknown): ProfileSelection {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const rec = data as Record<string, unknown>;
    if (rec.version === 3) return parseSelection(rec, 3);
    if (rec.version === 2) return parseSelection(rec, 2);
  }
  return parseV1(data);
}

/** v1: the object is one profile — that pack, alone. */
function parseV1(data: unknown): ProfileSelection {
  // Same resolution as the pre-v2 loader: a file naming a built-in inherits
  // that profile's defaults for anything it leaves out, so `{"id":"ttrpg"}`
  // is a complete, valid profile.
  const declaredId =
    data && typeof data === "object" && typeof (data as { id?: unknown }).id === "string"
      ? (data as { id: string }).id
      : "";
  const fallback = builtinProfile(declaredId) ?? NOVEL_PROFILE;
  const { profile, issues } = parseProfile(data, fallback);

  // A file that says nothing beyond its id resolves to the built-in exactly
  // and need not be carried as a custom pack; anything more is a
  // customisation that must survive a future save.
  const isCustom =
    !!data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    Object.keys(data).some((key) => !V1_META_KEYS.has(key));

  return {
    enabled: [profile],
    customPacks: isCustom ? [profile] : [],
    customCategories: [],
    issues,
  };
}

/**
 * v2 and v3 share everything but two details: v2 has a `primary` (normalised
 * to "first enabled"), v3 has top-level `categories` (the user-defined ones).
 */
function parseSelection(rec: Record<string, unknown>, version: 2 | 3): ProfileSelection {
  const issues: string[] = [];

  // Custom packs first: `enabled` may reference them. A pack whose id matches
  // a built-in *overrides* that built-in for this project — the same "file
  // beats built-in" contract a v1 file has always had.
  const packById = new Map<string, WorkspaceProfile>();
  const customPacks: WorkspaceProfile[] = [];
  if (Array.isArray(rec.packs)) {
    for (const raw of rec.packs) {
      const declaredId =
        raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string"
          ? (raw as { id: string }).id
          : "";
      const fallback = builtinProfile(declaredId) ?? NOVEL_PROFILE;
      const { profile, issues: packIssues } = parseProfile(raw, fallback);
      issues.push(...packIssues);
      if (packById.has(profile.id)) {
        issues.push(`duplicate pack id "${profile.id}" — keeping the first`);
        continue;
      }
      packById.set(profile.id, profile);
      customPacks.push(profile);
    }
  } else if (rec.packs !== undefined) {
    issues.push("`packs` is not an array");
  }

  const resolvePack = (id: string): WorkspaceProfile | null =>
    packById.get(id) ?? builtinProfile(id);

  // Enabled: file order, unknown ids dropped loudly — a pack that got
  // renamed or removed must not take the whole selection down with it.
  const enabled: WorkspaceProfile[] = [];
  if (Array.isArray(rec.enabled)) {
    for (const raw of rec.enabled) {
      if (typeof raw !== "string") {
        issues.push("`enabled` entry is not a string");
        continue;
      }
      const id = raw.trim();
      if (enabled.some((p) => p.id === id)) {
        issues.push(`duplicate enabled id "${id}"`);
        continue;
      }
      const pack = resolvePack(id);
      if (!pack) {
        issues.push(`enabled pack "${id}" is unknown — ignoring`);
        continue;
      }
      enabled.push(pack);
    }
  } else if (rec.enabled !== undefined) {
    issues.push("`enabled` is not an array");
  }

  if (version === 2) {
    // The v2 primary owned dimensions that are app-level now, so all that is
    // left of it is ordering: it goes first, the way the v2 loader ordered it.
    // A primary naming a known pack missing from the enabled list is promoted
    // into it — `{"version":2,"primary":"ttrpg"}` should mean what it meant.
    const primaryId = typeof rec.primary === "string" ? rec.primary.trim() : "";
    const inList = enabled.find((p) => p.id === primaryId) ?? null;
    if (inList) {
      const rest = enabled.filter((p) => p.id !== primaryId);
      enabled.length = 0;
      enabled.push(inList, ...rest);
    } else if (primaryId) {
      const pack = resolvePack(primaryId);
      if (pack) enabled.unshift(pack);
      else issues.push(`primary pack "${primaryId}" is unknown`);
    }
    // A v2 file that resolved to nothing meant "novel" (there was always a
    // primary); keep that meaning rather than degrading it to an empty
    // selection the author never chose.
    if (enabled.length === 0) {
      issues.push('no usable packs — falling back to the "novel" pack');
      enabled.push(NOVEL_PROFILE);
    }
  }

  const customCategories =
    version === 3 ? parseCategoryList(rec.categories, issues) : [];

  return { enabled, customPacks, customCategories, issues };
}
