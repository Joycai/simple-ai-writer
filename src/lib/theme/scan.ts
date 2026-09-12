/**
 * The themes folders — the one place this feature touches the disk.
 *
 * Two of them (docs/feature/theme-system-plan.md §6): the installation-level
 * `appDataDir/themes/` holds appearance and typography themes alike — a
 * theme is taste, and taste belongs to the machine — and a project's
 * `.ai-writer/themes/` holds typography themes only, the brand look that
 * ships with a repository. The first is inside the app data directory the
 * Rust side already scopes at startup (`lib.rs`), the second inside the
 * project root. A folder that does not exist is not an error — it is "no
 * user themes", and 「打开主题文件夹」 creates the first one on the way.
 */
import { fileExists, makeDir, readDir, readFile } from "../fs/fileio";
import { dirName, joinPath } from "../paths";
import { THEME_FILE_EXT } from "./manifest";

const THEMES_DIR_NAME = "themes";
export const PROJECT_THEMES_DIR = `.ai-writer/${THEMES_DIR_NAME}`;

let cachedDir: string | null = null;

export async function themesDir(): Promise<string> {
  if (cachedDir) return cachedDir;
  const { appDataDir } = await import("@tauri-apps/api/path");
  cachedDir = joinPath(await appDataDir(), THEMES_DIR_NAME);
  return cachedDir;
}

export function projectThemesDir(projectPath: string): string {
  return joinPath(projectPath, PROJECT_THEMES_DIR);
}

/** Create the installation folder if it is not there yet; returns its path. */
export async function ensureThemesDir(): Promise<string> {
  const dir = await themesDir();
  if (!(await fileExists(dir))) await makeDir(dir);
  return dir;
}

export interface ThemeFileText {
  fileName: string;
  path: string;
  text?: string;
  error?: string;
}

/** Every `.css` file in `dir`, read. Missing folder = empty list. */
export async function scanThemeFiles(dir: string): Promise<ThemeFileText[]> {
  let entries;
  try {
    entries = await readDir(dir);
  } catch {
    return [];
  }
  const out: ThemeFileText[] = [];
  for (const e of entries) {
    if (e.isDirectory || !e.name.endsWith(THEME_FILE_EXT)) continue;
    out.push(await readThemeFile(e.name, e.path));
  }
  return out;
}

/** One theme file by id in `dir` — what startup reads instead of the whole folder. */
export async function readThemeById(dir: string, id: string): Promise<ThemeFileText | null> {
  const fileName = `${id}${THEME_FILE_EXT}`;
  const path = joinPath(dir, fileName);
  if (!(await fileExists(path))) return null;
  return readThemeFile(fileName, path);
}

/** The folder a theme file's relative `url()`s resolve against. */
export function themeBaseDir(path: string): string {
  return dirName(path);
}

async function readThemeFile(fileName: string, path: string): Promise<ThemeFileText> {
  try {
    return { fileName, path, text: await readFile(path) };
  } catch (e) {
    return { fileName, path, error: String(e) };
  }
}
