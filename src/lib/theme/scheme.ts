/**
 * The app's colour polarity — light or dark — as one attribute on `<html>`.
 *
 * Two attributes carry a theme (docs/feature/theme-system-plan.md §3):
 *
 *   data-theme  = "paper" | "night" | <a user theme's id>   — the cascade key
 *   data-scheme = "light" | "dark"                          — the polarity
 *
 * `data-theme` selects which token block wins in `tokens.css`; nothing else
 * may read its value, because once theme files exist it is an arbitrary id.
 * Anything that needs to know "is this dark?" — Mermaid's palette, a native
 * `color-scheme`, an image's fallback border — reads `data-scheme`, which the
 * theme's manifest decides. A source guard in `themeContract.test.ts` keeps
 * `getAttribute("data-theme")` out of every other module.
 */
import { useEffect, useState } from "react";

export type ColorScheme = "light" | "dark";

export const THEME_ATTR = "data-theme";
export const SCHEME_ATTR = "data-scheme";

/** The two built-in themes, keyed by the scheme they carry. */
export const BUILTIN_THEME_FOR_SCHEME: Record<ColorScheme, string> = {
  light: "paper",
  dark: "night",
};

/**
 * Write both attributes: `id` is the cascade key (a built-in or a theme
 * file's id), `scheme` the polarity the theme's manifest declared. The only
 * writer — `lib/theme/install.ts` resolves which id, then comes here.
 */
export function applyThemeId(id: string, scheme: ColorScheme): void {
  const root = document.documentElement;
  root.setAttribute(THEME_ATTR, id);
  root.setAttribute(SCHEME_ATTR, scheme);
}

/** The polarity currently on `<html>`; dark until something has applied one. */
function currentScheme(): ColorScheme {
  return document.documentElement.getAttribute(SCHEME_ATTR) === "light" ? "light" : "dark";
}

/**
 * React view of `currentScheme()`, updated when the attribute changes — a
 * MutationObserver rather than a store subscription, so `theme: "system"`
 * flipping with the OS reaches subscribers too (the store value doesn't move
 * in that case, only the attribute does).
 */
export function useScheme(): ColorScheme {
  const [scheme, setScheme] = useState<ColorScheme>(() =>
    typeof document === "undefined" ? "dark" : currentScheme(),
  );
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setScheme(currentScheme());
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: [SCHEME_ATTR] });
    return () => observer.disconnect();
  }, []);
  return scheme;
}
