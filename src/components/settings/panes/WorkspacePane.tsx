import { useState } from "react";
import { useTranslation } from "react-i18next";
import { flushDirtyDocuments, useProjectStore } from "../../../stores/projectStore";
import { exportProjectBundle, restoreProjectBundle } from "../../../lib/fs/projectBackup";
import {
  BUILTIN_PROFILES,
  categoryLabel,
  profileLabel,
  type WorkspaceProfile,
} from "../../../lib/profile";
import { Pane, PaneHeader, Section, Row } from "./bits";
import ui from "../settingsUi.module.css";

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
    <Pane>
      <PaneHeader title={t("systemSettings.tabs.workspace")} sub={t("systemSettings.workspace.paneSub")} />

      <Section label={t("systemSettings.workspace.profileSection")}>
        {!projectPath ? (
          <div className={ui.emptyNote}>{t("systemSettings.workspace.noProject")}</div>
        ) : (
          <div className={`${ui.rowStacked} ${ui.rowLast}`}>
            <div className={ui.rowDesc}>
              {t("systemSettings.workspace.profileHint")} {t("systemSettings.workspace.switchHint")}
            </div>
            <div className={`${ui.cardGrid} ${ui.cardGridProfile}`}>
              {BUILTIN_PROFILES.map((p) => {
                const active = p.id === profile.id;
                return (
                  <button
                    key={p.id}
                    className={`${ui.card} ${active ? ui.cardActive : ""}`}
                    onClick={() => choose(p)}
                    disabled={busy}
                  >
                    <div className={ui.profileHead}>
                      <span className={ui.profileName}>{profileLabel(p, isZh)}</span>
                      {active && <span className={ui.profileCurrent}>{t("systemSettings.workspace.current")}</span>}
                    </div>
                    {/* The category list is the substance of the choice — it is
                        what actually changes on disk. */}
                    <div className={ui.tagRow}>
                      {p.categories.map((c) => (
                        <span key={c.id} className={ui.tag}>{categoryLabel(c, isZh)}</span>
                      ))}
                    </div>
                  </button>
                );
              })}
            </div>
            {error && <div className={ui.statusError}>{error}</div>}
          </div>
        )}
      </Section>

      <ProjectBackupSection />
    </Pane>
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
    <Section label={t("systemSettings.projectBackup.section")}>
      <Row
        title={t("systemSettings.projectBackup.export")}
        desc={`${t("systemSettings.projectBackup.hint")} ${t("systemSettings.projectBackup.scopeHint")}`}
      >
        <button
          className={ui.rowBtn}
          onClick={handleExport}
          disabled={busy || !projectPath}
          title={projectPath ? undefined : t("systemSettings.workspace.noProject")}
        >
          {t("systemSettings.projectBackup.export")}
        </button>
      </Row>
      <Row
        title={t("systemSettings.projectBackup.restore")}
        desc={t("systemSettings.projectBackup.restoreHint")}
        last
      >
        <button className={ui.rowBtn} onClick={handleRestore} disabled={busy}>
          {t("systemSettings.projectBackup.restore")}
        </button>
      </Row>
      {status && <div className={status.ok ? ui.statusOk : ui.statusError}>{status.text}</div>}
    </Section>
  );
}
