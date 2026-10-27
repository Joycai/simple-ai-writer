import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureUsageSchema } from "../usageSchema";
let recordUsage: typeof import("../usageRow").recordUsage;
const state = vi.hoisted(() => ({ project: null as unknown, global: null as unknown, dir: "", diskFailed: false, projectExists: true }));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: async () => state.dir }));
vi.mock("../../fs/fileio", async () => {
  const fs = await import("node:fs/promises");
  return {
    makeDir: async (p: string) => { if (state.diskFailed) throw new Error("disk full"); await fs.mkdir(p, { recursive: true }); },
    writeFile: async (p: string, text: string) => { if (state.diskFailed) throw new Error("disk full"); await fs.writeFile(p, text); },
    renamePath: fs.rename, removeFile: fs.unlink,
    readFile: (p: string) => fs.readFile(p, "utf8"),
    fileExists: async (p: string) => p.endsWith("project.db") ? state.projectExists : fs.stat(p).then(() => true, () => false),
    readDir: async (p: string) => (await fs.readdir(p, { withFileTypes: true })).map((f) => ({ name: f.name, path: `${p}/${f.name}`, isDirectory: f.isDirectory() })),
  };
});
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
let retryUsageDelivery: typeof import("../usageOutbox").retryUsageDelivery;
let usageDeliverySnapshot: typeof import("../usageOutbox").usageDeliverySnapshot;
let withUsageClear: typeof import("../usageOutbox").withUsageClear;
import { ZERO_FEE } from "../feeGroup";
import { ROLLUP_SELECT } from "../usage";
beforeEach(async () => {
  vi.resetModules();
  ({ recordUsage } = await import("../usageRow"));
  ({ retryUsageDelivery, usageDeliverySnapshot, withUsageClear } = await import("../usageOutbox"));
  state.dir = await mkdtemp(`${tmpdir()}/usage-outbox-test-`);
  state.diskFailed = false; state.projectExists = true;
});
afterEach(async () => { await rm(state.dir, { recursive: true, force: true }); });
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

