import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOutputRecoveryStore } from "../../stores/outputRecoveryStore";
import { useProjectStore } from "../../stores/projectStore";
import { useAiStore } from "../../stores/aiStore";
import styles from "./OutputRecoveryPanel.module.css";

/** One recovery shelf in both writing surfaces; data belongs to the project. */
export function OutputRecoveryPanel() {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.projectPath);
  const modelId = useAiStore((s) => s.activeModelId);
  const { rows, running, error, load, resume, keep, remove, startLong, stop } = useOutputRecoveryStore();
  const [request, setRequest] = useState("");
  const [outline, setOutline] = useState("");
  const [copyError, setCopyError] = useState("");
  useEffect(() => { void load(project); }, [project, load]);
  if (!project) return null;
  const sections = outline.split("\n").map((s) => s.trim()).filter(Boolean);
  return (
    <details className={styles.shelf} onKeyDown={(event) => {
      // The parent task panel uses this chord to run its own task.
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
      }
    }}>
      <summary>{error ? t("ai.recovery.attention") + " · " : ""}{t("ai.recovery.title", { count: rows.length })}</summary>
      {error && <p role="alert">{error}</p>}
      {copyError && <p role="alert">{copyError}</p>}
      <p>{t("ai.recovery.help")}</p>
      {rows.map((row) => (
        <details key={row.id} className={styles.item} open={running === row.id || undefined}>
          <summary>{t(`ai.recovery.${row.status}`)} · {row.request.slice(0, 60)}</summary>
          <textarea aria-label={t("ai.recovery.savedText")} value={row.text} readOnly rows={8} />
          {row.sections && <p>{t("ai.recovery.progress", { done: row.nextSection ?? 0, total: row.sections.length })}</p>}
          <div className={styles.actions}>
            {running === row.id ? <button type="button" onClick={stop}>{t("ai.recovery.stop")}</button> : (
              <button type="button" disabled={!!running || (row.sections && row.nextSection === row.sections.length)} onClick={() => void resume(row.id)}>{t("ai.recovery.continue")}</button>
            )}
            <button type="button" onClick={() => {
              void navigator.clipboard.writeText(row.text).catch((e: unknown) => setCopyError(String(e)));
            }}>{t("ai.recovery.copy")}</button>
            <button type="button" disabled={running === row.id} onClick={() => void keep(row.id)}>{t("ai.recovery.keep")}</button>
            <button type="button" disabled={running === row.id} onClick={() => void remove(row.id)}>{t("ai.recovery.discard")}</button>
          </div>
        </details>
      ))}
      <details className={styles.item}>
        <summary>{t("ai.recovery.longTitle")}</summary>
        <p>{t("ai.recovery.longHelp")}</p>
        <label>{t("ai.recovery.request")}<textarea rows={3} value={request} onChange={(e) => setRequest(e.target.value)} /></label>
        <label>{t("ai.recovery.outline")}<textarea rows={4} value={outline} onChange={(e) => setOutline(e.target.value)} /></label>
        <button type="button" disabled={!!running || !modelId || !request.trim() || !sections.length || sections.length > 20}
          onClick={() => void startLong(request, sections, modelId)}>{t("ai.recovery.start")}</button>
      </details>
    </details>
  );
}
