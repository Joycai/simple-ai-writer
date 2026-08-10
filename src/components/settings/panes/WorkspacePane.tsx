import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Archive, ArchiveRestore } from "lucide-react";
import { flushDirtyDocuments, useProjectStore } from "../../../stores/projectStore";
import { exportProjectBundle, restoreProjectBundle } from "../../../lib/fs/projectBackup";
import {
  BUILTIN_PROFILES,
  categoryLabel,
  profileLabel,
  type WorkspaceProfile,
} from "../../../lib/profile";
import styles from "../settingsCommon.module.css";

/**
 * Picks the open project's workspace profile — see lib/profile.
 *
 * Project-scoped, unlike every other pane here, which is why it lives on its own
 * and shows an explicit "open a project first" state rather than rendering
 * controls that would have nothing to act on.
 */
export function WorkspacePane() {
  const { t, i18n: i18nInst } = useTranslation();
  const isZh = i18nInst.language.startsWith("zh");
  const projectPath = useProjectStore((s) => s.projectPath);
  const profile = useProjectStore((s) => s.profile);
  const setProfile = useProjectStore((s) => s.setProfile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (next: WorkspaceProfile) => {
    if (busy || next.id === profile.id) return;
    setBusy(true);
    setError(null);
    try {
      await setProfile(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>{t("systemSettings.workspace.profileSection")}</div>
        {!projectPath ? (
          <div className={styles.emptyNote}>{t("systemSettings.workspace.noProject")}</div>
        ) : (
          <div className={styles.fieldGroup}>
            <div className={styles.safetyHint}>{t("systemSettings.workspace.profileHint")}</div>
            <div className={styles.profileGrid}>
              {BUILTIN_PROFILES.map((p) => (
                <button
                  key={p.id}
                  className={`${styles.profileCard} ${p.id === profile.id ? styles.profileCardActive : ""}`}
                  onClick={() => choose(p)}
                  disabled={busy}
                >
                  <span className={styles.profileName}>{profileLabel(p, isZh)}</span>
                  <span className={styles.profileCats}>
                    {p.categories.map((c) => categoryLabel(c, isZh)).join(" · ")}
                  </span>
                </button>
              ))}
            </div>
            <div className={styles.safetyHint}>{t("systemSettings.workspace.switchHint")}</div>
            {error && <div className={styles.errorNote}>{error}</div>}
          </div>
        )}
      </div>
      <ProjectBackupSection />
    </div>
  );
}

// ─── Whole-project backup / restore ──────────────────────────────────────────

/**
 * Restore is offered even with no project open — that is the state a fresh
 * install is in, and it is the state this feature exists for.
 */
function ProjectBackupSection() {
  const { t } = useTranslation();
  const projectPath = useProjectStore((s) => s.projectPath);
  const openProject = useProjectStore((s) => s.openProject);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const handleExport = async () => {
    if (busy || !projectPath) return;
    setBusy(true);
    setStatus(null);
    try {
      // The archive is built from disk, so whatever is still only in the
      // editor has to land first or the backup is a version behind.
      await flushDirtyDocuments();
      const saved = await exportProjectBundle(projectPath);
      if (saved) setStatus({ ok: true, text: t("systemSettings.projectBackup.exported", { path: saved }) });
    } catch (e) {
      setStatus({ ok: false, text: `${t("systemSettings.projectBackup.exportFailed")} ${e}` });
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async () => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const restored = await restoreProjectBundle();
      if (!restored) return;
      setStatus({
        ok: true,
        text: t("systemSettings.projectBackup.restored", {
          count: restored.fileCount,
          path: restored.path,
        }),
      });
      await openProject(restored.path);
    } catch (e) {
      const code = e instanceof Error ? e.message : "";
      const known =
        code === "dest-not-empty"
          ? t("systemSettings.projectBackup.destNotEmpty")
          : code === "empty-bundle"
            ? t("systemSettings.projectBackup.emptyBundle")
            : null;
      setStatus({ ok: false, text: known ?? `${t("systemSettings.projectBackup.restoreFailed")} ${e}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>{t("systemSettings.projectBackup.section")}</div>
      <div className={styles.fieldGroup}>
        <div className={styles.safetyHint}>{t("systemSettings.projectBackup.hint")}</div>
        <div className={styles.safetyHint}>{t("systemSettings.projectBackup.scopeHint")}</div>
        <div className={styles.debugControls}>
          <button
            className={`${styles.btnSecondary} ${styles.btnWithIcon}`}
            onClick={handleExport}
            disabled={busy || !projectPath}
            title={projectPath ? undefined : t("systemSettings.workspace.noProject")}
          >
            <Archive size={14} /> {t("systemSettings.projectBackup.export")}
          </button>
          <button
            className={`${styles.btnSecondary} ${styles.btnWithIcon}`}
            onClick={handleRestore}
            disabled={busy}
          >
            <ArchiveRestore size={14} /> {t("systemSettings.projectBackup.restore")}
          </button>
        </div>
        <div className={styles.safetyHint}>{t("systemSettings.projectBackup.restoreHint")}</div>
      </div>
      {status && (
        <div className={status.ok ? styles.safetyHint : styles.errorNote}>{status.text}</div>
      )}
    </div>
  );
}
