import { readPref, writePref, SEMANTIC_LORE_PREFIX } from "../prefs";
import { toPosixPath } from "../paths";

export interface SemanticPrefs {
  enabled: boolean;
  embeddingModelId: string;
  rerankerModelId: string;
  minScore: number;
}
const DEFAULT_SEMANTIC_PREFS: SemanticPrefs = {
  enabled: false, embeddingModelId: "", rerankerModelId: "", minScore: 0.5,
};
const key = (project: string) => SEMANTIC_LORE_PREFIX + toPosixPath(project);
export function semanticPrefs(project: string | null): SemanticPrefs {
  if (!project) return { ...DEFAULT_SEMANTIC_PREFS };
  try {
    const r = JSON.parse(readPref(key(project)) ?? "null");
    return {
      enabled: r?.enabled === true,
      embeddingModelId: typeof r?.embeddingModelId === "string" ? r.embeddingModelId : "",
      rerankerModelId: typeof r?.rerankerModelId === "string" ? r.rerankerModelId : "",
      minScore: typeof r?.minScore === "number" && Number.isFinite(r.minScore)
        ? Math.max(-1, Math.min(1, r.minScore)) : 0.5,
    };
  } catch { return { ...DEFAULT_SEMANTIC_PREFS }; }
}
export function saveSemanticPrefs(project: string, value: SemanticPrefs): void {
  writePref(key(project), JSON.stringify(value));
}
