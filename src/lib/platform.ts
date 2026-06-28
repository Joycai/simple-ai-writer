/**
 * Platform detection for cosmetic shortcut labels (e.g. `⌘K` vs `Ctrl+K`).
 *
 * Note: this affects display only — the global handler in App.tsx already
 * listens for both `e.metaKey` and `e.ctrlKey`, so the actual binding works
 * on any platform regardless of what we render here.
 */
export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);

/** The OS modifier key label. */
export const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";

/** Pre-built label for the command-palette shortcut. */
export const MOD_K = IS_MAC ? "⌘K" : "Ctrl+K";

/** Same but with a thin space, used where the layout reads better with breathing room. */
export const MOD_K_SPACED = IS_MAC ? "⌘ K" : "Ctrl + K";
