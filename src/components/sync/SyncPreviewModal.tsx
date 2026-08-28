/**
 * 知识库同步 · 预览 / 执行 / 结果（设计稿 06）。
 *
 * One modal, four phases, because they are one decision the author is walking
 * through: what will happen → it is happening → what happened. Splitting them
 * into separate dialogs would lose the thread at exactly the moment a mirror
 * becomes irreversible.
 *
 * Three rules from the design carry the safety of the whole feature:
 *
 * 1. **Local is always the left column, remote always the right** — whichever
 *    direction runs. Only the arrow and the tint move. Swapping sides per
 *    direction would make "which one is mine" something to re-read every time.
 * 2. **Only rows that lose something are coloured.** A two-sided conflict gets
 *    a fill *and* an accent rail; a one-sided loss gets the rail alone; the
 *    other few hundred rows stay plain. Colouring more would mean colouring
 *    everything, and then nothing reads as a warning.
 * 3. **A plan that destroys work needs the consequence acknowledged in words**
 *    — a sentence naming what is lost, not a typed ritual the author learns to
 *    perform without reading.
 *
 * The per-entry 「执行 / 跳过」 column is the fourth thing this screen is for.
 * A mirror is the default, but the author is the one who decides whether a
 * local-only draft survives a pull, so every actionable row carries its own
 * off switch and the footer counts only what is still switched on.
 */

import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "../common/ModalShell";
import type { EntryPath, SyncDecision, SyncPlan, SyncStep } from "../../lib/sync/model";
import { canDecide } from "../../lib/sync/plan";
import { useSyncStore } from "../../stores/syncStore";
import { useProjectStore } from "../../stores/projectStore";
import s from "./sync.module.css";
import { baseName } from "../../lib/paths";

/** Above this many actionable rows the list gets filter chips and a search box.
 *  Below it they are chrome around a list the eye already takes in at once. */
const FILTER_THRESHOLD = 12;
/** Rows rendered per group before the "…and N more" line. Keeps a 3000-entry
 *  project from mounting 3000 rows; the filters are how you reach the rest. */
const ROW_CAP = 60;

type Filter = "all" | "risk" | "create" | "overwrite" | "delete" | "skipped" | "unchanged";

function shortHash(hash: string | null): string | null {
  return hash ? hash.slice(0, 8) : null;
}

