import type { CSSProperties } from "react";
import type { Transition, Variants } from "motion/react";

/**
 * Shared Motion presets for screen / panel transitions.
 *
 * Motion (framer-motion) is the one sanctioned exception to the "pure CSS
 * motion" rule in docs/design-system.md: it is the only way to animate a view
 * *out* while the next one animates *in* (AnimatePresence), which is what makes
 * the switch read as a real iOS-like transition instead of a hard cut.
 *
 * `MotionConfig reducedMotion="user"` at the app root makes every one of these
 * degrade automatically under `prefers-reduced-motion` — keep it there.
 */

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
  initial: { opacity: 0, x: 26 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -22 },
};

/** Forward "push" (drill-down): enters from the right, and on back-nav leaves
 *  to the right — the parent it reveals feels like it was underneath. */
export const pushForward: Variants = {
  initial: { opacity: 0, x: 40 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: 40 },
};

/** The layer being covered by a push — recedes slightly left (parallax).
 *  Paired with `pushForward`, this yields a symmetric iOS push/pop without
 *  having to track navigation direction. */
export const pushBackdrop: Variants = {
  initial: { opacity: 0, x: -30 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -30 },
};

/** Light vertical fade for in-flow panel content (sidebar tabs). */
export const panelFade: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
};

/** Fill the (position:relative) parent so stacked layers overlap for a crossfade. */
export const fillLayer: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
};

/* ── Overlay surfaces (modals, palettes, drawers) — enter *and* exit ────────
   These pair with <AnimatePresence> so a dismissed surface animates out
   instead of snapping. Replaces the mount-only CSS `animation:` on the
   corresponding .backdrop/.overlay/.drawer/.palette/.modal classes. */

/** Backdrop / scrim fade. */
export const overlayFade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
};
export const overlayFadeTransition: Transition = { duration: 0.2, ease: "easeOut" };

/** Right-side drawer slide-over (AI assistant panel). */
export const drawerSlide: Variants = {
  initial: { x: "100%" },
  animate: { x: 0 },
  exit: { x: "100%" },
};
export const springDrawer: Transition = {
  type: "spring",
  stiffness: 360,
  damping: 40,
  mass: 0.9,
};

/** Centered modal / command-palette pop — scale + fade + slight rise. */
export const modalPop: Variants = {
  initial: { opacity: 0, scale: 0.96, y: 8 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.97, y: 4 },
};