async function ledgers() {
  const project = database(), global = database();
  await ensureUsageSchema(project.db, "project"); await ensureUsageSchema(global.db, "global");
  state.project = project.db; state.global = global.db;
  return { project, global };
}
it("persists both snapshots before delivery, survives restart, and keeps original prices and timestamp", async () => {
  const { project, global } = await ledgers();
  const model = { id: "m", fee: { ...ZERO_FEE, inputPrice: 2, cachePrice: 2, outputPrice: 4 } };
  const input = { model, task: "image", requestId: "stable-image", promptTokens: 1000, completionTokens: 1000, cachedTokens: 0, reportedCost: null };
  state.global = { execute: async () => { throw new Error("locked"); } };
  await recordUsage("/p", input);
  expect(project.raw.prepare("SELECT COUNT(*) AS n FROM token_usage").get()?.n).toBe(1);
  const files = await readdir(`${state.dir}/usage-outbox`);
  expect(files).toHaveLength(1);
  const receipt = JSON.parse(await readFile(`${state.dir}/usage-outbox/${files[0]}`, "utf8"));
  expect(receipt.scope).toBe("global");
  model.fee.inputPrice = 999;
  state.global = global.db;
  vi.resetModules(); // a new process has no in-memory receipts
  const restored = await import("../usageOutbox");
  const restartedWriter = await import("../usageRow");
  await restartedWriter.recordUsage("/p", input);
  await restored.retryUsageDelivery();
  const p = project.raw.prepare("SELECT cost_usd, created_at FROM token_usage").get();
  expect(global.raw.prepare("SELECT cost_usd, created_at FROM token_usage").get()).toEqual(p);
  expect(p?.cost_usd).toBeCloseTo(0.006);
  expect(await readdir(`${state.dir}/usage-outbox`)).toEqual([]);
  expect(global.raw.prepare("SELECT COUNT(*) AS n FROM token_usage").get()?.n).toBe(1);
});
it("keeps volatile receipts on a disk failure, retries both sinks, and never masks the result", async () => {
  const { project, global } = await ledgers();
  state.diskFailed = true;
  state.project = state.global = { execute: async () => { throw new Error("locked"); } };
  await expect(recordUsage("/p", { model: { id: "m" }, task: "asr", requestId: "asr-1", reportedCost: null })).resolves.toBeUndefined();
  expect(usageDeliverySnapshot()).toMatchObject({ pending: 2, volatile: 2, failed: true });
  state.diskFailed = false; state.project = project.db; state.global = global.db;
  await retryUsageDelivery();
  expect(usageDeliverySnapshot()).toMatchObject({ pending: 0, volatile: 0, failed: false });
});
it("does not recreate a missing project and does not allow a clear that would be resurrected", async () => {
  const { project, global } = await ledgers();
  state.projectExists = false;
  await recordUsage("/p", { model: { id: "m" }, task: "chat", requestId: "missing-project", reportedCost: 0 });
  expect(global.raw.prepare("SELECT COUNT(*) AS n FROM token_usage").get()?.n).toBe(1);
  const clear = vi.fn(async () => {});
  await expect(withUsageClear("project", "/p", clear)).rejects.toThrow();
  expect(clear).not.toHaveBeenCalled();
  state.projectExists = true;
  await retryUsageDelivery();
  await withUsageClear("project", "/p", async () => { project.raw.exec("DELETE FROM token_usage"); });
  await retryUsageDelivery();
  expect(project.raw.prepare("SELECT COUNT(*) AS n FROM token_usage").get()?.n).toBe(0);
});
it("SQL distinguishes missing usage, explicit zero, trusted zero quote, and historical unknowns", async () => {
  const { global } = await ledgers();
  const model = { id: "m", fee: { ...ZERO_FEE, inputPrice: 2, cachePrice: 2, outputPrice: 4 } };
  await recordUsage(null, { model, task: "unknown", reportedCost: null });
  await recordUsage(null, { model, task: "zero", promptTokens: 0, completionTokens: 0, cachedTokens: 0, reportedCost: null });
  await recordUsage(null, { model, task: "quote", reportedCost: 0 });
  global.raw.exec("INSERT INTO token_usage (model_id,task,cost_usd) VALUES ('m','legacy',2)");
  const rows = global.raw.prepare(`SELECT task, ${ROLLUP_SELECT} FROM token_usage GROUP BY task`).all();
  expect(rows.find((r) => r.task === "unknown")).toMatchObject({ incomplete_usage: 1, incomplete_cost: 1 });
  expect(rows.find((r) => r.task === "zero")).toMatchObject({ incomplete_usage: 0, incomplete_cost: 0, cost_usd: 0 });
  expect(rows.find((r) => r.task === "quote")).toMatchObject({ incomplete_usage: 1, incomplete_cost: 0, cost_usd: 0 });
  expect(rows.find((r) => r.task === "legacy")).toMatchObject({ incomplete_usage: 1, incomplete_cost: 1, cost_usd: 2 });
});

it("saves both receipts before the first ledger write and preserves malformed receipts for inspection", async () => {
  const { project, global } = await ledgers();
  state.project = { execute: async (sql: string, values: unknown[]) => {
    expect((await readdir(`${state.dir}/usage-outbox`)).filter((p) => p.endsWith(".json"))).toHaveLength(2);
    return project.db.execute(sql, values);
  } };
  await recordUsage("/p", { model: { id: "m" }, task: "chat", reportedCost: 0, requestId: "before-write" });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(`${state.dir}/usage-outbox/bad.json`, "not json");
  await retryUsageDelivery();
  expect(usageDeliverySnapshot().failed).toBe(true);
  expect(await readFile(`${state.dir}/usage-outbox/bad.json`, "utf8")).toBe("not json");
  expect(global.raw.prepare("SELECT COUNT(*) AS n FROM token_usage").get()?.n).toBe(1);
});


