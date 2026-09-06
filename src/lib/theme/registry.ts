/**
 * The merged view of themes — built-in plus whatever the folders hold — as
 * the settings grids and the switchers see it. Pure: the disk is read by
 * `scan.ts`, the CSS parsed by `validate.ts`; this decides what the results
 * mean together.
 *
 * `ThemeEntry` is the data boundary the design was drawn against (设计稿 05i
 * 「数据边界」): a card can show nothing that is not on it. One shape for both
 * kinds — the ui fields (`scheme`, `tokens`) and the markdown fields (`css`,
 * `ownFonts`…) are optional and set by kind.
 */
import type { ColorScheme } from "./scheme";
import { BUILTIN_THEME_FOR_SCHEME } from "./scheme";
import {
  BUILTIN_MARKDOWN_IDS, BUILTIN_UI_IDS, readThemeMeta, themeIdFromFileName, type ThemeKind, type ThemeProblem,
} from "./manifest";
import { DEFAULT_MARKDOWN_THEME, MARKDOWN_THEMES } from "./markdownThemes";
import type { ThemeValidation } from "./validate";

export type ThemeSource = "builtin" | "user" | "project";

export interface ThemeEntry {
  id: string;
  kind: ThemeKind;
  /** Built-ins are bilingual; a user theme has the one name its file wrote. */
  name: { zh: string; en: string } | string;
  /** Built-in markdown themes carry a one-line description. */
  desc?: { zh: string; en: string };
  /** ui only: the polarity the file declared. */
  scheme?: ColorScheme;
  /** The built-in the cascade bases it on. */
  extends: string;
  source: ThemeSource;
  path?: string;
  fileName?: string;
  version?: string;
  author?: string;
  /** Dropped rules / declarations. Empty = clean. */
  problems: ThemeProblem[];
  /** Kept declarations (ui) or top-level rules (markdown) — 「其余 N 条已生效」. */
  kept: number;
  /** False when the file exists but cannot be used (metadata unreadable, id reserved, wrong folder). */
  usable: boolean;
  /** The preference names it, the folder does not have it — already fallen back. */
  missing?: boolean;
  /** ui: the kept tokens, for the installed sheet and the export. */
  tokens?: Record<string, string>;
  /** markdown: the validated CSS with relative `url()`s, and what they name. */
  css?: string;
  assets?: string[];
  ownFonts?: boolean;
  ownColors?: boolean;
}

/**
 * The built-in appearance themes, 内置 → the grid's first cards, in this order.
 *
 * 纸 / 夜 are the two **bases**: their core lives in `tokens.scheme`, keyed by
 * polarity, and `resolveUiTheme` falls back to them. 石 / 墨 (设计稿 05j
 * 「石墨 Graphite」) are the second pair — a cold-grey ground with a 青黛
 * accent — and they are *not* bases: they write the 37 core tokens in
 * `tokens.theme` and take every derived token from `tokens.derive`, exactly
 * as a theme file does. That is deliberate (theme-system-plan.md §4): the
 * derive layer had never been seen without a hand-tune under it.
 */
export const BUILTIN_UI_THEMES: readonly ThemeEntry[] = [
  {
    id: "paper", kind: "ui", name: { zh: "纸", en: "Paper" }, scheme: "light", extends: "paper",
    source: "builtin", problems: [], kept: 0, usable: true,
  },
  {
    id: "night", kind: "ui", name: { zh: "夜", en: "Night" }, scheme: "dark", extends: "night",
    source: "builtin", problems: [], kept: 0, usable: true,
  },
  {
    id: "stone", kind: "ui", name: { zh: "石", en: "Stone" }, scheme: "light", extends: "paper",
    source: "builtin", problems: [], kept: 0, usable: true,
  },
  {
    id: "ink", kind: "ui", name: { zh: "墨", en: "Ink" }, scheme: "dark", extends: "night",
    source: "builtin", problems: [], kept: 0, usable: true,
  },
];

export const BUILTIN_MARKDOWN_THEMES: readonly ThemeEntry[] = MARKDOWN_THEMES.map((t) => ({
  id: t.id, kind: "markdown", name: t.label, desc: t.desc, extends: t.id,
  source: "builtin", problems: [], kept: 0, usable: true,
}));

