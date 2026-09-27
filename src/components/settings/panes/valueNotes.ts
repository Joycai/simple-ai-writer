/**
 * The one line under 上下文 / 最大输出 / 思考类目 that says where a value comes
 * from and what it does (设计稿：P6 界面, docs/api/capability-resolution-lld.md
 * §9.9). Pure over `valueFacts` (`lib/ai/modelSummary.ts`), which already
 * answers every question — the value, its source, whether the pre-send gate
 * takes it, what `max_tokens` sends — so nothing here decides; it only picks
 * the sentence.
 *
 *   - left empty, the tables know one: 「{出处} {值} · 用它做什么」; they know
 *     none: 「未知 · …」, so the brief's 「跟随下方的来源」 always has a line below;
 *   - typed and equal to the tables': 「与{出处}一致 · 清空后跟随它」 — a row
 *     saved while the drawer still prefilled (before P6) reads this — plus what
 *     clearing gives up: the pre-send gate, the `max_tokens` it sends;
 *   - typed and different: 「手填 · 覆盖{出处} {值}」, the probe badge's shape.
 */
import type { TFunction } from "i18next";

import type { Source } from "../../../lib/ai/capabilities";
import type { ValueFacts } from "../../../lib/ai/modelSummary";
import type { PlatformId } from "../../../lib/ai/platforms";
import { effortForCategory, type ReasoningEffort, type ThinkingCategory, type ThinkingCategoryId } from "../../../lib/ai/reasoning";

const num = (v: number) => v.toLocaleString();

/** 「平台 · 智谱 BigModel」「模型目录」… — what a note calls a source. */
export function sourceName(t: TFunction, source: Source, platform: PlatformId | undefined): string {
  return t(`aiConfig.models.valueSource.${source}`, { platform: platform ? t(`aiConfig.platforms.${platform}`) : "" });
}

type Name = (source: Source) => string;

export function contextNote(t: TFunction, v: ValueFacts["contextSize"], name: Name): string | undefined {
  if (v.own === undefined) {
    return v.table
      ? t("aiConfig.models.noteCtxFollow", { source: name(v.table.source), value: num(v.table.value) })
      : t("aiConfig.models.noteCtxUnknown");
  }
  if (!v.table) return undefined;
  if (v.own !== v.table.value) return t("aiConfig.models.noteOverrides", { source: name(v.table.source), value: num(v.table.value) });
  const same = t("aiConfig.models.noteSame", { source: name(v.table.source) });
  return v.gates && !v.gatesIfEmpty ? t("aiConfig.models.noteSameLosesGate", { note: same }) : same;
}

export function maxOutputNote(t: TFunction, v: ValueFacts["maxOutput"], name: Name): string | undefined {
  if (v.own === undefined) {
    if (!v.table) {
      return v.onWire !== undefined
        ? t("aiConfig.models.noteOutUnknownWire", { sent: num(v.onWire) })
        : t("aiConfig.models.noteOutUnknown");
    }
    const params = { source: name(v.table.source), value: num(v.table.value), sent: v.onWire !== undefined ? num(v.onWire) : "" };
    return v.onWire !== undefined ? t("aiConfig.models.noteOutFollowWire", params) : t("aiConfig.models.noteOutFollow", params);
  }
  // Typed, `max_tokens` is the field — nothing to add, unless clearing would change it.
  if (!v.table) return undefined;
  if (v.own !== v.table.value) return t("aiConfig.models.noteOverrides", { source: name(v.table.source), value: num(v.table.value) });
  const same = t("aiConfig.models.noteSame", { source: name(v.table.source) });
  return v.onWireIfEmpty !== undefined && v.onWireIfEmpty !== v.onWire
    ? t("aiConfig.models.noteSameChangesWire", { note: same, sent: num(v.onWireIfEmpty) })
    : same;
}

/**
 * 「自动 → GLM-5.3 · 平台 · 智谱 BigModel」 when the category is left on
 * 自动; 「自动时为 …」 when the author picked one the tables would not.
 */
export function categoryNote(t: TFunction, v: ValueFacts["thinkingCategory"], name: Name): string | undefined {
  const cat = t(v.table.value.labelKey);
  if (!v.own) return t("aiConfig.models.noteCatAuto", { cat, source: name(v.table.source) });
  return v.own.id !== v.table.value.id ? t("aiConfig.models.noteCatAutoIs", { cat, source: name(v.table.source) }) : undefined;
}

/**
 * A route's effort once the model id changes: a category left on 自动
 * resolves anew for the new id (`resolved`), and an effort picked under the
 * old one may be a 400 — or silently ignored — under it (glm-5.2's off is not
 * on glm-5.3's menu). A declared category does not move with the id, so its
 * effort stays.
 */
export function effortForNewId(
  category: ThinkingCategoryId | "auto" | undefined,
  effort: ReasoningEffort,
  resolved: ThinkingCategory,
): ReasoningEffort {
  return category === undefined || category === "auto" ? effortForCategory(resolved, effort) : effort;
}
