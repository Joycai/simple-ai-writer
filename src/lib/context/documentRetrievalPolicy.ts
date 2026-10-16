import type { SemanticPrefs } from "./semanticPrefs";

/** Includes local prose, retrieved excerpts and their source labels. */
export const DOCUMENT_CONTEXT_CHARS = 16_000;
export const DOCUMENT_LOCAL_CHARS = 6_000;
/** Do not refill the freed long-context space with unbounded recaps. */
export const DOCUMENT_RECAP_CHARS = 12_000;
export function documentWindowLimit(prefs: SemanticPrefs): number | undefined {
  return prefs.enabled && prefs.documentEnabled ? DOCUMENT_CONTEXT_CHARS : undefined;
}
