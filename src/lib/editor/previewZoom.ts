/**
 * The preview pane's zoom ladder.
 *
 * A fixed ladder rather than a continuous factor: the buttons and the
 * ⌘/Ctrl+wheel gesture must agree on what "one step" means, and a percentage
 * the author can't name ("113%") is a worse place to land than a slightly
 * coarser jump. The rungs thicken around 100% because that is where reading
 * adjustments actually happen.
 */
export const PREVIEW_ZOOM_STEPS = [
  0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3,
] as const;

export const PREVIEW_ZOOM_DEFAULT = 1;
export const PREVIEW_ZOOM_MIN = PREVIEW_ZOOM_STEPS[0];
export const PREVIEW_ZOOM_MAX = PREVIEW_ZOOM_STEPS[PREVIEW_ZOOM_STEPS.length - 1];

/** Snap an arbitrary factor (a stored preference, a hand-edited row) to the ladder. */
export function snapPreviewZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return PREVIEW_ZOOM_DEFAULT;
  return PREVIEW_ZOOM_STEPS.reduce((best, step) =>
    Math.abs(step - zoom) < Math.abs(best - zoom) ? step : best,
  );
}

/**
 * The next rung `dir` (+1 in, -1 out) from `zoom`, clamped at both ends.
 *
 * Stepping is relative to the *snapped* value, so a factor that fell between
 * rungs still moves exactly one rung rather than jumping to wherever the
 * nearest one happened to be.
 */
export function stepPreviewZoom(zoom: number, dir: 1 | -1): number {
  const at = PREVIEW_ZOOM_STEPS.indexOf(snapPreviewZoom(zoom) as (typeof PREVIEW_ZOOM_STEPS)[number]);
  const next = Math.max(0, Math.min(PREVIEW_ZOOM_STEPS.length - 1, at + dir));
  return PREVIEW_ZOOM_STEPS[next];
}

/** `1.25` → `125%`. Whole percents only — the ladder never lands between them. */
export function formatPreviewZoom(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}
