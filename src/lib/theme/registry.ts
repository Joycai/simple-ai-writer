/**
 * The merged view of appearance themes — built-in plus whatever the themes
 * folder holds — as the settings grid and the switcher see it. Pure: the disk
 * is read by `scan.ts`, the CSS parsed by `validate.ts`; this decides what
 * the results mean together.
 *
 * `ThemeEntry` is the data boundary the design was drawn against (设计稿 05i
 * 「数据边界」): a card can show nothing that is not on it.
 */
import type { ColorScheme } from "./scheme";
import { BUILTIN_THEME_FOR_SCHEME } from "./scheme";
import { BUILTIN_UI_IDS, readThemeMeta, themeIdFromFileName, type ThemeProblem } from "./manifest";
import type { UiThemeValidation } from "./validate";

export type ThemeSource = "builtin" | "user";

export interface ThemeEntry {
  id: string;
  kind: "ui";
  /** Built-ins are bilingual; a user theme has the one name its file wrote. */
  name: { zh: string; en: string } | string;
  scheme: ColorScheme;
  /** The built-in the cascade bases it on. */
  extends: string;
  source: ThemeSource;
  path?: string;
  fileName?: string;
  version?: string;
  author?: string;
  /** Dropped rules / declarations. Empty = clean. */
  problems: ThemeProblem[];
  /** Kept declarations — 「其余 N 条已生效」. */
  kept: number;
  /** False when the file exists but cannot be used (metadata unreadable, id reserved). */
  usable: boolean;
  /** The preference names it, the folder does not have it — already fallen back. */
  missing?: boolean;
  /** The kept tokens, for the installed sheet and the export. User themes only. */
  tokens?: Record<string, string>;
}

export const BUILTIN_UI_THEMES: readonly ThemeEntry[] = [
  {
    id: "paper", kind: "ui", name: { zh: "纸", en: "Paper" }, scheme: "light", extends: "paper",
    source: "builtin", problems: [], kept: 0, usable: true,
  },
  {
    id: "night", kind: "ui", name: { zh: "夜", en: "Night" }, scheme: "dark", extends: "night",
    source: "builtin", problems: [], kept: 0, usable: true,
  },
];

/** One file the scan found, after validation — or the reason it could not be read. */
export interface ScannedThemeFile {
  fileName: string;
  path: string;
  validation?: UiThemeValidation;
  /** The read failed (permissions, encoding). The card still stands. */
  error?: string;
}

export interface UiRegistry {
  entries: ThemeEntry[];
  /** Files that declared `--theme-kind: markdown` — S3's; counted, not listed here. */
  markdownFiles: number;
}

export function displayThemeName(entry: Pick<ThemeEntry, "name">, isZh: boolean): string {
  return typeof entry.name === "string" ? entry.name : isZh ? entry.name.zh : entry.name.en;
}

export function isBuiltinUiId(id: string): boolean {
  return BUILTIN_UI_IDS.includes(id);
}

/**
 * Build the registry from the folder's files and the two selected ids.
 *
 * Order is one rule (设计稿 1z A2): built-in → the author's, then by file
 * name, never dragged. A selected id no file provides becomes a `missing`
 * entry standing where the file's card would — the preference is left alone,
 * because putting the file back is all it takes to revive it.
 */
export function buildUiRegistry(
  files: ScannedThemeFile[],
  selected: Record<ColorScheme, string>,
  themesDir: string,
): UiRegistry {
  const users: ThemeEntry[] = [];
  let markdownFiles = 0;
  for (const f of files) {
    const id = themeIdFromFileName(f.fileName);
    if (!id) continue;
    const entry = entryFromFile(id, f);
    if (entry === "markdown") {
      markdownFiles++;
      continue;
    }
    users.push(entry);
  }
  users.sort((a, b) => (a.fileName ?? a.id).localeCompare(b.fileName ?? b.id, "zh-Hans-CN"));

  const entries: ThemeEntry[] = [...BUILTIN_UI_THEMES, ...users];
  for (const scheme of ["light", "dark"] as const) {
    const id = selected[scheme];
    if (entries.some((e) => e.id === id)) continue;
    const fileName = `${id}.css`;
    entries.push({
      id, kind: "ui", name: id, scheme, extends: BUILTIN_THEME_FOR_SCHEME[scheme], source: "user",
      path: `${themesDir}/${fileName}`, fileName, problems: [], kept: 0, usable: false, missing: true,
    });
  }
  return { entries, markdownFiles };
}

function entryFromFile(id: string, f: ScannedThemeFile): ThemeEntry | "markdown" {
  const base = { id, kind: "ui" as const, source: "user" as const, path: f.path, fileName: f.fileName };
  if (!f.validation) {
    return {
      ...base, name: f.fileName, scheme: "light", extends: "paper", kept: 0, usable: false,
      problems: [{ rule: 0, reason: f.error ? `读不出文件 · ${f.error}` : "读不出文件" }],
    };
  }
  const { meta, problems } = readThemeMeta(f.validation.meta);
  const allProblems = [...problems, ...f.validation.problems];
  if (!meta) {
    return { ...base, name: f.fileName, scheme: "light", extends: "paper", kept: f.validation.kept, usable: false, problems: allProblems };
  }
  if (meta.kind === "markdown") return "markdown";
  const scheme = meta.scheme as ColorScheme;
  if (isBuiltinUiId(id)) {
    return {
      ...base, name: meta.name, scheme, extends: meta.extends, kept: f.validation.kept, usable: false,
      problems: [{ rule: 0, selector: f.fileName, reason: `「${id}」是内置主题的名字 · 换个文件名` }, ...allProblems],
    };
  }
  return {
    ...base,
    name: meta.name,
    scheme,
    extends: meta.extends,
    ...(meta.version ? { version: meta.version } : {}),
    ...(meta.author ? { author: meta.author } : {}),
    problems: allProblems,
    kept: f.validation.kept,
    usable: true,
    tokens: f.validation.tokens,
  };
}

export function findEntry(entries: readonly ThemeEntry[], id: string): ThemeEntry | undefined {
  return entries.find((e) => e.id === id);
}

/**
 * The theme that actually applies for `scheme` when the preference says `id`:
 * the entry itself when it is usable and of that polarity, otherwise the
 * built-in base. The preference is never rewritten by this.
 */
export function resolveUiTheme(entries: readonly ThemeEntry[], scheme: ColorScheme, id: string): ThemeEntry {
  const entry = findEntry(entries, id);
  if (entry && entry.usable && !entry.missing && entry.scheme === scheme) return entry;
  return findEntry(entries, BUILTIN_THEME_FOR_SCHEME[scheme]) ?? BUILTIN_UI_THEMES[scheme === "light" ? 0 : 1];
}

/** Everything the installed user sheet has to carry: every usable user theme. */
export function installableEntries(entries: readonly ThemeEntry[]): ThemeEntry[] {
  return entries.filter((e) => e.source === "user" && e.usable && e.tokens);
}

/** The 「N 个可用」 count: usable cards, built-ins included. */
export function usableCount(entries: readonly ThemeEntry[]): number {
  return entries.filter((e) => e.usable).length;
}
