import type { ConnOptions } from "./conn";

export type RetrievalConfig = NonNullable<ConnOptions["retrieval"]>;
export const RETRIEVAL_PATHS: Record<RetrievalConfig["format"], string> = {
  "openai-embedding": "/v1/embeddings",
  "ollama-embedding": "/api/embed",
  "cohere-rerank": "/v2/rerank",
};

/** Paths are same-origin, so a model cannot redirect a channel's credential. */
export function validRetrievalPath(path: string): boolean {
  return /^\/(?!\/)[^?#\\\s]*$/.test(path);
}

export function parseRetrievalConfig(raw: unknown): RetrievalConfig | undefined {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!value || typeof value !== "object") return undefined;
    const r = value as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(RETRIEVAL_PATHS, String(r.format))) return undefined;
    if (typeof r.path !== "string" || !validRetrievalPath(r.path)) return undefined;
    return {
      format: r.format as RetrievalConfig["format"], path: r.path,
      queryPrefix: typeof r.queryPrefix === "string" ? r.queryPrefix : undefined,
      documentPrefix: typeof r.documentPrefix === "string" ? r.documentPrefix : undefined,
    };
  } catch { return undefined; }
}
