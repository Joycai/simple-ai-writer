/** Disposable derived data; never contains API keys or source descriptions. */
import { getDb } from "../project";
import { sqlTransaction } from "../sqlTx";

interface CachedEmbedding { entry: string; hash: string; vector: number[] }
async function database(project: string) {
  const db = await getDb(project);
  await db.execute(`CREATE TABLE IF NOT EXISTS kb_embeddings (
    namespace TEXT NOT NULL, entry TEXT NOT NULL, hash TEXT NOT NULL, vector TEXT NOT NULL,
    PRIMARY KEY (namespace, entry))`);
  return db;
}
export async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
function validVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 65536
    && value.every((v) => typeof v === "number" && Number.isFinite(v)) && value.some((v) => v !== 0);
}
export async function readEmbeddings(project: string, namespace: string): Promise<Map<string, CachedEmbedding>> {
  const db = await database(project);
  const rows = await db.select<{ entry: string; hash: string; vector: string }[]>(
    "SELECT entry, hash, vector FROM kb_embeddings WHERE namespace = ?", [namespace]);
  const result = new Map<string, CachedEmbedding>();
  for (const row of rows) {
    try { const vector: unknown = JSON.parse(row.vector); if (validVector(vector)) result.set(row.entry, { ...row, vector }); }
    catch { /* Corrupt derived data is a cache miss, never a broken project. */ }
  }
  return result;
}
export async function writeEmbeddings(project: string, namespace: string, rows: CachedEmbedding[]): Promise<void> {
  await database(project);
  await sqlTransaction(`${project}/.ai-writer/project.db`, rows.map((r) => ({
    sql: "INSERT OR REPLACE INTO kb_embeddings (namespace, entry, hash, vector) VALUES (?, ?, ?, ?)",
    values: [namespace, r.entry, r.hash, JSON.stringify(r.vector)],
  })));
}
export async function invalidateEmbeddings(project: string, namespace: string): Promise<void> {
  await (await database(project)).execute("DELETE FROM kb_embeddings WHERE namespace = ?", [namespace]);
}
/** Called with the full index, not the source scope: hidden entries are not deleted. */
export async function pruneEmbeddings(project: string, entries: string[]): Promise<void> {
  await (await database(project)).execute(
    "DELETE FROM kb_embeddings WHERE entry NOT IN (SELECT value FROM json_each(?))", [JSON.stringify(entries)]);
}

export async function removeEmbeddings(project: string, namespace: string, entries: string[]): Promise<void> {
  await (await database(project)).execute(
    "DELETE FROM kb_embeddings WHERE namespace = ? AND entry IN (SELECT value FROM json_each(?))", [namespace, JSON.stringify(entries)]);
}