/** One file the scan found, after validation — or the reason it could not be read. */
export interface ScannedThemeFile {
  fileName: string;
  path: string;
  validation?: ThemeValidation;
  /** The read failed (permissions, encoding). The card still stands. */
  error?: string;
}

export interface SelectedThemes {
  light: string;
  dark: string;
  markdown: string;
}

export interface Registry {
  ui: ThemeEntry[];
  markdown: ThemeEntry[];
}

export interface RegistryDirs {
  /** Installation-level `appDataDir/themes`. */
  user: string;
  /** The open project's `.ai-writer/themes`, when a project is open. */
  project?: string;
}

export function displayThemeName(entry: Pick<ThemeEntry, "name">, isZh: boolean): string {
  return typeof entry.name === "string" ? entry.name : isZh ? entry.name.zh : entry.name.en;
}

export function isBuiltinUiId(id: string): boolean {
  return BUILTIN_UI_IDS.includes(id);
}

export function isBuiltinMarkdownId(id: string): boolean {
  return BUILTIN_MARKDOWN_IDS.includes(id);
}

const byFileName = (a: ThemeEntry, b: ThemeEntry) =>
  (a.fileName ?? a.id).localeCompare(b.fileName ?? b.id, "zh-Hans-CN");

/**
 * Build the registry from the folders' files and the selected ids.
 *
 * Order is one rule (设计稿 1z A2): built-in → the author's → the project's,
 * each group by file name, never dragged. A project file with a user file's
 * id replaces it whole (the `.ai-writer/workflows/` precedent). A ui theme in
 * the project folder is refused — appearance is this machine's taste, and a
 * repository must not be able to recolour the app (1z A3). A selected id no
 * file provides becomes a `missing` entry standing where the card would; the
 * preference is left alone, because putting the file back is all it takes.
 */
export function buildRegistry(
  userFiles: ScannedThemeFile[],
  projectFiles: ScannedThemeFile[],
  selected: SelectedThemes,
  dirs: RegistryDirs,
): Registry {
  const ui: ThemeEntry[] = [];
  const userMd: ThemeEntry[] = [];
  const projectMd: ThemeEntry[] = [];
  for (const f of userFiles) {
    const id = themeIdFromFileName(f.fileName);
    if (!id) continue;
    const e = entryFromFile(id, f, "user");
    (e.kind === "markdown" ? userMd : ui).push(e);
  }
  for (const f of projectFiles) {
    const id = themeIdFromFileName(f.fileName);
    if (!id) continue;
    const e = entryFromFile(id, f, "project");
    if (e.kind === "ui") {
      // Shown, so the author learns why the file did nothing — but never usable.
      projectMd.push({
        ...e, kind: "markdown", scheme: undefined, tokens: undefined, usable: false,
        problems: [{ rule: 0, selector: f.fileName, reason: "uiInProject" }, ...e.problems],
      });
    } else projectMd.push(e);
  }
  ui.sort(byFileName);
  userMd.sort(byFileName);
  projectMd.sort(byFileName);
  const projectIds = new Set(projectMd.map((e) => e.id));

  const uiAll: ThemeEntry[] = [...BUILTIN_UI_THEMES, ...ui];
  for (const scheme of ["light", "dark"] as const) {
    const id = selected[scheme];
    if (uiAll.some((e) => e.id === id)) continue;
    const fileName = `${id}.css`;
    uiAll.push({
      id, kind: "ui", name: id, scheme, extends: BUILTIN_THEME_FOR_SCHEME[scheme], source: "user",
      path: `${dirs.user}/${fileName}`, fileName, problems: [], kept: 0, usable: false, missing: true,
    });
  }

  const mdAll: ThemeEntry[] = [
    ...BUILTIN_MARKDOWN_THEMES,
    ...userMd.filter((e) => !projectIds.has(e.id)),
    ...projectMd,
  ];
  if (!mdAll.some((e) => e.id === selected.markdown)) {
    const fileName = `${selected.markdown}.css`;
    mdAll.push({
      id: selected.markdown, kind: "markdown", name: selected.markdown, extends: DEFAULT_MARKDOWN_THEME,
      source: "user", path: `${dirs.user}/${fileName}`, fileName, problems: [], kept: 0, usable: false, missing: true,
    });
  }
  return { ui: uiAll, markdown: mdAll };
}

