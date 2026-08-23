import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, RotateCcw, X } from "lucide-react";
import { flushDirtyDocuments, useProjectStore } from "../../../stores/projectStore";
import { exportProjectBundle, restoreProjectBundle } from "../../../lib/fs/projectBackup";
import {
  BUILTIN_PROFILES,
  categoryLabel,
  loreCategoryIds,
  profileLabel,
  suggestCategoryId,
  type ProfileCategory,
  type WorkspaceProfile,
} from "../../../lib/profile";
import { fileExists, readDir } from "../../../lib/fs/fileio";
import {
  BUILTIN_WORKFLOWS,
  deleteWorkflowCard,
  saveWorkflowCard,
  scanWorkflows,
  suggestWorkflowId,
  type WorkflowCard,
} from "../../../lib/workflow";
import { useImeGuard } from "../../../lib/ime";
import { Pane, PaneHeader, Section, Row, Toggle } from "./bits";
import ui from "../settingsUi.module.css";
import common from "../settingsCommon.module.css";

/**
 * Configures the open project's capability packs and its user-defined
 * knowledge-base categories — see lib/profile.
 *
 * Packs are equal, purely additive toggles: enabling one adds its predefined
 * tasks and its knowledge-base categories to the project, nothing more. There
 * is no primary pack to pick any more — vocabulary, document model and the
 * AI's identity are app-level — so the card is one decision, on or off.
 *
 * Project-scoped, unlike every other pane here, which is why it lives on its
 * own and shows an explicit "open a project first" state rather than
 * rendering controls that would have nothing to act on.
 */
export function WorkspacePane() {
  const { t, i18n: i18nInst } = useTranslation();
  const isZh = i18nInst.language.startsWith("zh");
  const projectPath = useProjectStore((s) => s.projectPath);
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

  /** Toggle: enable/disable this pack; everything else stays as it is. */
  const togglePack = async (pack: WorkspaceProfile, on: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const ids = workspace.enabled.map((p) => p.id);
      await setPacks(on ? [...ids, pack.id] : ids.filter((id) => id !== pack.id));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // Which disabled packs still have entities on disk — their own categories
  // (not shared with anything enabled) with content under `.ai-writer/lore/`.
  // Since orphan categories are scanned (lib/lore/categories), those entries are
  // not parked any more: they stay on the wall and in context, minus the
  // category's name and type schema. This note says which pack would give those
  // back.
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
                const isEnabled = workspace.enabled.some((e) => e.id === p.id);
                const parked = parkedCounts[p.id] ?? 0;
                return (
                  // A div, not a button: the enable toggle nests inside, and a
                  // button inside a button is invalid HTML with unreliable
                  // event routing.
                  <div
                    key={p.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isEnabled}
                    aria-disabled={busy}
                    className={`${ui.card} ${ui.cardClickable} ${isEnabled ? ui.cardEnabled : ""}`}
                    onClick={() => void togglePack(p, !isEnabled)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        void togglePack(p, !isEnabled);
                      }
                    }}
                  >
                    <div className={ui.profileHead}>
                      <span className={ui.profileName}>{profileLabel(p, isZh)}</span>
                      {/* stopPropagation: the card click toggles too — the
                          switch must not fire the action twice. */}
                      <span className={ui.packToggle} onClick={(e) => e.stopPropagation()}>
                        <Toggle
                          on={isEnabled}
                          onChange={(next) => void togglePack(p, next)}
                          label={t(
                            isEnabled
                              ? "systemSettings.workspace.disablePack"
                              : "systemSettings.workspace.enablePack",
                            { pack: profileLabel(p, isZh) },
                          )}
                        />
                      </span>
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

      <CustomCategoriesSection />
      <WorkflowCardsSection />
      <ProjectBackupSection />
    </Pane>
  );
}

// ─── Workflow cards ──────────────────────────────────────────────────────────

/** What the inline editor is holding: an existing card's id, or "new". */
interface WorkflowDraft {
  id: string | null;
  name: string;
  description: string;
  body: string;
}

/**
 * 工作流卡（docs/feature/agent/workflow-cards-plan.md）：内置 + 项目文件的
 * 合并清单，启停、编辑、新建、还原。所有改动都是写/删
 * `.ai-writer/workflows/<id>.md` —— 这个 section 没有自己的持久状态，
 * 每次动作后重扫一遍就是真相。
 */
