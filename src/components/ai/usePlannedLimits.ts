import { useMemo } from "react";
import { plannedLimitsOf, type PlannedLimits } from "../../lib/ai/conn";
import type { Model } from "../../lib/ai/configDb";
import { useAiStore } from "../../stores/aiStore";

/**
 * A model's window and per-reply cap as the run will plan with them — the
 * author's value, else the platform's or the catalog's (`plannedLimitsOf`).
 * Every bar, forecast and cap note reads this rather than `model.contextSize`,
 * so what the author is shown is what the run measures against.
 */
export function usePlannedLimits(model: Model | null | undefined): PlannedLimits {
  const providers = useAiStore((s) => s.providers);
  return useMemo(() => plannedLimitsOf(model ?? undefined, providers), [model, providers]);
}
