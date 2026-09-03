/**
 * 一致性检查 — the document read back against the knowledge base. 设计稿 22.
 *
 * Three moments, one protagonist each: fill the form → watch it check → read
 * the report. Everything else retreats to a line.
 *
 *   · The settings block is the whole panel before the first run and **folds to
 *     one line the moment 开始 is pressed** (locked while running, 「改范围重跑」
 *     after). Folding happens once, at the start, so the end of the run brings
 *     no layout jump; clicking the line re-opens the form *above* the report,
 *     which moves down rather than disappearing.
 *   · No segment strip. With several windows the execution log's header says
 *     「2/4 段核对中 · 1 完成 · 1 等待」 and each window is a card in the log; after
 *     the run the same facts become the report head's coverage band (solid =
 *     checked, hatched = not, square = failed) — which is the face that keeps
 *     「没查」 and 「没问题」 apart.
 *   · Findings appear the moment the checker records them; the log sits above
 *     them as one line, the evidence of "what is it doing now".
 *   · The stats line counts only what was actually checked, and the shortfall
 *     is said in the same line. An empty run is a sentence, not a green tick.
 *
 * Every finding is anchored to a verbatim quote (checked by the tool at record
 * time), so each card carries real buttons. 更新条目 navigates; the manuscript
 * is the author's to fix from here, and the knowledge base is the yardstick.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, ChevronDown, ChevronRight, ChevronUp, Crosshair, X } from "lucide-react";
import { useTerms, useProjectStore } from "../../stores/projectStore";
import { useAppStore } from "../../stores/appStore";
import { useAiStore } from "../../stores/aiStore";
import { useAgentStore } from "../../stores/agentStore";
import { useLoreStore } from "../../stores/loreStore";
import { useMemoryStore } from "../../stores/memoryStore";
import { useEditorStore } from "../../stores/editorStore";
import {
  forecastReview, openIssues, reportMatchesOpenDocument, useConsistencyStore,
} from "../../stores/consistencyStore";
import {
  locateIssue, textNearAnchor,
  type ConsistencyIssue, type ConsistencyPass, type ConsistencyReport, type WindowOutcome,
} from "../../lib/consistency/model";
import { coverageOf } from "../../lib/consistency/merge";
import { MAX_WINDOWS, REVIEW_CONCURRENCY, type ReviewPlan, type ReviewSegmentKey } from "../../lib/consistency/budget";
import { resolveReviewScope, samePin, type ReviewScope } from "../../lib/consistency/scope";
import type { LorePin } from "../../lib/context/loreSelect";
import {
  UNGROUPED, collectionViews, concreteScopeCollections, loreEntityCount, scopeHas, scopeLoreIndex,
  type LoreEntity, type LoreIndex, type LoreScope,
} from "../../lib/lore";
import { categoryLabel, findCategory } from "../../lib/profile";
import { baseName, isSamePath } from "../../lib/paths";
import { MOD_KEY } from "../../lib/platform";
import { AgentLog } from "./AgentLog";
import { SubAgentChips } from "./SubAgentChips";
import { ReasoningControls } from "./ReasoningControls";
import { ScopeMenu, type ScopeMenuAnchor } from "../lore/collections/ScopePicker";
import styles from "./ConsistencyCheck.module.css";

const ALL = "__all__";
const TIMELINE = "timeline";

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 100 || Number.isInteger(k) ? Math.round(k) : k.toFixed(1)}k`;
}

function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function formatChars(n: number): string {
  return n.toLocaleString("en-US");
}

/** A live clock while the run is in flight. */
function useElapsed(since: number | null, live: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live]);
  return since ? (live ? now : Date.now()) - since : 0;
}

