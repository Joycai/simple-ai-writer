/** Shared indexing path for on-demand retrieval and explicit preparation. */
import type { Model, Provider } from "../ai/configDb";
import { providerFor } from "../ai/routes";
import { embed, embeddingLimits, retrievalUrl, RetrievalError, type RetrievalConnection } from "../ai/retrieval";
import { recordUsage } from "../ai/usageRow";
import { loadApiKey } from "../keyStore";
import { inScope, type LoreEntity, type LoreIndex, type LoreScope } from "../lore";
import { digest, readEmbeddings, writeEmbeddings, pruneEmbeddings, invalidateEmbeddings, removeEmbeddings } from "./embeddingCache";

interface IndexConfig { projectPath: string; models: readonly Model[]; providers: Provider[] }
export interface IndexProgress { ready: number; total: number }
export function catalogText(e: LoreEntity): string {
  return [e.name, ...(e.aliases ?? []), e.summary, ...e.facets.filter((f) => f.mode !== "manual").map((f) => `${f.title}: ${f.keys.join(", ")}`)]
    .filter(Boolean).join("\n");
}
function indexConnection(args: IndexConfig, id: string, ranking = false) {
  const model = args.models.find((m) => m.id === id && m.enabled);
  const provider = model && providerFor(model, args.providers);
  if (!model?.retrieval || !provider || (model.retrieval.format === "cohere-rerank") !== ranking) throw new RetrievalError("model");
  const conn: RetrievalConnection = { baseUrl: provider.baseUrl, modelId: model.modelId, retrieval: model.retrieval, apiKey: "" };
  return { model, provider, conn };
}
export async function resolveIndexConnection(args: IndexConfig, id: string, signal: AbortSignal, ranking = false) {
  const { model, provider, conn } = indexConnection(args, id, ranking);
  conn.apiKey = await loadApiKey(provider.id) ?? "";
  signal.throwIfAborted();
  return { conn, usage: (usage: { promptTokens: number; outputUnits?: number }) => {
    void recordUsage(args.projectPath, { model, reportedCost: null, task: ranking ? "kb-rerank" : "kb-embedding", ...usage });
  } };
}
const indexEntries = (index: LoreIndex, scope: LoreScope) => Object.values(index).flat()
  .filter((e) => inScope(e, scope)).sort((a, b) => a.dirPath.localeCompare(b.dirPath));
const entryKey = (project: string, e: LoreEntity) => e.dirPath.startsWith(project + "/") ? e.dirPath.slice(project.length + 1) : e.dirPath;
export async function indexIdentity(conn: RetrievalConnection): Promise<string> {
  return digest(JSON.stringify([1, retrievalUrl(conn), conn.modelId, conn.retrieval]));
}
async function descriptions(project: string, conn: RetrievalConnection, entries: LoreEntity[]) {
  return Promise.all(entries.map(async (e) => {
    const text = (conn.retrieval?.documentPrefix ?? "") + catalogText(e).slice(0, 1600);
    return { entry: entryKey(project, e), hash: await digest(text), text };
  }));
}
export async function indexStatus(args: IndexConfig, id: string, index: LoreIndex, scope: LoreScope): Promise<IndexProgress> {
  const { conn } = indexConnection(args, id);
  const rows = await descriptions(args.projectPath, conn, indexEntries(index, scope));
  const cache = await readEmbeddings(args.projectPath, await indexIdentity(conn));
  return { ready: rows.filter((r) => cache.get(r.entry)?.hash === r.hash).length, total: rows.length };
}
// Serialize this installation's preparation and retrieval for a project/model.
// A waiting cancelled operation checks its signal before any billed work.
const locks = new Map<string, Promise<unknown>>();
async function embedBatch(conn: RetrievalConnection, texts: string[], signal: AbortSignal,
  usage: (u: { promptTokens: number; outputUnits?: number }) => void) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error("Embedding request timed out")), embeddingLimits(conn).timeoutMs);
  let stop = () => {};
  const stopped = new Promise<never>((_, reject) => {
    stop = () => reject(controller.signal.reason);
    if (controller.signal.aborted) stop(); else controller.signal.addEventListener("abort", stop, { once: true });
  });
  try { return await Promise.race([embed(conn, texts, controller.signal, usage), stopped]); }
  finally { clearTimeout(timer); signal.removeEventListener("abort", abort); controller.signal.removeEventListener("abort", stop); }
}
export async function indexedVectors(
  args: IndexConfig, conn: RetrievalConnection, entries: LoreEntity[], index: LoreIndex,
  signal: AbortSignal, usage: (u: { promptTokens: number; outputUnits?: number }) => void,
  onProgress?: (p: IndexProgress) => void, rebuild = false,
): Promise<number[][]> {
  const namespace = await indexIdentity(conn);
  const lockKey = args.projectPath + namespace;
  const previous = locks.get(lockKey) ?? Promise.resolve();
  const job = previous.catch(() => {}).then(async () => {
    signal.throwIfAborted();
    await pruneEmbeddings(args.projectPath, Object.values(index).flat().map((e) => entryKey(args.projectPath, e)));
    const rows = await descriptions(args.projectPath, conn, entries);
    signal.throwIfAborted();
    if (rebuild) await removeEmbeddings(args.projectPath, namespace, rows.map((r) => r.entry));
    const cache = await readEmbeddings(args.projectPath, namespace);
    const missing = rows.filter((r) => cache.get(r.entry)?.hash !== r.hash);
    let ready = rows.length - missing.length;
    onProgress?.({ ready, total: rows.length });
    const { batchSize } = embeddingLimits(conn);
    for (let start = 0; start < missing.length; start += batchSize) {
      signal.throwIfAborted();
      const batch = missing.slice(start, start + batchSize);
      const output = await embedBatch(conn, batch.map((r) => r.text), signal, usage);
      signal.throwIfAborted();
      const saved = batch.map((r, i) => ({ entry: r.entry, hash: r.hash, vector: output[i] }));
      await writeEmbeddings(args.projectPath, namespace, saved);
      saved.forEach((r) => cache.set(r.entry, r));
      ready += saved.length;
      onProgress?.({ ready, total: rows.length });
    }
    signal.throwIfAborted();
    const result = rows.map((r) => cache.get(r.entry)!.vector);
    if (result.some((v) => v.length !== result[0]?.length)) {
      await invalidateEmbeddings(args.projectPath, namespace);
      throw new RetrievalError("response");
    }
    return result;
  });
  locks.set(lockKey, job);
  try { return await job; }
  finally { if (locks.get(lockKey) === job) locks.delete(lockKey); }
}
export async function prepareIndex(
  args: IndexConfig, id: string, index: LoreIndex, scope: LoreScope,
  signal: AbortSignal, onProgress: (p: IndexProgress) => void, rebuild = false,
): Promise<void> {
  const { conn, usage } = await resolveIndexConnection(args, id, signal);
  await indexedVectors(args, conn, indexEntries(index, scope), index, signal, usage, onProgress, rebuild);
}
