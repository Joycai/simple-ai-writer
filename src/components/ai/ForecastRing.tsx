import styles from "./AiPanel.module.css";

/** Shared forecast trigger; values retain the caller's budget/estimation semantics. */
export function ForecastRing({ segments, label, open, onClick }: {
  segments: readonly { key: string; chars: number }[] | null;
  label: string;
  open: boolean;
  onClick: () => void;
}) {
  const total = segments?.reduce((sum, segment) => sum + segment.chars, 0) ?? 0;
  return <button type="button" className={styles.forecastRing} onClick={onClick}
    aria-haspopup="dialog" aria-expanded={open} aria-label={label} title={label}>
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" className={styles.ringTrack} />
      {segments && total > 0 && segments.map((segment, index) => <circle key={segment.key}
        cx="12" cy="12" r="9" pathLength="100"
        className={`${styles.ringArc} ${styles[`allocSeg_${segment.key}`]}`}
        strokeDasharray={`${segment.chars / total * 100} 100`}
        strokeDashoffset={-segments.slice(0, index).reduce((sum, item) => sum + item.chars, 0) / total * 100}
        transform="rotate(-90 12 12)" />)}
      {!segments && <text x="12" y="16" textAnchor="middle">?</text>}
    </svg>
  </button>;
}
