/**
 * Loading and installing themes — the DOM side of the registry.
 *
 * Entry points, one state:
 *
 * - `preloadSelectedThemes(selected)` at boot: reads only the files the
 *   preferences name (an appearance theme per polarity, the typography
 *   theme), so the first frame is already the author's (docs/feature/
 *   theme-system-plan.md §7.2). The folder is not scanned until asked.
 * - `reloadThemes(selected)` from the settings page: both folders in full.
 * - `setProjectDir(path)` when a project opens or closes: the project's
 *   `.ai-writer/themes/` joins or leaves the registry.
 *
 * Every path validates through `validate.ts`, builds a registry through
 * `registry.ts`, and installs: **every** usable appearance theme into one
 * `<style>` in `tokens.user` — so switching between them is an attribute
 * flip, never a file read — and the **selected** typography theme into a
 * second `<style>` after the generator's (`installMarkdownThemeStyles`), its
 * assets inlined as `data:` (assets.ts). One typography theme at a time is
 * Typora's semantics; the settings samples do not need more, they are
 * sandboxed frames of their own (`sample.ts`).
 *
 * `<style>` elements rather than `document.adoptedStyleSheets`: constructed
 * sheets arrived in WebKit 16.4, above the floor the build targets. The
 * layer makes the ui injection point irrelevant; the markdown sheet must
 * simply come after the generator's, which appending guarantees.
 */
import { TOKEN_CONTRACT } from "./contractData";
import {
  BUILTIN_MARKDOWN_THEMES, BUILTIN_UI_THEMES, buildRegistry, installableEntries, isBuiltinMarkdownId, isBuiltinUiId,
  resolveMarkdownTheme, resolveUiTheme, type Registry, type ScannedThemeFile, type SelectedThemes, type ThemeEntry,
} from "./registry";
import { projectThemesDir, readThemeById, scanThemeFiles, themeBaseDir, themesDir, type ThemeFileText } from "./scan";
import { themeIdFromFileName } from "./manifest";
import { MD_THEME_ATTR } from "./markdownThemes";
import { applyThemeId, type ColorScheme } from "./scheme";
import { inlineAssets } from "./assets";
import { uiThemeCss, validateThemeText } from "./validate";

export type { SelectedThemes };

const UI_STYLE_ID = "theme-user";
const MD_STYLE_ID = "theme-markdown-user";

let current: Registry = { ui: [...BUILTIN_UI_THEMES], markdown: [...BUILTIN_MARKDOWN_THEMES] };
/** The validated files behind `current` — the whole folders once `scanned`. */
let userFiles: ScannedThemeFile[] = [];
let projectFiles: ScannedThemeFile[] = [];
let userDir = "";
let projectDir: string | undefined;
let scanned = false;
let selection: SelectedThemes = { light: "paper", dark: "night", markdown: "manuscript" };
const listeners = new Set<() => void>();
/** Inlined CSS by file path + text, so a rebuild never re-reads a font. */
const inlined = new Map<string, { css: string; out: string }>();

export function currentRegistry(): Registry {
  return current;
}

/**
 * Be told whenever the registry is rebuilt — a scan, a project change, or a
 * selection change that moved a `missing` marker. `stores/themeStore` mirrors
 * it into React from here rather than after each call it happens to make
 * itself, so the grid cannot show a missing card the registry no longer holds.
 */
