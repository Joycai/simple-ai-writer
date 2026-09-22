import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAiStore } from "../../../stores/aiStore";
import { useProjectStore } from "../../../stores/projectStore";
import {
  clearUsage,
  formatTokenCount,
  formatUsd,
  groupBuckets,
  loadUsage,
  sortUsageBuckets,
  USAGE_WINDOWS,
  type UsageBucket,
  type UsageScope,
  type UsageSortKey,
  type UsageSummary,
  type UsageWindow,
} from "../../../lib/ai/usage";
import { meterSegments, type UsageMeter, type UsageSegKey } from "../../../lib/ai/usageMeter";
import { feeSummary } from "../../../lib/ai/feeGroupLabel";
import { useFeeLabelWords } from "./feeWords";
import { baseName } from "../../../lib/paths";
import { findTask, taskLabel, taskPackLabel } from "../../../lib/profile";
import { Pane, PaneHeader, Section, Row, Chip, ChipRow } from "./bits";
import ui from "../settingsUi.module.css";

/**
 * 明细按什么卷。`group` 是这一轮新加的那一维——价格从模型搬到组之后，
 * 「这个月哪一类支出最大」问的是组，不是模型。
 *
 * `project` 只在总体范围下有意义：项目库里每一行都是这个项目的。
 */
type Dimension = "group" | "model" | "task" | "project";

/** `cachedTokens` is a subset of `promptTokens` (see configDb.costFor), so the
 *  "fresh input" column is the difference, not the raw prompt figure. */
function uncached(b: UsageBucket): number {
  return Math.max(0, b.promptTokens - b.cachedTokens);
}

/**
 * 段 → 类名。**静态字面量，不是 `ui[`usageSeg_${key}`]`**：
 * `cssModuleClassRefs.test.ts` 对模板字符串下标完全失明，那样写打错一个字
 * 不会报错，只会在界面上悄悄没有样式。
 */
const SEG_CLASS: Record<UsageSegKey, string> = {
  input: ui.usageSegInput,
  cache: ui.usageSegCache,
  output: ui.usageSegOutput,
  count: ui.usageSegCount,
  duration: ui.usageSegDuration,
  other: ui.usageSegOther,
  unsplit: ui.usageSegUnsplit,
};

/** 占比写成整数百分比。渲染出来的段不能在文字里说自己是 0。 */
function pctText(share: number): string {
  const pct = Math.round(share * 100);
  return pct < 1 ? "<1%" : `${pct}%`;
}

function hitRate(b: UsageBucket): string {
  if (b.promptTokens <= 0) return "—";
  return `${Math.round((b.cachedTokens / b.promptTokens) * 100)}%`;
}

/**
 * 两本账加起来是多少 — 设计稿 05l 屏 1f / 1g。
 *
 * **本项目**读项目文件夹里的 `.ai-writer/project.db`，跟着项目走；**全部**
 * 读应用数据目录里的 `config.db`，比任何一个项目活得久。切范围就是换一个
 * 库（`lib/ai/usage` 的 `UsageScope`），不是在同一张表上加个过滤条件。
 *
 * 「按计费组」那一维不看行上的快照，而是问模型**现在**绑着哪个组：重新
 * 分组之后历史跟着走。行上快照的是**价**，不是归属。
 */
