/** Durable submit/poll identity; a unique reservation prevents duplicate POSTs. */
import { getGlobalDb } from "../project";
interface ImageTask { taskId: string; requestId: string; submittedAt: number; }
export async function imageTaskKey(endpoint: string, model: string, key: string, body: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([endpoint, model, key, body]));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
}
async function database() {
  const db = await getGlobalDb();
  await db.execute(`CREATE TABLE IF NOT EXISTS image_tasks (
    task_key TEXT PRIMARY KEY, task_id TEXT NOT NULL, request_id TEXT NOT NULL, submitted_at INTEGER NOT NULL,
    endpoint TEXT, model_id TEXT
  )`);
  const columns = await db.select<{ name: string }[]>("PRAGMA table_info(image_tasks)");
  for (const column of ["endpoint", "model_id"]) {
    if (columns.some(c => c.name === column)) continue;
    try { await db.execute(`ALTER TABLE image_tasks ADD COLUMN ${column} TEXT`); }
    catch (e) { if (!/duplicate column/i.test(String(e))) throw e; }
  }
  return db;
}
export async function readImageTask(key: string): Promise<ImageTask | undefined> {
  const db = await database();
  const rows = await db.select<ImageTask[]>(`SELECT task_id AS taskId, request_id AS requestId, submitted_at AS submittedAt
    FROM image_tasks WHERE task_key = ?`, [key]);
  return rows[0];
}
/** Reserve before a billed request. An unknown submission is never replayed automatically. */
export async function reserveImageTask(key: string, context?: { endpoint: string; modelId: string }): Promise<boolean> {
  const db = await database();
  const result = await db.execute(`INSERT OR IGNORE INTO image_tasks (task_key, task_id, request_id, submitted_at, endpoint, model_id)
    VALUES (?, '', ?, ?, ?, ?)`, [key, crypto.randomUUID(), Date.now(), context?.endpoint ?? null, context?.modelId ?? null]);
  return result.rowsAffected === 1;
}
export async function saveImageTask(key: string, task: ImageTask): Promise<void> {
  const db = await database();
  await db.execute(`UPDATE image_tasks SET task_id = ?, request_id = ?, submitted_at = ? WHERE task_key = ?`,
    [task.taskId, task.requestId, task.submittedAt, key]);
}
export async function forgetImageTask(key: string): Promise<void> {
  const db = await database();
  await db.execute("DELETE FROM image_tasks WHERE task_key = ?", [key]);
}

export async function listImageTasks(endpoint: string, modelId: string): Promise<(ImageTask & { key: string })[]> {
  const db = await database();
  return db.select(`SELECT task_key AS key, task_id AS taskId, request_id AS requestId, submitted_at AS submittedAt
    FROM image_tasks WHERE endpoint = ? AND model_id = ? ORDER BY submitted_at DESC`, [endpoint, modelId]);
}
