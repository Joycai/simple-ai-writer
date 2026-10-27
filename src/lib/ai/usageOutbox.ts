/** Immutable, per-sink receipts. Replay never calls a model or reprices a row. */
import { appDataDir } from "@tauri-apps/api/path";
import { fileExists, makeDir, readDir, readFile, removeFile, renamePath, writeFile } from "../fs/fileio";
import { getDb, getGlobalDb } from "../project";
import { normalizePathSegments } from "../paths";
import { USAGE_INSERT_COLUMNS, usageInsertSql } from "./usageSchema";

type Scope = "project" | "global";
interface Receipt {
  version: 1;
  scope: Scope;
  projectPath: string | null;
  values: unknown[];
}
interface Pending { receipt: Receipt; durable: boolean; }
const pending = new Map<string, Pending>();
const listeners = new Set<() => void>();
let status = { pending: 0, volatile: 0, failed: false, revision: 0 };
export const usageDeliverySnapshot = () => status;
export const subscribeUsageDelivery = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
function publish(failed = false) {
  status = { pending: pending.size, volatile: [...pending.values()].filter((p) => !p.durable).length,
    failed, revision: status.revision + 1 };
  listeners.forEach((listener) => listener());
}
async function directory() {
  const path = `${normalizePathSegments(await appDataDir())}/usage-outbox`;
  await makeDir(path);
  return path;
}
function parseReceipt(text: string): Receipt {
  const r = JSON.parse(text) as Receipt;
  // Receipts written before per-field completeness remain replayable.
  if (Array.isArray(r.values) && r.values.length === USAGE_INSERT_COLUMNS.length - 1) r.values.push(null);
  if (r.version !== 1 || !["project", "global"].includes(r.scope)
    || !(r.projectPath === null || typeof r.projectPath === "string")
    || (r.scope === "project" && !r.projectPath)
    || !Array.isArray(r.values) || r.values.length !== USAGE_INSERT_COLUMNS.length
    || !r.values.every((v) => v === null || typeof v === "string" || (typeof v === "number" && Number.isFinite(v)))
    || typeof r.values[USAGE_INSERT_COLUMNS.indexOf("request_id")] !== "string") {
    throw new Error("Invalid usage receipt");
  }
  return r;
}
async function persist(path: string, entry: Pending) {
  if (entry.durable) return;
  if (path.startsWith("unresolved:")) throw new Error("App directory unavailable");
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(entry.receipt));
    await renamePath(tmp, path);
    entry.durable = true;
  } finally {
    await removeFile(tmp).catch(() => {});
  }
}
async function deliver(path: string, entry: Pending) {
  const r = entry.receipt;
  if (entry.durable && !await fileExists(path)) { pending.delete(path); return; }
  // Never recreate a deleted/moved project while recovering its ledger.
  if (r.scope === "project" && !await fileExists(`${r.projectPath}/.ai-writer/project.db`)) {
    throw new Error("Project ledger unavailable");
  }
  const db = r.scope === "project" ? await getDb(r.projectPath!) : await getGlobalDb();
  await db.execute(usageInsertSql(r.scope), r.scope === "global" ? [...r.values, r.projectPath] : r.values);
  if (entry.durable) await removeFile(path).catch(async (e) => { if (await fileExists(path)) throw e; });
  pending.delete(path);
}
// Serialize local enqueue/replay/clear. Other windows may replay the same receipt;
// the ledger's unique request_id and deletion tombstones make that harmless.
let tail: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const next = tail.then(job, job);
  tail = next.catch(() => {});
  return next;
}
async function scan() {
  const dir = await directory();
  let failed = false;
  for (const file of await readDir(dir)) {
    if (file.isDirectory || !file.name.endsWith(".json") || pending.has(file.path)) continue;
    try { pending.set(file.path, { receipt: parseReceipt(await readFile(file.path)), durable: true }); }
    catch (e) {
      // A different window may have just acknowledged it. Corrupt receipts stay
      // on disk and remain visible as a recovery failure, never silently deleted.
      if (await fileExists(file.path)) { failed = true; console.warn("[usage] invalid receipt", e); }
    }
  }
  return { dir, failed };
}
async function drain() {
  let failed = false;
  let scanFailed = false;
  try {
    const scanned = await scan();
    const dir = scanned.dir;
    failed = scanFailed = scanned.failed;
    for (const [path, entry] of pending) {
      if (path.startsWith("unresolved:")) {
        pending.delete(path);
        pending.set(`${dir}/${path.slice(11)}.json`, entry);
      }
    }
  } catch (e) { failed = scanFailed = true; console.warn("[usage] outbox scan failed", e); }
  for (const [path, entry] of pending) {
    try { await persist(path, entry); } catch (e) { failed = true; console.warn("[usage] receipt not durable", e); }
  }
  for (const [path, entry] of pending) {
    try { await deliver(path, entry); } catch (e) { failed = true; console.warn("[usage] receipt pending", e); }
  }
  publish(failed);
  return scanFailed;
}
export function retryUsageDelivery(): Promise<void> { return serial(async () => { await drain(); }); }

export function enqueueUsage(projectPath: string | null, values: unknown[]): Promise<void> {
  return serial(async () => {
    // Resolve the intended path even if directory creation fails: keep the
    // receipt in memory and retry persistence without blocking generated output.
    let dir: string;
    try { dir = `${normalizePathSegments(await appDataDir())}/usage-outbox`; }
    catch (e) { console.warn("[usage] app directory unavailable", e); dir = ""; }
    // Restore older receipts before adding a repeated callback, so its original
    // snapshot wins even if current prices have changed since the crash.
    try { await scan(); } catch (e) { console.warn("[usage] outbox scan failed", e); }
    for (const scope of (projectPath ? ["project", "global"] : ["global"]) as Scope[]) {
      pending.set(dir ? `${dir}/${crypto.randomUUID()}.json` : `unresolved:${crypto.randomUUID()}`, {
        receipt: { version: 1, scope, projectPath, values }, durable: false,
      });
    }
    await drain();
  });
}

export function startUsageDelivery(): () => void {
  void retryUsageDelivery();
  const timer = setInterval(() => { void retryUsageDelivery(); }, 30_000);
  return () => clearInterval(timer);
}

/** A clear must not be undone by a receipt still awaiting delivery. */
export function withUsageClear(scope: Scope, projectPath: string | null, clear: () => Promise<void>): Promise<void> {
  return serial(async () => {
    const scanFailed = await drain();
    if (scanFailed || [...pending.values()].some(({ receipt: r }) => r.scope === scope
      && (scope === "global" && !projectPath || r.projectPath === projectPath))) {
      throw new Error("Usage recovery is pending; retry before clearing usage.");
    }
    await clear();
  });
}