it("does not resurrect cleared usage when another window's INSERT was already in flight", async () => {
  const { global } = await ledgers();
  state.global = { execute: async () => { throw new Error("locked"); } };
  await recordUsage(null, { model: { id: "m" }, task: "chat", requestId: "in-flight", reportedCost: 0 });
  let release!: () => void;
  let arrived!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const atWrite = new Promise<void>((resolve) => { arrived = resolve; });
  state.global = { execute: async (sql: string, values: unknown[]) => {
    arrived(); await paused; return global.db.execute(sql, values);
  } };
  const firstWindow = retryUsageDelivery();
  await atWrite;
  state.global = global.db;
  vi.resetModules();
  const secondWindow = await import("../usageOutbox");
  await secondWindow.withUsageClear("global", null, async () => { global.raw.exec("DELETE FROM token_usage"); });
  release(); await firstWindow;
  expect(global.raw.prepare("SELECT COUNT(*) AS n FROM token_usage").get()?.n).toBe(0);
  await recordUsage(null, { model: { id: "m" }, task: "chat", requestId: "new-request", reportedCost: 0 });
  expect(global.raw.prepare("SELECT request_id FROM token_usage").all()).toEqual([{ request_id: "new-request" }]);
});

it("keeps per-field zeros and sums fresh input only when input and cache are both known", async () => {
  const { global } = await ledgers();
  await recordUsage(null, { model: { id: "m" }, task: "partial", promptTokens: 100, completionTokens: 0, reportedCost: null });
  const row = () => global.raw.prepare(`SELECT ${ROLLUP_SELECT} FROM token_usage`).get();
  expect(row()).toMatchObject({ incomplete_input: 0, incomplete_cache: 1, incomplete_output: 0,
    incomplete_fresh: 1, fresh_tokens: 0, completion_tokens: 0 });
  await recordUsage(null, { model: { id: "m" }, task: "known", promptTokens: 50, cachedTokens: 20, completionTokens: 0, reportedCost: null });
  expect(row()).toMatchObject({ incomplete_input: 0, incomplete_cache: 1, incomplete_output: 0,
    incomplete_fresh: 1, fresh_tokens: 30, completion_tokens: 0 });
});

it("retains deletion markers per ledger and rolls them back with a failed clear", async () => {
  const { project, global } = await ledgers();
  const input = { model: { id: "m" }, task: "chat", requestId: "deleted", reportedCost: 0 };
  await recordUsage("/p", input);
  project.raw.exec("BEGIN; DELETE FROM token_usage; ROLLBACK;");
  expect(project.raw.prepare("SELECT COUNT(*) AS n FROM usage_deleted_requests").get()?.n).toBe(0);
  project.raw.exec("DELETE FROM token_usage");
  await recordUsage("/p", input);
  expect(project.raw.prepare("SELECT COUNT(*) AS n FROM token_usage").get()?.n).toBe(0);
  expect(global.raw.prepare("SELECT COUNT(*) AS n FROM token_usage").get()?.n).toBe(1);
});


it("replays receipts written before the per-field mask was added", async () => {
  const { global } = await ledgers();
  state.global = { execute: async () => { throw new Error("locked"); } };
  await recordUsage(null, { model: { id: "m" }, task: "legacy-receipt", requestId: "old-layout", reportedCost: 0 });
  const dir = `${state.dir}/usage-outbox`;
  const [file] = await readdir(dir);
  const receipt = JSON.parse(await readFile(`${dir}/${file}`, "utf8"));
  receipt.values.pop();
  const { writeFile } = await import("node:fs/promises");
  await writeFile(`${dir}/${file}`, JSON.stringify(receipt));
  state.global = global.db;
  vi.resetModules();
  await (await import("../usageOutbox")).retryUsageDelivery();
  expect(global.raw.prepare("SELECT request_id, usage_known, reported_cost FROM token_usage").get())
    .toMatchObject({ request_id: "old-layout", usage_known: null, reported_cost: 0 });
  expect(await readdir(dir)).toEqual([]);
});
