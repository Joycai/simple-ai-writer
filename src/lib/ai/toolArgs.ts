/**
 * Repairing a tool call's arguments that arrived as several JSON objects back
 * to back.
 *
 * Some relays stream `function.arguments` as a placeholder object followed by
 * the real one — `{}{"id":1}` — so the concatenated string is not JSON (seen on
 * relay traffic to a Claude backend, 2026-08-08). Left alone, the agent loop
 * drops the call and tells the model its arguments were cut off by the output
 * cap, which is untrue and invites the same call again; a caller that falls
 * back to `{}` instead runs the tool with nothing, silently.
 *
 * The repair splits the string at top-level object boundaries (string- and
 * escape-aware) and merges the objects left to right. Only a string that splits
 * into **two or more** objects, every one of which parses, is rewritten — one
 * object that doesn't parse is genuinely broken (a truncation, most often) and
 * is returned unchanged for the caller's own check to report.
 */

/** Top-level `{…}` spans of `raw`, or null when anything but whitespace lies between them. */
function splitTopLevelObjects(raw: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (depth === 0) return null; // a bare string at the top level
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth === 0) return null;
      depth--;
      if (depth === 0) out.push(raw.slice(start, i + 1));
    } else if (depth === 0 && !/\s/.test(ch)) {
      return null;
    }
  }
  return depth === 0 ? out : null;
}

/**
 * `raw` as a single JSON object string when it was several concatenated ones;
 * otherwise `raw` itself, untouched.
 */
export function mergeConcatenatedArgs(raw: string): string {
  if (!raw.trim()) return raw;
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    // fall through to the repair
  }
  const parts = splitTopLevelObjects(raw);
  if (!parts || parts.length < 2) return raw;
  const merged: Record<string, unknown> = {};
  for (const part of parts) {
    let obj: unknown;
    try {
      obj = JSON.parse(part);
    } catch {
      return raw;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return raw;
    Object.assign(merged, obj);
  }
  return JSON.stringify(merged);
}
