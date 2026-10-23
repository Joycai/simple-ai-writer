/** Disposable derived data; never contains API keys or source descriptions. */
import { getDb } from "../project";
import { sqlTransaction, type SqlStatement } from "../sqlTx";
import { DOCUMENT_CACHE_ACCESS_TABLE, documentCacheMaintenance } from "./documentCachePolicy";

interface CachedEmbedding { entry: string; hash: string; vector: number[] }
export async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
function validVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 65536
    && value.every((v) => typeof v === "number" && Number.isFinite(v)) && value.some((v) => v !== 0);
}
function embeddingCache(table: "kb_embeddings" | "document_embeddings") {
  async function database(project: string) {
    const db = await getDb(project);
    await db.execute(`CREATE TABLE IF NOT EXISTS ${table} (
      namespace TEXT NOT NULL, entry TEXT NOT NULL, hash TEXT NOT NULL, vector TEXT NOT NULL,
      PRIMARY KEY (namespace, entry))`);
    if (table === "document_embeddings") await db.execute(DOCUMENT_CACHE_ACCESS_TABLE);
    return db;
  }
  async function readEmbeddings(project: string, namespace: string): Promise<Map<string, CachedEmbedding>> {
    const db = await database(project);
    if (table === "document_embeddings") {
      await sqlTransaction(`${project}/.ai-writer/project.db`, documentCacheMaintenance(namespace));
    }
    const rows = await db.select<{ entry: string; hash: string; vector: string }[]>(
      `SELECT entry, hash, vector FROM ${table} WHERE namespace = ?`, [namespace]);
    const result = new Map<string, CachedEmbedding>();
    for (const row of rows) {
      try { const vector: unknown = JSON.parse(row.vector); if (validVector(vector)) result.set(row.entry, { ...row, vector }); }
      catch { /* Corrupt derived data is a cache miss, never a broken project. */ }
    }
    return result;
  }
  async function writeEmbeddings(project: string, namespace: string, rows: CachedEmbedding[]): Promise<void> {
    await database(project);
    const statements: SqlStatement[] = rows.map((r) => ({
      sql: `INSERT OR REPLACE INTO ${table} (namespace, entry, hash, vector) VALUES (?, ?, ?, ?)`,
      values: [namespace, r.entry, r.hash, JSON.stringify(r.vector)],
    }));
    if (table === "document_embeddings") statements.push(...documentCacheMaintenance(namespace));
    await sqlTransaction(`${project}/.ai-writer/project.db`, statements);
  }
  async function invalidateEmbeddings(project: string, namespace: string): Promise<void> {
    await (await database(project)).execute(`DELETE FROM ${table} WHERE namespace = ?`, [namespace]);
  }
  /** Called with the full index, not the source scope: hidden entries are not deleted. */
  async function pruneEmbeddings(project: string, entries: string[]): Promise<void> {
    await (await database(project)).execute(
      `DELETE FROM ${table} WHERE entry NOT IN (SELECT value FROM json_each(?))`, [JSON.stringify(entries)]);
  }

  async function removeEmbeddings(project: string, namespace: string, entries: string[]): Promise<void> {
    await (await database(project)).execute(
      `DELETE FROM ${table} WHERE namespace = ? AND entry IN (SELECT value FROM json_each(?))`, [namespace, JSON.stringify(entries)]);
  }

  async function pruneNamespace(project: string, namespace: string, entries: string[]): Promise<void> {
    await (await database(project)).execute(
      `DELETE FROM ${table} WHERE namespace = ? AND entry NOT IN (SELECT value FROM json_each(?))`,
      [namespace, JSON.stringify(entries)]);
  }
  return { readEmbeddings, writeEmbeddings, invalidateEmbeddings, pruneEmbeddings, removeEmbeddings, pruneNamespace };
}
export const { readEmbeddings, writeEmbeddings, invalidateEmbeddings, pruneEmbeddings, removeEmbeddings } = embeddingCache("kb_embeddings");
/** Separate table: KB catalog pruning must never erase document chunks. */
export const documentEmbeddingCache = embeddingCache("document_embeddings");
