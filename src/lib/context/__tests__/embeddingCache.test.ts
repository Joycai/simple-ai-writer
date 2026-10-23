import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCUMENT_CACHE_MAX_BYTES, DOCUMENT_CACHE_MAX_NAMESPACES } from "../documentCachePolicy";
import { readEmbeddings, writeEmbeddings, pruneEmbeddings, invalidateEmbeddings, removeEmbeddings, digest, documentEmbeddingCache } from "../embeddingCache";

const state = vi.hoisted(() => ({ db: null as DatabaseSync | null }));
vi.mock("../../project", () => ({ getDb: async () => ({
  execute: async (sql: string, values: SQLInputValue[] = []) => state.db!.prepare(sql).run(...values),
  select: async (sql: string, values: SQLInputValue[] = []) => state.db!.prepare(sql).all(...values),
}) }));
vi.mock("../../sqlTx", () => ({ sqlTransaction: async (_p: string, statements: { sql: string; values: SQLInputValue[] }[]) => {
  state.db!.exec("BEGIN IMMEDIATE");
  try {
    for (const s of statements) state.db!.prepare(s.sql).run(...s.values);
    state.db!.exec("COMMIT");
  } catch (error) { state.db!.exec("ROLLBACK"); throw error; }
} }));
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "embedding-cache-")); state.db = new DatabaseSync(join(dir, "cache.db")); });
afterEach(() => { state.db?.close(); rmSync(dir, { recursive: true, force: true }); });

describe("project embedding storage", () => {
  it("survives closing and reopening the database and replaces changed content", async () => {
    await writeEmbeddings(dir, "model-a", [{ entry: "a", hash: await digest("first"), vector: [1, 2] }]);
    state.db!.close(); state.db = new DatabaseSync(join(dir, "cache.db"));
    expect((await readEmbeddings(dir, "model-a")).get("a")?.vector).toEqual([1, 2]);
    await writeEmbeddings(dir, "model-a", [{ entry: "a", hash: await digest("changed"), vector: [3, 4] }]);
    const rows = await readEmbeddings(dir, "model-a");
    expect(rows.size).toBe(1); expect(rows.get("a")?.hash).toBe(await digest("changed"));
    expect(await digest("first")).not.toBe(await digest("changed"));
  });
  it("isolates models, prunes deleted entries and rejects corrupt vectors", async () => {
    for (const n of ["a", "b"]) await writeEmbeddings(dir, n, [
      { entry: "keep", hash: "h", vector: [1] }, { entry: "deleted", hash: "h", vector: [2] },
    ]);
    await removeEmbeddings(dir, "a", ["deleted"]);
    expect((await readEmbeddings(dir, "b")).size).toBe(2);
    await pruneEmbeddings(dir, ["keep"]);
    expect((await readEmbeddings(dir, "a")).size).toBe(1);
    await invalidateEmbeddings(dir, "a");
    expect((await readEmbeddings(dir, "a")).size).toBe(0);
    expect((await readEmbeddings(dir, "b")).size).toBe(1);
    state.db!.prepare("UPDATE kb_embeddings SET vector = ?").run("[0,0]");
    expect((await readEmbeddings(dir, "b")).size).toBe(0);
    state.db!.prepare("UPDATE kb_embeddings SET vector = ?").run("bad json");
    expect((await readEmbeddings(dir, "b")).size).toBe(0);
  });
});


describe("document vector isolation", () => {
  it("survives KB pruning and only removes stale chunks from its own document namespace", async () => {
    await writeEmbeddings(dir, "kb", [{ entry: "lore/a", hash: "h", vector: [1] }]);
    for (const namespace of ["document-a", "document-b"]) {
      await documentEmbeddingCache.writeEmbeddings(dir, namespace, [
        { entry: "keep", hash: "h", vector: [2] }, { entry: "old", hash: "h", vector: [3] },
      ]);
    }
    await pruneEmbeddings(dir, []);
    expect((await documentEmbeddingCache.readEmbeddings(dir, "document-a")).size).toBe(2);
    await documentEmbeddingCache.pruneNamespace(dir, "document-a", ["keep"]);
    expect((await documentEmbeddingCache.readEmbeddings(dir, "document-a")).size).toBe(1);
    expect((await documentEmbeddingCache.readEmbeddings(dir, "document-b")).size).toBe(2);
    await documentEmbeddingCache.invalidateEmbeddings(dir, "document-a");
    expect((await documentEmbeddingCache.readEmbeddings(dir, "document-b")).size).toBe(2);
  });
});


