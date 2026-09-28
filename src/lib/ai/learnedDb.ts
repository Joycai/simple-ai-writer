/**
 * The learned store's rows in `config.db` (docs/api/capability-resolution-lld.md
 * §9.13, decision D3 as revised).
 *
 * The store itself (`capability/learned.ts`) stays in memory and synchronous;
 * this is only where it is kept between runs. One row per endpoint+model+fact:
 * the ceiling, its strength (`rank`, lower = weaker) and when it was learned.
 *
 * Two rules the SQL holds, not the caller:
 *   - **Only lower.** Two windows each learn from their own 400s; neither may
 *     lift what the other wrote. The upsert replaces a row only with a weaker
 *     ceiling — or any ceiling once the row has aged out, since the store no
 *     longer counts it.
 *   - **Aged rows go.** Loading deletes whatever is past the limit before
 *     reading, so the table never grows past the endpoints used this week.
 *
 * Not part of a config backup or config sync, and not in a project's database:
 * what an endpoint refused from this machine, through this network, may not
 * hold from another.
 */
import type Database from "@tauri-apps/plugin-sql";
import {
  LEARNED_TTL_MS, seedLearned, STRUCTURED_RANK,
  type EndpointKey, type LearnedFact, type LearnedRow, type LearnedSink,
} from "./capability/learned";
import { parseStructuredOutputMode } from "./jsonMode";
import { isApiStandard } from "./types";

type Db = Pick<Awaited<ReturnType<typeof Database.load>>, "execute" | "select">;

export async function ensureLearnedSchema(db: Db): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS learned_ceilings (
      standard TEXT NOT NULL,
      base_url TEXT NOT NULL,
      model_id TEXT NOT NULL,
      fact TEXT NOT NULL,
      ceiling TEXT NOT NULL,
      rank INTEGER NOT NULL,
      learned_at INTEGER NOT NULL,
      PRIMARY KEY (standard, base_url, model_id, fact)
    )
  `);
}

interface Stored {
  standard: string;
  base_url: string;
  model_id: string;
  fact: string;
  ceiling: string;
  learned_at: number;
}

/** A switch's ceiling is always `false`, spelled so; a tier's is the tier. */
const spell = (r: LearnedRow): string => (r.fact === "forcedToolChoice" ? "false" : r.ceiling);
const rankOf = (r: LearnedRow): number => (r.fact === "forcedToolChoice" ? 0 : STRUCTURED_RANK[r.ceiling]);

/** A stored row back as the store's, or undefined for anything it no longer knows. */
function parse(s: Stored): LearnedRow | undefined {
  if (!isApiStandard(s.standard)) return undefined;
  const key = { standard: s.standard, baseUrl: s.base_url || undefined, modelId: s.model_id || undefined };
  if (s.fact === "forcedToolChoice" && s.ceiling === "false") {
    return { ...key, fact: "forcedToolChoice", ceiling: false, learnedAt: s.learned_at };
  }
  const tier = s.fact === "structuredOutput" ? parseStructuredOutputMode(s.ceiling) : undefined;
  return tier ? { ...key, fact: "structuredOutput", ceiling: tier, learnedAt: s.learned_at } : undefined;
}

/** Delete what has aged out, then hand the rest to the store. */
export async function loadLearned(db: Db, now = Date.now()): Promise<void> {
  await db.execute("DELETE FROM learned_ceilings WHERE learned_at <= ?", [now - LEARNED_TTL_MS]);
  const rows = await db.select<Stored[]>(
    "SELECT standard, base_url, model_id, fact, ceiling, learned_at FROM learned_ceilings",
  );
  seedLearned(rows.map(parse).filter((r): r is LearnedRow => r !== undefined));
}

/**
 * The sink the store writes through. Writes are not awaited by the request
 * that learned — a failed write costs one more 400 after the next restart —
 * so a failure is logged, not thrown.
 */
export function learnedSink(db: Db): LearnedSink {
  const warn = (e: unknown) => console.warn("[learned] could not update config.db:", e);
  return {
    write(r) {
      db.execute(
        `INSERT INTO learned_ceilings (standard, base_url, model_id, fact, ceiling, rank, learned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (standard, base_url, model_id, fact) DO UPDATE SET
           ceiling = excluded.ceiling, rank = excluded.rank, learned_at = excluded.learned_at
         WHERE excluded.rank < learned_ceilings.rank OR learned_ceilings.learned_at <= ?`,
        [r.standard, r.baseUrl ?? "", r.modelId ?? "", r.fact, spell(r), rankOf(r), r.learnedAt, r.learnedAt - LEARNED_TTL_MS],
      ).catch(warn);
    },
    forget(k: EndpointKey, facts: readonly LearnedFact[]) {
      if (facts.length === 0) return;
      db.execute(
        `DELETE FROM learned_ceilings WHERE standard = ? AND base_url = ? AND model_id = ? AND fact IN (${facts.map(() => "?").join(", ")})`,
        [k.standard, k.baseUrl ?? "", k.modelId ?? "", ...facts],
      ).catch(warn);
    },
  };
}