export function UsagePane({ onOpenFees }: { onOpenFees?: () => void } = {}) {
  const { t, i18n: i18nInst } = useTranslation();
  const isZh = i18nInst.language.startsWith("zh");
  const projectPath = useProjectStore((s) => s.projectPath);
  const models = useAiStore((s) => s.models);
  const providers = useAiStore((s) => s.providers);
  const feeGroups = useAiStore((s) => s.feeGroups);
  const words = useFeeLabelWords();
  const [scope, setScope] = useState<UsageScope>("project");
  const [window, setWindow] = useState<UsageWindow>("30d");
  const [dimension, setDimension] = useState<Dimension>("group");
  // Cost-descending is the default the lib already ordered rows by, so the
  // first render is unchanged until the author clicks a column.
  const [sort, setSort] = useState<{ key: UsageSortKey; dir: "asc" | "desc" }>({
    key: "cost",
    dir: "desc",
  });
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 总体那份不需要开着项目：它正是「项目删了、移走了，这一年花了多少还在」
  // 的那本账。只有本项目那一份要项目在。
  useEffect(() => {
    if (scope === "project" && !projectPath) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    setBusy(true);
    setError(null);
    loadUsage(scope, projectPath, window)
      .then((s) => { if (!cancelled) setSummary(s); })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [scope, projectPath, window]);

  // 「按项目」在本项目范围下永远只有一行——切回去时把维度带回来，免得
  // 作者看到一个只有一行、还是自己的表。
  useEffect(() => {
    if (scope === "project" && dimension === "project") setDimension("group");
  }, [scope, dimension]);

  /**
   * 清的永远是当前范围那一份。
   *
   * 清掉一个项目的记录不是在说「这半年我没花过钱」，所以本项目那次清除不
   * 碰总账；要清总账得先切到「全部」再清一次，那是另一次确认。
   */
  const handleClear = async () => {
    if (busy) return;
    const key = scope === "global" ? "clearConfirmGlobal" : "clearConfirm";
    if (!globalThis.confirm(t(`systemSettings.usage.${key}`))) return;
    setBusy(true);
    try {
      await clearUsage(scope, scope === "global" ? null : projectPath);
      setSummary(await loadUsage(scope, projectPath, window));
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
    // A secondary pack's task names its pack, matching the grouped task menu.
    if (task) return { name: taskLabel(task, isZh, t), sub: taskPackLabel(task, isZh) ?? "" };
    return { name: t(`systemSettings.usage.kinds.${id}`, { defaultValue: id }), sub: "" };
  };

  /**
   * 计费组那一行。归属取自模型**现在**绑着的组，不是行上的快照——重新分组
   * 之后历史跟着走，这是故意的（行上快照的是价，不是归属）。
   *
   * 已经删掉的组、没绑组的模型，都落进空 key 那个桶，写「未绑定」。
   */
  const groupRow = (id: string): { name: string; sub: string } => {
    const g = feeGroups.find((x) => x.id === id);
    if (!g) return { name: t("aiConfig.fees.unbound"), sub: t("systemSettings.usage.unboundSub") };
    return { name: g.name || t("aiConfig.fees.untitled"), sub: feeSummary(g, words) };
  };

  /** 总体那份才有：路径是身份，名字只是它的尾巴。 */
  const projectRow = (path: string): { name: string; sub: string } => {
    if (!path) return { name: t("systemSettings.usage.unknownProject"), sub: "" };
    return { name: baseName(path) || path, sub: path };
  };

  if (scope === "project" && !projectPath) {
    return (
      <Pane width="wide">
        <PaneHeader title={t("systemSettings.tabs.usage")} sub={t("systemSettings.usage.paneSub")} />
        <div className={ui.emptyNote}>{t("systemSettings.usage.noProjectScoped")}</div>
        <Section label={t("systemSettings.usage.scope")}>
          <Row title={t("systemSettings.usage.scopes.global")} desc={t("systemSettings.usage.scopeGlobalSub")} last>
            <button className={ui.rowBtn} onClick={() => setScope("global")}>
              {t("systemSettings.usage.switchToGlobal")}
            </button>
          </Row>
        </Section>
      </Pane>
    );
  }

  const total = summary?.total;
  const feeGroupIdOf = (modelId: string) =>
    (models.find((x) => x.id === modelId) ?? models.find((x) => x.modelId === modelId))?.feeGroupId;
  const rawBuckets = !summary
    ? []
    : dimension === "group"
      ? groupBuckets(summary.byModel, feeGroupIdOf)
      : dimension === "model"
        ? summary.byModel
        : dimension === "project"
          ? summary.byProject
          : summary.byTask;
  const label =
    dimension === "group" ? groupRow
      : dimension === "model" ? modelRow
        : dimension === "project" ? projectRow
          : taskRow;
  const buckets = sortUsageBuckets(rawBuckets, sort.key, sort.dir, (k) => label(k).name);
  const maxCalls = Math.max(1, ...buckets.map((b) => b.calls));

  const segLabel = (k: UsageSegKey) => t(`systemSettings.usage.seg.${k}`);

  /** 一段的 tooltip：维度 · 金额（或 token 数）· 占比。 */
  const segTip = (m: UsageMeter, key: UsageSegKey, value: number, share: number) =>
    m.mode === "cost"
      ? t("systemSettings.usage.segTip.cost", {
          label: segLabel(key), amount: formatUsd(value), pct: pctText(share),
        })
      : t("systemSettings.usage.segTip.token", {
          label: segLabel(key), tokens: formatTokenCount(value), pct: pctText(share),
        });

  /**
   * 整条的 tooltip：细到没法 hover 的段、以及调用少的短条，都靠它兜底。
   * `parts` 按**占比降序**拼，不按段序——这里回答的是「主要花在哪」。
   */
  const barTip = (m: UsageMeter) => {
    if (m.mode === "none") return t("systemSettings.usage.segTip.barNone");
    const parts = [...m.segments]
      .sort((a, b) => b.share - a.share)
      .map((s) => `${segLabel(s.key)} ${pctText(s.share)}`)
      .join(" · ");
    const head = t(
      m.mode === "cost" ? "systemSettings.usage.segTip.barCost" : "systemSettings.usage.segTip.barToken",
      { parts },
    );
    // 整条灰的时候必须说清楚这是「没有分项」而不是「出错了」。
    return m.hasUnsplit ? `${head}\n${t("systemSettings.usage.segTip.unsplitNote")}` : head;
  };

  /**
   * 条：长度是调用次数相对同批最大值，颜色是这笔钱花在哪一种量上。
   *
   * 地板 12% 而不是 4%：150px × 4% = 6px，6px 里塞不下两段——颜色这个通道
   * 在那种短条上等于不存在。抬到 18px 才够放下两三段。代价是 4%–12% 之间的
   * 长度差别被压平，调用很少的几行彼此不再区分长短，这是知道并且认了的。
   */
  const meterBar = (b: UsageBucket) => {
    const m = meterSegments(b);
    return (
      <div className={ui.usageBarWrap} role="img" aria-label={barTip(m)} title={barTip(m)}>
        <div className={ui.usageBar}>
          <div
            className={ui.usageBarFill}
            style={{ width: `${Math.max(12, Math.round((b.calls / maxCalls) * 100))}%` }}
          >
            {m.segments.map((s) => (
              <span
                key={s.key}
                className={`${ui.usageSeg} ${SEG_CLASS[s.key]}`}
                style={{ flexGrow: s.share }}
                title={m.mode === "none" ? undefined : segTip(m, s.key, s.value, s.share)}
                aria-hidden="true"
              />
            ))}
          </div>
        </div>
      </div>
    );
  };

  // A repeat click on the active column flips direction; a new column starts
  // descending for the figures (largest first — the usual question) and
  // ascending for the name (A→Z).
  const onSort = (key: UsageSortKey) =>
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "name" ? "asc" : "desc" },
    );

  const headCell = (key: UsageSortKey, text: string, narrow = false) => (
    <button
      type="button"
      className={`${ui.usageSortBtn}${sort.key === key ? ` ${ui.usageSortActive}` : ""}${narrow ? ` ${ui.hideNarrow}` : ""}`}
      onClick={() => onSort(key)}
      aria-label={t("systemSettings.usage.sortBy", { col: text })}
    >
      {text}
      {sort.key === key && (
        <span className={ui.usageSortArrow} aria-hidden="true">
          {sort.dir === "asc" ? "▲" : "▼"}
        </span>
      )}
    </button>
  );

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
        /* 副标题直接说这一份账存在哪：两本账的差别是「存在哪、活多久」，
           把它写在页顶就不必让作者去读脚注。 */
        sub={t(`systemSettings.usage.scopeSub.${scope}`)}
        action={
          <div className={ui.usageScopeStack}>
            <ChipRow>
              {(["project", "global"] as UsageScope[]).map((sc) => (
                <Chip
                  key={sc}
                  label={t(`systemSettings.usage.scopes.${sc}`)}
                  active={scope === sc}
                  onClick={() => setScope(sc)}
                />
              ))}
            </ChipRow>
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
          </div>
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
            <Chip label={t("systemSettings.usage.byGroup")} active={dimension === "group"} onClick={() => setDimension("group")} />
            <Chip label={t("systemSettings.usage.byModel")} active={dimension === "model"} onClick={() => setDimension("model")} />
            <Chip label={t("systemSettings.usage.byTask")} active={dimension === "task"} onClick={() => setDimension("task")} />
            {/* 项目库里每一行都是这个项目的：这一维只在总体那份里有意义。 */}
            {scope === "global" && (
              <Chip label={t("systemSettings.usage.byProject")} active={dimension === "project"} onClick={() => setDimension("project")} />
            )}
          </ChipRow>
        }
      >
        {buckets.length === 0 ? (
          <div className={ui.emptyNote}>{t("systemSettings.usage.empty")}</div>
        ) : (
          <>
            <div className={`${ui.usageGrid} ${ui.usageHead}`}>
              {headCell("name", t("systemSettings.usage.colName"))}
              {headCell("calls", t("systemSettings.usage.colCalls"))}
              {headCell("input", t("systemSettings.usage.colInput"))}
              {headCell("cached", t("systemSettings.usage.colCached"), true)}
              {headCell("output", t("systemSettings.usage.colOutput"))}
              {headCell("hitRate", t("systemSettings.usage.colHitRate"), true)}
              {headCell("cost", t("systemSettings.usage.colCost"))}
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
                    {meterBar(b)}
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
                  {/* 没命中任何档位的请求按 0 计——不是错误，是还没配完，所以
                      写成一行提示而不是警示色，并且给一条直达补表的路。 */}
                  {b.uncovered > 0 && (
                    <div className={ui.usageGap}>
                      <span>{t("systemSettings.usage.uncovered", { n: b.uncovered })}</span>
                      {dimension === "group" && b.key && (
                        <button type="button" className={ui.usageGapLink} onClick={() => onOpenFees?.()}>
                          {t("systemSettings.usage.goFixRates")}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            <div className={ui.usageFootRule} />
            <div className={ui.usageFoot}>{t(`systemSettings.usage.footnote.${scope}`)}</div>
          </>
        )}
      </Section>

      <Section label={t("systemSettings.usage.maintenance")}>
        {/* 按钮文字跟着范围换：清的是哪一份，按钮上就写哪一份。 */}
        <Row
          title={t(`systemSettings.usage.clearLabel.${scope}`)}
          desc={t(`systemSettings.usage.clearHint.${scope}`)}
          last
        >
          <button
            className={ui.rowBtn}
            onClick={handleClear}
            disabled={busy || !summary || summary.total.calls === 0}
          >
            {t(`systemSettings.usage.clearLabel.${scope}`)}
          </button>
        </Row>
      </Section>
    </Pane>
  );
}
