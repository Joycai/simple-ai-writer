import styles from "./SemanticReport.module.css";
import { useTranslation } from "react-i18next";
import type { LoreActivationReport } from "../../lib/context/loreSelect";

export function SemanticReport({ report }: { report: Pick<LoreActivationReport, "semantic" | "entities"> }) {
  const { t } = useTranslation();
  const s = report.semantic;
  if (!s) return null;
  return <div role="status" className={styles.report}>
    <div>{t(`semantic.${s.status}`, { n: report.entities.filter((e) => e.reason === "semantic").length, considered: s.considered })}</div>
    {s.failure && <div className={styles.failure}>{t(`semantic.failure.${s.failure.code}`, { status: s.failure.status })}</div>}
    {report.entities.filter((e) => e.reason === "semantic").map((e) => <div key={e.dirPath}>
      {e.name} · {t("semantic.match", { score: e.semanticScore?.toFixed(2) })}
    </div>)}
    {s.descriptionsTruncated > 0 && <div>{t("semantic.descriptionsTruncated", { n: s.descriptionsTruncated })}</div>}
    {s.matchesLimited > 0 && <div>{t("semantic.matchesLimited", { n: s.matchesLimited })}</div>}
    {s.omitted > 0 && <div>{t("semantic.omitted", { n: s.omitted })}</div>}
    {s.queryTruncated && <div>{t("semantic.queryTruncated")}</div>}
    {s.budgetDropped > 0 && <div>{t("semantic.budgetDropped", { n: s.budgetDropped })}</div>}
  </div>;
}
