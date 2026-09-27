/**
 * The one line under 上下文 / 最大输出 / 思考类目 that says where a value comes
 * from and what it does (设计稿：P6 界面, docs/api/capability-resolution-lld.md
 * §9.9). Pure over `valueFacts` (`lib/ai/modelSummary.ts`), which already
 * answers every question — the value, its source, whether the pre-send gate
 * takes it, what `max_tokens` sends — so nothing here decides; it only picks
 * the sentence.
 *
 *   - left empty, the tables know one: 「{出处} {值} · 用它做什么」;
 *   - typed and equal to the tables': 「与{出处}一致 · 清空后跟随它」 — a row
 *     saved while the drawer still prefilled (before P6) reads this;
 *   - typed and different: 「手填 · 覆盖{出处} {值}」, the probe badge's shape.
 */
import type { TFunction } from "i18next";

import type { Source } from "../../../lib/ai/capabilities";
import type { ValueFacts } from "../../../lib/ai/modelSummary";
import type { PlatformId } from "../../../lib/ai/platforms";
import type { ModelType } from "../../../lib/ai/configDb";

const num = (v: number) => v.toLocaleString();

/** 「平台 · 智谱 BigModel」「模型目录」… — what a note calls a source. */
export function sourceName(t: TFunction, source: Source, platform: PlatformId | undefined): string {
  return t(`aiConfig.models.valueSource.${source}`, { platform: platform ? t(`aiConfig.platforms.${platform}`) : "" });
}

type Name = (source: Source) => string;

/** A typed value beside the tables' one; undefined when the tables know none. */
function typedNote(t: TFunction, own: number, table: ValueFacts["contextSize"]["table"], name: Name): string | undefined {
  if (!table) return undefined;
  return own === table.value
    ? t("aiConfig.models.noteSame", { source: name(table.source) })
    : t("aiConfig.models.noteOverrides", { source: name(table.source), value: num(table.value) });
}

export function contextNote(t: TFunction, v: ValueFacts["contextSize"], name: Name): string | undefined {
  if (v.own !== undefined) return typedNote(t, v.own, v.table, name);
  return v.table && t("aiConfig.models.noteCtxFollow", { source: name(v.table.source), value: num(v.table.value) });
}

export function maxOutputNote(t: TFunction, v: ValueFacts["maxOutput"], name: Name): string | undefined {
  // What `max_tokens` carries on a wire that requires one — said only when it
  // is not simply the number in the field.
  const sent = v.onWire !== undefined ? num(v.onWire) : undefined;
  if (v.own !== undefined) {
    const note = typedNote(t, v.own, v.table, name);
    return note && sent && v.own !== v.table?.value ? t("aiConfig.models.noteWithWire", { note, sent }) : note;
  }
  if (!v.table) return sent && t("aiConfig.models.noteOutUnknownWire", { sent });
  const params = { source: name(v.table.source), value: num(v.table.value), sent };
  return sent ? t("aiConfig.models.noteOutFollowWire", params) : t("aiConfig.models.noteOutFollow", params);
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
 * What a new model's row takes from the platform's calibration when its id is
 * typed: only the declarations with no unset state (D1). The value facts are
 * left empty and follow the platform's rows through the chain, so a later
 * measurement reaches the row — prefilling them froze today's number as the
 * author's.
 */
export function calibrationPrefill(cal: { type?: string; pdfInput?: boolean }): { type?: ModelType; pdfInput?: boolean } {
  return { type: cal.type as ModelType | undefined, pdfInput: cal.pdfInput };
}
