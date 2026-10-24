import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { ensureUsageSchema } from "../usageSchema";
import { recordUsage } from "../usageRow";
const state = vi.hoisted(() => ({ project: null as unknown, global: null as unknown }));
vi.mock("../../project", () => ({ getDb: async () => state.project, getGlobalDb: async () => state.global }));
const opened: DatabaseSync[] = [];
function database() {
  const raw = new DatabaseSync(":memory:"); opened.push(raw);
  const db = {
    execute: async (sql: string, values: unknown[] = []) => raw.prepare(sql).run(...values as never[]),
    select: async (sql: string) => raw.prepare(sql).all(),
  } as unknown as Parameters<typeof ensureUsageSchema>[0];
  return { raw, db };
}
afterEach(() => opened.splice(0).forEach((db) => db.close()));
it("adds nullable provenance to old ledgers and deduplicates each attempt independently in both sinks", async () => {
  const project = database(), global = database();
  // Start with the historical columns; migration must keep existing usage.
  project.raw.exec(`CREATE TABLE token_usage (id INTEGER PRIMARY KEY, model_id TEXT, task TEXT, prompt_tokens INTEGER, cached_tokens INTEGER, completion_tokens INTEGER, cost_usd REAL, created_at INTEGER);
    INSERT INTO token_usage VALUES (1, 'old', 'chat', 20, 0, 3, 1, 1)`);
  state.project = project.db; state.global = global.db;
  await ensureUsageSchema(project.db, "project");
  await ensureUsageSchema(global.db, "global");
  await ensureUsageSchema(project.db, "project");
  const input = { model: { id: "model" }, task: "chat", promptTokens: 10, reportedCost: null, requestId: "attempt-1",
    usageEvidence: { outcome: "failed" as const, source: "reported" as const, fields: { inputTokens: 10 } } };
  await Promise.all([recordUsage("/p", input), recordUsage("/p", input)]);
  await recordUsage("/p", { ...input, requestId: "attempt-2" });
  for (const { raw } of [project, global]) {
    const rows = raw.prepare("SELECT request_id, usage_evidence FROM token_usage WHERE model_id = 'model'").all();
    expect(rows).toHaveLength(2);
    expect(JSON.parse(String(rows[0].usage_evidence))).toEqual(input.usageEvidence);
  }
  expect(project.raw.prepare("SELECT cost_usd, request_id, usage_evidence FROM token_usage WHERE model_id = 'old'").get()).toMatchObject({ cost_usd: 1, request_id: null, usage_evidence: null });
});
it("can retry a failed sink without duplicating the sink that already committed", async () => {
  const project = database(), global = database();
  await ensureUsageSchema(project.db, "project"); await ensureUsageSchema(global.db, "global");
  state.project = project.db;
  state.global = { execute: async () => { throw new Error("temporarily locked"); } };
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const input = { model: { id: "m" }, task: "chat", reportedCost: null, requestId: "same-attempt" };
  await recordUsage("/p", input);
  state.global = global.db;
  await recordUsage("/p", input);
  expect(project.raw.prepare("SELECT COUNT(*) AS n FROM token_usage").get()?.n).toBe(1);
  expect(global.raw.prepare("SELECT COUNT(*) AS n FROM token_usage").get()?.n).toBe(1);
  warning.mockRestore();
});
