/**
 * Per-model recall used by the model picker: which models the author actually
 * reaches for, and which one just refused the work.
 *
 * Both are preferences rather than project data — they describe the author's
 * habits, not the manuscript — so they go through `lib/prefs`, which is also
 * what keeps them readable synchronously while the picker renders.
 */

import { readPref, writePref, writePrefMerged } from "../prefs";

const RECENT_KEY = "ai:recentModels";
const BLOCKED_KEY = "ai:blockedModels";
const RECENT_MAX = 8;

function readList(key: string): string[] {
  return parseList(readPref(key));
}

function writeList(key: string, value: string[]): void {
  writePref(key, JSON.stringify(value));
}

/**
 * Both rows are *lists several windows append to*, which is the one shape
 * `writePref` gets wrong: each window persists the whole list from its own
 * startup snapshot, so whichever saves second silently drops the other's
 * addition. That is the recent-projects lesson (see `prefs.writePrefMerged`),
 * and these two never learned it — two windows picking models cost the picker
 * half its 常用 row, and a model blocked in one window could be un-blocked by
 * the other merely recording a pick.
 *
 * Merge on add, plain overwrite on remove — the same asymmetry, for the same
 * reason, as `mergePinnedProjects` and the unpin beside it: a union applied to
 * a removal puts the entry straight back.
 *
 * Ours goes first. Our addition is the newest thing that happened, and the
 * recents row is ordered by exactly that; anything the row already had that we
 * do not know about follows in its own order, and the cap falls where it falls.
 */
export function mergeRecentModels(dbRaw: string | null, ours: string): string {
  return JSON.stringify(unionIds(parseList(ours), parseList(dbRaw)).slice(0, RECENT_MAX));
}

/** Same union for the blocked row. Order carries no meaning — it is read as a
 *  set — so ours-first is only for consistency with the one above. */
export function mergeBlockedModels(dbRaw: string | null, ours: string): string {
  return JSON.stringify(unionIds(parseList(ours), parseList(dbRaw)));
}

function unionIds(ours: readonly string[], theirs: readonly string[]): string[] {
  const merged = [...ours];
  for (const id of theirs) {
    if (!merged.includes(id)) merged.push(id);
  }
  return merged;
}

/** The list shape both merges parse, tolerating a row we cannot read. */
function parseList(raw: string | null): string[] {
  try {
    const parsed = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Model ids the author picked recently, most recent first. */
export function recentModelIds(): string[] {
  return readList(RECENT_KEY);
}

/** Record a deliberate model choice (call on select, not on every run). */
export function noteModelUsed(id: string): void {
  const next = [id, ...recentModelIds().filter((x) => x !== id)].slice(0, RECENT_MAX);
  writePrefMerged(RECENT_KEY, JSON.stringify(next), mergeRecentModels);
}

/**
 * Models whose last run was refused by a safety filter. Sticky until that model
 * completes a run — a refusal is worth carrying across sessions, because the
 * usual fix ("switch models") is exactly the decision the picker is for.
 */
export function blockedModelIds(): Set<string> {
  return new Set(readList(BLOCKED_KEY));
}

export function markModelBlocked(id: string): void {
  const ids = readList(BLOCKED_KEY);
  if (ids.includes(id)) return;
  writePrefMerged(BLOCKED_KEY, JSON.stringify([...ids, id]), mergeBlockedModels);
}

/** Overwritten rather than merged — see the note above `mergeRecentModels`. */
export function clearModelBlocked(id: string): void {
  const ids = readList(BLOCKED_KEY);
  if (!ids.includes(id)) return;
  writeList(BLOCKED_KEY, ids.filter((x) => x !== id));
}

/**
 * Whether an error came from a content/safety filter rather than a transport or
 * auth fault. Matches the shapes the adapters surface: Gemini's block reasons,
 * OpenAI-compatible `content_filter` finish reasons, and Anthropic refusals.
 */
export function isSafetyBlockMessage(message: string): boolean {
  return /PROHIBITED_CONTENT|SAFETY|BLOCKLIST|content[_ -]?filter|safety[_ -]?(filter|setting|block)/i
    .test(message);
}

/**
 * Fold a finished run's outcome into the block memory: a safety refusal marks
 * the model, any other outcome clears it.
 */
export function recordRunOutcome(modelId: string, error: string | null): void {
  if (error && isSafetyBlockMessage(error)) markModelBlocked(modelId);
  else if (!error) clearModelBlocked(modelId);
}
