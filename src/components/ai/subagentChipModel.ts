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
import { subAgentModel, SUBAGENT_KINDS, type SubAgentKind } from "../../lib/agent/subagentModel";
import { isAsrEnabled } from "../../lib/asr/flag";
import { isTranslateEnabled } from "../../lib/translate/flag";

/**
 * Every kind that is a switch — i.e. all of them except the two nobody flips.
 *
 * The writer is excluded because its switch is a session-level decision made on
 * its own line (see `WriterStrip`, 设计稿 04d 屏 5a). `retrieval` is excluded
 * for a plainer reason: by the time the composer is on screen it has already
 * run, and a control that only takes effect on the *next* turn does not belong
 * among "for this turn" switches. Both live in Settings alone.
 *
 * `asr` used to be excluded too, on the grounds that transcription is an
 * explicit act. That held for the right-click, not for the assistant: routing
 * appends `transcribe_audio` whenever the Beta is on and a model is bound, so
 * the model *can* propose a transcription mid-turn (behind a card) — the same
 * shape as 绘图 and 日译中. Switching it off here takes the tool out of this
 * session, the same subtraction the other rows make.
 */
export type ChipKind = Exclude<SubAgentKind, "writer" | "retrieval">;
const OFF_CHIP: SubAgentKind[] = ["writer", "retrieval"];
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
  asr: "转写",
};

/**
 * The Beta behind a tool-shaped kind. Routing withholds `translate` /
 * `transcribe_audio` while their flag is off, so a row here would be a switch
 * that changes nothing — absent, like an unbound kind.
 */
function betaOn(kind: ChipKind): boolean {
  if (kind === "asr") return isAsrEnabled();
  if (kind === "translate") return isTranslateEnabled();
  return true;
}

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
  const providers = useAiStore((s) => s.providers);
  return CHIP_KINDS.filter((k) => betaOn(k) && subAgentModel(k, models, subAgents, providers) !== null);
}

/** The model id a kind is bound to, for the menu's right-hand column. */
export function useBoundModelName(): (kind: ChipKind) => string | null {
  const subAgents = useAiStore((s) => s.subAgents);
  const models = useAiStore((s) => s.models);
  return (kind) => subAgentModel(kind, models, subAgents)?.name ?? null;
}