export function subscribeRegistry(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The ids the preferences named at the last rebuild. */
export function currentSelection(): SelectedThemes {
  return selection;
}

/** The appearance theme that applies for `scheme` — the author's, or the built-in it fell back to. */
export function resolvedTheme(scheme: ColorScheme): ThemeEntry {
  return resolveUiTheme(current.ui, scheme, selection[scheme]);
}

/** The typography theme that applies — the author's, or the default it fell back to. */
export function resolvedMarkdownTheme(): ThemeEntry {
  return resolveMarkdownTheme(current.markdown, selection.markdown);
}

export function registryScanned(): boolean {
  return scanned;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function validateFile(f: ThemeFileText): ScannedThemeFile {
  if (f.text === undefined) return { fileName: f.fileName, path: f.path, error: f.error };
  const id = themeIdFromFileName(f.fileName) ?? f.fileName;
  return { fileName: f.fileName, path: f.path, validation: validateThemeText(f.text, id, TOKEN_CONTRACT) };
}

/** Rebuild the registry and the installed sheets from the files under `selected`. */
export function rebuildRegistry(selected: SelectedThemes): Registry {
  selection = selected;
  current = buildRegistry(userFiles, projectFiles, selected, { user: userDir, project: projectDir });
  setStyle(
    UI_STYLE_ID,
    wrapLayer(installableEntries(current.ui).map((e) => uiThemeCss(e.id, e.tokens as Record<string, string>)).join("\n\n")),
  );
  void installMarkdownSheet();
  for (const fn of listeners) fn();
  return current;
}

const wrapLayer = (css: string) => (css ? `@layer tokens.user {\n${css}\n}` : "");

function setStyle(id: string, css: string): void {
  // Several store tests stand in a bare `{ documentElement }` for `document`.
  if (typeof document === "undefined" || typeof document.getElementById !== "function") return;
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("style");
    el.id = id;
    document.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
}

/** Write the user appearance sheet, replacing whatever was there. Test seam. */
export function setUserThemeCss(css: string): void {
  setStyle(UI_STYLE_ID, wrapLayer(css));
}

/**
 * The selected typography theme's CSS with its assets inlined — read once
 * per file text, then served from memory. Built-ins have no sheet of their
 * own (the generator installed all five at startup).
 */
export async function inlinedMarkdownCss(entry: ThemeEntry): Promise<string> {
  if (entry.source === "builtin" || !entry.css) return "";
  const key = entry.path ?? entry.id;
  const hit = inlined.get(key);
  if (hit && hit.css === entry.css) return hit.out;
  const out = entry.assets?.length && entry.path && isTauri
    ? await inlineAssets(entry.css, themeBaseDir(entry.path), entry.assets)
    : entry.css;
  inlined.set(key, { css: entry.css, out });
  return out;
}

let mdInstallSeq = 0;

/**
 * Install the selected typography theme: `data-md-theme` names the built-in
 * base it sits on (the generator's variables and rules), and the file's own
 * CSS goes into the second sheet. A built-in selection clears that sheet.
 */
async function installMarkdownSheet(): Promise<void> {
  const seq = ++mdInstallSeq;
  const entry = resolvedMarkdownTheme();
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute(MD_THEME_ATTR, entry.source === "builtin" ? entry.id : entry.extends);
  }
  const css = await inlinedMarkdownCss(entry);
  if (seq !== mdInstallSeq) return; // a later selection already superseded this one
  setStyle(MD_STYLE_ID, css);
}

/**
 * Validate and install theme files handed in as text — what every reader
 * above goes through, and the seam a caller with the bytes in hand (a test
 * in a real browser, a future watcher) uses directly. `replace` swaps the
 * whole set of that folder; otherwise files not yet known are added.
 */
export function loadThemeFiles(
  texts: ThemeFileText[],
  selected: SelectedThemes,
  opts: { replace?: boolean; dir?: string; project?: boolean } = {},
): Registry {
  const fresh = texts.map(validateFile);
  if (opts.project) {
    if (opts.dir !== undefined) projectDir = opts.dir;
    projectFiles = opts.replace ? fresh : merge(projectFiles, fresh);
  } else {
    if (opts.dir !== undefined) userDir = opts.dir;
    userFiles = opts.replace ? fresh : merge(userFiles, fresh);
  }
  return rebuildRegistry(selected);
}

const merge = (have: ScannedThemeFile[], add: ScannedThemeFile[]) =>
  [...have, ...add.filter((f) => !have.some((k) => k.fileName === f.fileName))];

/**
 * Which of the three selected ids name a **file** rather than a built-in.
 *
 * The two namespaces are separate and the test has to be too: `paper` and
 * `night` are reserved for appearance themes, `manuscript` / `clean` /
 * `magazine` / `wechat` / `typewriter` for typography themes, and nothing
 * reserves one against the other. Testing every id against both lists — which
 * is what this replaced — meant an appearance theme the author had named
 * `clean.css` was silently never read at boot: it installs and applies while
 * Settings is open (the folder has been scanned by then), and then falls back
 * to the built-in on every launch after, because the preload dropped its id as
 * "a built-in markdown theme". `registry.ts` only reserves ids within a kind,
 * so this must match it.
 */
export function fileBackedIds(selected: SelectedThemes): string[] {
  const ui = [selected.light, selected.dark].filter((id) => !isBuiltinUiId(id));
  const md = isBuiltinMarkdownId(selected.markdown) ? [] : [selected.markdown];
  return [...new Set([...ui, ...md])];
}

/**
 * Boot: read the selected files only, from the installation folder. Outside
 * Tauri, or when nothing but built-ins is selected, this does no I/O at all.
 * A project theme cannot be selected here — no project is open at boot; it
 * installs when `setProjectDir` runs.
 */
export async function preloadSelectedThemes(selected: SelectedThemes): Promise<void> {
  const ids = fileBackedIds(selected);
  if (!isTauri || !ids.length) return;
  const dir = await themesDir();
  const known = new Set(userFiles.map((f) => themeIdFromFileName(f.fileName)));
  const texts: ThemeFileText[] = [];
  for (const id of ids) {
    if (known.has(id)) continue;
    const f = await readThemeById(dir, id);
    if (f) texts.push(f);
  }
  // Read the selected typography theme's assets before the first paint too.
  loadThemeFiles(texts, selected, { dir });
  await inlinedMarkdownCss(resolvedMarkdownTheme());
}

/** The settings page's 重新载入, and the first open of the page: both folders. */
export async function reloadThemes(selected: SelectedThemes): Promise<Registry> {
  scanned = true;
  // Outside Tauri there is no folder to scan: whatever `loadThemeFiles` was
  // handed stays, and a reload is a rebuild.
  if (!isTauri) return rebuildRegistry(selected);
  userDir = await themesDir();
  userFiles = (await scanThemeFiles(userDir)).map(validateFile);
  projectFiles = projectDir ? (await scanThemeFiles(projectDir)).map(validateFile) : [];
  return rebuildRegistry(selected);
}

/**
 * A project opened (or closed, `null`): its `.ai-writer/themes/` replaces the
 * previous project's in the registry. Read in full — a project's brand
 * typography is what the author opened it to see.
 */
export async function setProjectDir(projectPath: string | null, selected: SelectedThemes): Promise<Registry> {
  projectDir = projectPath ? projectThemesDir(projectPath) : undefined;
  projectFiles = projectDir && isTauri ? (await scanThemeFiles(projectDir)).map(validateFile) : [];
  return rebuildRegistry(selected);
}

/**
 * Make sure the selected ids are loaded, reading only what the registry does
 * not know yet — the path a preference change takes when the settings page
 * has not opened (a config import, a focus refresh from another window).
 */
export async function ensureSelectedLoaded(selected: SelectedThemes): Promise<void> {
  const known = new Set([...userFiles, ...projectFiles].map((f) => themeIdFromFileName(f.fileName)));
  const wanted = fileBackedIds(selected).filter((id) => !known.has(id));
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

/** Apply the appearance theme that resolves for `scheme` under the current selection. */
export function applyResolvedTheme(scheme: ColorScheme, selectedId: string): ThemeEntry {
  const entry = resolveUiTheme(current.ui, scheme, selectedId);
  applyThemeId(entry.id, scheme);
  return entry;
}

/**
 * Apply the typography theme for `id`: the registry is rebuilt if the
 * selection moved (a `missing` marker may follow), and the sheet installed.
 */
export function applyResolvedMarkdownTheme(id: string): ThemeEntry {
  if (selection.markdown !== id) rebuildRegistry({ ...selection, markdown: id });
  else void installMarkdownSheet();
  return resolvedMarkdownTheme();
}

/** Test seam. */
export function resetThemesForTest(): void {
  current = { ui: [...BUILTIN_UI_THEMES], markdown: [...BUILTIN_MARKDOWN_THEMES] };
  userFiles = [];
  projectFiles = [];
  userDir = "";
  projectDir = undefined;
  scanned = false;
  selection = { light: "paper", dark: "night", markdown: "manuscript" };
  inlined.clear();
}
