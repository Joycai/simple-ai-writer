/**
 * Per-model recall used by the model picker: which models the author actually
 * reaches for, and which one just refused the work.
 *
 * Both live in localStorage rather than the project DB — they describe the
 * author's machine and habits, not the manuscript, and must be readable
 * synchronously while the picker renders.
 */

const RECENT_KEY = "ai:recentModels";
const BLOCKED_KEY = "ai:blockedModels";
const RECENT_MAX = 8;

function readList(key: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeList(key: string, value: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full/unavailable — the picker just loses this hint
  }
}

/** Model ids the author picked recently, most recent first. */
export function recentModelIds(): string[] {
  return readList(RECENT_KEY);
}

/** Record a deliberate model choice (call on select, not on every run). */
export function noteModelUsed(id: string): void {
  const next = [id, ...recentModelIds().filter((x) => x !== id)].slice(0, RECENT_MAX);
  writeList(RECENT_KEY, next);
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
  writeList(BLOCKED_KEY, [...ids, id]);
}

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
