import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const h = vi.hoisted(() => ({ db: null as DatabaseSync | null }));
vi.mock("../../project", () => ({ getGlobalDbPath: async () => "cache.db", getGlobalDb: async () => ({
  execute: async (sql: string, values: SQLInputValue[] = []) => h.db!.prepare(sql).run(...values),
  select: async (sql: string, values: SQLInputValue[] = []) => h.db!.prepare(sql).all(...values),
}) }));
vi.mock("../../sqlTx", () => ({ sqlTransaction: async (_p: string, statements: { sql: string; values: SQLInputValue[] }[]) => {
  h.db!.exec("BEGIN IMMEDIATE");
  try { for (const s of statements) h.db!.prepare(s.sql).run(...s.values); h.db!.exec("COMMIT"); }
  catch (error) { h.db!.exec("ROLLBACK"); throw error; }
} }));
import { clearCatalogueRows, deleteCatalogueRow, readCatalogueRow, writeCatalogueRow } from "../catalogueDb";
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mcp-catalogue-")); h.db = new DatabaseSync(join(dir, "cache.db")); });
afterEach(() => { h.db?.close(); rmSync(dir, { recursive: true, force: true }); });
it("survives a real SQLite close/reopen and isolates connection revisions", async () => {
  await writeCatalogueRow("a", "c1", '{"tools":[]}'); h.db!.close(); h.db = new DatabaseSync(join(dir, "cache.db"));
  expect(await readCatalogueRow("a", "c1")).toBe('{"tools":[]}'); expect(await readCatalogueRow("a", "c2")).toBeUndefined();
  await writeCatalogueRow("a", "c2", "new"); expect(await readCatalogueRow("a", "c1")).toBeUndefined();
  await deleteCatalogueRow("a"); expect(await readCatalogueRow("a", "c2")).toBeUndefined();
});
it("rejects oversized snapshots without replacing the last saved catalogue", async () => {
  await writeCatalogueRow("a", "c", "old"); expect(await writeCatalogueRow("a", "c", "x".repeat(8 * 1024 * 1024 + 1))).toBe(false);
  expect(await readCatalogueRow("a", "c")).toBe("old");
});
it("prunes total storage transactionally and clears it on reset", async () => {
  const large = "x".repeat(8 * 1024 * 1024);
  for (let i = 0; i < 9; i++) await writeCatalogueRow(String(i), "c", large);
  const total = h.db!.prepare("SELECT SUM(bytes) AS bytes, COUNT(*) AS count FROM mcp_catalogues").get()!;
  expect(total.bytes).toBeLessThanOrEqual(64 * 1024 * 1024); expect(total.count).toBe(8);
  await clearCatalogueRows(); expect(h.db!.prepare("SELECT COUNT(*) AS count FROM mcp_catalogues").get()!.count).toBe(0);
});
