/** Durable prose checkpoints. These never contain credentials or executable tool calls. */
import { getDb } from "../project";

export interface OutputRecovery {
  v: 1;
  id: string;
  modelId: string;
  source: "chat" | "task" | "long";
  request: string;
  text: string;
  status: "streaming" | "interrupted" | "truncated" | "kept";
  updatedAt: number;
  /** Completed sections are immutable; only the current section can be continued. */
  sections?: string[];
  nextSection?: number;
}

async function database(project: string) {
  const db = await getDb(project);
  await db.execute(`CREATE TABLE IF NOT EXISTS output_recovery (
    id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`);
  return db;
}

export async function saveOutputRecovery(project: string, snapshot: OutputRecovery): Promise<void> {
  const db = await database(project);
  await db.execute(
    `INSERT INTO output_recovery (id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    [snapshot.id, JSON.stringify(snapshot), snapshot.updatedAt],
  );
}

export async function deleteOutputRecovery(project: string, id: string): Promise<void> {
  const db = await database(project);
  await db.execute("DELETE FROM output_recovery WHERE id = ?", [id]);
}

export function parseOutputRecovery(raw: string): OutputRecovery | null {
  try {
    const s = JSON.parse(raw) as OutputRecovery;
    if (s.v !== 1 || typeof s.id !== "string" || typeof s.modelId !== "string" ||
        typeof s.request !== "string" || typeof s.text !== "string" ||
        !["chat", "task", "long"].includes(s.source) ||
        !["streaming", "interrupted", "truncated", "kept"].includes(s.status) ||
        !Number.isFinite(s.updatedAt)) return null;
    if (s.sections !== undefined && (!Array.isArray(s.sections) ||
        !s.sections.every((x) => typeof x === "string") || s.sections.length > 20 ||
        !Number.isInteger(s.nextSection) || s.nextSection! < 0 || s.nextSection! > s.sections.length)) return null;
    return { ...s, status: s.status === "streaming" ? "interrupted" : s.status };
  } catch { return null; }
}

export async function listOutputRecoveries(project: string): Promise<OutputRecovery[]> {
  const db = await database(project);
  const rows = await db.select<{ data: string }[]>("SELECT data FROM output_recovery ORDER BY updated_at DESC");
  return rows.map((r) => parseOutputRecovery(r.data)).filter((r): r is OutputRecovery => !!r);
}

/** Periodic rather than debounced: a busy stream must still reach disk.
 * One in-flight write, latest pending snapshot; finalization waits for it.
 * A failed save keeps the dirty snapshot and retries at the next tick.
 */
export function createOutputCheckpoint(
  write: (snapshot: OutputRecovery) => Promise<void>,
  onError: (error: unknown) => void,
  interval = 1500,
) {
  let pending: OutputRecovery | null = null;
  let flight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const schedule = () => {
    if (!closed && !timer) timer = setTimeout(() => {
      timer = undefined;
      void flush().then(() => { if (pending) schedule(); });
    }, interval);
  };
  const flush = async (): Promise<boolean> => {
    if (flight) { await flight; return flush(); }
    const value = pending;
    if (!value) return true;
    pending = null;
    flight = write(value).catch((error: unknown) => {
      pending ??= value;
      onError(error);
    });
    await flight;
    flight = null;
    return pending === null;
  };
  return {
    update(snapshot: OutputRecovery) { pending = { ...snapshot }; schedule(); },
    flush,
    async close() {
      closed = true;
      clearTimeout(timer);
      await flush();
      // A newer snapshot may have arrived while an earlier write was in flight.
      if (pending) await flush();
      return pending === null;
    },
  };
}
