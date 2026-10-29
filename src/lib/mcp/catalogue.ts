/** Shared machine-local directory. A snapshot is never execution authorization. */
import { connectionRevision, isMcpEnabled, isObject, readMcpServers, subscribeMcpConfig, type McpServer } from "./config";
import { withMcp, type McpTool } from "./client";
import { clearCatalogueRows, deleteCatalogueRow, readCatalogueRow, writeCatalogueRow } from "./catalogueDb";
import { McpError } from "./errors";
interface McpCatalogue {
  format: 1; connection: string; fetchedAt: number; tools: McpTool[];
  info: { protocolVersion?: string; name?: string; version?: string };
}
interface CatalogueState { snapshot?: McpCatalogue; loading?: boolean; loaded?: boolean; error?: unknown; attemptedAt?: number; persisted?: boolean }
const states = new Map<string, CatalogueState>();
const listeners = new Set<() => void>();
const jobs = new Map<string, { controller: AbortController; promise: Promise<McpCatalogue>; users: number }>();
const reads = new Map<string, Promise<void>>();
const key = (s: McpServer) => `${s.id}:${connectionRevision(s)}`;
export const catalogueStale = (s: McpCatalogue) => Date.now() - s.fetchedAt >= 24 * 60 * 60 * 1000;
export function catalogueState(server: McpServer): CatalogueState { return states.get(key(server)) ?? {}; }
export function subscribeCatalogues(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
function publish(server: McpServer, patch: CatalogueState) { states.set(key(server), { ...catalogueState(server), ...patch }); listeners.forEach(fn => fn()); }
const current = (s: McpServer) => readMcpServers().some(v => v.id === s.id && connectionRevision(v) === connectionRevision(s));
let disk: Promise<unknown> = Promise.resolve();
function serialDisk<T>(fn: () => Promise<T>): Promise<T> { const next = disk.then(fn, fn); disk = next.catch(() => {}); return next; }
export function parseCatalogue(raw: string, connection: string): McpCatalogue | undefined {
  try {
    if (new TextEncoder().encode(raw).length > 8 * 1024 * 1024) return;
    const v: unknown = JSON.parse(raw);
    if (!isObject(v) || v.format !== 1 || v.connection !== connection || typeof v.fetchedAt !== "number"
      || !Number.isFinite(v.fetchedAt) || v.fetchedAt <= 0 || v.fetchedAt > Date.now() + 60_000
      || !Array.isArray(v.tools) || v.tools.length > 256 || !isObject(v.info)) return;
    const names = new Set<string>();
    for (const t of v.tools) {
      if (!isObject(t) || typeof t.name !== "string" || !t.name || names.has(t.name)
        || !isObject(t.inputSchema) || t.inputSchema.type !== "object" || (t.description !== undefined && typeof t.description !== "string")) return;
      names.add(t.name);
    }
    for (const field of ["protocolVersion", "name", "version"]) if (v.info[field] !== undefined && typeof v.info[field] !== "string") return;
    return v as unknown as McpCatalogue;
  } catch { return; }
}
export async function hydrateCatalogue(server: McpServer): Promise<void> {
  const k = key(server);
  if (catalogueState(server).loaded) return;
  let pending = reads.get(k);
  if (!pending) {
    pending = (async () => {
      let snapshot: McpCatalogue | undefined;
      try { const raw = await readCatalogueRow(server.id, connectionRevision(server)); if (raw) snapshot = parseCatalogue(raw, connectionRevision(server)); } catch { /* cache unavailable; discovery still works */ }
      if (current(server)) publish(server, { loaded: true, ...(snapshot && !catalogueState(server).snapshot ? { snapshot, persisted: true } : {}) });
    })().finally(() => reads.delete(k));
    reads.set(k, pending);
  }
  await pending;
}
// At most two simultaneous discoveries across all consumers.
let running = 0;
const queue: (() => void)[] = [];
async function slot<T>(run: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>(resolve => queue.push(resolve)); else running++;
  try { return await run(); } finally { const next = queue.shift(); if (next) next(); else running--; }
}
export function cancelCatalogue(server: McpServer): void { jobs.get(key(server))?.controller.abort(); }
export async function refreshCatalogue(server: McpServer, signal?: AbortSignal): Promise<McpCatalogue> {
  signal?.throwIfAborted();
  if (!current(server)) throw new McpError("changed");
  const k = key(server);
  let job = jobs.get(k);
  if (!job) {
    const controller = new AbortController();
    publish(server, { loading: true, error: undefined, attemptedAt: Date.now() });
    const promise = slot(async () => {
      controller.signal.throwIfAborted();
      const snapshot = await withMcp(server, controller.signal, async client => ({ format: 1 as const,
        connection: connectionRevision(server), fetchedAt: Date.now(), tools: await client.listTools(), info: client.info ?? {} }), 30_000);
      controller.signal.throwIfAborted();
      if (!current(server)) throw new McpError("changed");
      const persisted = await serialDisk(async () => {
        if (!current(server) || controller.signal.aborted) return false;
        return writeCatalogueRow(server.id, connectionRevision(server), JSON.stringify(snapshot)).catch(() => false);
      });
      controller.signal.throwIfAborted();
      if (!current(server)) throw new McpError("changed");
      publish(server, { snapshot, persisted, loaded: true, error: undefined });
      return snapshot;
    }).catch(error => {
      if (current(server)) publish(server, { error: controller.signal.aborted ? new McpError("cancelled") : error });
      throw error;
    }).finally(() => { jobs.delete(k); if (current(server)) publish(server, { loading: false }); });
    job = { controller, promise, users: 0 }; jobs.set(k, job);
  }
  const shared = job; shared.users++;
  return new Promise<McpCatalogue>((resolve, reject) => {
    let finished = false;
    const finish = () => { if (finished) return false; finished = true; signal?.removeEventListener("abort", abort); if (--shared.users === 0 && jobs.get(k) === shared) shared.controller.abort(); return true; };
    const abort = () => { if (finish()) reject(new McpError("cancelled")); };
    signal?.addEventListener("abort", abort, { once: true });
    shared.promise.then(value => { if (finish()) resolve(value); }, error => { if (finish()) reject(error); });
    if (signal?.aborted) abort();
  });
}
/** For visible surfaces: stale-while-refresh, never automatic networking when disabled. */
export async function browseCatalogue(server: McpServer, signal?: AbortSignal): Promise<void> {
  await hydrateCatalogue(server); signal?.throwIfAborted();
  const state = catalogueState(server);
  if (!isMcpEnabled() || !server.enabled || !current(server)) return;
  if (state.snapshot && !catalogueStale(state.snapshot)) return;
  if (state.attemptedAt && Date.now() - state.attemptedAt < 300_000) return;
  await refreshCatalogue(server, signal);
}
/** Discovery needs a usable definition, but never substitutes for apply-time validation. */
export async function discoverCatalogue(server: McpServer, signal?: AbortSignal): Promise<McpCatalogue> {
  await hydrateCatalogue(server); signal?.throwIfAborted();
  const cached = catalogueState(server).snapshot;
  if (cached && !catalogueStale(cached)) return cached;
  // A stale cache is browsing-only when the network fails; do not imply callability.
  return refreshCatalogue(server, signal);
}
export async function invalidateCatalogue(server: McpServer): Promise<void> {
  const job = jobs.get(key(server)); job?.controller.abort();
  if (job) await job.promise.catch(() => {});
  states.delete(key(server));
  await serialDisk(() => deleteCatalogueRow(server.id)); listeners.forEach(fn => fn());
}
export async function clearMcpCatalogues(): Promise<void> {
  jobs.forEach(job => job.controller.abort());
  await Promise.allSettled([...jobs.values()].map(job => job.promise));
  await Promise.allSettled([...reads.values()]);
  states.clear();
  await serialDisk(clearCatalogueRows); listeners.forEach(fn => fn());
}
subscribeMcpConfig(() => {
  const valid = new Set(readMcpServers().map(key));
  for (const k of [...states.keys()]) if (!valid.has(k)) {
    jobs.get(k)?.controller.abort(); states.delete(k);
    const id = k.split(":")[0];
    void serialDisk(() => deleteCatalogueRow(id)).catch(() => {});
  }
  listeners.forEach(fn => fn());
});
