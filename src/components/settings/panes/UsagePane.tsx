import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAiStore } from "../../../stores/aiStore";
import { useProjectStore } from "../../../stores/projectStore";
import {
  clearUsage,
  formatTokenCount,
  formatUsd,
  loadUsage,
  USAGE_WINDOWS,
  type UsageBucket,
  type UsageSummary,
  type UsageWindow,
} from "../../../lib/ai/usage";
import { findTask, taskLabel } from "../../../lib/profile";
import { Pane, PaneHeader, Section, Row, Chip, ChipRow } from "./bits";
import ui from "../settingsUi.module.css";

type Dimension = "model" | "task";

/** `cachedTokens` is a subset of `promptTokens` (see configDb.costFor), so the
 *  "fresh input" column is the difference, not the raw prompt figure. */
function uncached(b: UsageBucket): number {
  return Math.max(0, b.promptTokens - b.cachedTokens);
}

function hitRate(b: UsageBucket): string {
  if (b.promptTokens <= 0) return "—";
  return `${Math.round((b.cachedTokens / b.promptTokens) * 100)}%`;
}

/**
 * What the `token_usage` rows add up to. Project-scoped, like the workspace
 * pane, because that is where the table lives.
 */
export function UsagePane() {
  const { t, i18n: i18nInst } = useTranslation();
  const isZh = i18nInst.language.startsWith("zh");
  const projectPath = useProjectStore((s) => s.projectPath);
  const models = useAiStore((s) => s.models);
  const providers = useAiStore((s) => s.providers);
  const [window, setWindow] = useState<UsageWindow>("30d");
  const [dimension, setDimension] = useState<Dimension>("model");
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
  const modelRow = (id: string): { name: string; sub: string } => {
    const m = models.find((x) => x.id === id) ?? models.find((x) => x.modelId === id);
    if (!m) return { name: id, sub: t("systemSettings.usage.unknownModel") };
    return { name: m.name, sub: providers.find((p) => p.id === m.providerId)?.name ?? "" };
  };

  /**
   * A task id resolves through the active profile, so a run shows the same
   * words the panel that launched it used. The rest are the kinds that are not
   * profile tasks at all (chat, memory summarisation, image runs); anything
   * left — a task id belonging to a profile the project has since switched
   * away from — keeps its raw id, which is still the truth about that row.
   */
  const taskRow = (id: string): { name: string; sub: string } => {
    const task = findTask(id);
    if (task) return { name: taskLabel(task, isZh, t), sub: "" };
    return { name: t(`systemSettings.usage.kinds.${id}`, { defaultValue: id }), sub: "" };
  };

  if (!projectPath) {
    return (
      <Pane width="wide">
        <PaneHeader title={t("systemSettings.tabs.usage")} sub={t("systemSettings.usage.paneSub")} />
        <div className={ui.emptyNote}>{t("systemSettings.usage.noProject")}</div>
      </Pane>
    );
  }

  const total = summary?.total;
  const buckets = summary ? (dimension === "model" ? summary.byModel : summary.byTask) : [];
  const maxCalls = Math.max(1, ...buckets.map((b) => b.calls));
  const label = dimension === "model" ? modelRow : taskRow;

  const cards = total
    ? [
        {
          key: "calls",
          label: t("systemSettings.usage.cards.calls"),
          value: total.calls.toLocaleString("en-US"),
          sub: t(`systemSettings.usage.windows.${window}`),
        },
        {
          key: "input",
          label: t("systemSettings.usage.cards.input"),
          value: formatTokenCount(total.promptTokens),
          sub: t("systemSettings.usage.cards.inputSub", { cached: formatTokenCount(total.cachedTokens) }),
        },
        {
          key: "output",
          label: t("systemSettings.usage.cards.output"),
          value: formatTokenCount(total.completionTokens),
          sub: t("systemSettings.usage.cards.outputSub"),
        },
        {
          key: "hit",
          label: t("systemSettings.usage.cards.hitRate"),
          value: hitRate(total),
          sub: t("systemSettings.usage.cards.hitRateSub"),
        },
        {
          key: "cost",
          label: t("systemSettings.usage.cards.cost"),
          value: formatUsd(total.costUsd),
          sub: t("systemSettings.usage.cards.costSub"),
        },
      ]
    : [];

  return (
    <Pane width="wide">
      <PaneHeader
        title={t("systemSettings.tabs.usage")}
        sub={t("systemSettings.usage.paneSub")}
        action={
          <ChipRow>
            {USAGE_WINDOWS.map((w) => (
              <Chip
                key={w}
                label={t(`systemSettings.usage.windows.${w}`)}
                active={window === w}
                onClick={() => setWindow(w)}
              />
            ))}
          </ChipRow>
        }
      />

      {error && <div className={ui.statusError}>{error}</div>}

      {cards.length > 0 && (
        <div className={ui.statGrid}>
          {cards.map((c) => (
            <div className={ui.statCard} key={c.key}>
              <div className={ui.statLabel}>{c.label}</div>
              <div className={ui.statValue}>{c.value}</div>
              <div className={ui.statSub}>{c.sub}</div>
            </div>
          ))}
        </div>
      )}

      <Section
        label={t("systemSettings.usage.detail")}
        action={
          <ChipRow>
            <Chip label={t("systemSettings.usage.byModel")} active={dimension === "model"} onClick={() => setDimension("model")} />
            <Chip label={t("systemSettings.usage.byTask")} active={dimension === "task"} onClick={() => setDimension("task")} />
          </ChipRow>
        }
      >
        {buckets.length === 0 ? (
          <div className={ui.emptyNote}>{t("systemSettings.usage.empty")}</div>
        ) : (
          <>
            <div className={`${ui.usageGrid} ${ui.usageHead}`}>
              <span>{t("systemSettings.usage.colName")}</span>
              <span>{t("systemSettings.usage.colCalls")}</span>
              <span>{t("systemSettings.usage.colInput")}</span>
              <span className={ui.hideNarrow}>{t("systemSettings.usage.colCached")}</span>
              <span>{t("systemSettings.usage.colOutput")}</span>
              <span className={ui.hideNarrow}>{t("systemSettings.usage.colHitRate")}</span>
              <span>{t("systemSettings.usage.colCost")}</span>
            </div>
            {buckets.map((b) => {
              const { name, sub } = label(b.key);
              return (
                <div className={`${ui.usageGrid} ${ui.usageRow}`} key={b.key}>
                  <div>
                    <div className={ui.usageName}>
                      {name}
                      {sub && <span className={ui.usageSub}>{sub}</span>}
                    </div>
                    <div className={ui.usageBar}>
                      <div
                        className={ui.usageBarFill}
                        style={{ width: `${Math.max(4, Math.round((b.calls / maxCalls) * 100))}%` }}
                      />
                    </div>
                  </div>
                  <span className={ui.usageNum}>{b.calls.toLocaleString("en-US")}</span>
                  <span className={ui.usageNum}>{formatTokenCount(uncached(b))}</span>
                  <span className={`${ui.usageNum} ${ui.usageNumMuted} ${ui.hideNarrow}`}>{formatTokenCount(b.cachedTokens)}</span>
                  <span className={ui.usageNum}>{formatTokenCount(b.completionTokens)}</span>
                  <span className={`${ui.usageNum} ${ui.usageNumMuted} ${ui.hideNarrow}`}>{hitRate(b)}</span>
                  {/* A priced model always bills something, so a zero here means
                      "no price configured" rather than "this run was free". */}
                  <span className={`${ui.usageNum} ${ui.usageNumCost}`}>
                    {b.costUsd > 0 ? formatUsd(b.costUsd) : "—"}
                  </span>
                </div>
              );
            })}
            <div className={ui.usageFootRule} />
            <div className={ui.usageFoot}>{t("systemSettings.usage.footnote")}</div>
          </>
        )}
      </Section>

      <Section label={t("systemSettings.usage.maintenance")}>
        <Row title={t("systemSettings.usage.clear")} desc={t("systemSettings.usage.clearHint")} last>
          <button
            className={ui.rowBtn}
            onClick={handleClear}
            disabled={busy || !summary || summary.total.calls === 0}
          >
            {t("systemSettings.usage.clear")}
          </button>
        </Row>
      </Section>
    </Pane>
  );
}
