import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEmbeddings, writeEmbeddings, pruneEmbeddings, invalidateEmbeddings, removeEmbeddings, digest } from "../embeddingCache";

const state = vi.hoisted(() => ({ db: null as DatabaseSync | null }));
vi.mock("../../project", () => ({ getDb: async () => ({
  execute: async (sql: string, values: SQLInputValue[] = []) => state.db!.prepare(sql).run(...values),
  select: async (sql: string, values: SQLInputValue[] = []) => state.db!.prepare(sql).all(...values),
}) }));
vi.mock("../../sqlTx", () => ({ sqlTransaction: async (_p: string, statements: { sql: string; values: SQLInputValue[] }[]) => {
  for (const s of statements) state.db!.prepare(s.sql).run(...s.values);
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