function entityByDir(index: LoreIndex, dirPath: string): LoreEntity | undefined {
  for (const list of Object.values(index)) {
    const hit = (list ?? []).find((e) => e.dirPath === dirPath);
    if (hit) return hit;
  }
  return undefined;
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export function ConsistencyCheck() {
  const { t } = useTranslation();
  const terms = useTerms();
  const projectPath = useProjectStore((s) => s.projectPath);
  const content = useEditorStore((s) => s.content);
  const openFilePath = useEditorStore((s) => s.filePath);

  const report = useConsistencyStore((s) => s.report);
  const isScanning = useConsistencyStore((s) => s.isScanning);
  const error = useConsistencyStore((s) => s.error);
  const settingsOpen = useConsistencyStore((s) => s.settingsOpen);
  const startedAt = useConsistencyStore((s) => s.startedAt);
  const scan = useConsistencyStore((s) => s.scan);
  const abort = useConsistencyStore((s) => s.abort);
  const loadScopeFor = useConsistencyStore((s) => s.loadScopeFor);
  const setSettingsOpen = useConsistencyStore((s) => s.setSettingsOpen);

  useEffect(() => { loadScopeFor(projectPath); }, [projectPath, loadScopeFor]);

  const phase: "before" | "running" | "done" = isScanning ? "running" : report ? "done" : "before";
  const elapsed = useElapsed(startedAt, isScanning);

  // ⌘↵ starts, Esc stops — the same keys the composer uses, on the surface
  // that has no composer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isScanning) { e.preventDefault(); abort(); return; }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !isScanning && (phase === "before" || settingsOpen)) {
        e.preventDefault();
        void scan();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isScanning, phase, settingsOpen, scan, abort]);

  if (!openFilePath || !projectPath) {
    return (
      <div className={styles.root}>
        <div className={styles.emptyState}>
          <CheckCircle2 size={36} strokeWidth={1.2} color="var(--color-text-hint)" />
          <div className={styles.emptyTitle}>
            {t("ai.consistency.noDocTitle", { defaultValue: "打开一份{{doc}}，再对着{{kb}}核对它", doc: terms.doc, kb: terms.kb })}
          </div>
          {report && (
            <div className={styles.emptyText}>
              {t("ai.consistency.lastReport", {
                defaultValue: "上次核对：{{file}} · {{conflicts}} 冲突 {{warnings}} 提醒",
                file: baseName(report.filePath ?? ""),
                conflicts: report.issues.filter((i) => i.severity === "conflict").length,
                warnings: report.issues.filter((i) => i.severity === "warning").length,
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.wrap}>
        {phase === "before" ? (
          <SettingsForm docText={content} filePath={openFilePath} />
        ) : settingsOpen && phase === "done" ? (
          <div className={styles.settingsPanel}>
            <div className={styles.settingsPanelHead}>
              <span className={styles.sectionLabel}>
                {t("ai.consistency.settingsHead", { defaultValue: "范围 · 重点 · 段" })}
              </span>
              <span className={styles.sectionRule} />
              <button className={styles.linkBtn} onClick={() => setSettingsOpen(false)}>
                {t("ai.consistency.collapse", { defaultValue: "收起" })} <ChevronUp size={11} />
              </button>
            </div>
            <SettingsForm docText={content} filePath={openFilePath} compact />
            <div className={styles.settingsWarn}>
              {t("ai.consistency.rerunWarn", {
                defaultValue: "重新核对会丢掉这份报告里未处理的卡；已应用的替换留在{{doc}}里。",
                doc: terms.doc,
              })}
            </div>
            <div>
              <button className={styles.btnPrimary} onClick={() => void scan()}>
                {t("ai.consistency.rerun", { defaultValue: "重新核对" })}
              </button>
            </div>
          </div>
        ) : (
          <SettingsLine locked={phase === "running"} />
        )}

        {error && <div className={styles.error}>{error}</div>}

        {phase === "running" && <RunningBody elapsedMs={elapsed} />}
        {phase === "done" && report && <ReportBody report={report} docText={content} openFilePath={openFilePath} />}
      </div>

      <Footer phase={phase} elapsedMs={elapsed} docText={content} />
    </div>
  );
}

// ─── Settings: the form ───────────────────────────────────────────────────────

function SettingsForm({ docText, filePath, compact = false }: { docText: string; filePath: string; compact?: boolean }) {
  const { t } = useTranslation();
  const terms = useTerms();
  const scope = useConsistencyStore((s) => s.scope);
  const focus = useConsistencyStore((s) => s.focus);
  const setScope = useConsistencyStore((s) => s.setScope);
  const setFocus = useConsistencyStore((s) => s.setFocus);
  const report = useConsistencyStore((s) => s.report);
  const index = useLoreStore((s) => s.index);
  const declared = useProjectStore((s) => s.collections);

  const resolved = useMemo(() => resolveReviewScope(scope, index, declared), [scope, index, declared]);
  const plan = useReviewForecast(docText, resolved.effective);

  const lastChecked = report && isSamePath(report.filePath, filePath) ? report : null;

  return (
    <>
      {!compact && (
        <div className={styles.docLine}>
          <span>{t("ai.consistency.docLead", { defaultValue: "核对{{doc}} ·", doc: terms.doc })}</span>
          <span className={styles.docName}>{baseName(filePath)}</span>
          <span className={styles.docMeta}>
            {t("ai.consistency.docChars", { defaultValue: "{{n}} 字", n: formatChars(docText.length) })}
            {lastChecked ? ` · ${t("ai.consistency.lastCheckedAgo", { defaultValue: "上次核对 {{ago}}", ago: formatDuration(Date.now() - (Date.now() - lastChecked.durationMs)) })}` : ""}
          </span>
        </div>
      )}

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionLabel}>{t("ai.consistency.range", { defaultValue: "范围" })}</span>
          <span className={styles.sectionRule} />
          <span className={styles.sectionMeta}><ScopeMeta scope={resolved.effective} index={index} declared={declared} /></span>
        </div>
        <RangeControl scope={scope} resolved={resolved} index={index} declared={declared} onChange={setScope} />
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionLabel}>{t("ai.consistency.focus", { defaultValue: "重点" })}</span>
          <span className={styles.sectionRule} />
          <span className={styles.sectionMeta}>{t("ai.consistency.focusMeta", { defaultValue: "可空 · 空着＝全面核对" })}</span>
        </div>
        <input
          className={styles.focusInput}
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
          placeholder={t("ai.consistency.focusPlaceholder", { defaultValue: "例如：只核对角色外貌 · 文中的数字与日期" })}
        />
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionLabel}>{t("ai.chat.subagentChipsLabel", { defaultValue: "子代理" })}</span>
          <span className={styles.sectionRule} />
          <span className={styles.sectionMeta}>{t("ai.consistency.subagentsMeta", { defaultValue: "只能关" })}</span>
          <ReasoningControls variant="compact" />
        </div>
        <SubAgentChips />
      </div>

      <Allocation plan={plan} docChars={docText.length} />
    </>
  );
}

function useReviewForecast(docText: string, scope: ReviewScope): ReviewPlan {
  const models = useAiStore((s) => s.models);
  const activeModelId = useAiStore((s) => s.activeModelId);
  const subAgents = useAiStore((s) => s.subAgents);
  const disabled = useAgentStore((s) => s.disabledSubAgents);
  const utilization = useAppStore((s) => s.contextUtilization);
  const memory = useMemoryStore((s) => s.memory);
  const index = useLoreStore((s) => s.index);
  // Only the length is a dependency: the forecast reads the text for its
  // chars-per-token sample, and re-planning on every keystroke would be waste.
  const docChars = docText.length;
  return useMemo(
    () => forecastReview(docText, scope),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docChars, scope, models, activeModelId, subAgents, disabled, utilization, memory, index],
  );
}

/** The one-line summary in the range section's head — 已勾 2 · 39 条候选. */
function ScopeMeta({ scope, index, declared }: { scope: ReviewScope; index: LoreIndex; declared: string[] }) {
  const { t } = useTranslation();
  const terms = useTerms();
  const fence = useLoreStore((s) => s.scope);
  if (scope.kind === "all") {
    return <>{t("ai.consistency.candidates", { defaultValue: "{{n}} 条候选", n: loreEntityCount(scopeLoreIndex(index, fence)) })}</>;
  }
  if (scope.kind === "collections") {
    const n = loreEntityCount(scopeLoreIndex(index, scope.names));
    return (
      <>
        {t("ai.consistency.pickedCollections", { defaultValue: "已勾 {{picked}} · {{n}} 条候选", picked: scope.names.length, n })}
      </>
    );
  }
  void declared;
  return <>{t("ai.consistency.pinnedCount", { defaultValue: "{{n}} 条{{entry}}", n: scope.pins.length, entry: terms.entry })}</>;
}

