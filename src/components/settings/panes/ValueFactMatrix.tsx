/**
 * 值类矩阵 (P6 界面, docs/api/capability-resolution-lld.md §9.9): the
 * thinking category, the context window and the output cap on each route of
 * the channel, each with its source — the sibling of `CapabilityMatrix`, whose
 * cells are a verdict's glyph where these are a number.
 *
 * Every cell is `valueFacts` for that route's wire (lib/ai/modelSummary.ts),
 * the same answer the note under the field gives for the current route and a
 * request from the row carries. A typed value reads in full ink; one the
 * tables answer is muted, with its source beside it. Where a route sends
 * `max_tokens` and the field is not what it sends, a second line says what is.
 */
import { useTranslation } from "react-i18next";
import type { Source } from "../../../lib/ai/capabilities";
import { formatContextSize } from "../../../lib/ai/contextSize";
import type { Model } from "../../../lib/ai/configDb";
import { valueFacts } from "../../../lib/ai/modelSummary";
import type { Wire } from "../../../lib/ai/platforms";
import { ROUTE_SHORT } from "../../../lib/ai/routes";
import type { ProtocolFamily } from "../../../lib/ai/types";
import { sourceName } from "./valueNotes";
import r from "./Routes.module.css";

/** A route's own fields — the form's on the current route, the parked profile's on the others. */
type RouteValues = Pick<Model, "thinkingCategory" | "thinkingDialect" | "maxOutput">;

export function ValueFactMatrix({
  label, routes, current, wireFor, modelId, contextSize, valuesFor, catalogId,
}: {
  label: string;
  /** The channel's routes, in the channel's order. */
  routes: readonly ProtocolFamily[];
  current: ProtocolFamily;
  wireFor: (f: ProtocolFamily) => Wire | undefined;
  modelId: string;
  /** The model's window — one for every route. */
  contextSize?: number;
  valuesFor: (f: ProtocolFamily) => RouteValues;
  /** What the model catalog is asked about (`ConnOptions.canonicalModelId`). */
  catalogId?: string;
}) {
  const { t } = useTranslation();
  const columns = routes.flatMap((f) => {
    const w = wireFor(f);
    return w ? [{ f, w, v: valueFacts({ modelId, contextSize, ...valuesFor(f) }, w.standard, w.platform, catalogId) }] : [];
  });
  if (columns.length < 2) return null;

  const cell = (text: string, source: Source, w: Wire) => (
    <span className={source === "author" ? r.valueTyped : r.valueFollowed} title={sourceName(t, source, w.platform)}>
      {text}
      {source !== "author" && <span className={r.valueSource}>{t(`aiConfig.models.valueSourceShort.${source}`)}</span>}
    </span>
  );
  const none = <span className={r.cellNo}>—</span>;
  const colCls = (f: ProtocolFamily) => (f === current ? r.matrixCur : "");

  return (
    <>
      <table className={`${r.matrix} ${r.valueMatrix}`} aria-label={label}>
        <thead>
          <tr>
            <th />
            {columns.map(({ f }) => <th key={f} className={`${r.matrixHead} ${colCls(f)}`}>{ROUTE_SHORT[f]}</th>)}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{t("aiConfig.models.catLabel")}</td>
            {columns.map(({ f, w, v }) => (
              <td key={f} className={colCls(f)}>
                {cell(t(v.thinkingCategory.inForce.value.labelKey), v.thinkingCategory.inForce.source, w)}
              </td>
            ))}
          </tr>
          <tr>
            <td>{t("aiConfig.models.ctxLabel")}</td>
            {columns.map(({ f, w, v }) => (
              <td key={f} className={colCls(f)}>
                {v.contextSize.inForce ? cell(formatContextSize(v.contextSize.inForce.value), v.contextSize.inForce.source, w) : none}
              </td>
            ))}
          </tr>
          <tr>
            <td>{t("aiConfig.models.maxOutLabel")}</td>
            {columns.map(({ f, w, v }) => (
              <td key={f} className={colCls(f)}>
                {v.maxOutput.inForce ? cell(v.maxOutput.inForce.value.toLocaleString(), v.maxOutput.inForce.source, w) : none}
                {v.maxOutput.onWire !== undefined && v.maxOutput.onWire !== v.maxOutput.inForce?.value && (
                  <div className={r.valueWire}>max_tokens {v.maxOutput.onWire.toLocaleString()}</div>
                )}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <div className={r.url}>{t("aiConfig.models.valueMatrixLegend")}</div>
    </>
  );
}
