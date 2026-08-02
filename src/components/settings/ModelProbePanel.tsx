/**
 * "Probe endpoint" panel — sits under the context-size field in the model
 * editor and fills it in by measurement instead of guesswork.
 *
 * Deliberately never writes anything itself: the probe reports, the author
 * presses 应用 to move the numbers into the form, and the form still has to be
 * saved. A measurement is a sample of one moment on one route (a relay can
 * re-point the same model name tomorrow), so it is offered as evidence next to
 * the current value rather than silently replacing it.
 */

import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity, AlertTriangle, Check, Loader2, X } from "lucide-react";

import { useAiStore } from "../../stores/aiStore";
import { planProbeCost, probeEndpoint, type ProbeReport, type ProbeStage } from "../../lib/ai/endpointProbe";
import type { ProbeFinding } from "../../lib/ai/probeAnalysis";
import styles from "./ModelProbePanel.module.css";

interface Props {
  providerId: string;
  modelId: string;
  /** Raw form values, so the estimate tracks what the author is typing. */
  contextSize: string;
  maxOutput: string;
  priceIn: string;
  priceOut: string;
  onApply: (v: { contextSize?: number; maxOutput?: number; probedAt: number }) => void;
}

type Phase = "idle" | "confirm" | "running" | "done";

function intOr(value: string, fallback: number): number {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function floatOr(value: string, fallback: number): number {
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function compact(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

export function ModelProbePanel(props: Props) {
  const { t } = useTranslation();
  const providers = useAiStore((s) => s.providers);
  const getApiKey = useAiStore((s) => s.getApiKey);

  const [deep, setDeep] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [stage, setStage] = useState<{ stage: ProbeStage; detail?: string } | null>(null);
  const [report, setReport] = useState<ProbeReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const ready = Boolean(props.providerId && props.modelId);

  const estimate = useMemo(
    () => planProbeCost({
      claimedContext: intOr(props.contextSize, 0) || undefined,
      claimedMaxOutput: intOr(props.maxOutput, 0) || undefined,
      deep,
      measureOutput: deep,
      priceIn: floatOr(props.priceIn, 0),
      priceOut: floatOr(props.priceOut, 0),
    }),
    [props.contextSize, props.maxOutput, props.priceIn, props.priceOut, deep],
  );

  const costLabel = estimate.usd !== undefined
    ? t("aiConfig.probe.costWithPrice", {
        tokens: compact(estimate.inputTokens + estimate.outputTokens),
        usd: estimate.usd < 0.01 ? estimate.usd.toFixed(4) : estimate.usd.toFixed(2),
      })
    : t("aiConfig.probe.cost", { tokens: compact(estimate.inputTokens + estimate.outputTokens) });

  const run = async () => {
    const provider = providers.find((p) => p.id === props.providerId);
    if (!provider) return;
    setPhase("running");
    setReport(null);
    setError(null);
    setApplied(false);
    setStage(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const apiKey = (await getApiKey(provider.id)) ?? "";
      const result = await probeEndpoint({
        baseUrl: provider.baseUrl,
        apiKey,
        standard: provider.apiStandard,
        modelId: props.modelId,
        claimedContext: intOr(props.contextSize, 0) || undefined,
        claimedMaxOutput: intOr(props.maxOutput, 0) || undefined,
        deep,
        measureOutput: deep,
        signal: ctrl.signal,
        onProgress: (s, detail) => setStage({ stage: s, detail }),
      });
      setReport(result);
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    } finally {
      abortRef.current = null;
      setStage(null);
    }
  };

  const apply = () => {
    if (!report) return;
    props.onApply({
      contextSize: report.suggestion.contextWindow,
      maxOutput: report.suggestion.maxOutput,
      probedAt: report.probedAt,
    });
    setApplied(true);
  };

  const hasSuggestion =
    report?.suggestion.contextWindow !== undefined || report?.suggestion.maxOutput !== undefined;

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <Activity size={13} />
        <span className={styles.headTitle}>{t("aiConfig.probe.title")}</span>
        <span className={styles.cost}>{costLabel}</span>
      </div>

      <div className={styles.controls}>
        {phase === "running" ? (
          <button className={styles.cancelBtn} onClick={() => abortRef.current?.abort()}>
            <X size={12} /> {t("aiConfig.probe.cancel")}
          </button>
        ) : phase === "confirm" ? (
          <>
            <button className={styles.runBtn} onClick={() => { setPhase("idle"); void run(); }}>
              {t("aiConfig.probe.confirmRun")}
            </button>
            <button className={styles.cancelBtn} onClick={() => setPhase("idle")}>
              {t("aiConfig.probe.cancel")}
            </button>
            <span className={styles.confirmNote}>{t("aiConfig.probe.deepWarning")}</span>
          </>
        ) : (
          <button
            className={styles.runBtn}
            disabled={!ready}
            // Deep runs bill real tokens, so they get an explicit second press
            // with the estimate in view — the quick pass does not need one.
            onClick={() => (deep ? setPhase("confirm") : void run())}
          >
            {deep ? t("aiConfig.probe.runDeep") : t("aiConfig.probe.run")}
          </button>
        )}

        <label className={styles.deepToggle}>
          <input
            type="checkbox"
            checked={deep}
            disabled={phase === "running"}
            onChange={(e) => { setDeep(e.target.checked); setPhase("idle"); }}
          />
          {t("aiConfig.probe.deepLabel")}
        </label>
      </div>

      {!ready && <div className={styles.hint}>{t("aiConfig.probe.needTarget")}</div>}

      {phase === "running" && (
        <div className={styles.progress}>
          <Loader2 size={12} className={styles.spin} />
          {t(`aiConfig.probe.stages.${stage?.stage ?? "discover"}`)}
          {stage?.detail ? ` · ${stage.detail}` : ""}
        </div>
      )}

      {error && <div className={styles.errorLine}>{error}</div>}

      {report && <ProbeResult report={report} />}

      {report && (
        <div className={styles.applyRow}>
          <button className={styles.applyBtn} disabled={!hasSuggestion} onClick={apply}>
            <Check size={12} /> {t("aiConfig.probe.apply")}
          </button>
          <span className={styles.applyNote}>
            {applied
              ? t("aiConfig.probe.appliedNote")
              : hasSuggestion
                ? t("aiConfig.probe.applyNote")
                : t("aiConfig.probe.noResult")}
          </span>
        </div>
      )}
    </div>
  );
}

function ProbeResult({ report }: { report: ProbeReport }) {
  const { t } = useTranslation();
  const { suggestion, truncation, calibration, outputTest } = report;

  return (
    <div className={styles.result}>
      <div className={styles.summaryRow}>
        <SummaryCell
          label={t("aiConfig.probe.contextLabel")}
          value={suggestion.contextWindow?.toLocaleString() ?? t("aiConfig.probe.unknown")}
        />
        <SummaryCell
          label={t("aiConfig.probe.outputLabel")}
          value={suggestion.maxOutput?.toLocaleString() ?? t("aiConfig.probe.unknown")}
        />
        {calibration && (
          <SummaryCell
            label={t("aiConfig.probe.ratioLabel")}
            value={t("aiConfig.probe.ratioValue", { ratio: calibration.charsPerToken.toFixed(2) })}
          />
        )}
      </div>

      {truncation && (
        <div
          className={
            truncation.verdict === "truncated" ? styles.verdictBad
              : truncation.verdict === "unknown" ? styles.verdictWarn
                : styles.verdictOk
          }
        >
          {truncation.verdict === "truncated" ? (
            <>
              <AlertTriangle size={12} />
              {t("aiConfig.probe.truncated", {
                sent: truncation.expectedTokens.toLocaleString(),
                got: (truncation.reportedTokens ?? 0).toLocaleString(),
              })}
            </>
          ) : truncation.verdict === "unknown" ? (
            <>{t("aiConfig.probe.truncationUnknown")}</>
          ) : (
            // Worth spelling out: not finding truncation at this size proves
            // nothing about larger prompts, and a relay can fake the count.
            <>{t("aiConfig.probe.truncationNotDetected", {
              size: truncation.expectedTokens.toLocaleString(),
            })}</>
          )}
        </div>
      )}

      {outputTest && (
        <div className={styles.detailLine}>
          {t("aiConfig.probe.outputTest", {
            produced: outputTest.produced.toLocaleString(),
            requested: outputTest.requested.toLocaleString(),
            reason: outputTest.finishReason ?? "-",
          })}
          {outputTest.capped ? ` · ${t("aiConfig.probe.outputCapped")}` : ""}
        </div>
      )}

      {report.acceptedLimit !== undefined && (
        <div className={styles.detailLine}>
          {t("aiConfig.probe.accepted", { tokens: report.acceptedLimit.toLocaleString() })}
        </div>
      )}

      {report.findings.length > 0 && (
        <ul className={styles.findings}>
          {report.findings.map((f, i) => <FindingRow key={i} finding={f} />)}
        </ul>
      )}

      {suggestion.conflicts.length > 0 && (
        <div className={styles.detailLine}>
          {t("aiConfig.probe.conflicts", { list: suggestion.conflicts.join(" / ") })}
        </div>
      )}

      {report.warnings.map((w) => (
        <div key={w.code} className={styles.warnLine}>
          <AlertTriangle size={11} />
          {t(`aiConfig.probe.warnings.${w.code}`)}
          {w.detail ? ` (${w.detail})` : ""}
        </div>
      ))}

      <div className={styles.spent}>
        {t("aiConfig.probe.spent", {
          input: report.spent.inputTokens.toLocaleString(),
          output: report.spent.outputTokens.toLocaleString(),
        })}
      </div>
    </div>
  );
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.summaryCell}>
      <div className={styles.summaryLabel}>{label}</div>
      <div className={styles.summaryValue}>{value}</div>
    </div>
  );
}

function FindingRow({ finding }: { finding: ProbeFinding }) {
  const { t } = useTranslation();
  const value = finding.contextWindow ?? finding.maxOutput ?? 0;
  const kind = finding.contextWindow !== undefined
    ? t("aiConfig.probe.contextLabel")
    : t("aiConfig.probe.outputLabel");
  return (
    <li className={styles.finding}>
      <span className={styles.findingValue}>{value.toLocaleString()}</span>
      <span className={styles.findingKind}>{kind}</span>
      <span className={styles.findingSource}>
        {t(`aiConfig.probe.sources.${finding.source}`)} · {finding.detail}
      </span>
      <span className={`${styles.findingConf} ${styles[`conf_${finding.confidence}`]}`}>
        {t(`aiConfig.probe.confidence.${finding.confidence}`)}
      </span>
    </li>
  );
}
