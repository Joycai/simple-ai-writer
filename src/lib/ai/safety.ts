/**
 * Gemini per-request safety filtering settings.
 * Docs: https://ai.google.dev/gemini-api/docs/safety-settings#safety-filtering-per-request
 */

/** Harm categories that can be configured per request. */
export const GEMINI_HARM_CATEGORIES = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
] as const;

export type GeminiHarmCategory = (typeof GEMINI_HARM_CATEGORIES)[number];

/** Block thresholds, ordered from most permissive (index 0) to strictest. */
export const GEMINI_THRESHOLD_LEVELS = [
  "OFF",
  "BLOCK_NONE",
  "BLOCK_ONLY_HIGH",
  "BLOCK_MEDIUM_AND_ABOVE",
  "BLOCK_LOW_AND_ABOVE",
] as const;

export type GeminiHarmThreshold = (typeof GEMINI_THRESHOLD_LEVELS)[number];

export type GeminiSafetySettings = Partial<Record<GeminiHarmCategory, GeminiHarmThreshold>>;

/** Default: don't block — this is a creative-writing tool that values freedom. */
export function defaultSafetySettings(): GeminiSafetySettings {
  return Object.fromEntries(
    GEMINI_HARM_CATEGORIES.map((c) => [c, "BLOCK_NONE"] as const),
  ) as GeminiSafetySettings;
}

/** Convert the stored record into the array shape the Gemini API expects. */
export function toSafetySettingsArray(
  s: GeminiSafetySettings | undefined,
): { category: GeminiHarmCategory; threshold: GeminiHarmThreshold }[] {
  if (!s) return [];
  return GEMINI_HARM_CATEGORIES.flatMap((category) =>
    s[category] ? [{ category, threshold: s[category]! }] : [],
  );
}
