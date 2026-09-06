/**
 * Loading and installing appearance themes — the DOM side of the registry.
 *
 * Two entry points, one state:
 *
 * - `preloadSelectedThemes(selected)` at boot: reads only the one or two
 *   files the preferences name, so the first frame is already the author's
 *   theme (docs/feature/theme-system-plan.md §7.2). The rest of the folder
 *   is not read until the settings page asks.
 * - `reloadThemes(selected)` from the settings page: the whole folder.
 *
 * Both validate through `validate.ts`, build a registry through `registry.ts`,
 * write **every** usable user theme into one `<style>` in `tokens.user` — so
 * switching between them is an attribute flip, never a file read — and keep
 * the registry here for the export palette and the switcher. The validated
 * files are kept too, so a selection change rebuilds the registry (its
 * `missing` markers depend on the selection) without touching the disk.
 *
 * A `<style>` element rather than `document.adoptedStyleSheets`: constructed
 * sheets arrived in WebKit 16.4, above the floor the build targets. The layer
 * makes the injection point irrelevant — `tokens.user` wins over the built-in
 * hand-tunes wherever the element sits.
 */
import { TOKEN_CONTRACT } from "./contractData";
import {
  BUILTIN_UI_THEMES, buildUiRegistry, installableEntries, isBuiltinUiId, resolveUiTheme,
  type ScannedThemeFile, type ThemeEntry, type UiRegistry,
} from "./registry";
import { readThemeById, scanThemeFiles, themesDir, type ThemeFileText } from "./scan";
import { themeIdFromFileName } from "./manifest";
import { applyThemeId, type ColorScheme } from "./scheme";
import { uiThemeCss, validateUiThemeText } from "./validate";

const STYLE_ID = "theme-user";

export type SelectedThemes = Record<ColorScheme, string>;

let current: UiRegistry = { entries: [...BUILTIN_UI_THEMES], markdownFiles: 0 };
/** The validated files behind `current` — the whole folder once `scanned`. */
let files: ScannedThemeFile[] = [];
let dirPath = "";
let scanned = false;
let selection: SelectedThemes = { light: "paper", dark: "night" };
const listeners = new Set<() => void>();

export function currentRegistry(): UiRegistry {
  return current;
}

/**
 * Be told whenever the registry is rebuilt — a scan, or a selection change
 * that moved a `missing` marker. `stores/themeStore` mirrors it into React
 * from here rather than after each call it happens to make itself, so the
 * settings grid cannot show a missing card the registry no longer holds.
 */
export function subscribeRegistry(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The ids the preferences named at the last rebuild — what the export palette resolves. */
export function currentSelection(): SelectedThemes {
  return selection;
}

/** The theme the export should carry for `scheme` — the author's, or the built-in it fell back to. */
export function resolvedTheme(scheme: ColorScheme): ThemeEntry {
  return resolveUiTheme(current.entries, scheme, selection[scheme]);
}

export function registryScanned(): boolean {
  return scanned;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function validateFile(f: ThemeFileText): ScannedThemeFile {
  if (f.text === undefined) return { fileName: f.fileName, path: f.path, error: f.error };
  const id = themeIdFromFileName(f.fileName) ?? f.fileName;
  return { fileName: f.fileName, path: f.path, validation: validateUiThemeText(f.text, id, TOKEN_CONTRACT) };
}

/** Rebuild the registry and the installed sheet from `files` under `selected`. */
export function rebuildRegistry(selected: SelectedThemes): UiRegistry {
  selection = selected;
  current = buildUiRegistry(files, selected, dirPath);
  setUserThemeCss(
    installableEntries(current.entries)
      .map((e) => uiThemeCss(e.id, e.tokens as Record<string, string>))
      .join("\n\n"),
  );
  for (const fn of listeners) fn();
  return current;
}

/**
 * Validate and install theme files handed in as text — what both readers
 * above go through, and the seam a caller with the bytes in hand (a test in
 * a real browser, a future watcher) uses directly. `replace` swaps the whole
 * set; otherwise files the registry does not have yet are added.
 */
export function loadThemeFiles(
  texts: ThemeFileText[],
  selected: SelectedThemes,
  opts: { replace?: boolean; dir?: string } = {},
): UiRegistry {
  if (opts.dir !== undefined) dirPath = opts.dir;
  const fresh = texts.map(validateFile);
  files = opts.replace ? fresh : [...files, ...fresh.filter((f) => !files.some((k) => k.fileName === f.fileName))];
  return rebuildRegistry(selected);
}

/** Write the user themes' sheet, replacing whatever was there. */
export function setUserThemeCss(css: string): void {
  if (typeof document === "undefined") return;
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = `@layer tokens.user {\n${css}\n}`;
}

/**
 * Boot: read the selected files only. Outside Tauri, or when nothing but
 * built-ins is selected, this does no I/O at all.
 */
export async function preloadSelectedThemes(selected: SelectedThemes): Promise<void> {
  const ids = [...new Set(Object.values(selected))].filter((id) => !isBuiltinUiId(id));
  if (!isTauri || !ids.length) return;
  const dir = await themesDir();
  const texts: ThemeFileText[] = [];
  for (const id of ids) {
    if (files.some((f) => themeIdFromFileName(f.fileName) === id)) continue;
    const f = await readThemeById(id);
    if (f) texts.push(f);
  }
  loadThemeFiles(texts, selected, { dir });
}

/** The settings page's 重新载入, and the first open of the page: the whole folder. */
export async function reloadThemes(selected: SelectedThemes): Promise<UiRegistry> {
  scanned = true;
  // Outside Tauri there is no folder to scan: whatever `loadThemeFiles` was
  // handed stays, and a reload is a rebuild.
  if (!isTauri) return rebuildRegistry(selected);
  return loadThemeFiles(await scanThemeFiles(), selected, { replace: true, dir: await themesDir() });
}

/**
 * Make sure the two selected ids are loaded, reading only what the registry
 * does not know yet — the path a preference change takes when the settings
 * page has not opened (a config import, a focus refresh from another window).
 */
export async function ensureSelectedLoaded(selected: SelectedThemes): Promise<void> {
  const known = new Set(files.map((f) => themeIdFromFileName(f.fileName)));
  const wanted = Object.values(selected).filter((id) => !known.has(id) && !isBuiltinUiId(id));
  if (wanted.length && scanned) {
    await reloadThemes(selected);
    return;
  }
  if (wanted.length) {
    await preloadSelectedThemes(selected);
    return;
  }
  rebuildRegistry(selected);
}

/** Apply the theme that resolves for `scheme` under the current selection. */
export function applyResolvedTheme(scheme: ColorScheme, selectedId: string): ThemeEntry {
  const entry = resolveUiTheme(current.entries, scheme, selectedId);
  applyThemeId(entry.id, scheme);
  return entry;
}

/** Test seam. */
export function resetThemesForTest(): void {
  current = { entries: [...BUILTIN_UI_THEMES], markdownFiles: 0 };
  files = [];
  dirPath = "";
  scanned = false;
  selection = { light: "paper", dark: "night" };
}
