/**
 * The themes folder — the one place this feature touches the disk.
 *
 * Installation-level, `appDataDir/themes/` (docs/feature/theme-system-plan.md
 * §6): a theme is taste, and taste belongs to the machine, not the project.
 * The folder is inside the app data directory the Rust side already scopes at
 * startup (`lib.rs`), so no new root is registered for it. A folder that does
 * not exist is not an error — it is "no user themes", and 「打开主题文件夹」
 * creates it on the way.
 */
import { fileExists, makeDir, readDir, readFile } from "../fs/fileio";
import { joinPath } from "../paths";
import { THEME_FILE_EXT } from "./manifest";

export const THEMES_DIR_NAME = "themes";

let cachedDir: string | null = null;

export async function themesDir(): Promise<string> {
  if (cachedDir) return cachedDir;
  const { appDataDir } = await import("@tauri-apps/api/path");
  cachedDir = joinPath(await appDataDir(), THEMES_DIR_NAME);
  return cachedDir;
}

/** Create the folder if it is not there yet; returns its path. */
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

/** Every `.css` file in the folder, read. Missing folder = empty list. */
export async function scanThemeFiles(): Promise<ThemeFileText[]> {
  const dir = await themesDir();
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

/** One theme file by id — what startup reads instead of the whole folder. */
export async function readThemeById(id: string): Promise<ThemeFileText | null> {
  const dir = await themesDir();
  const fileName = `${id}${THEME_FILE_EXT}`;
  const path = joinPath(dir, fileName);
  if (!(await fileExists(path))) return null;
  return readThemeFile(fileName, path);
}

async function readThemeFile(fileName: string, path: string): Promise<ThemeFileText> {
  try {
    return { fileName, path, text: await readFile(path) };
  } catch (e) {
    return { fileName, path, error: String(e) };
  }
}