function RangeControl({ scope, resolved, index, declared, onChange }: {
  scope: ReviewScope;
  resolved: ReturnType<typeof resolveReviewScope>;
  index: LoreIndex;
  declared: string[];
  onChange: (scope: ReviewScope) => void;
}) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const terms = useTerms();
  const fence = useLoreStore((s) => s.scope);
  const setMainView = useAppStore((s) => s.setMainView);
  const [menu, setMenu] = useState<ScopeMenuAnchor | null>(null);

  const views = useMemo(() => collectionViews(index, declared), [index, declared]);
  const countOf = (name: string) =>
    name === UNGROUPED ? loreEntityCount(scopeLoreIndex(index, [UNGROUPED])) : views.find((v) => v.name === name)?.count ?? 0;

  const pick = (kind: ReviewScope["kind"]) => {
    if (kind === scope.kind) return;
    onChange(kind === "all" ? { kind: "all" } : kind === "collections" ? { kind: "collections", names: [] } : { kind: "entries", pins: [] });
  };

  const fenceLabel = fence
    ? [...concreteScopeCollections(fence), ...(scopeHas(fence, UNGROUPED) ? [t("lore.collections.ungrouped")] : [])].join(" · ")
    : t("lore.collections.all");
  const total = loreEntityCount(index);
  const fenced = loreEntityCount(scopeLoreIndex(index, fence));

  return (
    <div className={styles.rangeBody}>
      <div className={styles.segmented} role="tablist">
        {(["all", "collections", "entries"] as const).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={scope.kind === k}
            className={`${styles.segment} ${scope.kind === k ? styles.segmentActive : ""}`}
            onClick={() => pick(k)}
          >
            {k === "all"
              ? t("ai.consistency.rangeAll", { defaultValue: "全部" })
              : k === "collections"
                ? t("ai.consistency.rangeCollections", { defaultValue: "集合" })
                : t("ai.consistency.rangeEntries", { defaultValue: "{{entry}}", entry: terms.entry })}
          </button>
        ))}
      </div>

      {scope.kind === "all" && (
        <div className={styles.hint}>
          {t("ai.consistency.followFence", { defaultValue: "跟随取材范围：" })}
          <b>{fenceLabel}</b>
          {" · "}
          <b>{fenced}</b>
          {fence && fenced !== total
            ? ` ${t("ai.consistency.notAllOf", { defaultValue: "条 —— 不是{{kb}}的全部 {{total}} 条", kb: terms.kb, total })}`
            : ` ${t("ai.consistency.entriesUnit", { defaultValue: "条" })}`}
          {"  "}
          <button className={styles.hintLink} onClick={() => setMainView("lore-wall")}>
            {t("ai.consistency.changeInKb", { defaultValue: "在{{kb}}里改 →", kb: terms.kb })}
          </button>
        </div>
      )}

      {scope.kind === "collections" && (
        <>
          <div className={styles.chipRow}>
            {scope.names.map((name) => {
              const stale = resolved.staleCollections.includes(name);
              return (
                <span key={name} className={`${styles.chip} ${stale ? styles.chipStale : ""}`}>
                  {name === UNGROUPED ? t("lore.collections.ungrouped") : name}
                  {!stale && <span className={styles.chipCount}>{countOf(name)}</span>}
                  <button
                    className={styles.chipX}
                    aria-label={t("ai.consistency.removeChip", { defaultValue: "移除" })}
                    onClick={() => onChange({ kind: "collections", names: scope.names.filter((n) => n !== name) })}
                  >
                    <X size={10} />
                  </button>
                </span>
              );
            })}
            <button
              className={styles.chipAdd}
              onClick={(ev) => {
                const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                setMenu({ x: r.left, y: r.bottom + 4 });
              }}
            >
              {t("ai.consistency.addCollection", { defaultValue: "＋ 集合" })}
            </button>
          </div>
          {resolved.staleCollections.length > 0 && (
            <StaleLine
              n={resolved.staleCollections.length}
              text={t("ai.consistency.staleCollections", { defaultValue: "条失效 · 集合已删除，不会计入" })}
              onPurge={() => onChange(resolved.effective.kind === "collections" ? resolved.effective : { kind: "collections", names: [] })}
            />
          )}
          {menu && (
            <ScopeMenu
              index={index}
              declared={declared}
              scope={scope.names.length ? scope.names : null}
              anchor={menu}
              variant="narrow"
              onPick={(next: LoreScope) => onChange({ kind: "collections", names: next ?? [] })}
              onClose={() => setMenu(null)}
            />
          )}
        </>
      )}

      {scope.kind === "entries" && (
        <>
          <div className={styles.chipRow}>
            {scope.pins.map((pin) => {
              const stale = resolved.stalePins.some((s) => samePin(s.pin, pin));
              const entity = entityByDir(index, pin.dirPath);
              const facet = pin.facetFile ? entity?.facets.find((f) => f.file === pin.facetFile)?.title ?? pin.facetFile.replace(/\.md$/i, "") : null;
              const label = entity?.name ?? pin.dirPath.split(/[\\/]/).pop();
              return (
                <span key={`${pin.dirPath}#${pin.facetFile ?? ""}`} className={`${styles.chip} ${stale ? styles.chipStale : ""}`}>
                  @{label}{facet ? ` · ${facet}` : ""}
                  <button
                    className={styles.chipX}
                    aria-label={t("ai.consistency.removeChip", { defaultValue: "移除" })}
                    onClick={() => onChange({ kind: "entries", pins: scope.pins.filter((p) => !samePin(p, pin)) })}
                  >
                    <X size={10} />
                  </button>
                </span>
              );
            })}
            <EntryPicker
              index={index}
              pinned={scope.pins}
              categoryLabel={(id) => { const c = findCategory(id); return c ? categoryLabel(c, isZh) : id; }}
              onPick={(pin) => onChange({ kind: "entries", pins: [...scope.pins, pin] })}
            />
          </div>
          {resolved.stalePins.length > 0 && (
            <StaleLine
              n={resolved.stalePins.length}
              text={t("ai.consistency.stalePins", { defaultValue: "条失效 · {{entry}}被移走或删除，不会计入", entry: terms.entry })}
              onPurge={() => onChange(resolved.effective.kind === "entries" ? resolved.effective : { kind: "entries", pins: [] })}
            />
          )}
        </>
      )}
    </div>
  );
}

function StaleLine({ n, text, onPurge }: { n: number; text: string; onPurge: () => void }) {
  const { t } = useTranslation();
  return (
    <div className={styles.staleLine}>
      <b>{n}</b> {text}
      <button className={`${styles.btnGhost} ${styles.btnSmall}`} onClick={onPurge}>
        {t("ai.consistency.purgeStale", { defaultValue: "剔除失效项" })}
      </button>
    </div>
  );
}

