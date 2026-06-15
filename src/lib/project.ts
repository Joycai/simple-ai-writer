import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import Database from "@tauri-apps/plugin-sql";

export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileNode[];
}

export async function openProjectFolder(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

export async function scaffoldProject(projectPath: string): Promise<void> {
  await invoke("scaffold_project", { projectPath });
}

export async function readDirRecursive(dirPath: string): Promise<FileNode[]> {
  return invoke("read_dir_recursive", { dirPath });
}

let _db: Awaited<ReturnType<typeof Database.load>> | null = null;

export async function getDb(projectPath: string) {
  if (_db) return _db;
  const dbPath = `${projectPath}/.ai-writer/project.db`;
  _db = await Database.load(`sqlite:${dbPath}`);
  await initSchema(_db);
  return _db;
}

export function resetDb() {
  _db = null;
}

async function initSchema(db: Awaited<ReturnType<typeof Database.load>>) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS lore_entities (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      dir_path TEXT NOT NULL,
      name TEXT NOT NULL,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      summary TEXT NOT NULL DEFAULT '',
      embedding_status TEXT NOT NULL DEFAULT 'pending',
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id TEXT NOT NULL,
      task TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
}
