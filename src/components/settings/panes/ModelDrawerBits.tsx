/**
 * The model editor's building blocks — 设计稿 19. Kept apart from the drawer so
 * that file reads as *which* fields exist, not as how a field is drawn.
 *
 *   - `Fold`        the one animation: grid rows 0fr ↔ 1fr, both directions the
 *                   same 200ms; folded content is also hidden from focus.
 *   - `Section`     an eyebrow label that folds its body; folded, its right side
 *                   shows either the values it holds (mono) or the dashed square
 *                   + "nothing sent" line.
 *   - `Field`       label · optional unit · control · optional note / warning ·
 *                   one-line hint with a 「为什么」 that unfolds the full text.
 *   - `ToggleField` the same for a yes/no declaration, switch on the right.
 *   - `DashChip`    the shared chip plus the two states it lacks: a selected
 *                   "auto / default" is hollow and dashed (chosen, sends nothing),
 *                   and a locked value has no pointer.
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { Toggle } from "./bits";
import ui from "../settingsUi.module.css";
import s from "./ModelDrawer.module.css";

export function Fold({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className={`${s.fold} ${open ? s.foldOpen : ""}`} aria-hidden={!open}>
      <div className={s.foldInner}>{children}</div>
    </div>
  );
}

export function Section({
  label, open, onToggle, summary, unset, children,
}: {
  label: string;
  open: boolean;
  /** Absent = the section never folds (身份). */
  onToggle?: () => void;
  /** What the folded header shows on the right: values, or the "unset" line. */
  summary: string;
  /** True when nothing in the section is set — dashed square + muted text. */
  unset: boolean;
  children: ReactNode;
}) {
  const head = (
    <>
      <span className={s.secLabel}>{label}</span>
      <span className={`${s.secSum} ${unset ? s.secSumUnset : ""}`}>
        {!open && unset && <span className={s.dashMark} />}
        {!open && <span className={s.secSumText}>{summary}</span>}
      </span>
      {onToggle && (
        <ChevronDown size={11} strokeWidth={2.2} className={`${s.chevron} ${open ? s.chevronOpen : ""}`} />
      )}
    </>
  );
  return (
    <div className={s.section}>
      {onToggle ? (
        <button type="button" className={s.secHead} onClick={onToggle} aria-expanded={open}>{head}</button>
      ) : (
        <div className={`${s.secHead} ${s.secHeadStatic}`}>{head}</div>
      )}
      <Fold open={open}>
        <div className={s.secBody}>{children}</div>
      </Fold>
    </div>
  );
}

export interface WhyProps {
  /** The full explanation; absent = no 「为什么」 link. */
  why?: string;
  whyOpen?: boolean;
  onWhy?: () => void;
}

function Hint({ hint, why, whyOpen, onWhy }: { hint: string } & WhyProps) {
  const { t } = useTranslation();
  return (
    <>
      <div className={s.hint}>
        {hint}
        {why && onWhy && (
          <span
            role="button"
            tabIndex={0}
            className={s.whyLink}
            onClick={onWhy}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onWhy(); } }}
          >
            {whyOpen ? t("aiConfig.models.whyLess") : t("aiConfig.models.why")}
          </span>
        )}
      </div>
      {why && (
        <Fold open={!!whyOpen}>
          <div className={s.why}>{why}</div>
        </Fold>
      )}
    </>
  );
}

export type NoteTone = "muted" | "ok" | "faint";

export function Note({ text, tone = "muted" }: { text: string; tone?: NoteTone }) {
  return (
    <div className={`${s.note} ${tone === "ok" ? s.noteOk : ""}`}>
      {tone !== "muted" && <span className={`${s.noteDot} ${tone === "faint" ? s.noteDotFaint : ""}`} />}
      <span>{text}</span>
    </div>
  );
}

export function Field({
  label, sub, hint, note, noteTone, warn, children, ...whyProps
}: {
  label: string;
  /** A unit or qualifier beside the label — `tokens`, `USD / 1M tokens`. */
  sub?: string;
  hint: string;
  /** One mono line under the control: a resolved "auto → …" or a measured badge. */
  note?: string;
  noteTone?: NoteTone;
  /** A consequence the author must read before saving (Sakura). */
  warn?: string;
  children: ReactNode;
} & WhyProps) {
  return (
    <div className={s.field}>
      <div className={s.fieldHead}>
        <span className={s.fieldLabel}>{label}</span>
        {sub && <span className={s.fieldSub}>{sub}</span>}
      </div>
      {children}
      {note && <Note text={note} tone={noteTone} />}
      {warn && (
        <div className={s.warn}><span className={s.warnMark}>!</span><span>{warn}</span></div>
      )}
      <Hint hint={hint} {...whyProps} />
    </div>
  );
}

export function ToggleField({
  title, hint, on, onChange, ...whyProps
}: {
  title: string;
  hint: string;
  on: boolean;
  onChange: (next: boolean) => void;
} & WhyProps) {
  return (
    <div className={s.field}>
      <div className={s.toggleRow}>
        <div className={s.toggleMain}>
          <div className={s.toggleTitle}>{title}</div>
          <Hint hint={hint} {...whyProps} />
        </div>
        <Toggle on={on} onChange={onChange} label={title} className={`${s.toggleCtl} ${on ? "" : s.toggleUnset}`} />
      </div>
    </div>
  );
}

export function DashChip({
  label, active, auto, locked, onClick,
}: {
  label: string;
  active: boolean;
  /** This option means "send nothing": selected, it renders hollow and dashed. */
  auto?: boolean;
  /** The category cannot leave this value; no pointer, no-op click. */
  locked?: boolean;
  onClick: () => void;
}) {
  const cls = [
    ui.chip,
    active ? ui.chipActive : "",
    active && auto ? s.chipAuto : "",
    locked ? s.chipLocked : "",
  ].join(" ");
  return (
    <button type="button" className={cls} onClick={locked ? undefined : onClick} aria-pressed={active}>
      {label}
    </button>
  );
}

export function ChipDivider() {
  return <span className={s.chipDivider} />;
}
