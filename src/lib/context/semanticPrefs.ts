import { readPref, writePref, SEMANTIC_LORE_PREFIX } from "../prefs";
import { toPosixPath } from "../paths";

export interface SemanticPrefs {
  enabled: boolean;
  documentEnabled?: boolean;
  embeddingModelId: string;
  rerankerModelId: string;
  /** Legacy fallback for preferences saved before split thresholds. */
  minScore: number;
  cosineMinScore?: number;
  rerankerMinScore?: number;
}
const DEFAULT_SEMANTIC_PREFS: SemanticPrefs = {
  enabled: false, documentEnabled: false, embeddingModelId: "", rerankerModelId: "", minScore: 0.5,
};
const finiteScore = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
export function retrievalThreshold(prefs: SemanticPrefs): number {
  const legacy = Math.max(-1, Math.min(1, finiteScore(prefs.minScore, 0.5)));
  return prefs.rerankerModelId
    ? finiteScore(prefs.rerankerMinScore, legacy)
    : Math.max(-1, Math.min(1, finiteScore(prefs.cosineMinScore, legacy)));
}
const key = (project: string) => SEMANTIC_LORE_PREFIX + toPosixPath(project);
export function semanticPrefs(project: string | null): SemanticPrefs {
  if (!project) return { ...DEFAULT_SEMANTIC_PREFS };
  try {
    const r = JSON.parse(readPref(key(project)) ?? "null");
    const legacy = Math.max(-1, Math.min(1, finiteScore(r?.minScore, 0.5)));
    return {
      cosineMinScore: Math.max(-1, Math.min(1, finiteScore(r?.cosineMinScore, legacy))),
      rerankerMinScore: finiteScore(r?.rerankerMinScore, legacy),
      enabled: r?.enabled === true,
      documentEnabled: r?.documentEnabled === true,
      embeddingModelId: typeof r?.embeddingModelId === "string" ? r.embeddingModelId : "",
      rerankerModelId: typeof r?.rerankerModelId === "string" ? r.rerankerModelId : "",
      minScore: legacy,
    };
  } catch { return { ...DEFAULT_SEMANTIC_PREFS }; }
}
const listeners = new Set<() => void>();
export function subscribeSemanticPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function saveSemanticPrefs(project: string, value: SemanticPrefs): void {
  writePref(key(project), JSON.stringify(value));
  listeners.forEach((listener) => listener());
}
