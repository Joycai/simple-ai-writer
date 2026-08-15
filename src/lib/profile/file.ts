/**
 * profile.json parsing — the file format behind ./store, kept pure so the
 * v1 → v2 normalisation is testable without a filesystem.
 *
 * Two generations of the file exist:
 *
 *   - **v1** (no `version`, or `version: 1`): the whole object *is* one
 *     profile, read as a patch over the built-in named by its `id`. Every
 *     project created before packs existed has one of these — or none at all.
 *   - **v2** (`version: 2`): a selection of packs —
 *     `{ version, primary, enabled: [ids], packs: [custom profiles] }`.
 *     Built-in packs appear by id only; `packs` carries hand-written ones.
 *
 * A v1 file is normalised to "that one profile, as the primary and only
 * enabled pack", which is exactly the pre-v2 behaviour. Nothing here writes:
 * a v1 file stays v1 on disk until the author actually changes the selection
 * (see ./store), so old projects remain readable by old builds.
 */

import {
  builtinProfile,
  NOVEL_PROFILE,
  parseProfile,
  type WorkspaceProfile,
} from "./model";

/** What profile.json describes once parsed: the project's pack selection. */
export interface ProfileSelection {
  /** The pack in charge of the non-additive dimensions. Always in `enabled`. */
  primary: WorkspaceProfile;
  /** Every enabled pack, primary first, file order otherwise. */
  enabled: WorkspaceProfile[];
  /**
   * The hand-written packs this file carries — what `saveProfileFile` must
   * persist. Built-ins are not repeated here; they serialise as bare ids.
   */
  customPacks: WorkspaceProfile[];
  /** Human-readable problems found while parsing; empty when the file is clean. */
  issues: string[];
}

/** The keys of a v1 file that do not make it a customisation. */
const V1_META_KEYS = new Set(["id", "version"]);

/**
 * Parse the JSON of a profile.json of either generation.
 *
 * Never throws, and always yields a usable selection: like `parseProfile`,
 * malformed input degrades toward the novel defaults with issues recorded,
 * because this runs inside the project-open path.
 */
export function parseProfileFile(data: unknown): ProfileSelection {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const rec = data as Record<string, unknown>;
    if (rec.version === 2) return parseV2(rec);
  }
  return parseV1(data);
}

/** v1: the object is one profile — that pack, alone, primary. */
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
    primary: profile,
    enabled: [profile],
    customPacks: isCustom ? [profile] : [],
    issues,
  };
}

/** v2: a selection — custom packs, enabled ids, a primary. */
function parseV2(rec: Record<string, unknown>): ProfileSelection {
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

  // Primary: must be one of the enabled packs. A primary that names a known
  // pack missing from a *declared* enabled list is quietly promoted into it —
  // `{"version":2,"primary":"ttrpg"}` should mean what it obviously means.
  const primaryId = typeof rec.primary === "string" ? rec.primary.trim() : "";
  let primary = enabled.find((p) => p.id === primaryId) ?? null;
  if (!primary) {
    const pack = primaryId ? resolvePack(primaryId) : null;
    if (pack) {
      primary = pack;
      enabled.unshift(pack);
    } else if (primaryId) {
      issues.push(`primary pack "${primaryId}" is unknown`);
    } else {
      issues.push("no usable primary");
    }
  }
  if (enabled.length === 0) {
    issues.push('no usable packs — falling back to the "novel" pack');
    enabled.push(NOVEL_PROFILE);
  }
  if (!primary) primary = enabled[0];

  // Primary first — the arbitration order `resolveWorkspace` consumes.
  const ordered = [primary, ...enabled.filter((p) => p.id !== primary.id)];
  return { primary, enabled: ordered, customPacks, issues };
}
