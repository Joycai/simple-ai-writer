/**
 * The handful of shapes every settings pane repeats: a pane header, an
 * eyebrow-over-rule section, a label-left / control-right row, a chip and a
 * toggle. Kept here so the panes read as content rather than as markup.
 */
import type { ReactNode } from "react";
import ui from "../settingsUi.module.css";

const WIDTHS = {
  narrow: ui.innerNarrow,   // 关于
  compact: ui.innerCompact, // 快捷键
  default: "",              // 通用 / 工作台 / Prompt
  wide: ui.innerWide,       // 用量
} as const;

/**
 * A scrolling settings pane with a centred content column, plus an optional
 * slot for an edit drawer that must sit over the whole pane rather than
 * scrolling with it.
 */
export function Pane({
  width = "default",
  drawer,
  children,
}: {
  width?: keyof typeof WIDTHS;
  drawer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={ui.pane}>
      <div className={ui.scroll}>
        <div className={`${ui.inner} ${WIDTHS[width]}`}>{children}</div>
      </div>
      {drawer}
    </div>
  );
}

export function PaneHeader({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className={ui.paneHead}>
      <div>
        <div className={ui.paneTitle}>{title}</div>
        {sub && <div className={ui.paneSub}>{sub}</div>}
      </div>
      {action && (
        <>
          <span className={ui.spacer} />
          {action}
        </>
      )}
    </div>
  );
}

export function Section({ label, action, children }: { label: string; action?: ReactNode; children?: ReactNode }) {
  return (
    <div className={ui.section}>
      {action ? (
        <div className={ui.sectionHead}>
          <span className={ui.sectionLabel}>{label}</span>
          <span className={ui.spacer} />
          {action}
        </div>
      ) : (
        <div className={ui.sectionLabel}>{label}</div>
      )}
      <div className={ui.sectionRule} />
      {children}
    </div>
  );
}

export function Row({
  title,
  desc,
  warn,
  last,
  children,
}: {
  title?: string;
  desc?: string;
  warn?: string;
  /** Drops the separator — use on the final row of a section. */
  last?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`${ui.row} ${last ? ui.rowLast : ""}`}>
      <div className={ui.rowMain}>
        {title && <div className={ui.rowTitle}>{title}</div>}
        {desc && <div className={ui.rowDesc}>{desc}</div>}
        {warn && <div className={ui.rowWarn}>{warn}</div>}
      </div>
      {children && <div className={ui.rowActions}>{children}</div>}
    </div>
  );
}

export function Chip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`${ui.chip} ${active ? ui.chipActive : ""}`} onClick={onClick}>
      {label}
    </button>
  );
}

export function ChipRow({ children }: { children: ReactNode }) {
  return <div className={ui.chipRow}>{children}</div>;
}

export function Toggle({
  on, onChange, label, className,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
  /** Extra class on the track — the model editor dashes an off toggle's border. */
  className?: string;
}) {
  return (
    <button
      className={`${ui.toggle} ${on ? ui.toggleOn : ""} ${className ?? ""}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    >
      <span className={ui.toggleKnob} />
    </button>
  );
}
