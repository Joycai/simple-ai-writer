import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../stores/appStore";
import { useAiStore } from "../../../stores/aiStore";
import { IMAGE_LONG_EDGE_MAX, IMAGE_LONG_EDGE_MIN } from "../../../lib/image/downscalePlan";
import {
  ASSUMED_INPUT_CEILING_TOKENS,
  COMPACT_TRIGGER_RATIO_MAX, COMPACT_TRIGGER_RATIO_MIN,
  COMPACT_TRIGGER_TOKENS_MAX, COMPACT_TRIGGER_TOKENS_MIN,
  CONTEXT_UTILIZATION_MAX, CONTEXT_UTILIZATION_MIN,
} from "../../../lib/context/budget";
import { compactTriggerFor } from "../../../lib/agent/compact";
import { messageCeilingFor } from "../../../lib/agent/toolCost";
import { chatAgentPreset } from "../../../lib/agent/packs";
import { Slider, type SliderTick } from "../../common/Slider";
import { Pane, PaneHeader, Section, Row, Toggle } from "./bits";
import common from "../settingsCommon.module.css";
import styles from "./ContextMemory.module.css";

const EDGE_STEP = 256;

/** 128000 → "128k", 1048576 → "1M", 600 → "600". */
function formatTokens(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(n % 1_048_576 ? 1 : 0)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_024)}k`;
  return String(n);
}

/**
 * The token slider's ticks (设计稿 20): the four the author named plus both
 * ends. 64k is the log midpoint and deliberately unmarked — "common" has to
 * stay rare to mean anything.
 */
const TOKEN_TICKS: SliderTick[] = [8_192, 16_384, 32_768, 131_072, 262_144, 524_288]
  .map((value) => ({ value, label: formatTokens(value) }));
/** Under 64k the slider moves in 1k; above, in 4k. */
const tokenStep = (v: number) => (v < 65_536 ? 1_024 : 4_096);
const RATIO_TICKS: SliderTick[] = [50, 60, 70, 80].map((value) => ({ value, label: `${value}%` }));
/** 窗口占用's ticks: both ends plus the tens between them, all equally usable. */
const UTIL_TICKS: SliderTick[] = [50, 60, 70, 80, 90].map((value) => ({ value, label: `${value}%` }));

/**
 * 设置 → AI 配置 → 上下文与记忆: what a conversation puts in front of the
 * model, and how much of it.
 *
 * Three sections, in the order one bounds the next. 窗口占用: the hard cap on
 * a single request (input + reply) as a share of the model's declared window —
 * it moved here from the AI panel's chip row on 2026-09-05, so the third line
 * the compaction example has to attribute to now lives one section above it
 * rather than on another screen. 对话归纳
 * (docs/feature/agent/compact-threshold-plan.md, 设计稿 20): the 自动归纳
 * switch, the two lines the trigger is the lowest of — an absolute token count
 * and a share of the model's window — and a worked example for the active model
 * that names which line actually won. That example exists because the cap above
 * beats both sliders under its default, and a slider that never bites has to
 * say so: the row that won carries a 生效中 tag, and the hard cap gets a
 * signpost that now scrolls up this same page. 图片: the picture ceiling.
 */
export function ContextMemoryPane() {
  const { t } = useTranslation();

  // ── 对话归纳 ──
  const autoCompact = useAppStore((s) => s.autoCompact);
  const setAutoCompact = useAppStore((s) => s.setAutoCompact);
  const triggerTokens = useAppStore((s) => s.compactTriggerTokens);
  const setTriggerTokens = useAppStore((s) => s.setCompactTriggerTokens);
  const triggerRatio = useAppStore((s) => s.compactTriggerRatio);
  const setTriggerRatio = useAppStore((s) => s.setCompactTriggerRatio);
  const contextUtilization = useAppStore((s) => s.contextUtilization);
  const setContextUtilization = useAppStore((s) => s.setContextUtilization);
  const utilSectionRef = useRef<HTMLDivElement>(null);
  const models = useAiStore((s) => s.models);
  const subAgents = useAiStore((s) => s.subAgents);
  const activeModel = useAiStore((s) => s.models.find((m) => m.id === s.activeModelId) ?? null);

  // The worked example runs the same resolver the chat runs, fed the same
  // ceiling (`messageCeilingFor` with the chat's toolset), so the line this
  // sentence names is the line the bar will draw and the store will fold at.
  const example = useMemo(() => {
    if (!activeModel) return null;
    const messageCeiling = messageCeilingFor(
      activeModel.contextSize, contextUtilization, chatAgentPreset(), subAgents, models,
      { handoff: true, packs: true },
    );
    return compactTriggerFor({
      contextSize: activeModel.contextSize, messageCeiling, triggerTokens, triggerRatio,
    });
  }, [activeModel, contextUtilization, subAgents, models, triggerTokens, triggerRatio]);

  const ratioPct = Math.round(triggerRatio * 100);
  const utilPct = Math.round(contextUtilization * 100);
  const hasWindow = !!activeModel?.contextSize;

  // 生效中 sits on the row whose line won; the ratio row instead says why it
  // cannot compete when the model declares no window. Neither when off.
  const tokensTag = autoCompact && example?.boundBy === "tokens"
    ? { text: t("systemSettings.contextMemory.tagActive"), muted: false } : null;
  const ratioTag = !autoCompact ? null
    : example?.boundBy === "ratio" ? { text: t("systemSettings.contextMemory.tagActive"), muted: false }
    : activeModel && !hasWindow ? { text: t("systemSettings.contextMemory.tagNoWindow"), muted: true }
    : null;

  // Editable readouts: the value is the truth, the field mirrors it and can
  // drive it back — committed on blur / Enter, clamped and stepped like the
  // slider would.
  const [tokDraft, setTokDraft] = useState<string | null>(null);
  const [ratioDraft, setRatioDraft] = useState<string | null>(null);
  const [utilDraft, setUtilDraft] = useState<string | null>(null);
  const commitTok = () => {
    if (tokDraft === null) return;
    const n = parseFloat(tokDraft);
    setTokDraft(null);
    if (!Number.isFinite(n)) return;
    const raw = Math.round(n * 1_024);
    const s = tokenStep(raw);
    setTriggerTokens(Math.round(raw / s) * s);
  };
  const commitRatio = () => {
    if (ratioDraft === null) return;
    const n = parseInt(ratioDraft, 10);
    setRatioDraft(null);
    if (!Number.isFinite(n)) return;
    setTriggerRatio(n / 100);
  };
  const commitUtil = () => {
    if (utilDraft === null) return;
    const n = parseInt(utilDraft, 10);
    setUtilDraft(null);
    if (!Number.isFinite(n)) return;
    setContextUtilization(n / 100);
  };

  // The hard cap is now the first section of this very page, so the signpost
  // scrolls rather than navigates.
  const goToUtilization = () =>
    utilSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });

  // ── 图片 ──
  const imageMaxLongEdge = useAppStore((s) => s.imageMaxLongEdge);
  const setImageMaxLongEdge = useAppStore((s) => s.setImageMaxLongEdge);
  const [edgeDraft, setEdgeDraft] = useState(imageMaxLongEdge ? String(imageMaxLongEdge) : "");
  const commitEdge = () => {
    const n = parseInt(edgeDraft, 10);
    const next = Number.isFinite(n) && n > 0
      ? Math.min(Math.max(n, IMAGE_LONG_EDGE_MIN), IMAGE_LONG_EDGE_MAX)
      : 0;
    setImageMaxLongEdge(next);
    setEdgeDraft(next ? String(next) : "");
  };

  const exampleBody = (() => {
    if (!autoCompact) {
      return <div className={styles.exampleText}>{t("systemSettings.contextMemory.exampleOff")}</div>;
    }
    if (!activeModel || !example) {
      return <div className={styles.exampleText}>{t("systemSettings.contextMemory.exampleNoModel")}</div>;
    }
    const attribution = {
      tokens: t("systemSettings.contextMemory.attrTokens", { tokens: formatTokens(triggerTokens) }),
      ratio: t("systemSettings.contextMemory.attrRatio", { pct: ratioPct }),
      ceiling: t("systemSettings.contextMemory.attrCeiling", { util: Math.round(contextUtilization * 100) }),
      assumed: t("systemSettings.contextMemory.attrAssumed", { assumed: formatTokens(ASSUMED_INPUT_CEILING_TOKENS) }),
    }[example.boundBy];
    return (
      <>
        <div className={styles.exampleText}>
          {t("systemSettings.contextMemory.exampleLead")}
          <span className={styles.exampleName}>{activeModel.name}</span>
          （<span className={styles.exampleMono}>
            {hasWindow ? formatTokens(activeModel.contextSize!) : t("systemSettings.contextMemory.noWindow")}
          </span>）
          {t("systemSettings.contextMemory.exampleAt")}
          <span className={`${styles.exampleMono} ${styles.exampleTrigger}`}>{formatTokens(example.tokens)}</span>
          {t("systemSettings.contextMemory.exampleFold")}
          {attribution}
        </div>
        {example.boundBy === "ceiling" && (
          <div className={styles.go}>
            <span className={styles.goLead}>{t("systemSettings.contextMemory.goCeilingLead")}</span>
            <button type="button" className={styles.goLink} onClick={goToUtilization}>
              {t("systemSettings.contextMemory.goCeilingLink")} ↑
            </button>
          </div>
        )}
      </>
    );
  })();

  return (
    <Pane>
      <PaneHeader
        title={t("systemSettings.tabs.contextMemory")}
        sub={t("systemSettings.contextMemory.paneSub")}
      />

      {/* The cap first: it bounds every request, including the ones the
          归纳 lines are about — a compaction threshold above it never fires
          (that is what the worked example below has to keep explaining). */}
      <div ref={utilSectionRef}>
        <Section label={t("systemSettings.contextMemory.windowSection")}>
          {/* The foot line shows what the percentage is *of*, for the model
              actually selected — the same "show the arithmetic" move as the
              归纳 example below, but one line: there is one number to derive. */}
          <Row
            top
            last
            title={t("systemSettings.contextMemory.utilizationLabel")}
            desc={t("systemSettings.contextMemory.utilizationHint")}
            foot={
              <div className={styles.utilCeiling}>
                {!activeModel
                  ? t("systemSettings.contextMemory.utilizationNoModel")
                  : !hasWindow
                    ? t("systemSettings.contextMemory.utilizationNoWindow", {
                        assumed: formatTokens(ASSUMED_INPUT_CEILING_TOKENS),
                      })
                    : t("systemSettings.contextMemory.utilizationCeiling", {
                        name: activeModel.name,
                        window: formatTokens(activeModel.contextSize!),
                        tokens: formatTokens(Math.floor(activeModel.contextSize! * contextUtilization)),
                      })}
              </div>
            }
          >
            <div className={styles.sliderCell}>
              <Slider
                value={utilPct}
                min={Math.round(CONTEXT_UTILIZATION_MIN * 100)}
                max={Math.round(CONTEXT_UTILIZATION_MAX * 100)}
                onChange={(v) => setContextUtilization(v / 100)}
                ticks={UTIL_TICKS}
                snapToTicks
                step={1}
                shiftMultiplier={5}
                ariaLabel={t("systemSettings.contextMemory.utilizationLabel")}
                valueText={`${utilPct}%`}
              />
              <div className={styles.fieldRow}>
                <input
                  className={`${common.input} ${common.rowNumber} ${styles.mono}`}
                  type="text"
                  inputMode="numeric"
                  value={utilDraft ?? String(utilPct)}
                  onChange={(e) => setUtilDraft(e.target.value)}
                  onBlur={commitUtil}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                  aria-label={t("systemSettings.contextMemory.utilizationLabel")}
                />
                <span className={styles.unit}>%</span>
              </div>
            </div>
          </Row>
        </Section>
      </div>

      {/* 归纳 first: it shapes every long conversation; the picture ceiling
          only touches requests that carry one. Row order 开关 → token → 比例
          → 读数句: whether, then when, then the arithmetic. */}
      <Section label={t("systemSettings.contextMemory.compactSection")}>
        <Row
          top
          title={t("systemSettings.contextMemory.autoCompactLabel")}
          desc={t("systemSettings.contextMemory.autoCompactHint")}
        >
          <Toggle
            on={autoCompact}
            onChange={setAutoCompact}
            label={t("systemSettings.contextMemory.autoCompactLabel")}
          />
        </Row>

        <div className={`${styles.sliderRow} ${autoCompact ? "" : styles.sliderRowOff}`}>
          <Row
            top
            title={t("systemSettings.contextMemory.triggerTokensLabel")}
            titleExtra={tokensTag && (
              <span className={`${styles.tag} ${tokensTag.muted ? styles.tagMuted : ""}`}>{tokensTag.text}</span>
            )}
            desc={t("systemSettings.contextMemory.triggerTokensHint")}
          >
            <div className={styles.sliderCell}>
              <Slider
                value={triggerTokens}
                min={COMPACT_TRIGGER_TOKENS_MIN}
                max={COMPACT_TRIGGER_TOKENS_MAX}
                onChange={setTriggerTokens}
                scale="log2"
                ticks={TOKEN_TICKS}
                snapToTicks
                step={tokenStep}
                shiftMultiplier={8}
                disabled={!autoCompact}
                ariaLabel={t("systemSettings.contextMemory.triggerTokensLabel")}
                valueText={formatTokens(triggerTokens)}
              />
              <div className={styles.fieldRow}>
                <input
                  className={`${common.input} ${common.rowNumber} ${styles.mono}`}
                  type="text"
                  inputMode="numeric"
                  value={tokDraft ?? String(Math.round(triggerTokens / 1_024))}
                  disabled={!autoCompact}
                  onChange={(e) => setTokDraft(e.target.value)}
                  onBlur={commitTok}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                  aria-label={t("systemSettings.contextMemory.triggerTokensLabel")}
                />
                <span className={styles.unit}>k</span>
              </div>
            </div>
          </Row>
        </div>

        <div className={`${styles.sliderRow} ${autoCompact ? "" : styles.sliderRowOff}`}>
          <Row
            top
            title={t("systemSettings.contextMemory.triggerRatioLabel")}
            titleExtra={ratioTag && (
              <span className={`${styles.tag} ${ratioTag.muted ? styles.tagMuted : ""}`}>{ratioTag.text}</span>
            )}
            desc={t("systemSettings.contextMemory.triggerRatioHint")}
            last
          >
            <div className={styles.sliderCell}>
              <Slider
                value={ratioPct}
                min={Math.round(COMPACT_TRIGGER_RATIO_MIN * 100)}
                max={Math.round(COMPACT_TRIGGER_RATIO_MAX * 100)}
                onChange={(v) => setTriggerRatio(v / 100)}
                ticks={RATIO_TICKS}
                step={1}
                shiftMultiplier={5}
                disabled={!autoCompact}
                ariaLabel={t("systemSettings.contextMemory.triggerRatioLabel")}
                valueText={`${ratioPct}%`}
              />
              <div className={styles.fieldRow}>
                <input
                  className={`${common.input} ${common.rowNumber} ${styles.mono}`}
                  type="text"
                  inputMode="numeric"
                  value={ratioDraft ?? String(ratioPct)}
                  disabled={!autoCompact}
                  onChange={(e) => setRatioDraft(e.target.value)}
                  onBlur={commitRatio}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                  aria-label={t("systemSettings.contextMemory.triggerRatioLabel")}
                />
                <span className={styles.unit}>%</span>
              </div>
            </div>
          </Row>
        </div>

        {/* The worked example: a sentence about the three rows above it, on
            its own paper so it reads as arithmetic shown, not as a fourth
            setting. */}
        <div className={styles.example}>
          <div className={styles.exampleEyebrow}>{t("systemSettings.contextMemory.exampleEyebrow")}</div>
          {exampleBody}
        </div>
      </Section>

      {/* Downscaling is not a feature to switch on, it is what the app does
          with every picture — this field only moves where the line is. */}
      <Section label={t("systemSettings.contextMemory.imageSection")}>
        <Row
          top
          title={t("systemSettings.contextMemory.imageLongEdgeLabel")}
          desc={t("systemSettings.contextMemory.imageLongEdgeHint")}
          last
        >
          <div className={styles.field}>
            <div className={styles.fieldRow}>
              <input
                className={`${common.input} ${common.rowNumber} ${styles.mono}`}
                type="number"
                min={IMAGE_LONG_EDGE_MIN}
                max={IMAGE_LONG_EDGE_MAX}
                step={EDGE_STEP}
                placeholder={t("systemSettings.contextMemory.imageLongEdgeOff")}
                value={edgeDraft}
                onChange={(e) => setEdgeDraft(e.target.value)}
                // Committed on blur, not per keystroke: clamping as the author
                // types means the first digit of "4096" becomes 256 and the
                // rest has nowhere to go.
                onBlur={commitEdge}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
              />
              <span className={styles.unit}>{t("systemSettings.contextMemory.imageUnit")}</span>
            </div>
            <div className={styles.range}>
              {t("systemSettings.contextMemory.imageRange", {
                min: IMAGE_LONG_EDGE_MIN, max: IMAGE_LONG_EDGE_MAX, step: EDGE_STEP,
              })}
            </div>
          </div>
        </Row>
      </Section>

      <div className={styles.elsewhere}>{t("systemSettings.contextMemory.elsewhereNote")}</div>
    </Pane>
  );
}
