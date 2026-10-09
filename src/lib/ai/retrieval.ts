/** Dedicated retrieval protocols. No conversational prompts or tool loop. */
import { fetch } from "../http";
import type { ConnOptions } from "./conn";
import { validRetrievalPath } from "./retrievalConfig";

export type RetrievalConnection = Pick<ConnOptions, "baseUrl" | "apiKey" | "modelId" | "retrieval">;
interface RetrievalUsage { promptTokens: number; outputUnits?: number }
type UsageListener = (usage: RetrievalUsage) => void;

export function retrievalUrl(conn: RetrievalConnection): string {
  if (!conn.retrieval || !validRetrievalPath(conn.retrieval.path)) throw new Error("Invalid retrieval path");
  const base = new URL(conn.baseUrl);
  if (!/^https?:$/.test(base.protocol) || base.username || base.password) throw new Error("Invalid retrieval host");
  return new URL(conn.retrieval.path, base.origin).href;
}
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid retrieval response");
  return raw as Record<string, unknown>;
}
function number(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
}
async function request(conn: RetrievalConnection, body: object, signal: AbortSignal, onUsage?: UsageListener) {
  const response = await fetch(retrievalUrl(conn), {
    method: "POST", signal, redirect: "error",
    headers: { "Content-Type": "application/json", ...(conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {}) },
    body: JSON.stringify({ model: conn.modelId, ...body }),
  });
  if (!response.ok) throw new Error(`Retrieval HTTP ${response.status}`);
  const data = object(await response.json());
  const usage = data.usage as Record<string, unknown> | undefined;
  const meta = data.meta as { billed_units?: { search_units?: unknown } } | undefined;
  // Record successful billed requests even if their vectors/scores are malformed.
  onUsage?.({ promptTokens: number(usage?.prompt_tokens ?? usage?.total_tokens ?? data.prompt_eval_count),
    outputUnits: number(meta?.billed_units?.search_units) || undefined });
  return data;
}
function vector(raw: unknown): number[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 65536
    || !raw.every((x) => typeof x === "number" && Number.isFinite(x))
    || !raw.some((x) => x !== 0)) throw new Error("Invalid embedding vector");
  return raw as number[];
}
export async function embed(conn: RetrievalConnection, input: string[], signal: AbortSignal, onUsage?: UsageListener): Promise<number[][]> {
  const native = conn.retrieval?.format === "ollama-embedding";
  const data = await request(conn, { input, ...(native ? { truncate: false } : { encoding_format: "float" }) }, signal, onUsage);
  let result: number[][];
  if (native) {
    if (!Array.isArray(data.embeddings)) throw new Error("Missing embeddings");
    result = data.embeddings.map(vector);
  } else {
    if (!Array.isArray(data.data)) throw new Error("Missing embeddings");
    const indexed = new Map<number, number[]>();
    for (const raw of data.data) {
      const row = object(raw);
      const i = row.index;
      if (!Number.isInteger(i) || Number(i) < 0 || Number(i) >= input.length || indexed.has(Number(i))) throw new Error("Invalid embedding index");
      indexed.set(Number(i), vector(row.embedding));
    }
    result = input.map((_, i) => { const v = indexed.get(i); if (!v) throw new Error("Missing embedding index"); return v; });
  }
  if (result.length !== input.length || result.some((v) => v.length !== result[0]?.length)) throw new Error("Embedding dimensions/count mismatch");
  return result;
}
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("Embedding dimensions changed");
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  const score = dot / Math.sqrt(aa * bb);
  if (!Number.isFinite(score)) throw new Error("Invalid embedding similarity");
  return score;
}
export async function rerank(conn: RetrievalConnection, query: string, documents: string[], signal: AbortSignal, onUsage?: UsageListener): Promise<{ index: number; score: number }[]> {
  const data = await request(conn, { query, documents, top_n: documents.length }, signal, onUsage);
  if (!Array.isArray(data.results)) throw new Error("Missing rerank results");
  const seen = new Set<number>();
  return data.results.map((raw) => {
    const r = object(raw), index = Number(r.index), score = r.relevance_score;
    if (typeof r.index !== "number" || !Number.isInteger(index) || index < 0 || index >= documents.length || seen.has(index)
      || typeof score !== "number" || !Number.isFinite(score)) throw new Error("Invalid rerank result");
    seen.add(index);
    return { index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
}
