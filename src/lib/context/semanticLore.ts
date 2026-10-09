/** Optional, bounded catalog retrieval. Scope is filtered before any text leaves the app. */
import type { Model, Provider } from "../ai/configDb";
import { providerFor } from "../ai/routes";
import { loadApiKey } from "../keyStore";
import { embed, rerank, cosine, retrievalUrl, RetrievalError, type RetrievalConnection } from "../ai/retrieval";
import { recordUsage } from "../ai/usageRow";
import { inScope, type LoreEntity, type LoreIndex, type LoreScope } from "../lore";
import { semanticPrefs } from "./semanticPrefs";

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
const CACHE_LIMIT = 1024;
const vectors = new Map<string, number[]>();
export function clearSemanticCache(): void { vectors.clear(); }

/** Metadata only: descriptions must carry the connections retrieval can discover. */
export function catalogText(e: LoreEntity): string {
  return [e.name, ...(e.aliases ?? []), e.summary, ...e.facets.filter((f) => f.mode !== "manual").map((f) => `${f.title}: ${f.keys.join(", ")}`)]
    .filter(Boolean).join("\n");
}

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
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
  const signal = controller.signal;
  const stopped = new Promise<never>((_, reject) => {
    const stop = () => reject(new DOMException("Retrieval stopped", "AbortError"));
    if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
  });
  const run = async (): Promise<SemanticMatch[]> => {
    const resolve = async (id: string, ranking: boolean) => {
      const model = args.models.find((m) => m.id === id && m.enabled);
      const provider = model && providerFor(model, args.providers);
      if (!model?.retrieval || !provider || (model.retrieval.format === "cohere-rerank") !== ranking) throw new RetrievalError("model");
      const apiKey = await loadApiKey(provider.id) ?? "";
      signal.throwIfAborted();
      const conn: RetrievalConnection = { baseUrl: provider.baseUrl, modelId: model.modelId, apiKey, retrieval: model.retrieval };
      return { conn, usage: (usage: { promptTokens: number; outputUnits?: number }) => {
        void recordUsage(args.projectPath, { model, reportedCost: null, task: ranking ? "kb-rerank" : "kb-embedding", ...usage });
      } };
    };
    if (!prefs.embeddingModelId && !prefs.rerankerModelId) throw new RetrievalError("model");
    let candidates = catalog.map((entity) => ({ entity, score: 0 }));
    const query = target.slice(0, QUERY_LIMIT);
    if (prefs.embeddingModelId) {
      const { conn, usage } = await resolve(prefs.embeddingModelId, false);
      const texts = catalog.map((e) => (conn.retrieval?.documentPrefix ?? "") + catalogText(e).slice(0, 1600));
      const identity = JSON.stringify([args.projectPath, prefs.embeddingModelId, retrievalUrl(conn), conn.modelId, conn.retrieval]);
      const keys = texts.map((s) => identity + s);
      const missing = keys.map((k, i) => vectors.has(k) ? -1 : i).filter((i) => i >= 0);
      for (let start = 0; start < missing.length; start += 32) {
        signal.throwIfAborted();
        const batch = missing.slice(start, start + 32);
        const output = await embed(conn, batch.map((i) => texts[i]), signal, usage);
        signal.throwIfAborted();
        batch.forEach((i, j) => {
          if (vectors.size >= CACHE_LIMIT) vectors.delete(vectors.keys().next().value!);
          vectors.set(keys[i], output[j]);
        });
      }
      const [q] = await embed(conn, [(conn.retrieval?.queryPrefix ?? "") + query], signal, usage);
      if (keys.some((key) => vectors.get(key)?.length !== q.length)) {
        keys.forEach((key) => vectors.delete(key));
        throw new Error("Embedding dimensions changed; cache invalidated");
      }
      candidates = catalog.map((entity, i) => {
        const v = vectors.get(keys[i]);
        if (!v) throw new Error("Embedding cache changed during retrieval");
        return { entity, score: cosine(q, v) };
      }).sort((a, b) => b.score - a.score || a.entity.dirPath.localeCompare(b.entity.dirPath));
      // A reranker gets a broad shortlist, before any embedding threshold.
      if (prefs.rerankerModelId) candidates = candidates.slice(0, 30);
    }
    if (prefs.rerankerModelId) {
      const { conn, usage } = await resolve(prefs.rerankerModelId, true);
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
