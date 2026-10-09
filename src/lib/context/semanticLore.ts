/** Optional, bounded catalog retrieval. Scope is filtered before any text leaves the app. */
import type { Model, Provider } from "../ai/configDb";
import { embed, rerank, cosine, embeddingLimits, RetrievalError } from "../ai/retrieval";
import { inScope, type LoreEntity, type LoreIndex, type LoreScope } from "../lore";
import { semanticPrefs } from "./semanticPrefs";
import { catalogText, resolveIndexConnection, indexedVectors, indexIdentity } from "./semanticIndex";
import { invalidateEmbeddings } from "./embeddingCache";
export { catalogText } from "./semanticIndex";

export interface SemanticRequest {
  projectPath: string;
  models: readonly Model[];
  providers: Provider[];
  signal?: AbortSignal;
  /** Author intent first, so a long selection cannot crowd it out. */
  query?: string;
}
export interface SemanticReport {
  status: "complete" | "unavailable" | "timeout";
  failure?: { code: "http" | "network" | "response" | "model" | "keyring"; status?: number };
  considered: number;
  omitted: number;
  queryTruncated: boolean;
  budgetDropped: number;
  descriptionsTruncated: number;
  matchesLimited: number;
}
interface SemanticMatch { entity: LoreEntity; score: number }
const CATALOG_LIMIT = 256;
const QUERY_LIMIT = 4000;
export async function retrieveSemantic(
  target: string, index: LoreIndex, scope: LoreScope | undefined,
  exclude: ReadonlySet<string>, args: SemanticRequest,
): Promise<{ matches: SemanticMatch[]; report?: SemanticReport }> {
  target = args.query ?? target;
  const prefs = semanticPrefs(args.projectPath);
  if (!prefs.enabled || !target.trim()) return { matches: [] };
  const all = Object.values(index).flat().filter((e) => !exclude.has(e.dirPath) && inScope(e, scope ?? null))
    .sort((a, b) => a.dirPath.localeCompare(b.dirPath));
  const catalog = all.slice(0, CATALOG_LIMIT);
  const report: SemanticReport = { status: "complete", considered: catalog.length,
    omitted: all.length - catalog.length, queryTruncated: target.length > QUERY_LIMIT, budgetDropped: 0,
    descriptionsTruncated: catalog.filter((e) => catalogText(e).length > 1600).length, matchesLimited: 0 };
  if (!catalog.length) return { matches: [], report };
  const controller = new AbortController();
  const abort = () => controller.abort(args.signal?.reason);
  args.signal?.addEventListener("abort", abort, { once: true });
  if (args.signal?.aborted) abort();
  let timedOut = false;
  const started = Date.now();
  const timeout = () => { timedOut = true; controller.abort(); };
  let timer = setTimeout(timeout, 20_000);
  const signal = controller.signal;
  const stopped = new Promise<never>((_, reject) => {
    const stop = () => reject(new DOMException("Retrieval stopped", "AbortError"));
    if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
  });
  const run = async (): Promise<SemanticMatch[]> => {
    if (!prefs.embeddingModelId && !prefs.rerankerModelId) throw new RetrievalError("model");
    let candidates = catalog.map((entity) => ({ entity, score: 0 }));
    const query = target.slice(0, QUERY_LIMIT);
    if (prefs.embeddingModelId) {
      const { conn, usage } = await resolveIndexConnection(args, prefs.embeddingModelId, signal);
      const { timeoutMs } = embeddingLimits(conn);
      // Smaller provider batches need more round trips on a cold catalog. Keep
      // one absolute deadline, including credential resolution and reranking.
      clearTimeout(timer);
      timer = setTimeout(timeout, Math.max(0, timeoutMs - (Date.now() - started)));
      const vectors = await indexedVectors(args, conn, catalog, index, signal, usage);
      const [q] = await embed(conn, [(conn.retrieval?.queryPrefix ?? "") + query], signal, usage);
      if (vectors.some((v) => v.length !== q.length)) {
        await invalidateEmbeddings(args.projectPath, await indexIdentity(conn));
        throw new Error("Embedding dimensions changed; cache invalidated");
      }
      candidates = catalog.map((entity, i) => {
        const v = vectors[i];
        if (!v) throw new Error("Embedding cache changed during retrieval");
        return { entity, score: cosine(q, v) };
      }).sort((a, b) => b.score - a.score || a.entity.dirPath.localeCompare(b.entity.dirPath));
      // A reranker gets a broad shortlist, before any embedding threshold.
      if (prefs.rerankerModelId) candidates = candidates.slice(0, 30);
    }
    if (prefs.rerankerModelId) {
      const { conn, usage } = await resolveIndexConnection(args, prefs.rerankerModelId, signal, true);
      const ranked = await rerank(conn, query, candidates.map((c) => catalogText(c.entity).slice(0, 1600)), signal, usage);
      candidates = ranked.map((r) => ({ entity: candidates[r.index].entity, score: r.score }));
    }
    signal.throwIfAborted();
    const matches = candidates.filter((c) => c.score >= prefs.minScore);
    report.matchesLimited = Math.max(0, matches.length - 5);
    return matches.slice(0, 5);
  };
  try { return { matches: await Promise.race([run(), stopped]), report }; }
  catch (error) {
    if (args.signal?.aborted) throw error;
    report.status = timedOut ? "timeout" : "unavailable";
    if (!timedOut) report.failure = error instanceof RetrievalError
      ? { code: error.code, status: error.status }
      : { code: error instanceof Error && error.name === "KeyringError" ? "keyring" : "response" };
    return { matches: [], report };
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener("abort", abort);
  }
}
