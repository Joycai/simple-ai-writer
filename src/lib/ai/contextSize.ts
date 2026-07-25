/**
 * Presentation helpers for a model's context-window setting.
 *
 * The stops are the real window sizes shipped by mainstream models (powers of
 * two, not round decimals — a "128k" model is 131,072 tokens). They drive the
 * slider in the model editor; the adjacent number field still accepts anything
 * up to MAX_CONTEXT_SIZE, because plenty of models sit between stops (Claude's
 * 200,000, local builds capped at 8k or 64k).
 */

export const CONTEXT_SIZE_STOPS = [
  16_384,    // 16k
  32_768,    // 32k
  131_072,   // 128k
  262_144,   // 256k
  524_288,   // 512k
  1_048_576, // 1M
];

/** Compact token count: 1_048_576 → "1M", 131_072 → "128k". */
export function formatContextSize(tokens: number): string {
  if (tokens >= 1_048_576) return `${Math.round(tokens / 1_048_576)}M`;
  if (tokens >= 1024) return `${Math.round(tokens / 1024)}k`;
  return String(tokens);
}

/**
 * Index of the stop a value *exactly* equals: 0 for unset, 1..N for a stop, and
 * -1 for anything in between. Use this to decide which stop label reads as
 * selected — snapping is right for the slider thumb but wrong for a highlight,
 * which asserts "this is your value" (Claude's 200,000 would light up "256k"
 * while the field next to it plainly says 200,000).
 */
export function exactStopIndex(value: string | number | undefined): number {
  const n = typeof value === "number" ? value : parseInt(value ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const i = CONTEXT_SIZE_STOPS.indexOf(n);
  return i >= 0 ? i + 1 : -1;
}

/**
 * Slider position for a raw field value: 0 means "unset", 1..N select a stop.
 * A value between stops (or above the top one) snaps to the nearest stop so the
 * thumb has somewhere to sit — the stored value is untouched until the user
 * actually moves the slider.
 */
export function contextStopIndex(value: string | number | undefined): number {
  const n = typeof value === "number" ? value : parseInt(value ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  let best = 0;
  for (let i = 1; i < CONTEXT_SIZE_STOPS.length; i++) {
    if (Math.abs(CONTEXT_SIZE_STOPS[i] - n) < Math.abs(CONTEXT_SIZE_STOPS[best] - n)) best = i;
  }
  return best + 1;
}
