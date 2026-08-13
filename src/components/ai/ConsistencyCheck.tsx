/**
 * 一致性检查 — the chapter read back against the knowledge base.
 *
 * Three decisions shape this screen:
 *
 *   · Every finding is anchored to a verbatim quote, so each card carries real
 *     buttons (跳到原文 / 应用建议) instead of advice. A finding whose passage
 *     can no longer be found in the live document says so and stops offering
 *     to edit it.
 *   · 已通过 is shown, not hidden. "Nothing found" and "didn't look" render
 *     identically otherwise, and a checker you can't calibrate goes unused.
 *   · 更新设定 navigates to the entity rather than rewriting it. The manuscript
 *     is the author's to fix from here; the knowledge base is the thing the
 *     check is measured against, and quietly editing the yardstick from a
 *     verdict about the manuscript is not a change anyone asked to make.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Circle, Crosshair, RotateCw, Square, Wand2,
} from "lucide-react";
import { useTerms } from "../../stores/projectStore";
import { useAppStore } from "../../stores/appStore";
import { useLoreStore } from "../../stores/loreStore";
import { ReasoningControls } from "./ReasoningControls";
import { useEditorStore } from "../../stores/editorStore";
import { openIssues, useConsistencyStore } from "../../stores/consistencyStore";
import { locateQuote, type ConsistencyIssue } from "../../lib/consistency/model";
import { categoryLabel, findCategory } from "../../lib/profile";
import styles from "./ConsistencyCheck.module.css";

const ALL = "__all__";
const TIMELINE = "timeline";

export function ConsistencyCheck() {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const terms = useTerms();
  const setMainView = useAppStore((s) => s.setMainView);
  const openDetail = useLoreStore((s) => s.openDetail);
  const content = useEditorStore((s) => s.content);
  const openFilePath = useEditorStore((s) => s.filePath);

  const {
    report, isScanning, progress, error, resolved,
    scan, abort, ignore, ignoreAll, apply, applyAll, locate,
  } = useConsistencyStore();
  const open = useMemo(() => openIssues(report, resolved), [report, resolved]);

  const [filter, setFilter] = useState<string>(ALL);
  const [showPassed, setShowPassed] = useState(false);

  /** The label for a finding's category — profile wording, never hardcoded. */
  const label = (id: string): string => {
    if (id === TIMELINE) return t("ai.consistency.filter.time", { defaultValue: "时序" });
    const cat = findCategory(id);
    return cat ? categoryLabel(cat, isZh) : id;
  };

  // Only the categories this report actually produced: an empty 物品 tab is a
  // question the author has to click to answer.
  const filters = useMemo(() => {
    const seen: string[] = [];
    for (const issue of open) if (!seen.includes(issue.category)) seen.push(issue.category);
    return [ALL, ...seen];
  }, [open]);

  const visible = filter === ALL ? open : open.filter((i) => i.category === filter);
  const conflicts = open.filter((i) => i.severity === "conflict").length;
  const warnings = open.length - conflicts;
  // Every write path is against the document the report was made on. Once the
  // author moves to another file the findings are still worth reading, but
  // nothing here may touch the manuscript — see reportMatchesOpenDocument.
  const onTarget = !!report && report.filePath === openFilePath;
  const appliable = onTarget ? open.filter((i) => i.suggestion).length : 0;

  const goToEntity = (dirPath: string) => {
    openDetail(dirPath);
    setMainView("lore-wall");
  };

  return (
    <div className={styles.root}>
      <div className={styles.wrap}>
        {report && (
          <div className={styles.stats}>
            <span className={styles.statStrong}>
              {t("ai.consistency.checked", { defaultValue: "{{n}} 项核对", n: report.checkedCount })}
            </span>
            <span className={styles.statSep} />
            <span className={styles.statConflict}>
              {t("ai.consistency.conflictCount", { defaultValue: "{{n}} 冲突", n: conflicts })}
            </span>
            <span className={styles.statWarning}>
              {t("ai.consistency.warningCount", { defaultValue: "{{n}} 提醒", n: warnings })}
            </span>
            <span className={styles.statPass}>
              {t("ai.consistency.passCount", { defaultValue: "{{n}} 一致", n: report.passed.length })}
            </span>
            <span className={styles.statSep} />
            <span>{(report.durationMs / 1000).toFixed(1)}s</span>
          </div>
        )}

        {report && (
          <div className={styles.filterTabs}>
            {filters.map((f) => {
              const n = f === ALL ? open.length : open.filter((i) => i.category === f).length;
              return (
                <button
                  key={f}
                  className={`${styles.filterTab} ${filter === f ? styles.filterTabActive : ""}`}
                  onClick={() => setFilter(f)}
                >
                  {f === ALL ? t("ai.consistency.filter.all", { defaultValue: "全部" }) : label(f)}
                  {n > 0 && <span className={styles.filterTabBadge}>{n}</span>}
                </button>
              );
            })}
            <span className={styles.spacer} />
            <ReasoningControls variant="compact" />
            {isScanning ? (
              <button className={styles.linkBtn} onClick={abort}>
                <Square size={9} fill="currentColor" /> {t("ai.panel.stop")}
              </button>
            ) : (
              <button className={styles.linkBtn} onClick={() => void scan()}>
                <RotateCw size={10} strokeWidth={1.8} />
                {t("ai.consistency.rerun", { defaultValue: "重新检查" })}
              </button>
            )}
          </div>
        )}

        {error && <div className={styles.error}>{error}</div>}

        {report && !onTarget && (
          <div className={styles.staleDoc}>
            {t("ai.consistency.otherDocument", {
              defaultValue: "这份检查针对的是《{{file}}》。切回该{{doc}}才能应用或跳转。",
              file: (report.filePath?.split(/[\\/]/).pop() ?? "").replace(/\.md$/i, "")
                || t("ai.consistency.untitledDoc", { defaultValue: "当前文档" }),
              doc: terms.doc,
            })}
          </div>
        )}

        {isScanning ? (
          <div className={styles.scanning}>
            <span className={styles.spinner} />
            <div className={styles.scanningText}>
              {t("ai.consistency.scanning", { defaultValue: "正在对照{{kb}}核对本{{doc}}…", kb: terms.kb, doc: terms.doc })}
            </div>
            {/* The raw stream, tail-first: on the JSON-fallback path it is the
                only evidence the model is still working. */}
            {progress && <pre className={styles.scanningStream}>{progress.slice(-400)}</pre>}
          </div>
        ) : !report ? (
          <div className={styles.emptyState}>
            <CheckCircle2 size={40} strokeWidth={1.2} color="var(--color-success)" style={{ marginBottom: 16 }} />
            <div className={styles.emptyTitle}>
              {t("ai.consistency.emptyTitle", { defaultValue: "尚未运行一致性检查" })}
            </div>
            <div className={styles.emptyText}>
              {t("ai.consistency.emptyText", {
                defaultValue: "AI 会对照{{kb}}核对本{{doc}}的名称、事实与时序，列出冲突与提醒。",
                kb: terms.kb,
                doc: terms.doc,
              })}
            </div>
            <button className={styles.emptyBtn} onClick={() => void scan()}>
              <Wand2 size={12} style={{ marginRight: 6, verticalAlign: "middle" }} />
              {t("ai.consistency.run", { defaultValue: "开始检查" })}
            </button>
            {/* Also here, not only in the toolbar above: that toolbar only
                exists once a report does, and the run worth tuning is the
                first one — the author shouldn't have to pay for a scan to
                discover the dial. */}
            <div className={styles.emptyDials}>
              <ReasoningControls variant="compact" />
            </div>
          </div>
        ) : visible.length === 0 ? (
          <div className={styles.emptyState}>
            <CheckCircle2 size={40} strokeWidth={1.2} color="var(--color-success)" style={{ marginBottom: 16 }} />
            <div className={styles.emptyTitle}>
              {open.length === 0
                ? t("ai.consistency.allClear", { defaultValue: "没有发现冲突" })
                : t("ai.consistency.noneInFilter", { defaultValue: "该分类下没有条目" })}
            </div>
          </div>
        ) : (
          <div className={styles.issueList}>
            {visible.map((issue) => (
              <IssueCard
                key={issue.id}
                issue={issue}
                docText={content}
                actionable={onTarget}
                categoryLabel={label(issue.category)}
                onLocate={() => locate(issue.id)}
                onApply={() => apply(issue.id)}
                onIgnore={() => ignore(issue.id)}
                onOpenEntity={issue.entityDirPath ? () => goToEntity(issue.entityDirPath!) : undefined}
              />
            ))}
          </div>
        )}

        {/* 已通过 — collapsed, at the bottom, because it is reassurance rather
            than work. Expanding it is how the author audits the scan's reach. */}
        {report && report.passed.length > 0 && (
          <div className={styles.passSummary}>
            <button className={styles.passToggle} onClick={() => setShowPassed((v) => !v)}>
              <span className={styles.passCheck}><CheckCircle2 size={13} strokeWidth={2} /></span>
              <span className={styles.passLabel}>
                {t("ai.consistency.passedTitle", { defaultValue: "已通过 {{n}} 项", n: report.passed.length })}
              </span>
              {!showPassed && (
                <span className={styles.passList}>{report.passed.join(" · ")}</span>
              )}
              <span className={styles.spacer} />
              {showPassed ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
            {showPassed && (
              <div className={styles.passItems}>
                {report.passed.map((p, i) => (
                  <span key={`${p}-${i}`} className={styles.passItem}>{p}</span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {report && (
        <div className={styles.footer}>
          <span className={styles.footerHint}>
            {open.length > 0
              ? t("ai.consistency.footerHint", { defaultValue: "建议先解决冲突，再继续写作" })
              : t("ai.consistency.footerDone", { defaultValue: "本轮的条目都已处理" })}
          </span>
          <button className={styles.actBtnGhost} disabled={open.length === 0} onClick={ignoreAll}>
            {t("ai.consistency.ignoreAll", { defaultValue: "全部忽略" })}
          </button>
          <button
            className={styles.actBtnPrimary}
            disabled={appliable === 0}
            onClick={() => applyAll()}
            title={t("ai.consistency.applyAllHint", {
              defaultValue: "把所有带建议的条目一次写回正文；找不到原文的会跳过",
            })}
          >
            {t("ai.consistency.applyAll", { defaultValue: "应用 {{n}} 项建议", n: appliable })}
          </button>
        </div>
      )}
    </div>
  );
}

function IssueCard({
  issue, docText, actionable, categoryLabel: catLabel, onLocate, onApply, onIgnore, onOpenEntity,
}: {
  issue: ConsistencyIssue;
  docText: string;
  /** False once the author has moved to another document — read-only then. */
  actionable: boolean;
  categoryLabel: string;
  onLocate: () => void;
  onApply: () => boolean;
  onIgnore: () => void;
  onOpenEntity?: () => void;
}) {
  const { t } = useTranslation();
  const terms = useTerms();
  // Re-checked against the live text on every render: the author edits while
  // working the list, and a button that silently no-ops is worse than one that
  // isn't offered.
  const located = useMemo(() => locateQuote(docText, issue.quote) !== null, [docText, issue.quote]);
  const found = actionable && located;
  const conflict = issue.severity === "conflict";

  return (
    <div className={`${styles.issue} ${conflict ? styles.issueConflict : styles.issueWarning}`}>
      <div className={styles.issueHead}>
        <span className={`${styles.severityChip} ${conflict ? styles.sevConflict : styles.sevWarning}`}>
          {conflict
            ? <AlertTriangle size={9} fill="currentColor" strokeWidth={0} />
            : <Circle size={9} fill="currentColor" strokeWidth={0} />}
          {conflict
            ? t("ai.consistency.sevConflict", { defaultValue: "冲突" })
            : t("ai.consistency.sevWarning", { defaultValue: "提醒" })}
        </span>
        <span className={styles.issueTitle}>{issue.title}</span>
        <span className={styles.issueMeta}>
          {catLabel}{issue.entityName ? ` · ${issue.entityName}` : ""}
        </span>
        <span className={styles.spacer} />
        {found && (
          <button className={styles.linkBtn} onClick={onLocate}>
            <Crosshair size={10} strokeWidth={1.8} />
            {t("ai.consistency.jumpToText", { defaultValue: "跳到原文" })}
          </button>
        )}
      </div>

      <div className={styles.row}>
        <span className={styles.rowLabel}>{t("ai.consistency.rowCurrent", { defaultValue: "本文" })}</span>
        <span className={conflict ? styles.highlight : styles.highlightWarn}>{issue.quote}</span>
      </div>
      {issue.reference && (
        <div className={styles.row}>
          <span className={styles.rowLabel}>{terms.kb}</span>
          <span>{issue.reference}</span>
        </div>
      )}
      {issue.suggestion && (
        <div className={styles.row}>
          <span className={styles.rowLabel}>{t("ai.consistency.rowSuggested", { defaultValue: "建议" })}</span>
          <span className={styles.suggestion}>{issue.suggestion}</span>
        </div>
      )}

      {actionable && !located && (
        <div className={styles.staleNote}>
          {t("ai.consistency.quoteGone", {
            defaultValue: "这段原文已找不到（可能已被改写或出现多次），只能手动核对",
          })}
        </div>
      )}

      <div className={styles.actions}>
        {issue.suggestion && found && (
          <button className={styles.actBtnPrimary} onClick={onApply}>
            {t("ai.consistency.applyOne", { defaultValue: "应用建议" })}
          </button>
        )}
        <button className={styles.actBtnGhost} onClick={onIgnore}>
          {t("ai.consistency.ignoreOne", { defaultValue: "忽略 · 这是有意为之" })}
        </button>
        {onOpenEntity && (
          <button className={styles.actBtnSecondary} onClick={onOpenEntity}>
            {t("ai.consistency.updateLore", { defaultValue: "更新{{entry}}", entry: terms.entry })}
          </button>
        )}
      </div>
    </div>
  );
}
