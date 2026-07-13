/**
 * Extract a JSON object from a model reply that may wrap it in a ```json code
 * fence or surround it with reasoning prose (common with reasoning/"thinking"
 * models). Returns the raw `{…}` substring; throws if none is found so callers
 * can surface a clear error.
 */
export function extractJsonObject(text: string): string {
  const trimmed = text.trim();

  // Prefer a fenced ```json block when present.
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/i.exec(trimmed);
  if (fenced) return fenced[1];

  // Otherwise take the outermost {…} span.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Model returned no JSON object.");
  }
  return trimmed.slice(start, end + 1);
}