function WorkflowCardsSection() {
  const { t } = useTranslation();
  const projectPath = useProjectStore((s) => s.projectPath);
  const [cards, setCards] = useState<WorkflowCard[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<WorkflowDraft | null>(null);
  /** Two-click delete: first click arms this id, second deletes. */
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const rescan = async (path: string) => setCards(await scanWorkflows(path));

  useEffect(() => {
    if (!projectPath) {
      setCards([]);
      return;
    }
    let cancelled = false;
    void scanWorkflows(projectPath).then((c) => {
      if (!cancelled) setCards(c);
    });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  const run = async (action: () => Promise<void>) => {
    if (!projectPath || busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await rescan(projectPath);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 启停。项目卡改写自己的文件；内置卡的「停用」写一份带 disabled 的全量
   * 副本（薄覆盖会合并出一张空卡——整张替换是刻意的，见 lib/workflow/write）。
   */
  const toggleCard = (card: WorkflowCard, on: boolean) =>
    run(() =>
      saveWorkflowCard(projectPath!, card.id, {
        name: card.name,
        description: card.description,
        body: card.body,
        disabled: !on,
      }),
    );

  const saveDraft = () =>
    run(async () => {
      if (!draft || !draft.name.trim()) return;
      const id = draft.id ?? suggestWorkflowId(draft.name, cards.map((c) => c.id));
      await saveWorkflowCard(projectPath!, id, {
        name: draft.name.trim(),
        description: draft.description.trim(),
        body: draft.body,
        disabled: false,
      });
      setDraft(null);
    });

  if (!projectPath) return null;

  const isBuiltinId = (id: string) => BUILTIN_WORKFLOWS.some((b) => b.id === id);

  return (
    <Section label={t("systemSettings.workflows.section")}>
      <div className={`${ui.rowStacked} ${ui.rowLast}`}>
        <div className={ui.rowDesc}>{t("systemSettings.workflows.hint")}</div>

        <div style={{ marginTop: "var(--space-3)" }}>
          {cards.map((card) => (
            <div key={card.id} className={ui.customRow}>
              <span className={ui.badge}>
                {card.builtin
                  ? t("systemSettings.workflows.builtin")
                  : isBuiltinId(card.id)
                    ? t("systemSettings.workflows.overridden")
                    : t("systemSettings.workflows.custom")}
              </span>
              <span className={ui.customName} style={card.disabled ? { opacity: 0.5 } : undefined}>
                {card.name}
                {card.description && (
                  <span style={{ color: "var(--color-text-muted)" }}>{` — ${card.description}`}</span>
                )}
              </span>
              <span className={ui.spacer} />
              <button
                className={ui.iconBtn}
                title={t("systemSettings.workflows.edit")}
                onClick={() =>
                  setDraft({ id: card.id, name: card.name, description: card.description, body: card.body })
                }
              >
                <Pencil size={14} />
              </button>
              {/* 覆盖过的内置卡回得去；纯项目卡只能删。二者互斥。 */}
              {!card.builtin && isBuiltinId(card.id) && (
                <button
                  className={ui.iconBtn}
                  title={t("systemSettings.workflows.restore")}
                  onClick={() => void run(() => deleteWorkflowCard(projectPath, card.id))}
                >
                  <RotateCcw size={14} />
                </button>
              )}
              {!card.builtin && !isBuiltinId(card.id) && (
                <button
                  className={ui.iconBtn}
                  title={
                    confirmingDelete === card.id
                      ? t("systemSettings.workflows.deleteConfirm")
                      : t("systemSettings.workflows.delete")
                  }
                  style={confirmingDelete === card.id ? { color: "var(--color-error)" } : undefined}
                  onClick={() => {
                    if (confirmingDelete !== card.id) {
                      setConfirmingDelete(card.id);
                      return;
                    }
                    setConfirmingDelete(null);
                    void run(() => deleteWorkflowCard(projectPath, card.id));
                  }}
                  onBlur={() => setConfirmingDelete(null)}
                >
                  <X size={14} />
                </button>
              )}
              <Toggle
                on={!card.disabled}
                onChange={(next) => void toggleCard(card, next)}
                label={t(
                  card.disabled
                    ? "systemSettings.workflows.enableCard"
                    : "systemSettings.workflows.disableCard",
                  { card: card.name },
                )}
              />
            </div>
          ))}
        </div>

        {draft ? (
          <div style={{ marginTop: "var(--space-3)", display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            <input
              className={common.input}
              value={draft.name}
              maxLength={40}
              placeholder={t("systemSettings.workflows.namePlaceholder")}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <input
              className={common.input}
              value={draft.description}
              maxLength={60}
              placeholder={t("systemSettings.workflows.descPlaceholder")}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
            <textarea
              className={common.textarea}
              rows={10}
              value={draft.body}
              placeholder={t("systemSettings.workflows.bodyPlaceholder")}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              spellCheck={false}
            />
            <div style={{ display: "flex", gap: "var(--space-2)" }}>
              <button className={ui.rowBtn} onClick={() => void saveDraft()} disabled={busy || !draft.name.trim()}>
                {t("common.save")}
              </button>
              <button className={ui.rowBtn} onClick={() => setDraft(null)} disabled={busy}>
                {t("common.cancel")}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: "var(--space-3)" }}>
            <button
              className={ui.rowBtn}
              onClick={() => setDraft({ id: null, name: "", description: "", body: "" })}
              disabled={busy}
            >
              {t("systemSettings.workflows.newCard")}
            </button>
          </div>
        )}
        {error && <div className={ui.statusError}>{error}</div>}
      </div>
    </Section>
  );
}

// ─── User-defined knowledge-base categories ──────────────────────────────────

/**
 * The project's own categories, alongside whatever the enabled packs bring:
 * add, rename (labels only — the folder id is stable), remove. Removing only
 * hides the directory, the same never-silently-lose-data rule pack toggles
 * follow.
 */
function CustomCategoriesSection() {
  const { t, i18n: i18nInst } = useTranslation();
  const isZh = i18nInst.language.startsWith("zh");
  const projectPath = useProjectStore((s) => s.projectPath);
  const customCategories = useProjectStore((s) => s.customCategories);
  const setCustomCategories = useProjectStore((s) => s.setCustomCategories);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null);
  const ime = useImeGuard();

  const apply = async (next: ProfileCategory[]) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await setCustomCategories(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleAdd = async () => {
    const label = newLabel.trim();
    if (!label || busy) return;
    const id = suggestCategoryId(label, loreCategoryIds());
    await apply([...customCategories, { id, labelZh: label, labelEn: label }]);
    setNewLabel("");
  };

  const handleRename = async () => {
    if (!editing) return;
    const label = editing.label.trim();
    if (!label) return;
    await apply(
      customCategories.map((c) =>
        c.id === editing.id ? { ...c, labelZh: label, labelEn: label } : c,
      ),
    );
    setEditing(null);
  };

  if (!projectPath) return null;

  return (
    <Section label={t("systemSettings.workspace.categoriesSection")}>
      <div className={`${ui.rowStacked} ${ui.rowLast}`}>
        <div className={ui.rowDesc}>{t("systemSettings.workspace.categoriesHint")}</div>

        {customCategories.length > 0 && (
          <div style={{ marginTop: "var(--space-3)" }}>
            {customCategories.map((c) => (
              <div key={c.id} className={ui.customRow}>
                <span className={ui.badge}>{c.id}</span>
                {editing?.id === c.id ? (
                  <input
                    className={common.input}
                    value={editing.label}
                    autoFocus
                    maxLength={40}
                    onChange={(e) => setEditing({ id: c.id, label: e.target.value })}
                    {...ime.imeProps}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !ime.isComposing(e)) void handleRename();
                      if (e.key === "Escape") setEditing(null);
                    }}
                    onBlur={() => void handleRename()}
                  />
                ) : (
                  <span
                    className={ui.customName}
                    role="button"
                    tabIndex={0}
                    title={t("systemSettings.workspace.renameCategory")}
                    onClick={() => setEditing({ id: c.id, label: isZh ? c.labelZh : c.labelEn })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") setEditing({ id: c.id, label: isZh ? c.labelZh : c.labelEn });
                    }}
                  >
                    {categoryLabel(c, isZh)}
                  </span>
                )}
                <span className={ui.spacer} />
                <button
                  className={ui.iconBtn}
                  title={t("systemSettings.workspace.removeCategory")}
                  onClick={() => void apply(customCategories.filter((x) => x.id !== c.id))}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
          <input
            className={common.input}
            placeholder={t("systemSettings.workspace.newCategoryPlaceholder")}
            value={newLabel}
            maxLength={40}
            onChange={(e) => setNewLabel(e.target.value)}
            {...ime.imeProps}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !ime.isComposing(e)) void handleAdd();
            }}
          />
          <button className={ui.rowBtn} onClick={() => void handleAdd()} disabled={busy || !newLabel.trim()}>
            {t("systemSettings.workspace.addCategory")}
          </button>
        </div>
        {error && <div className={ui.statusError}>{error}</div>}
      </div>
    </Section>
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
