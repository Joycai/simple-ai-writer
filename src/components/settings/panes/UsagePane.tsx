import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { useAiStore } from "../../../stores/aiStore";
import { useProjectStore } from "../../../stores/projectStore";
import {
  clearUsage,
  formatTokenCount,
  formatUsd,
  loadUsage,
  USAGE_WINDOWS,
  type UsageSummary,
  type UsageWindow,
} from "../../../lib/ai/usage";
import { findTask, taskLabel } from "../../../lib/profile";
import styles from "../settingsCommon.module.css";

/**
 * What the `token_usage` rows add up to. Project-scoped, like the workspace
 * pane, because that is where the table lives.
 */
export function UsagePane() {
  const { t, i18n: i18nInst } = useTranslation();
  const isZh = i18nInst.language.startsWith("zh");
  const projectPath = useProjectStore((s) => s.projectPath);
  const models = useAiStore((s) => s.models);
  const [window, setWindow] = useState<UsageWindow>("30d");
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!projectPath) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    setBusy(true);
    setError(null);
    loadUsage(projectPath, window)
      .then((s) => { if (!cancelled) setSummary(s); })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [projectPath, window]);

  const handleClear = async () => {
    if (!projectPath || busy) return;
    if (!globalThis.confirm(t("systemSettings.usage.clearConfirm"))) return;
    setBusy(true);
    try {
      await clearUsage(projectPath);
      setSummary(await loadUsage(projectPath, window));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * `model_id` holds two different things historically: every text call
   * records the configured model's internal id, while image runs recorded the
   * provider's own model string (see `recordImageUsage`, since corrected).
   * Both are matched so old rows keep a name, and an id matching neither —
   * a model deleted since, or a config imported from another machine — falls
   * back to the raw value rather than an empty cell.
   */
  const modelLabel = (id: string) =>
    models.find((m) => m.id === id)?.name ?? models.find((m) => m.modelId === id)?.name ?? id;

  /**
   * A task id resolves through the active profile, so a run shows the same
   * words the panel that launched it used. The rest are the kinds that are not
   * profile tasks at all (chat, memory summarisation, image runs); anything
   * left — a task id belonging to a profile the project has since switched
   * away from — keeps its raw id, which is still the truth about that row.
   */
  const taskDisplay = (id: string) => {
    const task = findTask(id);
    if (task) return taskLabel(task, isZh, t);
    return t(`systemSettings.usage.kinds.${id}`, { defaultValue: id });
  };

  if (!projectPath) {
    return (
      <div>
        <div className={styles.section}>
          <div className={styles.emptyNote}>{t("systemSettings.workspace.noProject")}</div>
        </div>
      </div>
    );
  }

  const bucketRows = (
    buckets: UsageSummary["byModel"],
    label: (key: string) => string,
  ) =>
    buckets.map((b) => (
      <div className={styles.item} key={b.key}>
        <div className={styles.itemInfo}>
          <div className={styles.itemName}>{label(b.key)}</div>
          <div className={styles.itemMeta}>
            {t("systemSettings.usage.rowMeta", {
              calls: b.calls,
              input: formatTokenCount(b.promptTokens),
              output: formatTokenCount(b.completionTokens),
            })}
          </div>
        </div>
        <span className={styles.badge}>{formatUsd(b.costUsd)}</span>
      </div>
    ));

  return (
    <div>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>{t("systemSettings.usage.section")}</div>
        <div className={styles.fieldGroup}>
          <div className={styles.safetyHint}>{t("systemSettings.usage.hint")}</div>
          <div className={styles.optionGroup}>
            {USAGE_WINDOWS.map((w) => (
              <button
                key={w}
                className={`${styles.optionBtn} ${window === w ? styles.optionBtnActive : ""}`}
                onClick={() => setWindow(w)}
              >
                {t(`systemSettings.usage.windows.${w}`)}
              </button>
            ))}
          </div>
        </div>
        {error && <div className={styles.errorNote}>{error}</div>}
        {summary && (
          <div className={styles.itemList}>
            <div className={styles.item}>
              <div className={styles.itemInfo}>
                <div className={styles.itemName}>{t("systemSettings.usage.totalLabel")}</div>
                <div className={styles.itemMeta}>
                  {t("systemSettings.usage.totalMeta", {
                    calls: summary.total.calls,
                    input: formatTokenCount(summary.total.promptTokens),
                    cached: formatTokenCount(summary.total.cachedTokens),
                    output: formatTokenCount(summary.total.completionTokens),
                  })}
                </div>
              </div>
              <span className={styles.badge}>{formatUsd(summary.total.costUsd)}</span>
            </div>
          </div>
        )}
      </div>

      {summary && summary.total.calls === 0 && (
        <div className={styles.section}>
          <div className={styles.emptyNote}>{t("systemSettings.usage.empty")}</div>
        </div>
      )}

      {summary && summary.byModel.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>{t("systemSettings.usage.byModel")}</div>
          <div className={styles.itemList}>{bucketRows(summary.byModel, modelLabel)}</div>
        </div>
      )}

      {summary && summary.byTask.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>{t("systemSettings.usage.byTask")}</div>
          <div className={styles.itemList}>{bucketRows(summary.byTask, taskDisplay)}</div>
        </div>
      )}

      <div className={styles.section}>
        <div className={styles.fieldGroup}>
          <div className={styles.safetyHint}>{t("systemSettings.usage.clearHint")}</div>
          <div className={styles.debugControls}>
            <button
              className={`${styles.btnSecondary} ${styles.btnWithIcon}`}
              onClick={handleClear}
              disabled={busy || !summary || summary.total.calls === 0}
            >
              <Trash2 size={14} /> {t("systemSettings.usage.clear")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