export function SyncPreviewModal() {
  const { t } = useTranslation();
  const projectPath = useProjectStore((p) => p.projectPath);
  const phase = useSyncStore((p) => p.phase);
  const plan = useSyncStore((p) => p.plan);
  const direction = useSyncStore((p) => p.direction);
  const progress = useSyncStore((p) => p.progress);
  const result = useSyncStore((p) => p.result);
  const binding = useSyncStore((p) => p.binding);
  const acknowledged = useSyncStore((p) => p.acknowledged);
  const error = useSyncStore((p) => p.error);
  const setAcknowledged = useSyncStore((p) => p.setAcknowledged);
  const confirmRun = useSyncStore((p) => p.confirmRun);
  const setDecision = useSyncStore((p) => p.setDecision);
  const closeModal = useSyncStore((p) => p.closeModal);
  const startPreview = useSyncStore((p) => p.startPreview);
  const checking = useSyncStore((p) => p.checking);

  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [showUnchanged, setShowUnchanged] = useState(false);
  const shellCloseRef = useRef<(() => void) | null>(null);

  if (phase === "idle") return null;

  const isPush = direction === "push";
  const projectName = baseName(projectPath ?? "");

  const close = () => {
    setFilter("all");
    setQuery("");
    setShowUnchanged(false);
    closeModal();
  };
  const requestClose = () => (shellCloseRef.current ?? close)();

  return (
    <ModalShell
      overlayClassName={s.overlay}
      onClose={close}
      // A run in flight cannot be dismissed by a stray backdrop click: the
      // filesystem is being written to, and the modal is the only place the
      // progress and the backup location are shown.
      closeOnBackdrop={phase !== "running"}
      closeOnEscape={phase !== "running"}
      closeRef={shellCloseRef}
    >
      <div className={`${s.panel} ${panelWidth(phase, plan)}`}>
        <div className={s.head}>
          <div className={s.headTitle}>{headTitle(t, phase, isPush, binding?.kbName ?? "", result)}</div>
          <span className={s.spacer} />
          {phase !== "running" && (
            <button className={s.close} onClick={requestClose} aria-label={t("common.close")}>
              ×
            </button>
          )}
        </div>

        {phase === "planning" && (
          <div className={s.centered}>
            <div className={s.centeredBody}>
              {t("sync.planning")}
              {/* 本地哈希的逐条进度——大库要读全部配图,没有数字就像挂了。 */}
              {checking && checking.total > 0 && (
                <>
                  {" "}
                  {checking.done} / {checking.total} · {checking.path}
                </>
              )}
            </div>
          </div>
        )}

        {phase === "preview" && plan && (
          <PreviewBody
            plan={plan}
            isPush={isPush}
            projectName={projectName}
            kbName={binding?.kbName ?? ""}
            serverHost={hostOf(binding?.serverUrl ?? "")}
            filter={filter}
            setFilter={setFilter}
            query={query}
            setQuery={setQuery}
            showUnchanged={showUnchanged}
            setShowUnchanged={setShowUnchanged}
            acknowledged={acknowledged}
            setAcknowledged={setAcknowledged}
            onDecide={setDecision}
            error={error}
            onCancel={requestClose}
            onConfirm={() => projectPath && void confirmRun(projectPath)}
            onSwitchDirection={() =>
              projectPath && void startPreview(projectPath, isPush ? "pull" : "push")
            }
          />
        )}

        {phase === "running" && (
          <>
            <div className={s.progressBody}>
              {!isPush && (
                <div className={s.backedUp}>
                  <em>✓</em> {t("sync.backedUp")}
                </div>
              )}
              <div className={s.track}>
                <div
                  className={s.trackFill}
                  style={{ transform: `scaleX(${(progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0) / 100})` }}
                />
              </div>
              <div className={s.progressNums}>
                <div className={s.progressCount}>
                  {t("sync.progressCount", { done: progress?.done ?? 0, total: progress?.total ?? 0 })}
                </div>
                <span className={s.spacer} />
                <div className={s.progressPct}>
                  {progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%
                </div>
              </div>
              <div className={s.progressNow}>
                {t("sync.progressNow")}
                <em>{prettyPath(progress?.path ?? "")}</em>
              </div>
            </div>
            <div className={s.foot}>
              <div className={s.footNote}>{t("sync.runningNote")}</div>
            </div>
          </>
        )}

        {phase === "done" && result && <ResultBody result={result} onClose={requestClose} />}
      </div>
    </ModalShell>
  );
}

// ─── Preview ─────────────────────────────────────────────────────────────────

interface PreviewProps {
  plan: SyncPlan;
  isPush: boolean;
  projectName: string;
  kbName: string;
  serverHost: string;
  filter: Filter;
  setFilter: (f: Filter) => void;
  query: string;
  setQuery: (q: string) => void;
  showUnchanged: boolean;
  setShowUnchanged: (on: boolean) => void;
  acknowledged: boolean;
  setAcknowledged: (on: boolean) => void;
  onDecide: (paths: readonly EntryPath[], decision: SyncDecision) => void;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  onSwitchDirection: () => void;
}

function PreviewBody(p: PreviewProps) {
  const { t } = useTranslation();
  const { plan, isPush } = p;
  // Applied-only counts (see `SyncPlan.summary`): everything the footer says is
  // about the run that would start, not about the mirror that was proposed.
  const { create, overwrite, delete: del, unchanged, warnings, skipped } = plan.summary;

  const risky = useMemo(() => plan.steps.filter((x) => x.warning !== null), [plan]);
  // A skipped conflict is not a conflict any more — nothing of it runs — so it
  // stops driving the acknowledgement gate while still being listed, dimmed,
  // where the author can put it back.
  const conflicts = risky.filter(
    (x) => x.warning === "both-changed" && x.decision === "apply",
  ).length;
  const willRun = create + overwrite + del;
  const ordinary = useMemo(
    () => plan.steps.filter((x) => x.action !== "none" && x.warning === null),
    [plan],
  );
  const same = useMemo(() => plan.steps.filter((x) => x.action === "none"), [plan]);

  const localCount = plan.steps.filter((x) => (isPush ? x.sourceHash : x.targetHash) !== null).length;
  const remoteCount = plan.steps.filter((x) => (isPush ? x.targetHash : x.sourceHash) !== null).length;

  // A sync whose SOURCE is empty would wipe a target that is not — the most
  // likely way to run this in the wrong direction, so it replaces the table
  // with a stop rather than being one line inside it. The mirror case (empty
  // target) loses nothing and simply says so.
  const sourceEmpty = (isPush ? localCount : remoteCount) === 0;
  const targetEmpty = (isPush ? remoteCount : localCount) === 0;
  const targetTotal = isPush ? remoteCount : localCount;

  const band = (
    <Band
      isPush={isPush}
      projectName={p.projectName}
      kbName={p.kbName}
      serverHost={p.serverHost}
      localLine={t("sync.entryCount", { n: localCount })}
      remoteLine={t("sync.entryCount", { n: remoteCount })}
    />
  );

  if (sourceEmpty && targetTotal > 0) {
    return (
      <>
        <div className={s.centered}>
          <div className={s.centeredPath}>
            {p.projectName}（{localCount}）{isPush ? "→" : "←"} {p.kbName}（{remoteCount}）
          </div>
          <div className={`${s.centeredTitle} ${s.centeredTitleWarn}`}>
            {t(isPush ? "sync.emptyLocalTitle" : "sync.emptyRemoteTitle")}
          </div>
          <div
            className={s.centeredBody}
            dangerouslySetInnerHTML={{
              __html: t(isPush ? "sync.emptyLocalBody" : "sync.emptyRemoteBody", { n: targetTotal }),
            }}
          />
        </div>
        <div className={s.foot}>
          <button className={s.btnLink} onClick={p.onConfirm}>
            {t(isPush ? "sync.emptyPushAnyway" : "sync.emptyPullAnyway")}
          </button>
          <span className={s.spacer} />
          <button className={s.btnGhost} onClick={p.onCancel}>{t("common.cancel")}</button>
          <button className={s.btnPrimary} onClick={p.onSwitchDirection}>
            {t(isPush ? "sync.switchToPull" : "sync.switchToPush", { n: targetTotal })}
          </button>
        </div>
      </>
    );
  }

  if (targetEmpty) {
    return (
      <>
        <div className={s.centered}>
          <div className={s.centeredPath}>
            {p.projectName}（{localCount}）{isPush ? "→" : "←"} {p.kbName}（{remoteCount}）
          </div>
          <div className={s.centeredTitle}>{t(isPush ? "sync.freshRemote" : "sync.freshLocal")}</div>
          <div
            className={s.centeredBody}
            dangerouslySetInnerHTML={{ __html: t("sync.freshBody", { n: create }) }}
          />
        </div>
        <div className={s.foot}>
          <span className={s.spacer} />
          <button className={s.btnGhost} onClick={p.onCancel}>{t("common.cancel")}</button>
          <button className={s.btnPrimary} onClick={p.onConfirm}>
            {t(isPush ? "sync.uploadAll" : "sync.downloadAll", { n: create })}
          </button>
        </div>
      </>
    );
  }

  const filtered = (list: SyncStep[]) =>
    list.filter((x) => {
      if (p.query && !x.path.toLowerCase().includes(p.query.toLowerCase())) return false;
      switch (p.filter) {
        case "risk": return x.warning !== null;
        case "create": return x.action === "create";
        case "overwrite": return x.action === "overwrite";
        case "delete": return x.action === "delete";
        case "skipped": return x.decision === "skip" && x.action !== "none";
        case "unchanged": return x.action === "none";
        default: return true;
      }
    });

  const riskyShown = filtered(risky);
  const ordinaryShown = filtered(ordinary);
  const sameShown = filtered(same);
  const showFilters = plan.steps.length - unchanged > FILTER_THRESHOLD;

  // Bulk decisions act on what the filters currently select — including the
  // rows past `ROW_CAP` that are not mounted. That is the point: "keep the 200
  // entries only I have" is one filter and one click, not 200 toggles, and the
  // rows the author cannot see are exactly the ones a per-row-only control
  // would silently leave behind.
  const bulk = [...riskyShown, ...ordinaryShown].filter(canDecide);
  const bulkBar = (
    <BulkBar
      paths={bulk.map((x) => x.path)}
      skippable={bulk.filter((x) => x.decision === "apply").length}
      restorable={bulk.filter((x) => x.decision === "skip").length}
      onDecide={p.onDecide}
    />
  );

  return (
    <>
      {band}

      {plan.firstSync && (
        <div className={s.notice}>
          <span className={s.noticeMark}>i</span>
          <div>
            <b className={s.noticeStrong}>{t("sync.firstSyncTitle")}</b>
            {t("sync.firstSyncBody")}
          </div>
        </div>
      )}

      {p.error && (
        <div className={s.notice}>
          <span className={s.noticeMark}>!</span>
          <div>{p.error}</div>
        </div>
      )}

      {showFilters ? (
        <div className={s.filters}>
          {([
            // Chip counts are per action across the whole plan, skipped rows
            // included — a chip is a way to *reach* rows, so a count that
            // shrank as you skipped would hide the rows you just turned off.
            ["all", t("sync.filterAll"), plan.steps.length],
            ["risk", t("sync.filterRisk"), risky.length],
            ["create", t("sync.filterCreate"), byAction(plan, "create")],
            ["overwrite", t("sync.filterOverwrite"), byAction(plan, "overwrite")],
            ["delete", t("sync.filterDelete"), byAction(plan, "delete")],
            ...(skipped > 0 ? ([["skipped", t("sync.filterSkipped"), skipped]] as [Filter, string, number][]) : []),
            ["unchanged", t("sync.filterUnchanged"), unchanged],
          ] as [Filter, string, number][]).map(([id, label, n]) => (
            <button
              key={id}
              className={`${s.chip} ${p.filter === id ? s.chipOn : ""}`}
              onClick={() => p.setFilter(id)}
            >
              {label} <span>{n}</span>
            </button>
          ))}
          <span className={s.spacer} />
          <input
            className={s.search}
            placeholder={t("sync.searchPlaceholder")}
            value={p.query}
            onChange={(e) => p.setQuery(e.target.value)}
          />
          {bulkBar}
        </div>
      ) : (
        <div className={s.summary}>
          {t("sync.summary")
            .split("|")
            .map((part, i) => {
              const n = [create, overwrite, del, warnings, unchanged][i];
              return (
                <span key={part}>
                  {i > 0 ? " · " : ""}
                  {part} <b>{n}</b>
                </span>
              );
            })}
          {skipped > 0 && (
            <span>
              {" · "}
              {t("sync.filterSkipped")} <b>{skipped}</b>
            </span>
          )}
          <span className={s.spacer} />
          {bulkBar}
        </div>
      )}

      <div className={s.list}>
        <div className={`${s.grid} ${s.thead}`}>
          <span>{t("sync.colEntry")}</span>
          <span>{t("sync.colAction")}</span>
          <span className={isPush ? undefined : s.thTarget}>
            {t("sync.colLocal")} · {t(isPush ? "sync.colSource" : "sync.colTarget")}
          </span>
          <span />
          <span className={isPush ? s.thTarget : undefined}>
            {t("sync.colRemote")} · {t(isPush ? "sync.colTarget" : "sync.colSource")}
          </span>
          <span className={s.thDecide}>{t("sync.colDecision")}</span>
        </div>

        {riskyShown.length > 0 && (
          <>
            <div className={`${s.groupHead} ${s.groupHeadRisk}`}>
              {t("sync.filterRisk")} · <span>{riskyShown.length}</span>
              <span className={`${s.groupRule} ${s.groupRuleRisk}`} />
            </div>
            {riskyShown.slice(0, ROW_CAP).map((step) => (
              <Row key={step.path} step={step} isPush={isPush} onDecide={p.onDecide} />
            ))}
            {riskyShown.length > ROW_CAP && (
              <div className={s.more}>{t("sync.andMore", { n: riskyShown.length - ROW_CAP })}</div>
            )}
          </>
        )}

        {ordinaryShown.length > 0 && (
          <>
            <div className={s.groupHead}>
              {t("sync.ordinary")} · <span>{ordinaryShown.length}</span>
              <span className={s.groupRule} />
            </div>
            {ordinaryShown.slice(0, ROW_CAP).map((step) => (
              <Row key={step.path} step={step} isPush={isPush} onDecide={p.onDecide} />
            ))}
            {ordinaryShown.length > ROW_CAP && (
              <div className={s.more}>{t("sync.andMore", { n: ordinaryShown.length - ROW_CAP })}</div>
            )}
          </>
        )}

        {sameShown.length > 0 && (
          <>
            <button className={s.unchanged} onClick={() => p.setShowUnchanged(!p.showUnchanged)}>
              <span className={s.caret}>{p.showUnchanged ? "▾" : "▸"}</span>
              {t("sync.unchangedNote")} <span>{sameShown.length}</span> {t("sync.unchangedTail")}
            </button>
            {p.showUnchanged &&
              sameShown.slice(0, ROW_CAP).map((step) => (
                <Row key={step.path} step={step} isPush={isPush} onDecide={p.onDecide} />
              ))}
          </>
        )}
      </div>

      <div className={`${s.foot} ${s.footScrolled}`}>
        {conflicts > 0 ? (
          <label className={s.ack}>
            <input
              type="checkbox"
              checked={p.acknowledged}
              onChange={(e) => p.setAcknowledged(e.target.checked)}
              style={{ position: "absolute", opacity: 0, pointerEvents: "none" }}
            />
            <span className={`${s.ackBox} ${p.acknowledged ? s.ackBoxOn : ""}`}>✓</span>
            <span
              dangerouslySetInnerHTML={{
                __html: t(isPush ? "sync.ackPush" : "sync.ackPull", { n: conflicts }),
              }}
            />
          </label>
        ) : (
          <div className={s.footNote}>
            {skipped > 0
              ? t("sync.skippedNote", { n: skipped })
              : isPush
                ? t("sync.pushNote")
                : t("sync.pullNote")}
          </div>
        )}
        <button className={s.btnGhost} onClick={p.onCancel}>{t("common.cancel")}</button>
        <button
          className={s.btnPrimary}
          // Nothing left switched on is not a sync: a pull would still zip the
          // whole tree "before" writing nothing, and the run would report zero
          // successes as if it had done its job.
          disabled={willRun === 0 || (conflicts > 0 && !p.acknowledged)}
          onClick={p.onConfirm}
        >
          {willRun === 0 ? t("sync.nothingToRun") : confirmLabel(t, isPush, create, overwrite, del)}
        </button>
      </div>
    </>
  );
}

function Band(props: {
  isPush: boolean;
  projectName: string;
  kbName: string;
  serverHost: string;
  localLine: string;
  remoteLine: string;
}) {
  const { t } = useTranslation();
  const { isPush } = props;
  const localIsTarget = !isPush;
  return (
    <div className={s.band}>
      <div>
        <div className={`${s.sideLabel} ${localIsTarget ? s.sideLabelTarget : ""}`}>
          {localIsTarget ? t("sync.targetLabelLocal") : t("sync.sourceLabel")}
        </div>
        <div className={`${s.card} ${localIsTarget ? s.cardTarget : ""}`}>
          <div className={s.cardName}>
            {props.projectName}
            <span className={s.cardWhere}>{t("sync.localProject")}</span>
          </div>
          <div className={s.cardMeta}>{props.localLine}</div>
        </div>
      </div>
      <div className={s.arrowCol}>
        <div className={s.arrowVerb}>{t(isPush ? "sync.push" : "sync.pull")}</div>
        <div className={s.arrowLine}>
          {!isPush && <span className={s.arrowHeadLeft} />}
          <span className={s.arrowBar} />
          {isPush && <span className={s.arrowHeadRight} />}
        </div>
        <div className={s.arrowNote}>{t(isPush ? "sync.localWins" : "sync.remoteWins")}</div>
      </div>
      <div>
        <div className={`${s.sideLabel} ${localIsTarget ? "" : s.sideLabelTarget}`}>
          {localIsTarget ? t("sync.sourceLabel") : t("sync.targetLabelRemote")}
        </div>
        <div className={`${s.card} ${localIsTarget ? "" : s.cardTarget}`}>
          <div className={s.cardName}>
            {props.kbName}
            <span className={s.cardWhere}>{props.serverHost}</span>
          </div>
          <div className={s.cardMeta}>{props.remoteLine}</div>
        </div>
      </div>
    </div>
  );
}

function Row({
  step,
  isPush,
  onDecide,
}: {
  step: SyncStep;
  isPush: boolean;
  onDecide: (paths: readonly EntryPath[], decision: SyncDecision) => void;
}) {
  const { t } = useTranslation();
  const [category, ...rest] = step.path.split("/");
  const name = rest.join("/");
  const localHash = isPush ? step.sourceHash : step.targetHash;
  const remoteHash = isPush ? step.targetHash : step.sourceHash;
  const skip = step.decision === "skip";
  // A skipped step keeps its warning text — it explains what it *would* have
  // cost — but stops wearing the alarm: the row no longer describes anything
  // that will happen, and leaving it lit would keep drawing the eye to the one
  // decision already made.
  const conflict = step.warning === "both-changed" && !skip;
  const risky = step.warning !== null && !skip;

  const rowClass = conflict ? s.rowConflict : risky ? s.rowRisk : s.row;

  return (
    <div className={`${s.grid} ${rowClass} ${skip ? s.rowSkipped : ""}`}>
      <div className={s.entry}>
        <span className={s.entryCat}>{category} / </span>
        {name}
        {step.warning && (
          <div className={`${s.warn} ${conflict ? s.warnConflict : ""}`}>
            {conflict ? "⚠ " : ""}
            {t(`sync.warn.${step.warning}` as const)}
          </div>
        )}
      </div>
      <span className={`${s.badge} ${skip ? s.badgeSkipped : badgeClass(step)}`}>
        {t(`sync.action.${step.action}`)}
      </span>
      <HashCell hash={localHash} />
      <span className={s.arrowCell}>{skip ? "·" : isPush ? "→" : "←"}</span>
      <HashCell hash={remoteHash} />
      {canDecide(step) ? (
        <button
          className={`${s.decide} ${skip ? s.decideOff : ""}`}
          aria-pressed={!skip}
          // The button names the verb it performs, and for a delete that verb
          // is 「保留」 rather than 「跳过」: what the author is choosing is not
          // an abstract step being skipped, it is this entry staying.
          onClick={() => onDecide([step.path], skip ? "apply" : "skip")}
        >
          {skip ? t("sync.decide.restore") : t(`sync.decide.off.${step.action}`)}
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

/**
 * Skip or restore everything the filters currently select.
 *
 * Both buttons are always present, each disabled when it has nothing to do, so
 * the pair keeps its position instead of the row reflowing under the cursor as
 * the selection changes.
 */
function BulkBar({
  paths,
  skippable,
  restorable,
  onDecide,
}: {
  paths: readonly EntryPath[];
  skippable: number;
  restorable: number;
  onDecide: (paths: readonly EntryPath[], decision: SyncDecision) => void;
}) {
  const { t } = useTranslation();
  if (paths.length === 0) return null;
  return (
    <div className={s.bulk}>
      <button
        className={s.bulkBtn}
        disabled={skippable === 0}
        onClick={() => onDecide(paths, "skip")}
      >
        {t("sync.bulkSkip", { n: skippable })}
      </button>
      <button
        className={s.bulkBtn}
        disabled={restorable === 0}
        onClick={() => onDecide(paths, "apply")}
      >
        {t("sync.bulkRestore", { n: restorable })}
      </button>
    </div>
  );
}

/** How many steps the plan has for one action, skipped ones included. */
function byAction(plan: SyncPlan, action: SyncStep["action"]): number {
  return plan.steps.filter((x) => x.action === action).length;
}

function HashCell({ hash }: { hash: string | null }) {
  const short = shortHash(hash);
  if (!short) return <div className={s.hashNone}>—</div>;
  return <div className={s.hash}>{short}</div>;
}

function badgeClass(step: SyncStep): string {
  if (step.action === "create") return s.badgeCreate;
  if (step.action === "delete") return s.badgeDelete;
  if (step.action === "overwrite") return s.badgeOverwrite;
  return s.badgeCreate;
}

// ─── Result ──────────────────────────────────────────────────────────────────

function ResultBody({
  result,
  onClose,
}: {
  result: NonNullable<ReturnType<typeof useSyncStore.getState>["result"]>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const projectPath = useProjectStore((p) => p.projectPath);
  const direction = useSyncStore((p) => p.direction);
  const startPreview = useSyncStore((p) => p.startPreview);

  const conflicts = result.failures.filter((f) => f.conflict);
  const others = result.failures.filter((f) => !f.conflict);

  return (
    <>
      <div className={s.resultCount}>
        {t("sync.resultOk")} <b>{result.succeeded.length}</b>
        {result.failures.length > 0 && (
          <>
            {" · "}
            {t("sync.resultFailed")} <b className={s.bad}>{result.failures.length}</b>
          </>
        )}
      </div>

      {conflicts.length > 0 && (
        <div className={`${s.group} ${s.groupConflict}`}>
          <div className={s.groupTitle}>{t("sync.resultMoved", { n: conflicts.length })}</div>
          <div className={s.groupItems}>
            {conflicts.map((f) => (
              <div key={f.path}>{prettyPath(f.path)}</div>
            ))}
          </div>
          <button
            className={`${s.btnPrimary} ${s.groupBtn}`}
            onClick={() => projectPath && void startPreview(projectPath, direction)}
          >
            {t("sync.repreview", { n: conflicts.length })}
          </button>
        </div>
      )}

      {others.length > 0 && (
        <div className={`${s.group} ${s.groupOther}`}>
          <div className={s.groupTitle}>{t("sync.resultOther", { n: others.length })}</div>
          <div className={s.groupItems}>
            {others.map((f) => (
              <div key={f.path}>
                {prettyPath(f.path)} <i>{f.message}</i>
              </div>
            ))}
          </div>
        </div>
      )}

      {result.backupPath && (
        <div className={s.backupRow}>
          <span className={s.backupTag}>{t("sync.backup")}</span>
          <span className={s.backupPath}>{result.backupPath}</span>
        </div>
      )}

      <div className={s.foot} style={{ marginTop: 6 }}>
        <div className={s.footNote}>
          {result.failures.length > 0 ? t("sync.resultIntact", { n: result.failures.length }) : ""}
        </div>
        <button className={s.btnPrimary} onClick={onClose}>{t("sync.done")}</button>
      </div>
    </>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

function prettyPath(path: string): string {
  return path.replace("/", " / ");
}

function panelWidth(phase: string, plan: SyncPlan | null): string {
  if (phase === "running") return s.slim;
  if (phase === "done") return s.narrow;
  if (phase === "planning") return s.slim;
  // The long-list layout needs the extra width for the filter row; a short plan
  // in a 960px panel is mostly empty paper.
  return plan && plan.steps.length - plan.summary.unchanged > FILTER_THRESHOLD ? s.wide : s.mid;
}

function headTitle(
  t: (k: string, o?: Record<string, unknown>) => string,
  phase: string,
  isPush: boolean,
  kbName: string,
  result: { failures: unknown[] } | null,
): string {
  if (phase === "running") return t(isPush ? "sync.runningPush" : "sync.runningPull", { kb: kbName });
  if (phase === "done") {
    const failed = result?.failures.length ?? 0;
    return failed > 0
      ? t(isPush ? "sync.donePushPartial" : "sync.donePullPartial", { n: failed })
      : t(isPush ? "sync.donePush" : "sync.donePull");
  }
  return t(isPush ? "sync.titlePush" : "sync.titlePull");
}

/**
 * The confirm button names the outcome, never "OK".
 *
 * At most two clauses, destructive ones first: a button that lists everything
 * stops being read. When the plan only adds, it says so instead.
 */
function confirmLabel(
  t: (k: string, o?: Record<string, unknown>) => string,
  isPush: boolean,
  create: number,
  overwrite: number,
  del: number,
): string {
  if (overwrite === 0 && del === 0) {
    return t(isPush ? "sync.uploadAll" : "sync.downloadAll", { n: create });
  }
  const parts: string[] = [];
  if (overwrite > 0) parts.push(t("sync.clauseOverwrite", { n: overwrite }));
  if (del > 0) parts.push(t("sync.clauseDelete", { n: del }));
  if (create > 0) parts.push(t("sync.clauseCreate", { n: create }));
  return t(isPush ? "sync.confirmPush" : "sync.confirmPull", { parts: parts.slice(0, 2).join("、") });
}