/** Entries picker: an input that lists entries and their facets as you type. */
function EntryPicker({ index, pinned, categoryLabel: label, onPick }: {
  index: LoreIndex;
  pinned: LorePin[];
  categoryLabel: (id: string) => string;
  onPick: (pin: LorePin) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  type Row = { pin: LorePin; name: string; facet: string | null; category: string; taken: boolean };
  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    const out: Row[] = [];
    for (const list of Object.values(index)) {
      for (const e of list ?? []) {
        const hit = !q || e.name.toLowerCase().includes(q) || e.aliases?.some((a) => a.toLowerCase().includes(q));
        if (!hit) continue;
        const base: LorePin = { dirPath: e.dirPath, facetFile: null };
        out.push({ pin: base, name: e.name, facet: null, category: e.category, taken: pinned.some((p) => samePin(p, base)) });
        for (const f of e.facets ?? []) {
          const pin: LorePin = { dirPath: e.dirPath, facetFile: f.file };
          out.push({ pin, name: e.name, facet: f.title, category: e.category, taken: pinned.some((p) => samePin(p, pin)) });
        }
        if (out.length >= 40) return out;
      }
    }
    return out;
  }, [index, query, pinned]);

  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent) => { if (!wrapRef.current?.contains(ev.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open]);

  const choose = (row: Row) => {
    if (row.taken) return;
    onPick(row.pin);
    setQuery("");
    setActive(0);
  };

  return (
    <div className={styles.pickerWrap} ref={wrapRef} style={{ minWidth: 160, flex: 1 }}>
      <input
        className={styles.pickerInput}
        value={query}
        placeholder={t("ai.consistency.addEntry", { defaultValue: "＋ 添加" })}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0); }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(rows.length - 1, i + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
          else if (e.key === "Enter") { e.preventDefault(); if (rows[active]) choose(rows[active]); }
          else if (e.key === "Escape") { setOpen(false); }
        }}
      />
      {open && rows.length > 0 && (
        <div className={styles.pickerList} role="listbox">
          {rows.map((row, i) => (
            <button
              key={`${row.pin.dirPath}#${row.pin.facetFile ?? ""}`}
              className={`${styles.pickerItem} ${i === active ? styles.pickerItemActive : ""}`}
              disabled={row.taken}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(row)}
            >
              <span className={styles.pickerName}>{row.name}</span>
              {row.facet && <span className={styles.pickerFacet}>· {row.facet}</span>}
              <span className={styles.pickerCat}>{label(row.category)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Allocation bar ───────────────────────────────────────────────────────────

const SEGMENT_LABELS: Record<ReviewSegmentKey, { key: string; fallback: string }> = {
  system: { key: "ai.panel.allocSystem", fallback: "系统+工具" },
  input:  { key: "ai.consistency.allocInput", fallback: "原文" },
  lore:   { key: "ai.panel.allocLore", fallback: "{{entry}}" },
  memory: { key: "ai.panel.allocMemory", fallback: "前情" },
  free:   { key: "ai.panel.allocFree", fallback: "余量" },
};

function Allocation({ plan, docChars }: { plan: ReviewPlan; docChars: number }) {
  const { t } = useTranslation();
  const terms = useTerms();
  const label = (key: ReviewSegmentKey) => t(SEGMENT_LABELS[key].key, { defaultValue: SEGMENT_LABELS[key].fallback, entry: terms.entry });
  const tk = (chars: number) => formatTokens(Math.round(chars / plan.charsPerToken));

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionLabel}>{t("ai.panel.contextAllocation", { defaultValue: "上下文分配" })}</span>
        <span className={styles.sectionRule} />
        <span className={styles.sectionMeta}>
          {plan.assumed
            ? t("ai.consistency.unknownWindow", { defaultValue: "未知窗口" })
            : t("ai.consistency.allocMeta", {
                defaultValue: "本次 {{n}} 段 · 并行 {{parallel}} · 每段 ≤ {{tk}} tk",
                n: plan.windowCount,
                parallel: Math.min(REVIEW_CONCURRENCY, plan.windowCount),
                tk: formatTokens(plan.perWindowTokens),
              })}
        </span>
      </div>

      {plan.assumed ? (
        <div className={styles.allocNote}>
          {t("ai.consistency.unknownWindowNote", {
            defaultValue: "这个模型没有声明上下文大小，不能预估段数。将按 {{tk}} 假定值切段；在模型编辑里填上窗口大小，这里就会画条。",
            tk: formatTokens(plan.ceilingTokens),
          })}
        </div>
      ) : (
        <>
          <div className={styles.allocBar}>
            {plan.segments.map((seg) => seg.chars > 0 && (
              <span
                key={seg.key}
                className={`${styles.allocSeg} ${styles[`allocSeg_${seg.key}`]}`}
                style={{ flexGrow: seg.chars }}
                title={`${label(seg.key)} ≈ ${tk(seg.chars)} tk`}
              />
            ))}
          </div>
          <div className={styles.allocLegend}>
            {plan.segments.map((seg) => (
              <span key={seg.key} className={styles.allocLegendItem}>
                <span className={`${styles.allocSwatch} ${styles[`allocSeg_${seg.key}`]}`} />
                {label(seg.key)}
                <span className={styles.allocLegendValue}>{tk(seg.chars)}</span>
              </span>
            ))}
          </div>
          <div className={styles.allocNote}>
            {plan.windowCount > 1
              ? t("ai.consistency.allocSplitNote", {
                  defaultValue: "{{doc}} {{chars}} 字一次装不下，按每段 ≤ {{tk}} tk 切成 {{n}} 段并行核对。缩小范围、或换更大窗口的模型，段数会变。",
                  doc: terms.doc, chars: formatChars(docChars), tk: formatTokens(plan.perWindowTokens), n: plan.windowCount,
                })
              : t("ai.consistency.allocOneNote", {
                  defaultValue: "{{doc}} {{chars}} 字一次装得下，一个运行核对全文。",
                  doc: terms.doc, chars: formatChars(docChars),
                })}
            {plan.uncheckedChars > 0 && (
              <> {t("ai.consistency.allocCapNote", {
                defaultValue: "超过 {{max}} 段上限，后 {{n}} 字不会核对。",
                max: MAX_WINDOWS, n: formatChars(plan.uncheckedChars),
              })}</>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Settings: the folded line ────────────────────────────────────────────────

function useScopeLabel(scope: ReviewScope): { first: string; more: number } {
  const { t } = useTranslation();
  const index = useLoreStore((s) => s.index);
  const fence = useLoreStore((s) => s.scope);
  if (scope.kind === "all") {
    const fenceLabel = fence ? concreteScopeCollections(fence)[0] ?? t("lore.collections.ungrouped") : null;
    return {
      first: fenceLabel
        ? t("ai.consistency.allFollowing", { defaultValue: "全部 · 跟随 {{name}}", name: fenceLabel })
        : t("ai.consistency.rangeAll", { defaultValue: "全部" }),
      more: fence ? Math.max(0, fence.length - 1) : 0,
    };
  }
  if (scope.kind === "collections") {
    const first = scope.names[0];
    return { first: first === UNGROUPED ? t("lore.collections.ungrouped") : first ?? "—", more: Math.max(0, scope.names.length - 1) };
  }
  const first = scope.pins[0];
  const name = first ? entityByDir(index, first.dirPath)?.name ?? first.dirPath.split(/[\\/]/).pop() : "—";
  return { first: `@${name}`, more: Math.max(0, scope.pins.length - 1) };
}

function SettingsLine({ locked }: { locked: boolean }) {
  const { t } = useTranslation();
  const report = useConsistencyStore((s) => s.report);
  const scope = useConsistencyStore((s) => (locked ? s.scope : s.report?.scope ?? s.scope));
  const focus = useConsistencyStore((s) => (locked ? s.focus : s.report?.focus ?? s.focus));
  const windows = useConsistencyStore((s) => s.windows);
  const setSettingsOpen = useConsistencyStore((s) => s.setSettingsOpen);
  const { first, more } = useScopeLabel(scope);
  const n = locked ? windows.length : report?.windows.length ?? windows.length;

  const body = (
    <>
      <span className={styles.settingsItem}>
        <span className={styles.settingsKey}>{t("ai.consistency.range", { defaultValue: "范围" })}</span>
        {first}
        {more > 0 && <span className={styles.settingsPlus}>＋{more}</span>}
      </span>
      <span className={styles.settingsItem}>
        <span className={styles.settingsKey}>{t("ai.consistency.focus", { defaultValue: "重点" })}</span>
        {focus.trim() || t("ai.consistency.focusNone", { defaultValue: "无 · 全面核对" })}
      </span>
      <span className={styles.settingsItem}>
        <span className={styles.settingsKey}>{t("ai.consistency.segments", { defaultValue: "段" })}</span>
        {n > 1
          ? t("ai.consistency.segmentsParallel", { defaultValue: "{{n}} 段 · 并行 {{p}}", n, p: Math.min(REVIEW_CONCURRENCY, n) })
          : t("ai.consistency.segmentsOne", { defaultValue: "1 段" })}
      </span>
      <span className={`${styles.settingsRight} ${locked ? "" : styles.settingsRightAction}`}>
        {locked
          ? t("ai.consistency.lockedNote", { defaultValue: "运行中 · 不可改" })
          : <>{t("ai.consistency.changeAndRerun", { defaultValue: "改范围重跑" })} <ChevronDown size={11} /></>}
      </span>
    </>
  );

  return locked
    ? <div className={styles.settingsLine}>{body}</div>
    : <button className={styles.settingsLine} onClick={() => setSettingsOpen(true)}>{body}</button>;
}

// ─── Running ──────────────────────────────────────────────────────────────────

function windowsHeadline(windows: WindowOutcome[], t: (k: string, o: Record<string, unknown>) => string): string | undefined {
  if (windows.length <= 1) return undefined;
  const running = windows.filter((w) => w.status === "running").length;
  const done = windows.filter((w) => w.status === "done").length;
  const pending = windows.filter((w) => w.status === "pending").length;
  const failed = windows.filter((w) => w.status === "failed").length;
  const parts = [
    t("ai.consistency.headRunning", { defaultValue: "{{k}}/{{n}} 段核对中", k: running, n: windows.length }),
    t("ai.consistency.headDone", { defaultValue: "{{n}} 完成", n: done }),
    pending > 0 ? t("ai.consistency.headPending", { defaultValue: "{{n}} 等待", n: pending }) : "",
    failed > 0 ? t("ai.consistency.headFailed", { defaultValue: "{{n}} 失败", n: failed }) : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function RunningBody({ elapsedMs }: { elapsedMs: number }) {
  const { t } = useTranslation();
  const log = useConsistencyStore((s) => s.log);
  const windows = useConsistencyStore((s) => s.windows);
  const issues = useConsistencyStore((s) => s.liveIssues);
  const passes = useConsistencyStore((s) => s.livePasses);
  const content = useEditorStore((s) => s.content);
  const conflicts = issues.filter((i) => i.severity === "conflict").length;

  return (
    <>
      {log.length > 0 && (
        <AgentLog
          log={log}
          isRunning
          flat
          headline={windowsHeadline(windows, t as never)}
          subRunsLabel={t("ai.consistency.segments", { defaultValue: "段" })}
        />
      )}

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionLabel}>{t("ai.consistency.findings", { defaultValue: "发现" })}</span>
          <span className={styles.sectionRule} />
          <span className={styles.stats} style={{ fontSize: 11 }}>
            {t("ai.consistency.liveCount", { defaultValue: "已记" })} <span className={styles.count}>{issues.length + passes.length}</span> {t("ai.consistency.items", { defaultValue: "项" })} ·{" "}
            <span className={`${styles.count} ${styles.countConflict}`}>{conflicts}</span> {t("ai.consistency.sevConflict", { defaultValue: "冲突" })} ·{" "}
            <span className={`${styles.count} ${styles.countWarning}`}>{issues.length - conflicts}</span> {t("ai.consistency.sevWarning", { defaultValue: "提醒" })} ·{" "}
            <span className={`${styles.count} ${styles.countPass}`}>{passes.length}</span> {t("ai.consistency.passWord", { defaultValue: "通过" })} · {formatClock(elapsedMs)}
          </span>
        </div>
        <div className={styles.issueList}>
          {issues.map((issue) => (
            <IssueCard key={issue.id} issue={issue} docText={content} actionable={false} live />
          ))}
          {passes.map((p, i) => <PassRow key={`${p.label}-${i}`} pass={p} />)}
        </div>
      </div>
    </>
  );
}

function PassRow({ pass }: { pass: ConsistencyPass }) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const cat = pass.entityDirPath ? entityByDir(useLoreStore.getState().index, pass.entityDirPath)?.category : undefined;
  const catDef = cat ? findCategory(cat) : null;
  return (
    <div className={styles.passRow}>
      <span className={styles.countPass}>{t("ai.consistency.passWord", { defaultValue: "通过" })}</span>
      <b>{pass.label}</b>
      {catDef && <span>· {categoryLabel(catDef, isZh)}</span>}
      {pass.entityName && <span>· {pass.entityName}</span>}
      {pass.line && <span className={styles.issueLine}>L{pass.line}</span>}
    </div>
  );
}

// ─── Report ───────────────────────────────────────────────────────────────────

function ReportBody({ report, docText, openFilePath }: { report: ConsistencyReport; docText: string; openFilePath: string }) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const terms = useTerms();
  const setMainView = useAppStore((s) => s.setMainView);
  const openDetail = useLoreStore((s) => s.openDetail);
  const setActiveFilePath = useProjectStore((s) => s.setActiveFilePath);
  const ignored = useConsistencyStore((s) => s.ignored);
  const applied = useConsistencyStore((s) => s.applied);
  const log = useConsistencyStore((s) => s.log);
  const ignore = useConsistencyStore((s) => s.ignore);
  const unignore = useConsistencyStore((s) => s.unignore);
  const apply = useConsistencyStore((s) => s.apply);
  const undoApply = useConsistencyStore((s) => s.undoApply);
  const remove = useConsistencyStore((s) => s.remove);
  const locate = useConsistencyStore((s) => s.locate);
  const locateNear = useConsistencyStore((s) => s.locateNear);
  const rerunWindow = useConsistencyStore((s) => s.rerunWindow);
  const resume = useConsistencyStore((s) => s.resume);
  const scan = useConsistencyStore((s) => s.scan);

  const [filter, setFilter] = useState<string>(ALL);
  const [showPassed, setShowPassed] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const open = useMemo(() => openIssues(report.issues, ignored, applied), [report, ignored, applied]);
  const onTarget = isSamePath(report.filePath, openFilePath);

  const label = useCallback((id: string): string => {
    if (id === TIMELINE) return t("ai.consistency.filter.time", { defaultValue: "时序" });
    const cat = findCategory(id);
    return cat ? categoryLabel(cat, isZh) : id;
  }, [t, isZh]);

  const filters = useMemo(() => {
    const seen: string[] = [];
    for (const issue of open) if (!seen.includes(issue.category)) seen.push(issue.category);
    return [ALL, ...seen];
  }, [open]);
  const visible = filter === ALL ? open : open.filter((i) => i.category === filter);

  const conflicts = report.issues.filter((i) => i.severity === "conflict").length;
  const warnings = report.issues.length - conflicts;
  const doneWindows = report.windows.filter((w) => w.status === "done");
  const failedWindows = report.windows.filter((w) => w.status === "failed");
  const notDone = report.windows.filter((w) => w.status !== "done");
  const coverage = coverageOf(report.windows, report.docChars, report.uncheckedFrom);
  const rounds = report.windows.reduce((n, w) => n + w.rounds, 0);
  const tokens = report.windows.reduce((n, w) => n + w.inputTokens + w.outputTokens, 0);
  const allChecked = notDone.length === 0 && report.uncheckedFrom === null;
  const lastAborted = report.aborted ? report.windows.find((w) => w.status === "aborted" || w.status === "pending") : undefined;

  const goToEntity = (dirPath: string) => { openDetail(dirPath); setMainView("lore-wall"); };
  const { first: scopeFirst, more: scopeMore } = useScopeLabel(report.scope);

  const resolvedIgnored = report.issues.filter((i) => ignored.has(i.id));
  const resolvedApplied = report.issues.filter((i) => applied.has(i.id));

  return (
    <>
      {/* ── Report head ── */}
      <div className={styles.reportHead}>
        <div className={styles.stats}>
          {report.emptyRun ? (
            <>
              <span className={styles.statsNum}>0</span>
              <span>{t("ai.consistency.checkedWord", { defaultValue: "项核对" })} · {t("ai.consistency.emptyStat", { defaultValue: "模型没有记录任何一项" })} · {formatDuration(report.durationMs)}</span>
            </>
          ) : (
            <>
              <span className={styles.statsNum}>{report.checkedCount}</span>
              <span>{t("ai.consistency.checkedWord", { defaultValue: "项核对" })} ·</span>
              <span className={`${styles.statsNum} ${styles.countConflict}`}>{conflicts}</span>
              <span>{t("ai.consistency.sevConflict", { defaultValue: "冲突" })} ·</span>
              <span className={`${styles.statsNum} ${styles.countWarning}`}>{warnings}</span>
              <span>{t("ai.consistency.sevWarning", { defaultValue: "提醒" })} ·</span>
              <span className={`${styles.statsNum} ${styles.countPass}`}>{report.passed.length}</span>
              <span>{t("ai.consistency.consistentWord", { defaultValue: "一致" })}</span>
              {report.uncheckedFrom !== null && (
                <span className={styles.statsTail}>
                  · {t("ai.consistency.tailUnchecked", { defaultValue: "后 {{n}} 字未核对", n: formatChars(report.docChars - report.uncheckedFrom) })}
                </span>
              )}
              {failedWindows.map((w) => (
                <span key={w.index} className={styles.statsTail}>
                  · {t("ai.consistency.windowNotChecked", { defaultValue: "第 {{k}} 段没查", k: w.index + 1 })}
                </span>
              ))}
              {report.aborted && (
                <span className={styles.statsTail}>
                  · {t("ai.consistency.stoppedAt", {
                    defaultValue: "查到第 {{k}}/{{n}} 段时停止",
                    k: (lastAborted?.index ?? report.windows.length - 1) + 1,
                    n: report.windows.length,
                  })}
                </span>
              )}
              <span>· {formatDuration(report.durationMs)}</span>
            </>
          )}
        </div>

        <div className={styles.reportDoc}>
          <b>{baseName(report.filePath ?? "")}</b>
          <span>{t("ai.consistency.docChars", { defaultValue: "{{n}} 字", n: formatChars(report.docChars) })}</span>
          <span className={styles.spacer} />
          <span>
            <span className={styles.settingsKey}>{t("ai.consistency.range", { defaultValue: "范围" })}</span>{" "}
            {scopeFirst}{scopeMore > 0 ? ` ＋${scopeMore}` : ""}
            {" · "}
            <span className={styles.settingsKey}>{t("ai.consistency.focus", { defaultValue: "重点" })}</span>{" "}
            {report.focus.trim() || t("ai.consistency.focusNoneShort", { defaultValue: "无" })}
          </span>
        </div>

        <div className={styles.coverage} title={t("ai.consistency.coverageTitle", { defaultValue: "实心＝核对过 · 斜纹＝没查 · 方块＝失败" })}>
          {coverage.spans.map((s, i) => (
            <span
              key={i}
              className={`${styles.coverageSeg} ${styles[`coverage_${s.status}`]}`}
              style={{ flexGrow: Math.max(1, s.to - s.from) }}
            />
          ))}
        </div>
        <div className={styles.coverageLine}>
          <span>
            {allChecked
              ? t("ai.consistency.coverageAll", { defaultValue: "{{n}}/{{n}} 段 · 全文已核对", n: report.windows.length })
              : t("ai.consistency.coveragePart", { defaultValue: "{{k}}/{{n}} 段", k: doneWindows.length, n: report.windows.length })}
          </span>
          {report.uncheckedFrom !== null && !report.aborted && (
            <span>
              {t("ai.consistency.coverageChecked", { defaultValue: "前 {{n}} 字已核对", n: formatChars(report.uncheckedFrom) })}
            </span>
          )}
          <span className={styles.spacer} />
          <span>{t("ai.consistency.roundsTokens", { defaultValue: "{{r}} 轮 · {{tk}} tk", r: rounds, tk: formatTokens(tokens) })}</span>
        </div>

        {report.emptyRun && (
          <div className={styles.emptyRun}>
            <div className={styles.emptyRunText}>
              {t("ai.consistency.emptyRunText", {
                defaultValue: "这次没查成，不是没问题。模型读了{{doc}}和{{entry}}，但全程没有调用「记录发现」——换一个会调工具的模型再试。",
                doc: terms.doc, entry: terms.entry,
              })}
            </div>
            <div className={styles.emptyRunActions}>
              <button className={styles.btnSecondary} onClick={() => void scan()}>
                {t("ai.consistency.retry", { defaultValue: "重试" })}
              </button>
              <button className={styles.btnGhost} onClick={() => setShowLog((v) => !v)}>
                {t("ai.consistency.viewLog", { defaultValue: "看日志" })}
              </button>
            </div>
          </div>
        )}

        {failedWindows.map((w) => (
          <div key={w.index} className={styles.failedLine}>
            <b>{t("ai.consistency.windowN", { defaultValue: "第 {{k}} 段", k: w.index + 1 })}</b>
            <span>
              {w.error ?? t("ai.consistency.failedWord", { defaultValue: "失败" })} · {t("ai.consistency.windowRange", {
                defaultValue: "第 {{from}}–{{to}} 字这一截没查", from: formatChars(w.from + 1), to: formatChars(w.to),
              })}
            </span>
            <span className={styles.spacer} />
            <button className={`${styles.btnSecondary} ${styles.btnSmall}`} onClick={() => void rerunWindow(w.index)}>
              {t("ai.consistency.rerunWindow", { defaultValue: "重跑第 {{k}} 段", k: w.index + 1 })}
            </button>
          </div>
        ))}

        {(report.aborted || (report.uncheckedFrom !== null && failedWindows.length === 0)) && !report.emptyRun && (
          <div>
            <button className={styles.linkBtn} onClick={() => void resume()}>
              {report.aborted
                ? t("ai.consistency.resumeFromStop", { defaultValue: "从停下的地方继续 →" })
                : t("ai.consistency.resumeFromCap", { defaultValue: "从第 {{n}} 字起 · 再跑一次 →", n: formatChars((report.uncheckedFrom ?? 0) + 1) })}
            </button>
          </div>
        )}

        {!report.emptyRun && doneWindows.some((w) => w.summary) && (
          <div className={styles.summary}>
            {doneWindows.filter((w) => w.summary).map((w) => (
              <div key={w.index} className={styles.summaryRow}>
                {report.windows.length > 1 && (
                  <span className={styles.summaryTag}>{t("ai.consistency.windowN", { defaultValue: "第 {{k}} 段", k: w.index + 1 })}</span>
                )}
                <span>{w.summary}</span>
              </div>
            ))}
          </div>
        )}

        {log.length > 0 && (
          <>
            <button className={styles.logLine} onClick={() => setShowLog((v) => !v)} aria-expanded={showLog}>
              {showLog ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              {t("ai.agent.log.title")}
              <span className={styles.logLineMeta}>
                {t("ai.consistency.logMeta", { defaultValue: "{{n}} 段 · {{r}} 轮", n: report.windows.length, r: rounds })}
              </span>
            </button>
            {showLog && (
              <AgentLog log={log} isRunning={false} flat subRunsLabel={t("ai.consistency.segments", { defaultValue: "段" })} />
            )}
          </>
        )}
      </div>

      {!onTarget && (
        <div className={styles.readonlyBar}>
          {t("ai.consistency.readonlyLead", { defaultValue: "这份检查针对的是" })} <b>{baseName(report.filePath ?? "")}</b>
          <span className={styles.spacer} />
          {report.filePath && (
            <button
              className={styles.linkBtn}
              onClick={() => {
                // The editor only loads files while it is the visible view
                // (see CommandPalette.openDocument for the same two steps).
                setActiveFilePath(report.filePath!);
                setMainView("editor");
              }}
            >
              {t("ai.consistency.openIt", { defaultValue: "打开它 →" })}
            </button>
          )}
          <button className={styles.linkBtn} onClick={() => void scan()}>
            {t("ai.consistency.checkCurrent", { defaultValue: "核对当前{{doc}}", doc: terms.doc })}
          </button>
        </div>
      )}

      {/* ── Filters + cards ── */}
      {!report.emptyRun && open.length > 0 && (
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
        </div>
      )}

      {!report.emptyRun && (
        <div className={styles.issueList}>
          {visible.map((issue) => (
            <IssueCard
              key={issue.id}
              issue={issue}
              docText={docText}
              actionable={onTarget}
              showWindow={report.windows.length > 1}
              onLocate={() => locate(issue.id)}
              onLocateNear={() => locateNear(issue.id)}
              onApply={() => apply(issue.id)}
              onIgnore={() => ignore(issue.id)}
              onRemove={() => remove(issue.id)}
              onOpenEntity={issue.entityDirPath ? () => goToEntity(issue.entityDirPath!) : undefined}
            />
          ))}
          {open.length === 0 && (
            <div className={styles.emptyState} style={{ padding: "28px 24px" }}>
              <CheckCircle2 size={32} strokeWidth={1.2} color={report.passed.length > 0 ? "var(--color-success)" : "var(--color-text-hint)"} />
              <div className={styles.emptyTitle}>
                {report.issues.length === 0
                  ? report.passed.length > 0
                    ? t("ai.consistency.allClear", { defaultValue: "没有发现冲突" })
                    : t("ai.consistency.nothingRecorded", { defaultValue: "没有记录到任何一项" })
                  : t("ai.consistency.allHandled", { defaultValue: "本轮的卡都已处理" })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Resolved rows ── */}
      {(resolvedIgnored.length > 0 || resolvedApplied.length > 0) && (
        <div className={styles.resolved}>
          {resolvedApplied.map((issue) => (
            <div key={issue.id} className={styles.resolvedRow}>
              <span className={styles.resolvedTag}>{t("ai.consistency.appliedTag", { defaultValue: "已应用" })}</span>
              <span className={styles.resolvedTitle}>{issue.title}</span>
              {issue.suggestion && (
                <span>「<span className={styles.replaceFrom}>{issue.quote}</span>」→「<span className={styles.replaceTo}>{issue.suggestion}</span>」</span>
              )}
              {issue.line && <span className={styles.issueLine}>L{issue.line}</span>}
              <span className={styles.spacer} />
              <button className={styles.linkBtn} disabled={!onTarget} onClick={() => undoApply(issue.id)}>
                {t("ai.consistency.undo", { defaultValue: "撤销" })}
              </button>
            </div>
          ))}
          {resolvedIgnored.map((issue) => (
            <div key={issue.id} className={styles.resolvedRow}>
              <span className={styles.resolvedTag}>{t("ai.consistency.ignoredTag", { defaultValue: "已忽略" })}</span>
              <span className={styles.resolvedTitle}>{issue.title}</span>
              <span>{label(issue.category)}{issue.entityName ? ` · ${issue.entityName}` : ""}</span>
              {issue.line && <span className={styles.issueLine}>L{issue.line}</span>}
              <span className={styles.spacer} />
              <button className={styles.linkBtn} onClick={() => unignore(issue.id)}>
                {t("ai.consistency.undo", { defaultValue: "撤销" })}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── 已通过 — reassurance, not work; expanding it audits the reach ── */}
      {report.passed.length > 0 && (
        <div className={styles.passSummary}>
          <button className={styles.passToggle} onClick={() => setShowPassed((v) => !v)} aria-expanded={showPassed}>
            <span className={styles.passCheck}><CheckCircle2 size={13} strokeWidth={2} /></span>
            <span className={styles.passLabel}>
              {t("ai.consistency.passedTitle", { defaultValue: "已通过 {{n}} 项", n: report.passed.length })}
            </span>
            {!showPassed && <span className={styles.passList}>{report.passed.map((p) => p.label).join(" · ")}</span>}
            <span className={styles.spacer} />
            {showPassed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          {showPassed && (
            <div className={styles.passItems}>
              {report.passed.map((p, i) => (
                <span key={`${p.label}-${i}`} className={styles.passItem}>
                  {p.entityName ? <><b>{p.entityName}</b> · {p.label}</> : <b>{p.label}</b>}
                  {p.line && <span className={styles.issueLine}>L{p.line}</span>}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ─── Card ─────────────────────────────────────────────────────────────────────

function IssueCard({
  issue, docText, actionable, live = false, showWindow = false,
  onLocate, onLocateNear, onApply, onIgnore, onRemove, onOpenEntity,
}: {
  issue: ConsistencyIssue;
  docText: string;
  /** False once the author has moved to another document — read-only then. */
  actionable: boolean;
  /** In the findings stream during a run: no buttons yet. */
  live?: boolean;
  showWindow?: boolean;
  onLocate?: () => void;
  onLocateNear?: () => void;
  onApply?: () => boolean;
  onIgnore?: () => void;
  onRemove?: () => void;
  onOpenEntity?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const terms = useTerms();
  // Re-checked against the live text on every render: the author edits while
  // working the list, and a button that silently no-ops is worse than one that
  // isn't offered.
  const located = useMemo(() => locateIssue(docText, issue) !== null, [docText, issue]);
  const gone = actionable && !located;
  const conflict = issue.severity === "conflict";
  const cat = findCategory(issue.category);
  const catLabel = issue.category === TIMELINE
    ? t("ai.consistency.filter.time", { defaultValue: "时序" })
    : cat ? categoryLabel(cat, isZh) : issue.category;
  const near = gone ? textNearAnchor(docText, issue) : null;

  return (
    <div className={`${styles.issue} ${gone ? styles.issueGone : conflict ? styles.issueConflict : styles.issueWarning} ${!actionable && !live ? styles.issueReadonly : ""}`}>
      <div className={styles.issueHead}>
        <span className={`${styles.sev} ${gone ? styles.sevGone : conflict ? styles.sevConflict : styles.sevWarning}`}>
          {conflict ? t("ai.consistency.sevConflict", { defaultValue: "冲突" }) : t("ai.consistency.sevWarning", { defaultValue: "提醒" })}
        </span>
        <span className={styles.issueTitle}>{issue.title}</span>
        <span className={styles.issueMeta}>
          {catLabel}{issue.entityName ? <> · <b>{issue.entityName}</b></> : null}
        </span>
        <span className={styles.issueLine}>
          {showWindow && issue.window !== undefined ? `${t("ai.consistency.windowN", { defaultValue: "第 {{k}} 段", k: issue.window + 1 })} · ` : ""}
          {gone
            ? t("ai.consistency.wasAtLine", { defaultValue: "曾在 L{{n}}", n: issue.line ?? "?" })
            : issue.line ? `L${issue.line}` : ""}
        </span>
      </div>

      <div className={styles.row}>
        <span className={styles.rowLabel}>{t("ai.consistency.rowCurrent", { defaultValue: "本文" })}</span>
        <span className={styles.rowText}>
          {gone
            ? <span className={styles.quoteGone}>{issue.quote}</span>
            : <span className={conflict ? styles.quoteMark : styles.quoteMarkWarn}>{issue.quote}</span>}
        </span>
      </div>
      {issue.reference && (
        <div className={styles.row}>
          <span className={styles.rowLabel}>{terms.kb}</span>
          <span className={styles.rowRef}>
            {issue.entityName && <><b>{issue.entityName}</b> · </>}{issue.reference}
          </span>
        </div>
      )}
      {issue.suggestion && !gone && (
        <div className={styles.row}>
          <span className={styles.rowLabel}>{t("ai.consistency.rowSuggested", { defaultValue: "建议" })}</span>
          <span className={styles.rowSuggest}>
            「<span className={styles.replaceFrom}>{issue.quote}</span>」→「<span className={styles.replaceTo}>{issue.suggestion}</span>」
          </span>
        </div>
      )}

      {gone && (
        <div className={styles.goneNote}>
          {t("ai.consistency.quoteGoneLead", { defaultValue: "这句原文已找不到——核对之后你改过它。" })}
          {near && <> {t("ai.consistency.quoteGoneNear", { defaultValue: "附近现在是「" })}<b>{near}</b>」。</>}
        </div>
      )}

      {!live && (
        <div className={styles.actions}>
          {gone ? (
            <>
              {onLocateNear && (
                <button className={styles.linkBtn} onClick={onLocateNear}>
                  <Crosshair size={10} strokeWidth={1.8} /> {t("ai.consistency.jumpNear", { defaultValue: "跳到附近 ↗" })}
                </button>
              )}
              <span className={styles.spacer} />
              <button className={styles.btnGhost} onClick={onRemove}>{t("ai.consistency.remove", { defaultValue: "移除" })}</button>
            </>
          ) : (
            <>
              {issue.suggestion && (
                <button className={actionable ? styles.btnPrimary : styles.btnSecondary} disabled={!actionable} onClick={onApply}>
                  {t("ai.consistency.applyOne", { defaultValue: "应用建议" })}
                </button>
              )}
              <button className={styles.btnGhost} disabled={!actionable} onClick={onIgnore}>
                {t("ai.consistency.ignoreOne", { defaultValue: "忽略 · 这是有意为之" })}
              </button>
              {onOpenEntity && (
                <button className={styles.btnSecondary} onClick={onOpenEntity}>
                  {t("ai.consistency.updateLore", { defaultValue: "更新{{entry}}", entry: terms.entry })}
                </button>
              )}
              <span className={styles.spacer} />
              <button className={styles.linkBtn} disabled={!actionable} onClick={onLocate}>
                <Crosshair size={10} strokeWidth={1.8} /> {t("ai.consistency.jumpToText", { defaultValue: "跳到原文" })} ↗
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Footer ───────────────────────────────────────────────────────────────────

function Footer({ phase, elapsedMs, docText }: { phase: "before" | "running" | "done"; elapsedMs: number; docText: string }) {
  const { t } = useTranslation();
  const report = useConsistencyStore((s) => s.report);
  const ignored = useConsistencyStore((s) => s.ignored);
  const applied = useConsistencyStore((s) => s.applied);
  const windows = useConsistencyStore((s) => s.windows);
  const log = useConsistencyStore((s) => s.log);
  const scan = useConsistencyStore((s) => s.scan);
  const abort = useConsistencyStore((s) => s.abort);
  const ignoreAll = useConsistencyStore((s) => s.ignoreAll);
  const applyAll = useConsistencyStore((s) => s.applyAll);
  const scope = useConsistencyStore((s) => s.scope);
  const index = useLoreStore((s) => s.index);
  const declared = useProjectStore((s) => s.collections);
  const activeModelId = useAiStore((s) => s.activeModelId);
  const resolvedScope = useMemo(() => resolveReviewScope(scope, index, declared).effective, [scope, index, declared]);
  const plan = useReviewForecast(docText, resolvedScope);

  if (phase === "before") {
    return (
      <div className={styles.footer}>
        <span className={styles.footerMeta}>
          {t("ai.consistency.forecastInput", { defaultValue: "预计输入" })}{" "}
          <b>{plan.windowCount > 1 ? `${plan.windowCount} × ` : ""}{formatTokens(plan.perWindowTokens)} tk</b>
        </span>
        <span className={styles.footerHint}>
          {t("ai.consistency.footerBefore", { defaultValue: "上限 {{max}} 段 · 只读不写", max: MAX_WINDOWS })}
        </span>
        <button className={styles.btnPrimary} disabled={!activeModelId || !docText.trim()} onClick={() => void scan()}>
          {t("ai.consistency.run", { defaultValue: "开始核对" })}
          <span className={styles.kbd}>{MOD_KEY === "⌘" ? "⌘↵" : "Ctrl ↵"}</span>
        </button>
      </div>
    );
  }

  if (phase === "running") {
    const done = windows.filter((w) => w.status === "done").length;
    const round = (() => {
      for (let i = log.length - 1; i >= 0; i--) {
        const e = log[i];
        if (e.kind === "round-start" && !e.parentStep) return e.round;
        if (e.kind === "round-start" && windows.length <= 1) return e.round;
      }
      return null;
    })();
    return (
      <div className={styles.footer}>
        <span className={styles.runningNote}>
          <span className={styles.runningPips}><span /><span /><span /></span>
          {t("ai.consistency.runningNote", { defaultValue: "正在核对" })} · {formatClock(elapsedMs)}
          {windows.length > 1
            ? ` · ${t("ai.consistency.windowsDone", { defaultValue: "{{k}}/{{n}} 段完成", k: done, n: windows.length })}`
            : round ? ` · ${t("ai.consistency.roundN", { defaultValue: "第 {{n}} 轮", n: round })}` : ""}
        </span>
        <span className={styles.footerHint}>
          {t("ai.consistency.escHint", { defaultValue: "Esc 停止 · 已记的发现保留" })}
        </span>
        <button className={styles.stopBtn} onClick={abort} aria-label={t("ai.panel.stop")} title={t("ai.panel.stop")}>
          <span />
        </button>
      </div>
    );
  }

  const onTarget = reportMatchesOpenDocument(report);
  const open = report ? openIssues(report.issues, ignored, applied) : [];
  const appliable = onTarget ? open.filter((i) => i.suggestion).length : 0;
  return (
    <div className={styles.footer}>
      <span className={styles.footerHint}>
        {!onTarget
          ? t("ai.consistency.readonlyHint", { defaultValue: "只读 · 切回那份文档才能应用或跳转" })
          : open.length > 0
            ? t("ai.consistency.footerHint", { defaultValue: "只读 · 应用建议是你在卡上点的一次替换" })
            : t("ai.consistency.footerDone", { defaultValue: "本轮的卡都已处理" })}
      </span>
      <button className={styles.btnGhost} disabled={open.length === 0} onClick={ignoreAll}>
        {t("ai.consistency.ignoreAll", { defaultValue: "全部忽略" })}
      </button>
      <button
        className={styles.btnPrimary}
        disabled={appliable === 0}
        onClick={() => applyAll()}
        title={t("ai.consistency.applyAllHint", { defaultValue: "把所有带建议的卡一次写回正文；找不到原文的会跳过" })}
      >
        {t("ai.consistency.applyAll", { defaultValue: "应用 {{n}} 项建议", n: appliable })}
      </button>
    </div>
  );
}
