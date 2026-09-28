/**
 * The learned store kept in `config.db` (LLD §9.13). Run against a real SQLite
 * (`node:sqlite`) through the same `execute` / `select` surface the plugin
 * offers, so what is held is what the SQL does, not what it says: a write only
 * ever lowers a row — unless the row has aged out; loading prunes aged rows and
 * hands the rest to the store, which keeps the lower of disk and memory; a
 * forget deletes exactly the facts named; unknown rows are skipped.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetLearned, __setLearnedClock, forgetLearned, LEARNED_TTL_MS, learnedCeiling, noteLearned, seedLearned, setLearnedSink,
} from "../capability/learned";
import { ensureLearnedSchema, learnedSink, loadLearned } from "../learnedDb";

type Row = Record<string, unknown>;

/**
 * The plugin's surface over an in-memory database. `slowInserts` makes an
 * INSERT take longer than a DELETE, as two statements on a connection pool
 * may: whatever the sink does not order itself then lands out of order.
 */
function open({ slowInserts = false } = {}) {
  const raw = new DatabaseSync(":memory:");
  const db = {
    execute: async (sql: string, args: unknown[] = []) => {
      if (slowInserts) await new Promise((r) => setTimeout(r, /^\s*INSERT/.test(sql) ? 10 : 0));
      raw.prepare(sql).run(...(args as never[]));
      return { rowsAffected: 0 };
    },
    select: async <T,>(sql: string, args: unknown[] = []) => raw.prepare(sql).all(...(args as never[])) as T,
  };
  return { raw, db: db as never as Parameters<typeof loadLearned>[0] };
}

const rows = (raw: DatabaseSync): Row[] =>
  raw.prepare("SELECT standard, base_url, model_id, fact, ceiling, rank, learned_at FROM learned_ceilings ORDER BY fact").all() as Row[];
/** Let the un-awaited writes land. */
const settle = () => new Promise((r) => setTimeout(r, 30));

const QWEN = { standard: "openai_compat" as const, baseUrl: "https://relay/v1", modelId: "qwen3.8-max" };
const DAY = 24 * 60 * 60 * 1000;

let t = 1_000_000_000_000;
beforeEach(() => {
  __resetLearned();
  __setLearnedClock(() => t);
});
afterEach(() => {
  setLearnedSink(undefined);
  __resetLearned();
});