function entryFromFile(id: string, f: ScannedThemeFile, source: "user" | "project"): ThemeEntry {
  const base = { id, source, path: f.path, fileName: f.fileName };
  if (!f.validation) {
    return {
      ...base, kind: "ui", name: f.fileName, scheme: "light", extends: "paper", kept: 0, usable: false,
      problems: [{ rule: 0, reason: "unreadableFile", params: { error: f.error ?? "" } }],
    };
  }
  const v = f.validation;
  const { meta, problems } = readThemeMeta(v.meta);
  const allProblems = [...problems, ...v.problems];
  if (!meta) {
    return {
      ...base, kind: v.kind, name: f.fileName, extends: v.kind === "ui" ? "paper" : DEFAULT_MARKDOWN_THEME,
      ...(v.kind === "ui" ? { scheme: "light" as const } : {}),
      kept: v.kept, usable: false, problems: allProblems,
    };
  }
  const named = {
    ...base,
    name: meta.name,
    extends: meta.extends,
    ...(meta.version ? { version: meta.version } : {}),
    ...(meta.author ? { author: meta.author } : {}),
    kept: v.kept,
  };
  if (v.kind === "ui") {
    const scheme = meta.scheme as ColorScheme;
    if (isBuiltinUiId(id)) {
      return {
        ...named, kind: "ui", scheme, usable: false,
        problems: [{ rule: 0, selector: f.fileName, reason: "reservedUiId", params: { id } }, ...allProblems],
      };
    }
    return { ...named, kind: "ui", scheme, problems: allProblems, usable: true, tokens: v.tokens };
  }
  if (isBuiltinMarkdownId(id)) {
    return {
      ...named, kind: "markdown", usable: false,
      problems: [{ rule: 0, selector: f.fileName, reason: "reservedMdId", params: { id } }, ...allProblems],
    };
  }
  return {
    ...named, kind: "markdown", problems: allProblems, usable: true,
    css: v.css, assets: v.assets, ownFonts: v.ownFonts, ownColors: v.ownColors,
  };
}

export function findEntry(entries: readonly ThemeEntry[], id: string): ThemeEntry | undefined {
  return entries.find((e) => e.id === id);
}

/**
 * The ui theme that actually applies for `scheme` when the preference says
 * `id`: the entry itself when it is usable and of that polarity, otherwise
 * the built-in base. The preference is never rewritten by this.
 */
export function resolveUiTheme(entries: readonly ThemeEntry[], scheme: ColorScheme, id: string): ThemeEntry {
  const entry = findEntry(entries, id);
  if (entry && entry.usable && !entry.missing && entry.scheme === scheme) return entry;
  const base = BUILTIN_THEME_FOR_SCHEME[scheme];
  return findEntry(entries, base) ?? findEntry(BUILTIN_UI_THEMES, base) ?? BUILTIN_UI_THEMES[0];
}

/** The markdown theme that applies for `id`; the default built-in when it cannot. */
export function resolveMarkdownTheme(entries: readonly ThemeEntry[], id: string): ThemeEntry {
  const entry = findEntry(entries, id);
  if (entry && entry.usable && !entry.missing) return entry;
  return findEntry(entries, DEFAULT_MARKDOWN_THEME) ?? BUILTIN_MARKDOWN_THEMES[0];
}

/** Everything the installed ui sheet has to carry: every usable user theme. */
export function installableEntries(entries: readonly ThemeEntry[]): ThemeEntry[] {
  return entries.filter((e) => e.source !== "builtin" && e.usable && e.tokens);
}

/** The 「N 个可用」 count: usable cards, built-ins included. */
export function usableCount(entries: readonly ThemeEntry[]): number {
  return entries.filter((e) => e.usable).length;
}
