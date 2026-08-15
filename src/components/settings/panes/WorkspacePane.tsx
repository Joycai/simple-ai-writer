import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { flushDirtyDocuments, useProjectStore } from "../../../stores/projectStore";
import { exportProjectBundle, restoreProjectBundle } from "../../../lib/fs/projectBackup";
import {
  BUILTIN_PROFILES,
  categoryLabel,
  profileLabel,
  type WorkspaceProfile,
} from "../../../lib/profile";
import { fileExists, readDir } from "../../../lib/fs/fileio";
import { Pane, PaneHeader, Section, Row, Toggle } from "./bits";
import ui from "../settingsUi.module.css";

/**
 * Picks the open project's capability packs — see lib/profile.
 *
 * Two decisions live on one card: *clicking* a card makes that pack the
 * primary (owner of docModel and the UI vocabulary — the old single-select,
 * so a one-pack project reads exactly as before), while the card's *toggle*
 * enables or disables it as a secondary pack (its categories and tasks join
 * the union). The primary has no toggle: it cannot be disabled, only
 * succeeded by clicking another card.
 *
 * Project-scoped, unlike every other pane here, which is why it lives on its
 * own and shows an explicit "open a project first" state rather than
 * rendering controls that would have nothing to act on.
 */
export function WorkspacePane() {
  const { t, i18n: i18nInst } = useTranslation();
  const isZh = i18nInst.language.startsWith("zh");
  const projectPath = useProjectStore((s) => s.projectPath);
  const profile = useProjectStore((s) => s.profile);
  const workspace = useProjectStore((s) => s.workspace);
  const customPacks = useProjectStore((s) => s.customPacks);
  const setPacks = useProjectStore((s) => s.setPacks);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What the grid offers: the built-ins (each shadowed by this project's
  // custom pack of the same id, if any — the "file beats built-in" contract),
  // then the project's own packs.
  const packs: WorkspaceProfile[] = [
    ...BUILTIN_PROFILES.map((b) => customPacks.find((c) => c.id === b.id) ?? b),
    ...customPacks.filter((c) => !BUILTIN_PROFILES.some((b) => b.id === c.id)),
  ];

  const apply = async (primaryId: string, enabledIds: string[]) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await setPacks(primaryId, enabledIds);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Click: this pack becomes primary; everything enabled stays enabled. */
  const makePrimary = (pack: WorkspaceProfile) =>
    apply(pack.id, [pack.id, ...workspace.enabled.map((p) => p.id)]);

  /** Toggle: enable/disable as a secondary; the primary stays put. */
  const togglePack = (pack: WorkspaceProfile, on: boolean) => {
    const ids = workspace.enabled.map((p) => p.id);
    return apply(profile.id, on ? [...ids, pack.id] : ids.filter((id) => id !== pack.id));
  };

  // Which disabled packs still have entities on disk — their own categories
  // (not shared with anything enabled, which is still scanned) with content
  // under `.ai-writer/lore/`. Disabling never deletes, so this is the note
  // telling the author their data is parked, not gone.
  const [parkedCounts, setParkedCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!projectPath) {
      setParkedCounts({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const enabledCats = new Set(workspace.categories.map((c) => c.id.toLowerCase()));
      const counts: Record<string, number> = {};
      for (const pack of packs) {
        if (workspace.enabled.some((p) => p.id === pack.id)) continue;
        let parked = 0;
        for (const cat of pack.categories) {
          if (enabledCats.has(cat.id.toLowerCase())) continue;
          const dir = `${projectPath}/.ai-writer/lore/${cat.id}`;
          try {
            if ((await fileExists(dir)) && (await readDir(dir)).length > 0) parked++;
          } catch {
            // An unreadable directory is not data we can claim exists.
          }
        }
        if (parked > 0) counts[pack.id] = parked;
      }
      if (!cancelled) setParkedCounts(counts);
    })();
    return () => {
      cancelled = true;
    };
    // `packs` is derived from customPacks; workspace covers the enabled set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, workspace, customPacks]);

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
              {packs.map((p) => {
                const isPrimary = p.id === profile.id;
                const isEnabled = workspace.enabled.some((e) => e.id === p.id);
                const parked = parkedCounts[p.id] ?? 0;
                const cardClass = isPrimary ? ui.cardActive : isEnabled ? ui.cardEnabled : "";
                return (
                  // A div, not a button: the enable toggle nests inside, and a
                  // button inside a button is invalid HTML with unreliable
                  // event routing.
                  <div
                    key={p.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isPrimary}
                    aria-disabled={busy}
                    className={`${ui.card} ${ui.cardClickable} ${cardClass}`}
                    onClick={() => {
                      if (!busy && !isPrimary) void makePrimary(p);
                    }}
                    onKeyDown={(e) => {
                      if ((e.key === "Enter" || e.key === " ") && !busy && !isPrimary) {
                        e.preventDefault();
                        void makePrimary(p);
                      }
                    }}
                  >
                    <div className={ui.profileHead}>
                      <span className={ui.profileName}>{profileLabel(p, isZh)}</span>
                      {isPrimary ? (
                        <span className={ui.profileCurrent}>{t("systemSettings.workspace.primary")}</span>
                      ) : (
                        // stopPropagation: toggling enablement must not also
                        // promote the pack to primary via the card click.
                        <span className={ui.packToggle} onClick={(e) => e.stopPropagation()}>
                          <Toggle
                            on={isEnabled}
                            onChange={(next) => {
                              if (!busy) void togglePack(p, next);
                            }}
                            label={t(
                              isEnabled
                                ? "systemSettings.workspace.disablePack"
                                : "systemSettings.workspace.enablePack",
                              { pack: profileLabel(p, isZh) },
                            )}
                          />
                        </span>
                      )}
                    </div>
                    {/* The category list is the substance of the choice — it is
                        what actually changes on disk. */}
                    <div className={ui.tagRow}>
                      {p.categories.map((c) => (
                        <span key={c.id} className={ui.tag}>{categoryLabel(c, isZh)}</span>
                      ))}
                    </div>
                    {!isEnabled && parked > 0 && (
                      <div className={ui.packDataNote}>
                        {t("systemSettings.workspace.disabledHasData", { count: parked })}
                      </div>
                    )}
                  </div>
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