const cached = [{ entry: "chunk", hash: "hash", vector: [1, 2] }];
const namespaces = () => (state.db!.prepare("SELECT DISTINCT namespace FROM document_embeddings ORDER BY namespace")
  .all() as { namespace: string }[]).map((r) => r.namespace);
const payloadBytes = () => Number(state.db!.prepare(`SELECT COALESCE(SUM(length(CAST(namespace AS BLOB))
  + length(CAST(entry AS BLOB)) + length(CAST(hash AS BLOB)) + length(CAST(vector AS BLOB))), 0) AS bytes
  FROM document_embeddings`).get()!.bytes);

describe("document cache lifecycle", () => {
  it("evicts obsolete file/model namespaces and refreshes recency on cache hits", async () => {
    for (let i = 0; i < DOCUMENT_CACHE_MAX_NAMESPACES; i++) {
      await documentEmbeddingCache.writeEmbeddings(dir, `old-path-or-model-${i}`, cached);
    }
    await documentEmbeddingCache.readEmbeddings(dir, "old-path-or-model-0");
    await documentEmbeddingCache.writeEmbeddings(dir, "renamed-file-new-model", cached);
    expect(namespaces()).toHaveLength(DOCUMENT_CACHE_MAX_NAMESPACES);
    expect(namespaces()).toContain("old-path-or-model-0");
    expect(namespaces()).not.toContain("old-path-or-model-1");
    expect(namespaces()).toContain("renamed-file-new-model");
    expect(state.db!.prepare("SELECT count(*) AS n FROM document_embedding_access").get()!.n)
      .toBe(DOCUMENT_CACHE_MAX_NAMESPACES);
  });

  it("bounds legacy caches on first read without rewriting user tables or KB vectors", async () => {
    await writeEmbeddings(dir, "kb", cached);
    state.db!.exec(`CREATE TABLE document_embeddings (namespace TEXT, entry TEXT, hash TEXT, vector TEXT,
      PRIMARY KEY (namespace, entry));
      CREATE TABLE token_usage (cost_usd REAL); INSERT INTO token_usage VALUES (1.25);
      CREATE TABLE chat_sessions (content TEXT); INSERT INTO chat_sessions VALUES ('keep the author history');`);
    for (let i = 0; i < 12; i++) {
      state.db!.prepare("INSERT INTO document_embeddings VALUES (?, 'chunk', 'hash', '[1,2]')").run(`legacy-${i}`);
    }
    expect((await documentEmbeddingCache.readEmbeddings(dir, "legacy-9")).get("chunk")?.vector).toEqual([1, 2]);
    expect(namespaces()).toHaveLength(DOCUMENT_CACHE_MAX_NAMESPACES);
    expect((await readEmbeddings(dir, "kb")).size).toBe(1);
    expect(state.db!.prepare("SELECT * FROM token_usage").get()!.cost_usd).toBe(1.25);
    expect(state.db!.prepare("SELECT * FROM chat_sessions").get()!.content).toBe("keep the author history");
  });

  it("evicts by payload bytes even below the namespace-count limit", async () => {
    await documentEmbeddingCache.writeEmbeddings(dir, "old", cached);
    await documentEmbeddingCache.writeEmbeddings(dir, "recent", cached);
    // Large corrupt/legacy rows count toward the same bound as valid vectors.
    state.db!.prepare("UPDATE document_embeddings SET vector = zeroblob(?) WHERE namespace = 'old'")
      .run(40 * 1024 * 1024);
    state.db!.prepare("UPDATE document_embeddings SET vector = zeroblob(?) WHERE namespace = 'recent'")
      .run(30 * 1024 * 1024);
    await documentEmbeddingCache.writeEmbeddings(dir, "new", cached);
    expect(namespaces()).toEqual(["new", "recent"]);
    expect(payloadBytes()).toBeLessThanOrEqual(DOCUMENT_CACHE_MAX_BYTES);
  });

  it("drops an oversized namespace without displacing every smaller cache", async () => {
    await documentEmbeddingCache.writeEmbeddings(dir, "small", cached);
    await documentEmbeddingCache.writeEmbeddings(dir, "oversized", cached);
    state.db!.prepare("UPDATE document_embeddings SET vector = zeroblob(?) WHERE namespace = 'oversized'")
      .run(DOCUMENT_CACHE_MAX_BYTES + 1);
    expect((await documentEmbeddingCache.readEmbeddings(dir, "oversized")).size).toBe(0);
    expect(namespaces()).toEqual(["small"]);
    await documentEmbeddingCache.writeEmbeddings(dir, "oversized", cached);
    expect((await documentEmbeddingCache.readEmbeddings(dir, "oversized")).size).toBe(1);
    expect(payloadBytes()).toBeLessThanOrEqual(DOCUMENT_CACHE_MAX_BYTES);
  });

  it("serializes concurrent cache writes atomically and leaves already-read vectors usable", async () => {
    await documentEmbeddingCache.writeEmbeddings(dir, "active", cached);
    const inFlight = await documentEmbeddingCache.readEmbeddings(dir, "active");
    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      documentEmbeddingCache.writeEmbeddings(dir, `parallel-${i}`, cached)));
    expect(namespaces()).toHaveLength(DOCUMENT_CACHE_MAX_NAMESPACES);
    expect(namespaces()).not.toContain("active");
    expect(inFlight.get("chunk")?.vector).toEqual([1, 2]);
    expect(payloadBytes()).toBeLessThanOrEqual(DOCUMENT_CACHE_MAX_BYTES);
    // Subsequent passes can re-populate an evicted namespace without mixing models.
    await documentEmbeddingCache.writeEmbeddings(dir, "active", [{ ...cached[0], vector: [3, 4, 5] }]);
    expect((await documentEmbeddingCache.readEmbeddings(dir, "active")).get("chunk")?.vector).toEqual([3, 4, 5]);
  });

  it("rolls back a batch if its cache maintenance fails", async () => {
    await documentEmbeddingCache.writeEmbeddings(dir, "existing", cached);
    state.db!.exec(`CREATE TRIGGER reject_access BEFORE INSERT ON document_embedding_access
      WHEN NEW.namespace = 'failed' BEGIN SELECT RAISE(ABORT, 'maintenance failed'); END`);
    await expect(documentEmbeddingCache.writeEmbeddings(dir, "failed", cached)).rejects.toThrow("maintenance failed");
    expect(namespaces()).toEqual(["existing"]);
    expect((await documentEmbeddingCache.readEmbeddings(dir, "existing")).get("chunk")?.vector).toEqual([1, 2]);
  });

  it("preserves recency through a checkpointed project DB backup and restore", async () => {
    state.db!.exec("PRAGMA journal_mode = WAL");
    for (let i = 0; i < DOCUMENT_CACHE_MAX_NAMESPACES; i++) {
      await documentEmbeddingCache.writeEmbeddings(dir, `doc-${i}`, cached);
    }
    await documentEmbeddingCache.readEmbeddings(dir, "doc-0");
    state.db!.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const restored = join(dir, "restored.db");
    copyFileSync(join(dir, "cache.db"), restored);
    state.db!.close(); state.db = new DatabaseSync(restored);
    await documentEmbeddingCache.writeEmbeddings(dir, "new-model", cached);
    expect(namespaces()).toContain("doc-0");
    expect(namespaces()).not.toContain("doc-1");
    expect((await documentEmbeddingCache.readEmbeddings(dir, "doc-0")).get("chunk")?.vector).toEqual([1, 2]);
  });
});