describe("learned ceilings on disk", () => {
  it("writes a lowering through, and only a lowering", async () => {
    const { raw, db } = open();
    await ensureLearnedSchema(db);
    setLearnedSink(learnedSink(db));

    noteLearned(QWEN, "structuredOutput", "json_object");
    noteLearned(QWEN, "forcedToolChoice", false);
    await settle();
    expect(rows(raw)).toEqual([
      { standard: "openai_compat", base_url: "https://relay/v1", model_id: "qwen3.8-max", fact: "forcedToolChoice", ceiling: "false", rank: 0, learned_at: t },
      { standard: "openai_compat", base_url: "https://relay/v1", model_id: "qwen3.8-max", fact: "structuredOutput", ceiling: "json_object", rank: 1, learned_at: t },
    ]);

    // Another window lifting it: the table keeps the lower one.
    raw.prepare("UPDATE learned_ceilings SET ceiling = 'off', rank = 0 WHERE fact = 'structuredOutput'").run();
    __resetLearned();
    __setLearnedClock(() => t);
    noteLearned(QWEN, "structuredOutput", "json_object");
    await settle();
    expect(rows(raw).find((r) => r.fact === "structuredOutput")?.ceiling).toBe("off");
  });

  it("replaces a row that has aged out, whatever its strength", async () => {
    const { raw, db } = open();
    await ensureLearnedSchema(db);
    setLearnedSink(learnedSink(db));
    noteLearned(QWEN, "structuredOutput", "off");
    await settle();

    t += LEARNED_TTL_MS + DAY;
    // The store no longer counts the old ceiling, so this is a new lesson.
    expect(learnedCeiling(QWEN, "structuredOutput")).toBeUndefined();
    noteLearned(QWEN, "structuredOutput", "json_object");
    await settle();
    expect(rows(raw)[0]).toMatchObject({ ceiling: "json_object", learned_at: t });
  });

  it("loads what is still young, prunes the rest, and keeps the lower of disk and memory", async () => {
    const { raw, db } = open();
    await ensureLearnedSchema(db);
    const insert = raw.prepare("INSERT INTO learned_ceilings VALUES (?, ?, ?, ?, ?, ?, ?)");
    insert.run("openai_compat", "https://relay/v1", "qwen3.8-max", "structuredOutput", "json_object", 1, t - DAY);
    insert.run("openai_compat", "https://relay/v1", "old-model", "structuredOutput", "off", 0, t - LEARNED_TTL_MS - DAY);
    insert.run("openai_compat", "https://api.deepseek.com", "deepseek-v4-flash", "forcedToolChoice", "false", 0, t - DAY);
    // Rows this build cannot read: a standard and a tier it does not know.
    insert.run("some_future_wire", "https://x", "m", "structuredOutput", "off", 0, t);
    insert.run("openai_compat", "https://x", "m", "structuredOutput", "json_lines", 0, t);

    // Learned in memory while the table was loading, lower than the disk's.
    noteLearned(QWEN, "structuredOutput", "off");
    await loadLearned(db, t);

    expect(learnedCeiling(QWEN, "structuredOutput")).toBe("off");
    expect(learnedCeiling({ standard: "openai_compat", baseUrl: "https://api.deepseek.com", modelId: "deepseek-v4-flash" }, "forcedToolChoice"))
      .toBe(false);
    expect(learnedCeiling({ standard: "openai_compat", baseUrl: "https://relay/v1", modelId: "old-model" }, "structuredOutput"))
      .toBeUndefined();
    expect(rows(raw).map((r) => r.model_id)).not.toContain("old-model");
  });

  it("a loaded ceiling ages out on the same clock as a learned one", async () => {
    const { raw, db } = open();
    await ensureLearnedSchema(db);
    raw.prepare("INSERT INTO learned_ceilings VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("openai_compat", "https://relay/v1", "qwen3.8-max", "structuredOutput", "off", 0, t - DAY);
    await loadLearned(db, t);
    expect(learnedCeiling(QWEN, "structuredOutput")).toBe("off");
    t += LEARNED_TTL_MS;
    expect(learnedCeiling(QWEN, "structuredOutput")).toBeUndefined();
  });

  it("forgets the facts named, in memory and on disk, and nothing else", async () => {
    const { raw, db } = open();
    await ensureLearnedSchema(db);
    setLearnedSink(learnedSink(db));
    const other = { ...QWEN, modelId: "qwen-plus" };
    noteLearned(QWEN, "structuredOutput", "off");
    noteLearned(QWEN, "forcedToolChoice", false);
    noteLearned(other, "structuredOutput", "off");
    await settle();

    forgetLearned(QWEN, ["structuredOutput"]);
    await settle();
    expect(learnedCeiling(QWEN, "structuredOutput")).toBeUndefined();
    expect(learnedCeiling(QWEN, "forcedToolChoice")).toBe(false);
    expect(rows(raw).map((r) => `${r.model_id} ${r.fact}`).sort()).toEqual([
      "qwen-plus structuredOutput", "qwen3.8-max forcedToolChoice",
    ]);

    forgetLearned(QWEN);
    await settle();
    expect(learnedCeiling(QWEN, "forcedToolChoice")).toBeUndefined();
    expect(rows(raw).map((r) => r.model_id)).toEqual(["qwen-plus"]);
  });

  it("a row that no longer counts does not displace one that does", () => {
    noteLearned(QWEN, "structuredOutput", "json_object");
    seedLearned([{ ...QWEN, fact: "structuredOutput", ceiling: "off", learnedAt: t - LEARNED_TTL_MS - DAY }]);
    expect(learnedCeiling(QWEN, "structuredOutput")).toBe("json_object");
  });

  it("a time in the future does not count — a clock set back after learning", async () => {
    seedLearned([{ ...QWEN, fact: "structuredOutput", ceiling: "off", learnedAt: t + 365 * DAY }]);
    expect(learnedCeiling(QWEN, "structuredOutput")).toBeUndefined();

    const { raw, db } = open();
    await ensureLearnedSchema(db);
    raw.prepare("INSERT INTO learned_ceilings VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("openai_compat", "https://relay/v1", "qwen3.8-max", "structuredOutput", "off", 0, t + 365 * DAY);
    await loadLearned(db, t);
    expect(rows(raw)).toEqual([]);

    // And a fresh lesson replaces such a row in the table.
    raw.prepare("INSERT INTO learned_ceilings VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("openai_compat", "https://relay/v1", "qwen3.8-max", "structuredOutput", "off", 0, t + 365 * DAY);
    setLearnedSink(learnedSink(db));
    noteLearned(QWEN, "structuredOutput", "json_object");
    await settle();
    expect(rows(raw)[0]).toMatchObject({ ceiling: "json_object", learned_at: t });
  });

  it("a forget issued right after a write reaches the table after it", async () => {
    const { raw, db } = open({ slowInserts: true });
    await ensureLearnedSchema(db);
    setLearnedSink(learnedSink(db));
    noteLearned(QWEN, "structuredOutput", "off");
    forgetLearned(QWEN);
    await settle();
    expect(rows(raw)).toEqual([]);
  });

  it("a key with no address or model is kept as empty strings and read back as absent", async () => {
    const { raw, db } = open();
    await ensureLearnedSchema(db);
    setLearnedSink(learnedSink(db));
    noteLearned({ standard: "openai" }, "forcedToolChoice", false);
    await settle();
    expect(rows(raw)[0]).toMatchObject({ base_url: "", model_id: "" });
    __resetLearned();
    __setLearnedClock(() => t);
    await loadLearned(db, t);
    expect(learnedCeiling({ standard: "openai" }, "forcedToolChoice")).toBe(false);
  });
});
