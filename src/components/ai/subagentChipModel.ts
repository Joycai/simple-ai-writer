/**
 * What the two renderings of the subagent switches agree on.
 *
 * There are two on purpose (设计稿 02g 屏 1c · 1z §3): on a composer the six
 * switches collapse into one word (`CapabilityMenu`), because the row above the
 * input is paid for on every message; in 一致性检查's pre-run settings block
 * they stay six boxes (`SubAgentChips`), because that surface is a form the
 * author reads once before starting. Only the *rendering* differs — which kinds
 * exist, which are usable, and what each is called live here, so the two can't
 * drift apart.
 */

import { useAiStore } from "../../stores/aiStore";
import { subAgentModel, SUBAGENT_KINDS, type SubAgentKind } from "../../lib/agent/subagent";

/**
 * Every kind that is a switch — i.e. all of them except the three nobody flips.
 *
 * The writer is excluded because its switch is a session-level decision made on
 * its own line (see `WriterStrip`, 设计稿 04d 屏 5a). `retrieval` is excluded
 * for a plainer reason: by the time the composer is on screen it has already
 * run, and a control that only takes effect on the *next* turn does not belong
 * among "for this turn" switches. `asr` is off the list too: transcription is
 * an explicit act (a right-click, or a tool whose card the author approves),
 * never something the model picks up mid-turn. All three live in Settings alone.
 */
export type ChipKind = Exclude<SubAgentKind, "writer" | "retrieval" | "asr">;
const OFF_CHIP: SubAgentKind[] = ["writer", "retrieval", "asr"];
const CHIP_KINDS = SUBAGENT_KINDS.filter((k): k is ChipKind => !OFF_CHIP.includes(k));

/**
 * Last resort if a locale ever lacks a kind's key. `Record<ChipKind, …>` on
 * purpose: a new subagent kind then fails to compile here rather than shipping
 * a switch wearing a neighbour's word — which is exactly what happened while
 * `translate` had no locale entry and the fallback chain's tail was `长文`.
 */
export const FALLBACK_LABELS: Record<ChipKind, string> = {
  search: "联网",
  vision: "识图",
  longread: "长文",
  pdf: "PDF",
  imagegen: "绘图",
  translate: "日译中",
};

/**
 * The kinds this project can actually reach, in `SUBAGENT_KINDS` order.
 *
 * Usable, not merely enabled: a vision subagent bound to a text model, or a
 * search one whose model cannot browse, would give the author a switch that
 * changes nothing — every other surface has already decided it is off. An
 * unusable kind is *absent* from both renderings, never present-but-grey.
 */
export function useConfiguredKinds(): ChipKind[] {
  const subAgents = useAiStore((s) => s.subAgents);
  const models = useAiStore((s) => s.models);
  return CHIP_KINDS.filter((k) => subAgentModel(k, models, subAgents) !== null);
}

/** The model id a kind is bound to, for the menu's right-hand column. */
export function useBoundModelName(): (kind: ChipKind) => string | null {
  const subAgents = useAiStore((s) => s.subAgents);
  const models = useAiStore((s) => s.models);
  return (kind) => subAgentModel(kind, models, subAgents)?.name ?? null;
}
