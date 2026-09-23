/**
 * 可用性矩阵 (设计稿 05k 屏 05): one row per capability, one column per route
 * of the channel, each cell the capability table's verdict for that route's
 * wire — ✓ sent · ? unmeasured · — not sent, with the reason on hover.
 *
 * The standard way the model drawer says *where* a declaration reaches: the
 * switches above a matrix are the author's grant, the same on every route;
 * whether a route can say each one is the platform's. Every cell is read from
 * `capabilityVerdict` (lib/ai/capabilities.ts), so the matrix cannot say
 * anything the adapters don't do — `capabilityConsistency.test.ts` holds the
 * adapters to the same table. The reason sentences live in the locale files
 * (`aiConfig.capReason.*`), never here.
 */
import { useTranslation } from "react-i18next";
import { capabilityVerdict, type CapabilityId } from "../../../lib/ai/capabilities";
import { capabilityModelOf } from "../../../lib/ai/relayUpstream";
import { ROUTE_SHORT } from "../../../lib/ai/routes";
import type { ServerToolWire } from "../../../lib/ai/platforms";
import type { ModelType } from "../../../lib/ai/configDb";
import type { ProtocolFamily } from "../../../lib/ai/types";
import r from "./Routes.module.css";

const GLYPH = { yes: "✓", unknown: "?", no: "—" } as const;
const CELL = { yes: r.cellYes, unknown: r.cellUnknown, no: r.cellNo } as const;

export function CapabilityMatrix({
  label, ids, rowLabel, routes, current, wireFor, modelId, type,
}: {
  /** The table's accessible name, e.g. 「服务端工具 · 各线路可用性」. */
  label: string;
  ids: readonly CapabilityId[];
  rowLabel: (id: CapabilityId) => string;
  /** The channel's routes, in the channel's order. */
  routes: readonly ProtocolFamily[];
  /** The model's current route — the column the switches' hints speak for. */
  current: ProtocolFamily;
  wireFor: (f: ProtocolFamily) => ServerToolWire | undefined;
  /** Blank = the model-id axis is not consulted (nothing typed yet). */
  modelId: string;
  type: ModelType;
}) {
  const { t } = useTranslation();
  if (ids.length === 0) return null;
  const model = { ...capabilityModelOf({ modelId: modelId.trim() || undefined }), type };
  return (
    <>
      <table className={r.matrix} aria-label={label}>
        <thead>
          <tr>
            <th />
            {routes.map((f) => (
              <th key={f} className={`${r.matrixHead} ${f === current ? r.matrixCur : ""}`}>{ROUTE_SHORT[f]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ids.map((id) => (
            <tr key={id}>
              <td>{rowLabel(id)}</td>
              {routes.map((f) => {
                const w = wireFor(f);
                const v = w ? capabilityVerdict(id, w, model) : { status: "no" as const, reason: "family" as const };
                const why = t(`aiConfig.capReason.${v.reason}`, {
                  platform: w ? t(`aiConfig.platforms.${w.platform}`) : "",
                  model: model.modelId ?? "",
                  upstream: model.upstream ? t(`aiConfig.upstream.name.${model.upstream}`) : "",
                });
                return (
                  <td key={f} className={`${CELL[v.status]} ${f === current ? r.matrixCur : ""}`}
                    title={`${t(`aiConfig.models.matrix_${v.status}`)} — ${why}`}>
                    {GLYPH[v.status]}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className={r.url}>{t("aiConfig.models.matrixLegend")}</div>
    </>
  );
}
