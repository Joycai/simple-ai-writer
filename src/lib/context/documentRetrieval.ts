/** Retrieval of background prose only. The author's edit/summary selection stays intact. */
import { embed, rerank, cosine, embeddingLimits } from "../ai/retrieval";
import { digest, documentEmbeddingCache as cache } from "./embeddingCache";
import { indexIdentity, resolveIndexConnection } from "./semanticIndex";
import type { SemanticRequest, RetrievalProgress } from "./semanticLore";
import { semanticPrefs, retrievalThreshold } from "./semanticPrefs";
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
const CHUNK_VERSION = "document-cdc-v2";
const HASH_WINDOW = 32;
const ANCHOR_RADIUS = 240;
// A rolling polynomial over the preceding 32 UTF-16 units forgets an edit
// after that window. Keep it rolling across cuts, so offsets aren't anchors.
const HASH_POWER = Array.from({ length: HASH_WINDOW }, () => 31)
  .reduce((power, base) => Math.imul(power, base), 1);
function fingerprint(hash: number): number {
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}
const highSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const lowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
/** Offsets refer to the current editor snapshot, including unsaved changes. */
export function documentChunks(text: string, end: number): DocumentChunk[] {
  end = Math.max(0, Math.min(text.length, Math.floor(end)));
  // An anchor inside a pair excludes that whole code point; never read past it.
  if (highSurrogate(text.charCodeAt(end - 1))) end--;
  const chunks: DocumentChunk[] = [];
  let from = 0;
  let hash = 0;
  // Monotonic queue over a bounded neighbourhood: a unique local minimum is
  // an anchor regardless of earlier cuts. Equal minima are deliberately not
  // anchors (repeated text falls back to the hard size limit).
  const minima: { at: number; score: number }[] = [];
  for (let scanned = 1; scanned <= end + ANCHOR_RADIUS; scanned++) {
    if (scanned <= end) {
      hash = (Math.imul(hash, 31) + text.charCodeAt(scanned - 1)) | 0;
      if (scanned > HASH_WINDOW) hash = (hash - Math.imul(text.charCodeAt(scanned - HASH_WINDOW - 1), HASH_POWER)) | 0;
      const paragraph = text.charCodeAt(scanned - 1) === 10 && text.charCodeAt(scanned - 2) === 10;
      const splitPair = highSurrogate(text.charCodeAt(scanned - 1)) && lowSurrogate(text.charCodeAt(scanned));
      const score = splitPair ? Infinity : fingerprint(hash) / (paragraph ? 4 : 1);
      while (minima.length && minima[minima.length - 1].score > score) minima.pop();
      minima.push({ at: scanned, score });
    }
    const to = scanned - ANCHOR_RADIUS;
    while (minima.length && minima[0].at < to - ANCHOR_RADIUS) minima.shift();
    if (to <= 0) continue;
    const splitPair = highSurrogate(text.charCodeAt(to - 1)) && lowSurrogate(text.charCodeAt(to));
    if (splitPair) continue;
    const anchor = to >= HASH_WINDOW + ANCHOR_RADIUS && scanned <= end &&
      minima[0]?.at === to && minima[0]?.score !== minima[1]?.score;
    // Cut one unit early if the hard limit would bisect an astral character.
    const limit = to - from >= CHUNK_CHARS ||
      (to - from === CHUNK_CHARS - 1 && highSurrogate(text.charCodeAt(to)));
    if (to !== end && !anchor && !limit) continue;
    const body = text.slice(from, to);
    if (body.trim()) chunks.push({ from, to, text: body });
    if (chunks.length > MAX_CHUNKS) break;
    from = Math.max(0, to - OVERLAP);
    if (lowSurrogate(text.charCodeAt(from))) from++;
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
  // Failed or empty retrieval must still use the planned, anchor-bounded window.
  const fallback = () => text.slice(Math.max(0, end - Math.max(0, budget)), end).trim();
  const chunks = documentChunks(text, localStart);
  const report: DocumentRetrievalReport = { status: "complete", considered: chunks.length, matches: [] };
  if (!chunks.length || !query.trim() || budget <= DOCUMENT_LOCAL_CHARS) return { local: fallback(), excerpts: [] };
  if (chunks.length > MAX_CHUNKS) return { local: fallback(), excerpts: [], report: { ...report, status: "tooLarge" } };
  const prefs = args.prefs ?? semanticPrefs(args.projectPath);
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
  let finished = false;
  const progress = (phase: RetrievalProgress["phase"], counts?: { ready: number; total: number }) => {
    if (!finished && !signal.aborted) args.onProgress?.({ source: "document", phase, ...counts });
  };
  progress("preparing");
  const run = async () => {
    signal.throwIfAborted();
    if (!prefs.embeddingModelId) throw new Error("Document retrieval requires an embedding model");
    const { conn, usage } = await resolveIndexConnection(args, prefs.embeddingModelId, signal, false, "document");
    const namespace = await digest(JSON.stringify([CHUNK_VERSION, file, await indexIdentity(conn)]));
    const rows = await Promise.all(chunks.map(async (chunk) => {
      const input = (conn.retrieval?.documentPrefix ?? "") + chunk.text;
      const hash = await digest(input);
      return { entry: hash, hash, text: input };
    }));
    const vectors = await serialized(args.projectPath + namespace, async () => {
      signal.throwIfAborted();
      const stored = await cache.readEmbeddings(args.projectPath, namespace);
      const missing = [...new Map(rows.filter((r) => !stored.has(r.entry)).map((r) => [r.entry, r])).values()];
      const total = new Set(rows.map((r) => r.entry)).size;
      let ready = total - missing.length;
      progress("indexing", { ready, total });
      const { batchSize } = embeddingLimits(conn);
      for (let i = 0; i < missing.length; i += batchSize) {
        signal.throwIfAborted();
        const batch = missing.slice(i, i + batchSize);
        const output = await abortable(embed(conn, batch.map((r) => r.text), signal, usage), signal);
        signal.throwIfAborted();
        const saved = batch.map((r, j) => ({ entry: r.entry, hash: r.hash, vector: output[j] }));
        await cache.writeEmbeddings(args.projectPath, namespace, saved);
        saved.forEach((r) => stored.set(r.entry, r));
        ready += saved.length;
        progress("indexing", { ready, total });
      }
      signal.throwIfAborted();
      await cache.pruneNamespace(args.projectPath, namespace, rows.map((r) => r.entry));
      return rows.map((r) => stored.get(r.entry)!.vector);
    });
    const qtext = query.slice(0, 4000);
    progress("query");
    const [q] = await embed(conn, [(conn.retrieval?.queryPrefix ?? "") + qtext], signal, usage);
    if (vectors.some((v) => v.length !== q.length)) {
      await cache.invalidateEmbeddings(args.projectPath, namespace);
      throw new Error("Document embedding dimensions changed");
    }
    let ranked = chunks.map((chunk, i) => ({ chunk, score: cosine(q, vectors[i]) }))
      .sort((a, b) => b.score - a.score || a.chunk.from - b.chunk.from).slice(0, 30);
    if (prefs.rerankerModelId) {
      const ranking = await resolveIndexConnection(args, prefs.rerankerModelId, signal, true, "document");
      progress("reranking");
      const scores = await rerank(ranking.conn, qtext, ranked.map((r) => r.chunk.text), signal, ranking.usage);
      ranked = scores.map((r) => ({ chunk: ranked[r.index].chunk, score: r.score }));
    }
    signal.throwIfAborted();
    // Leave room for provenance labels; preserve source order after ranking.
    let remaining = Math.max(0, budget - local.length - 600);
    const picked: typeof ranked = [];
    for (const item of ranked) {
      if (item.score < retrievalThreshold(prefs) || picked.length >= 6) continue;
      if (picked.some((p) => item.chunk.from < p.chunk.to && item.chunk.to > p.chunk.from)) continue;
      if (item.chunk.text.length + 100 > remaining) continue;
      picked.push(item); remaining -= item.chunk.text.length + 100;
    }
    picked.sort((a, b) => a.chunk.from - b.chunk.from);
    report.matches = picked.map((r) => ({ from: r.chunk.from, to: r.chunk.to, score: r.score }));
    return { local: picked.length ? local : fallback(), excerpts: picked.map((r) => r.chunk), report };
  };
  try { return await Promise.race([run(), stopped]); }
  catch (error) {
    if (args.signal?.aborted) throw error;
    return { local: fallback(), excerpts: [], report: { ...report, status: timedOut ? "timeout" as const : "unavailable" as const } };
  } finally {
    finished = true;
    args.onProgress?.(null);
    clearTimeout(timer); signal.removeEventListener("abort", stop);
    args.signal?.removeEventListener("abort", abort);
  }
}
