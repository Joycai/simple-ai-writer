import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Minimize2, X } from "lucide-react";
import type { ContextBreakdown } from "../../lib/agent/contextBreakdown";
import { CONTEXT_SEGMENT_ORDER, type ContextSegmentKey } from "../../lib/agent/contextSegments";
import type { CompactFeedback } from "../../stores/agent/compactResult";
import { ContextExplanation, formatTokens, SEGMENT_LABELS } from "./ContextPresentation";
import { contextPopoverPosition, contextRingArcs } from "./contextRingGeometry";
import styles from "./ContextRing.module.css";

const colors: Record<ContextSegmentKey, string> = {
  system: styles.system, summary: styles.summary, seed: styles.seed,
  injected: styles.injected, conversation: styles.conversation, free: styles.free,
};

interface ContextRingProps {
  context: ContextBreakdown;
  entryTerm: string;
  compacting: boolean;
  busy: boolean;
  feedback?: CompactFeedback;
  contextVersion: number;
  onCompact: () => void;
}

/** The owner keys this component by chat key; presentation never owns a request. */
export function ContextRing({ entryTerm, context, compacting, busy, feedback, contextVersion, onCompact }: ContextRingProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback((restore = false) => {
    setOpen(false);
    if (restore) trigger.current?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current) return;
      setPosition(contextPopoverPosition(trigger.current.getBoundingClientRect(), window.innerWidth, window.innerHeight));
    };
    place();
    const observer = new ResizeObserver(place);
    if (trigger.current) observer.observe(trigger.current);
    if (trigger.current?.parentElement) observer.observe(trigger.current.parentElement);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    panel.current?.focus({ preventScroll: true });
    const inside = (target: EventTarget | null) => target instanceof Node
      && (panel.current?.contains(target) || trigger.current?.contains(target));
    const outside = (event: PointerEvent) => { if (!inside(event.target)) close(); };
    const focus = (event: FocusEvent) => { if (!inside(event.target)) close(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); close(true);
      }
      // The portal is at the end of body. Return Tab to the composer's next
      // control instead of marooning focus at the end of the application.
      if (event.key === "Tab" && panel.current?.contains(document.activeElement)) {
        const buttons = Array.from(panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), summary, [href], [tabindex="0"]'));
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
          event.preventDefault(); close(true);
        } else if (!event.shiftKey && document.activeElement === last) {
          // Let the browser perform its default Tab from the restored trigger.
          close(true);
        }
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", focus);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("keydown", key, true);
    };
  }, [open, close]);

  useEffect(() => {
    if (open && compacting && document.activeElement === document.body) {
      panel.current?.focus({ preventScroll: true });
    }
  }, [open, compacting]);

  const known = context.contextSize > 0 && context.ceilingTokens > 0;
  const pct = known ? Math.round(context.usedTokens / context.ceilingTokens * 100) : null;
  const warned = (context.willCompact && context.autoCompact) || context.over;
  const arcs = contextRingArcs(context);
  const label = (key: ContextSegmentKey) => t(SEGMENT_LABELS[key].key, { entry: entryTerm });
  const result = feedback?.contextVersion === contextVersion ? feedback.result : undefined;
  const reason = compacting ? t("ai.chat.ctxCompacting") : busy ? t("ai.chat.ringBusy")
    : !known ? t("ai.chat.ringUnknownHint") : !context.canFold ? t("ai.chat.ringNothing") : null;
  const reading = known
    ? t("ai.chat.ringUsage", { pct, used: formatTokens(context.usedTokens), limit: formatTokens(context.ceilingTokens) })
    : t("ai.chat.ringUnknown");
  return <>
    <button type="button" ref={trigger} className={`${styles.trigger} ${warned ? styles.warned : ""}`}
      title={reading} aria-label={reading} aria-expanded={open} aria-controls={open ? id : undefined}
      aria-haspopup="dialog" onClick={() => setOpen(value => !value)}>
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
        <circle className={styles.track} cx="12" cy="12" r="9" />
        {known ? arcs.map(arc => <circle key={arc.key} className={`${styles.arc} ${colors[arc.key]}`}
          cx="12" cy="12" r="9" pathLength="100" strokeDasharray={`${arc.length} 100`}
          strokeDashoffset={-arc.offset} transform="rotate(-90 12 12)" />)
          : <><circle className={styles.arc} cx="12" cy="12" r="9" pathLength="100" strokeDasharray="3 5" />
            <text x="12" y="16" textAnchor="middle" className={styles.unknown}>?</text></>}
      </svg>
    </button>
    {open && createPortal(<div ref={panel} id={id} role="dialog" aria-labelledby={`${id}-title`}
      tabIndex={-1} className={styles.popover} style={position}>
      <header className={styles.header}><strong id={`${id}-title`}>{t("ai.chat.contextMeter")}</strong>
        <button type="button" className={styles.close} aria-label={t("ai.chat.ringClose")} onClick={() => close(true)}><X size={15} /></button></header>
      <div className={styles.reading}><strong>{pct === null ? "—" : `${pct}%`}</strong><span>{t("ai.chat.ringUsed")}<small>{known
        ? `≈ ${formatTokens(context.usedTokens)} / ${formatTokens(context.ceilingTokens)} tk` : t("ai.chat.ringUnknown")}</small></span></div>
      <div className={styles.bar} aria-hidden="true">{known && arcs.map(arc => <span key={arc.key} className={colors[arc.key]} style={{ width: `${arc.length}%` }} />)}
        {known && context.compactMarkerPct !== null && <i className={context.autoCompact ? styles.marker : styles.markerOff}
          style={{ left: `${context.compactMarkerPct}%` }} />}</div>
      <dl className={styles.details}>{CONTEXT_SEGMENT_ORDER.map(key => <div key={key}>
        <dt><i className={`${styles.swatch} ${colors[key]}`} aria-hidden="true" />{label(key)}</dt>
        <dd>{!known && key === "free" ? "—" : formatTokens(context.segments.find(seg => seg.key === key)?.tokens ?? 0)}</dd>
      </div>)}</dl>
      <div className={styles.capacity}><span>{t("ai.chat.ringLimit")}<b>{known ? `${formatTokens(context.ceilingTokens)} tk` : "—"}</b></span>
        <span>{t("ai.chat.ringWindow")}<b>{context.contextSize > 0 ? `${formatTokens(context.contextSize)} tk` : "—"}</b></span></div>
      <p className={styles.hint}>{t(context.autoCompact ? "ai.chat.ringAutoOn" : "ai.chat.ringAutoOff")}</p>
      <ContextExplanation context={context} />
      <div className={styles.compact}>
        <p>{t(context.stateMode ? "ai.chat.ringStateHint" : "ai.chat.ringCompactHint")}</p>
        <button type="button" className={styles.action} disabled={!!reason} onClick={onCompact}>
          <Minimize2 size={14} />{compacting ? t("ai.chat.ctxCompacting") : context.stateMode ? t("ai.chat.ctxStateNow")
            : result?.status === "failed" ? t("ai.chat.ringRetry") : t("ai.chat.ctxCompactNow")}
        </button>
        {reason && <p className={styles.hint}>{reason}</p>}
        <div role="status" className={styles.status}>{!compacting && result && (
          result.status === "success" ? t("ai.chat.ringSuccess", { before: formatTokens(result.fromTokens), after: formatTokens(result.toTokens) })
            : result.status === "failed" ? <><span>{t("ai.chat.ringFailed")}</span><details><summary>{t("ai.chat.ringErrorDetails")}</summary><pre>{result.message}</pre></details></>
            : result.status === "cancelled" ? t("ai.chat.ringCancelled")
            : t(result.reason === "busy" ? "ai.chat.ringBusy" : "ai.chat.ringNothing")
        )}</div>
        <small className={styles.hint}>{t("ai.chat.ringBilling")}</small>
      </div>
    </div>, document.body)}
  </>;
}
