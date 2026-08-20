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
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "../common/ModalShell";
import type { SyncPlan, SyncStep } from "../../lib/sync/model";
import { useSyncStore } from "../../stores/syncStore";
import { useProjectStore } from "../../stores/projectStore";
import s from "./sync.module.css";

/** Above this many actionable rows the list gets filter chips and a search box.
 *  Below it they are chrome around a list the eye already takes in at once. */
const FILTER_THRESHOLD = 12;
/** Rows rendered per group before the "…and N more" line. Keeps a 3000-entry
 *  project from mounting 3000 rows; the filters are how you reach the rest. */
const ROW_CAP = 60;

type Filter = "all" | "risk" | "create" | "overwrite" | "delete" | "unchanged";

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
  const closeModal = useSyncStore((p) => p.closeModal);
  const startPreview = useSyncStore((p) => p.startPreview);

  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [showUnchanged, setShowUnchanged] = useState(false);

  if (phase === "idle") return null;

  const isPush = direction === "push";
  const projectName = (projectPath ?? "").replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? "";

  const close = () => {
    setFilter("all");
    setQuery("");
    setShowUnchanged(false);
    closeModal();
  };

  return (
    <ModalShell
      overlayClassName={s.overlay}
      onClose={close}
      // A run in flight cannot be dismissed by a stray backdrop click: the
      // filesystem is being written to, and the modal is the only place the
      // progress and the backup location are shown.
      closeOnBackdrop={phase !== "running"}
      closeOnEscape={phase !== "running"}
    >
      <div className={`${s.panel} ${panelWidth(phase, plan)}`}>
        <div className={s.head}>
          <div className={s.headTitle}>{headTitle(t, phase, isPush, binding?.kbName ?? "", result)}</div>
          <span className={s.spacer} />
          {phase !== "running" && (
            <button className={s.close} onClick={close} aria-label={t("common.close")}>
              ×
            </button>
          )}
        </div>

        {phase === "planning" && <div className={s.centered}><div className={s.centeredBody}>{t("sync.planning")}</div></div>}

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
            error={error}
            onCancel={close}
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
                  style={{ width: `${progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }}
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

        {phase === "done" && result && <ResultBody result={result} onClose={close} />}
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
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  onSwitchDirection: () => void;
}

function PreviewBody(p: PreviewProps) {
  const { t } = useTranslation();
  const { plan, isPush } = p;
  const { create, overwrite, delete: del, unchanged, warnings } = plan.summary;

  const risky = useMemo(() => plan.steps.filter((x) => x.warning !== null), [plan]);
  const conflicts = risky.filter((x) => x.warning === "both-changed").length;
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
        case "unchanged": return x.action === "none";
        default: return true;
      }
    });

  const riskyShown = filtered(risky);
  const ordinaryShown = filtered(ordinary);
  const sameShown = filtered(same);
  const showFilters = plan.steps.length - unchanged > FILTER_THRESHOLD;

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
            ["all", t("sync.filterAll"), plan.steps.length],
            ["risk", t("sync.filterRisk"), warnings],
            ["create", t("sync.filterCreate"), create],
            ["overwrite", t("sync.filterOverwrite"), overwrite],
            ["delete", t("sync.filterDelete"), del],
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
        </div>

        {riskyShown.length > 0 && (
          <>
            <div className={`${s.groupHead} ${s.groupHeadRisk}`}>
              {t("sync.filterRisk")} · <span>{riskyShown.length}</span>
              <span className={`${s.groupRule} ${s.groupRuleRisk}`} />
            </div>
            {riskyShown.slice(0, ROW_CAP).map((step) => (
              <Row key={step.path} step={step} isPush={isPush} />
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
              <Row key={step.path} step={step} isPush={isPush} />
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
                <Row key={step.path} step={step} isPush={isPush} />
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
          <div className={s.footNote}>{isPush ? t("sync.pushNote") : t("sync.pullNote")}</div>
        )}
        <button className={s.btnGhost} onClick={p.onCancel}>{t("common.cancel")}</button>
        <button
          className={s.btnPrimary}
          disabled={conflicts > 0 && !p.acknowledged}
          onClick={p.onConfirm}
        >
          {confirmLabel(t, isPush, create, overwrite, del)}
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

function Row({ step, isPush }: { step: SyncStep; isPush: boolean }) {
  const { t } = useTranslation();
  const [category, ...rest] = step.path.split("/");
  const name = rest.join("/");
  const localHash = isPush ? step.sourceHash : step.targetHash;
  const remoteHash = isPush ? step.targetHash : step.sourceHash;
  const conflict = step.warning === "both-changed";

  const rowClass =
    step.warning === null ? s.row : conflict ? `${s.grid} ${s.rowConflict}` : `${s.grid} ${s.rowRisk}`;

  return (
    <div className={step.warning === null ? `${s.grid} ${s.row}` : rowClass}>
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
      <span className={`${s.badge} ${badgeClass(step)}`}>{t(`sync.action.${step.action}`)}</span>
      <HashCell hash={localHash} />
      <span className={s.arrowCell}>{isPush ? "→" : "←"}</span>
      <HashCell hash={remoteHash} />
    </div>
  );
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
