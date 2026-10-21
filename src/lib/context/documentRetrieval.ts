/** Retrieval of background prose only. The author's edit/summary selection stays intact. */
import { embed, rerank, cosine, embeddingLimits } from "../ai/retrieval";
import { digest, documentEmbeddingCache as cache } from "./embeddingCache";
import { indexIdentity, resolveIndexConnection } from "./semanticIndex";
import type { SemanticRequest } from "./semanticLore";
import { semanticPrefs } from "./semanticPrefs";
import { DOCUMENT_LOCAL_CHARS } from "./documentRetrievalPolicy";

interface DocumentChunk { from: number; to: number; text: string }
export interface DocumentRetrievalReport {
  status: "complete" | "unavailable" | "timeout" | "tooLarge";
  considered: number;
  matches: { from: number; to: number; score: number }[];
}
const CHUNK_CHARS = 1200;
const OVERLAP = 160;
const MAX_CHUNKS = 4096;
/** Offsets refer to the current editor snapshot, including unsaved changes. */
export function documentChunks(text: string, end: number): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  for (let from = 0; from < end;) {
    let to = Math.min(end, from + CHUNK_CHARS);
    if (to < end) {
      // Search only this chunk: scanning the whole prefix is quadratic when
      // a long document has no paragraph breaks. Include both delimiter chars.
      const boundary = from + text.slice(from, to + 2).lastIndexOf("\n\n");
      if (boundary > from + CHUNK_CHARS / 2) to = Math.min(end, boundary + 2);
      // Never split a UTF-16 surrogate pair.
      if (/[\uD800-\uDBFF]/.test(text[to - 1])) to--;
    }
    const body = text.slice(from, to);
    if (body.trim()) chunks.push({ from, to, text: body });
    if (chunks.length > MAX_CHUNKS || to >= end) break;
    from = Math.max(from + 1, to - OVERLAP);
    if (/[\uDC00-\uDFFF]/.test(text[from])) from++;
  }
  return chunks;
}
const locks = new Map<string, Promise<unknown>>();
async function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const job = previous.catch(() => {}).then(run);
  locks.set(key, job);
  try { return await job; } finally { if (locks.get(key) === job) locks.delete(key); }
}
/** Release index serialization even if an HTTP implementation ignores abort. */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let stop = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    stop = () => reject(new DOMException("Document indexing stopped", "AbortError"));
    if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener("abort", stop); }
}
export async function retrieveDocument(args: SemanticRequest, file: string, text: string,
  end: number, budget: number, query: string,
): Promise<{ local: string; excerpts: DocumentChunk[]; report?: DocumentRetrievalReport }> {
  args.signal?.throwIfAborted();
  const localStart = Math.max(0, end - Math.min(DOCUMENT_LOCAL_CHARS, budget));
  const local = text.slice(localStart, end).trim();
  const chunks = documentChunks(text, localStart);
  const report: DocumentRetrievalReport = { status: "complete", considered: chunks.length, matches: [] };
  if (!chunks.length || !query.trim() || budget <= DOCUMENT_LOCAL_CHARS) return { local, excerpts: [] };
  if (chunks.length > MAX_CHUNKS) return { local, excerpts: [], report: { ...report, status: "tooLarge" } };
  const prefs = semanticPrefs(args.projectPath);
  const controller = new AbortController();
  const abort = () => controller.abort(args.signal?.reason);
  args.signal?.addEventListener("abort", abort, { once: true });
  if (args.signal?.aborted) abort();
  const signal = controller.signal;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 60_000);
  let stop = () => {};
  const stopped = new Promise<never>((_, reject) => {
    stop = () => reject(new DOMException("Document retrieval stopped", "AbortError"));
    if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
  });
  const run = async () => {
    signal.throwIfAborted();
    if (!prefs.embeddingModelId) throw new Error("Document retrieval requires an embedding model");
    const { conn, usage } = await resolveIndexConnection(args, prefs.embeddingModelId, signal, false, "document");
    const namespace = await digest(JSON.stringify(["document-v1", file, await indexIdentity(conn)]));
    const rows = await Promise.all(chunks.map(async (chunk) => {
      const input = (conn.retrieval?.documentPrefix ?? "") + chunk.text;
      const hash = await digest(input);
      return { entry: hash, hash, text: input };
    }));
    const vectors = await serialized(args.projectPath + namespace, async () => {
      signal.throwIfAborted();
      const stored = await cache.readEmbeddings(args.projectPath, namespace);
      const missing = [...new Map(rows.filter((r) => !stored.has(r.entry)).map((r) => [r.entry, r])).values()];
      const { batchSize } = embeddingLimits(conn);
      for (let i = 0; i < missing.length; i += batchSize) {
        signal.throwIfAborted();
        const batch = missing.slice(i, i + batchSize);
        const output = await abortable(embed(conn, batch.map((r) => r.text), signal, usage), signal);
        signal.throwIfAborted();
        const saved = batch.map((r, j) => ({ entry: r.entry, hash: r.hash, vector: output[j] }));
        await cache.writeEmbeddings(args.projectPath, namespace, saved);
        saved.forEach((r) => stored.set(r.entry, r));
      }
      signal.throwIfAborted();
      await cache.pruneNamespace(args.projectPath, namespace, rows.map((r) => r.entry));
      return rows.map((r) => stored.get(r.entry)!.vector);
    });
    const qtext = query.slice(0, 4000);
    const [q] = await embed(conn, [(conn.retrieval?.queryPrefix ?? "") + qtext], signal, usage);
    if (vectors.some((v) => v.length !== q.length)) {
      await cache.invalidateEmbeddings(args.projectPath, namespace);
      throw new Error("Document embedding dimensions changed");
    }
    let ranked = chunks.map((chunk, i) => ({ chunk, score: cosine(q, vectors[i]) }))
      .sort((a, b) => b.score - a.score || a.chunk.from - b.chunk.from).slice(0, 30);
    if (prefs.rerankerModelId) {
      const ranking = await resolveIndexConnection(args, prefs.rerankerModelId, signal, true, "document");
      const scores = await rerank(ranking.conn, qtext, ranked.map((r) => r.chunk.text), signal, ranking.usage);
      ranked = scores.map((r) => ({ chunk: ranked[r.index].chunk, score: r.score }));
    }
    signal.throwIfAborted();
    // Leave room for provenance labels; preserve source order after ranking.
    let remaining = Math.max(0, budget - local.length - 600);
    const picked: typeof ranked = [];
    for (const item of ranked) {
      if (item.score < prefs.minScore || picked.length >= 6) continue;
      if (picked.some((p) => item.chunk.from < p.chunk.to && item.chunk.to > p.chunk.from)) continue;
      if (item.chunk.text.length + 100 > remaining) continue;
      picked.push(item); remaining -= item.chunk.text.length + 100;
    }
    picked.sort((a, b) => a.chunk.from - b.chunk.from);
    report.matches = picked.map((r) => ({ from: r.chunk.from, to: r.chunk.to, score: r.score }));
    return { local, excerpts: picked.map((r) => r.chunk), report };
  };
  try { return await Promise.race([run(), stopped]); }
  catch (error) {
    if (args.signal?.aborted) throw error;
    return { local, excerpts: [], report: { ...report, status: timedOut ? "timeout" as const : "unavailable" as const } };
  } finally {
    clearTimeout(timer); signal.removeEventListener("abort", stop);
    args.signal?.removeEventListener("abort", abort);
  }
}
