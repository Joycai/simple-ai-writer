/**
 * Display formatting for execution-log tool steps.
 *
 * The runtime records a tool call's arguments and result close to raw, because
 * they also serve diagnosis. Rendered verbatim in the log that reads as noise:
 * a row becomes `读取文件 · {"path": "C:\\Users\\…\\MyDocument\\chara…` followed
 * by a wall of file content, and the eye can't find the one thing that matters —
 * *which* file, and *how much* came back.
 *
 * So the log formats at render time: the argument collapses to the identifying
 * value (a filename, an entity, a query), the result collapses to a single
 * short line. Nothing is lost — the row expands to the kept detail
 * (`formatToolArgsDetail` / the raw result summary), bounded by the caps below.
 */

/**
 * How much of a call the runtime keeps for the expanded row. Defined here, next
 * to the code that renders them, so the log can tell an at-the-cap value from a
 * complete one and say so instead of implying the tool returned that much.
 */
export const TOOL_ARGS_DETAIL_CHARS = 400;
export const TOOL_RESULT_DETAIL_CHARS = 600;

/** Keys whose value identifies *what* a call acted on, in preference order. */
const IDENTITY_KEYS = [
  "path", "file", "filePath", "dirPath",
  "name", "entity", "title", "query", "keyword", "category",
];

/** Keys that are worth showing as a qualifier after the identity. */
const DETAIL_KEYS = ["facet", "group", "start_line", "limit", "count", "new_path", "dest_dir"];

const MAX_ARG_CHARS = 44;
const MAX_RESULT_CHARS = 38;

/** Last path segment, with the `.md` extension dropped — chapters read better. */
function basename(value: string): string {
  const seg = value.split(/[\\/]/).filter(Boolean).pop() ?? value;
  return seg.replace(/\.md$/i, "");
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

/** Flatten a value to one short display string, or null if it carries nothing. */
function displayValue(key: string, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? key : null;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.length ? `${value.length}` : null;
  if (typeof value !== "string") return null;
  const isPathish = /path$/i.test(key) || key === "file" || value.includes("/") || value.includes("\\");
  return isPathish ? basename(value) : value.replace(/\s+/g, " ").trim();
}

/**
 * Compact one-line rendering of a tool call's arguments.
 * `{"path":"…/MagicalGirlSapphire/writing/番外篇.md"}` → `番外篇`.
 * Returns "" when there is nothing worth showing (a no-argument call).
 */
export function formatToolArgs(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || trimmed === "{}") return "";

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON (or truncated mid-string) — show it as a plain clipped string.
    return clip(trimmed.replace(/\s+/g, " "), MAX_ARG_CHARS);
  }
  if (typeof parsed !== "object" || parsed === null) {
    return clip(String(parsed), MAX_ARG_CHARS);
  }

  const obj = parsed as Record<string, unknown>;
  const parts: string[] = [];

  for (const key of IDENTITY_KEYS) {
    if (!(key in obj)) continue;
    const shown = displayValue(key, obj[key]);
    if (shown) { parts.push(shown); break; }
  }
  for (const key of DETAIL_KEYS) {
    if (!(key in obj)) continue;
    const shown = displayValue(key, obj[key]);
    if (shown) { parts.push(shown); break; }
  }

  // Nothing recognised — fall back to the first value that renders.
  if (parts.length === 0) {
    for (const [key, value] of Object.entries(obj)) {
      const shown = displayValue(key, value);
      if (shown) { parts.push(shown); break; }
    }
  }

  return clip(parts.join(" · "), MAX_ARG_CHARS);
}

/**
 * The expanded view of a call's arguments: the same JSON, indented so a
 * multi-key call reads as a list instead of one long line. A summary truncated
 * mid-string no longer parses — it comes back verbatim rather than not at all.
 */
export function formatToolArgsDetail(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || trimmed === "{}") return "";
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

/** Compact token count for log meta: 38400 → "38k", 3244 → "3.2k". */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 100 || Number.isInteger(k) ? Math.round(k) : k.toFixed(1)}k`;
}

/**
 * Single-line result summary: newlines collapsed, clipped. Markdown headings
 * lose their `#` so a chapter's first line reads as a title, not as syntax.
 */
export function formatToolResult(raw: string | undefined): string {
  if (!raw) return "";
  const line = raw.replace(/\s+/g, " ").replace(/^#+\s*/, "").trim();
  return clip(line, MAX_RESULT_CHARS);
}
