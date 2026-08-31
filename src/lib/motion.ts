import { useMemo } from "react";
import type { CSSProperties } from "react";
import { useReducedMotion } from "motion/react";
import type { Transition, Variants } from "motion/react";

/**
 * Shared Motion presets for screen / panel transitions.
 *
 * Motion (framer-motion) is the one sanctioned exception to the "pure CSS
 * motion" rule in docs/reference/design-system.md: it is the only way to animate a view
 * *out* while the next one animates *in* (AnimatePresence), which is what makes
 * the switch read as a real iOS-like transition instead of a hard cut.
 *
 * The variants declare full `transform` strings rather than Motion's `x`/`y`
 * shorthands, deliberately: the shorthands animate on the main thread (rAF),
 * while a plain `transform` is on motion-dom's accelerated-values list and runs
 * through WAAPI on the compositor — which matters precisely here, because these
 * presets fire on view switches, the moment the main thread is busiest mounting
 * the heavy tree being switched to.
 *
 * The cost of that choice: `MotionConfig reducedMotion="user"` (kept at the app
 * root) auto-disables Motion's positional keys (x/y/scale…) but NOT a raw
 * `transform`. Every consumer of a transform-bearing preset must therefore pass
 * it through `useMotionPreset()` below — that hook is what keeps the
 * reduced-motion promise now.
 */

/** The CSS `--ease-out` token (tokens.css) as a Motion easing, so both motion
 *  languages in the app speak the same curve. Keep in step with tokens.css. */
export const EASE_OUT: [number, number, number, number] = [0.32, 0.72, 0, 1];

/**
 * Reduced-motion gate for the presets in this file. When the OS asks for
 * reduced motion this strips the `transform` from every variant, leaving the
 * opacity fade — reduced motion means fewer and gentler animations, not zero.
 * (MotionConfig can't do this for us: it only silences positional keys, and
 * these presets animate `transform` directly — see the header comment.)
 */
export function useMotionPreset(preset: Variants): Variants {
  const reduced = useReducedMotion();
  return useMemo(() => {
    if (!reduced) return preset;
    const out: Variants = {};
    for (const [name, def] of Object.entries(preset)) {
      if (typeof def === "function") {
        out[name] = def;
        continue;
      }
      const { transform: _transform, ...rest } = def;
      out[name] = rest;
    }
    return out;
  }, [reduced, preset]);
}

/** iOS-like spring for screen-level (full-view) transitions. */
export const springScreen: Transition = {
  type: "spring",
  stiffness: 320,
  damping: 34,
  mass: 0.9,
};

/** Snappier spring for smaller panel content swaps. */
export const springPanel: Transition = {
  type: "spring",
  stiffness: 420,
  damping: 36,
  mass: 0.7,
};

/** Horizontal slide + fade — top-level view switches (crossfade over each other). */
export const viewSlide: Variants = {
  initial: { opacity: 0, transform: "translateX(26px)" },
  animate: { opacity: 1, transform: "translateX(0px)" },
  exit: { opacity: 0, transform: "translateX(-22px)" },
};

/** Forward "push" (drill-down): enters from the right, and on back-nav leaves
 *  to the right — the parent it reveals feels like it was underneath. */
export const pushForward: Variants = {
  initial: { opacity: 0, transform: "translateX(40px)" },
  animate: { opacity: 1, transform: "translateX(0px)" },
  exit: { opacity: 0, transform: "translateX(40px)" },
};

/** The layer being covered by a push — recedes slightly left (parallax).
 *  Paired with `pushForward`, this yields a symmetric iOS push/pop without
 *  having to track navigation direction. */
export const pushBackdrop: Variants = {
  initial: { opacity: 0, transform: "translateX(-30px)" },
  animate: { opacity: 1, transform: "translateX(0px)" },
  exit: { opacity: 0, transform: "translateX(-30px)" },
};

/** Light vertical fade for in-flow panel content (sidebar tabs). */
export const panelFade: Variants = {
  initial: { opacity: 0, transform: "translateY(6px)" },
  animate: { opacity: 1, transform: "translateY(0px)" },
  exit: { opacity: 0, transform: "translateY(-6px)" },
};

/** Fill the (position:relative) parent so stacked layers overlap for a crossfade. */
export const fillLayer: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
};

/* ── Overlay surfaces (modals, drawers) — enter *and* exit ────────
   These pair with <AnimatePresence> so a dismissed surface animates out
   instead of snapping. Replaces the mount-only CSS `animation:` on the
   corresponding .backdrop/.overlay/.drawer/.modal classes. */

/** Backdrop / scrim fade. */
export const overlayFade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
};
export const overlayFadeTransition: Transition = { duration: 0.2, ease: EASE_OUT };

/** Right-side drawer slide-over (AI assistant panel). */
export const drawerSlide: Variants = {
  initial: { transform: "translateX(100%)" },
  animate: { transform: "translateX(0%)" },
  exit: { transform: "translateX(100%)" },
};
export const springDrawer: Transition = {
  type: "spring",
  stiffness: 360,
  damping: 40,
  mass: 0.9,
};
