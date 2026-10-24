import type { Model } from "../../../lib/ai/configDb";
import type { SemanticPrefs } from "../../../lib/context/semanticPrefs";

/** Only the active project's preferences are known; never infer a global count. */
export function retrievalModelWarning(
  before: Model, after: Model | null, prefs: SemanticPrefs,
): "current" | "other" | null {
  const bound = prefs.embeddingModelId === before.id || prefs.rerankerModelId === before.id;
  const retrieval = before.type === "embedding" || before.type === "rerank" || !!before.retrieval;
  if (!bound && !retrieval) return null;
  if (after && before.type === after.type && before.enabled === after.enabled &&
    before.modelId === after.modelId && before.providerId === after.providerId &&
    before.activeRoute === after.activeRoute &&
    before.retrieval?.format === after.retrieval?.format &&
    before.retrieval?.path === after.retrieval?.path &&
    before.retrieval?.queryPrefix === after.retrieval?.queryPrefix &&
    before.retrieval?.documentPrefix === after.retrieval?.documentPrefix) return null;
  return bound ? "current" : "other";
}

export function retrievalDeletionWarning(models: readonly Model[], prefs: SemanticPrefs): "current" | "other" | null {
  const warnings = models.map((model) => retrievalModelWarning(model, null, prefs));
  return warnings.includes("current") ? "current" : warnings.includes("other") ? "other" : null;
}
