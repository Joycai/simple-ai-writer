import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAiStore } from "../../../stores/aiStore";
import { useLoreStore } from "../../../stores/loreStore";
import { indexStatus, prepareIndex, type IndexProgress } from "../../../lib/context/semanticIndex";
import { RetrievalError } from "../../../lib/ai/retrieval";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import ui from "../settingsUi.module.css";
import common from "../settingsCommon.module.css";
import styles from "./SemanticRetrieval.module.css";

export function SemanticIndexPanel({ project, modelId }: { project: string; modelId: string }) {
  const { t } = useTranslation();
  const models = useAiStore((s) => s.models);
  const providers = useAiStore((s) => s.providers);
  const index = useLoreStore((s) => s.index);
  const scope = useLoreStore((s) => s.scope);
  const args = useMemo(() => ({ projectPath: project, models, providers }), [project, models, providers]);
  const active = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<IndexProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let current = true;
    setProgress(null); setBusy(false); setError(""); setConfirm(false);
    void indexStatus(args, modelId, index, scope).then((p) => { if (current) setProgress(p); })
      .catch(() => { if (current) setError(t("semantic.indexReadFailed")); });
    return () => { current = false; active.current?.abort(); active.current = null; };
  }, [args, modelId, index, scope, t]);
  const start = async (rebuild: boolean) => {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setError("");
    try {
      await prepareIndex(args, modelId, index, scope, controller.signal,
        (p) => { if (active.current === controller) setProgress(p); }, rebuild);
    } catch (e) {
      if (active.current === controller) setError(controller.signal.aborted ? t("semantic.indexStopped")
        : e instanceof RetrievalError && e.status ? t("semantic.indexHttp", { status: e.status }) : t("semantic.indexFailed"));
    } finally {
      if (active.current === controller) {
        active.current = null; setBusy(false);
        // Completed batches remain on disk even when a later request fails.
      }
    }
  };
  const status = progress ? t(busy ? "semantic.indexBuilding" : progress.total === 0 ? "semantic.indexEmpty"
    : progress.ready === progress.total ? "semantic.indexReady" : "semantic.indexOutdated", { ...progress }) : t("semantic.indexChecking");
  return <section className={styles.indexPanel} aria-label={t("semantic.indexTitle")}>
    <div className={styles.libraryToolbar}>
      <div><h4 className={styles.heading}>{t("semantic.indexTitle")}</h4>
        <p className={ui.rowDesc} role="status" aria-live="polite">{status}</p></div>
      <div className={styles.actions}>
        {busy ? <button className={common.btnSecondary} onClick={() => active.current?.abort()}>{t("semantic.indexStop")}</button> : <>
          <button className={common.btnSecondary} disabled={!progress?.total} onClick={() => setConfirm(true)}>{t("semantic.indexRebuild")}</button>
          <button className={common.btnPrimary} disabled={!progress?.total || progress.ready === progress.total} onClick={() => void start(false)}>{t("semantic.indexPrepare")}</button>
        </>}
      </div>
    </div>
    {progress && progress.total > 0 && <progress className={styles.indexProgress} value={progress.ready} max={progress.total} aria-label={status} />}
    <p className={ui.rowDesc}>{t("semantic.indexHint")}</p>
    {error && <p className={ui.rowWarn} role="alert">{error}</p>}
    {confirm && <ConfirmDialog title={t("semantic.indexRebuild")} message={t("semantic.indexRebuildConfirm")}
      confirmLabel={t("semantic.indexRebuild")} onConfirm={() => void start(true)} onClose={() => setConfirm(false)} />}
  </section>;
}
