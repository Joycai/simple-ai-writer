import { useTranslation } from "react-i18next";
import type { RetrievalProgress } from "../../lib/context/semanticLore";

export function RetrievalProgressText({ progress }: { progress: RetrievalProgress }) {
  const { t } = useTranslation();
  return <span role="status">{t(`semantic.progress.${progress.phase}`, {
    source: t(`semantic.progress.${progress.source}`), ready: progress.ready, total: progress.total,
  })}</span>;
}
