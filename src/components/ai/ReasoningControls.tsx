/**
 * The thinking dials, shared by the three surfaces that run a model: the task
 * panel, the conversational assistant, and 一致性检查.
 *
 * What it edits is the **active model's own setting** (`Model.reasoningEffort`),
 * not a per-run override — thinking depth is a property of the model
 * (`docs/provider-layering.md` L3), so the same value shows here and in
 * Settings › 模型, and switching models switches the value with it.
 *
 * Two dials, because at protocol level they are two axes: how deep to think,
 * and how much effort to spend on the whole response. Only the first can reach
 * an endpoint today, so the second renders disabled with its reason — see
 * `supportsSeparateEffort`. Neither is rendered as a live control for a model
 * whose protocol the adapters can't yet carry the setting to.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { useAiStore } from "../../stores/aiStore";
import {
  REASONING_EFFORTS,
  supportsSeparateEffort,
  supportsThinkingLevel,
  type ReasoningEffort,
} from "../../lib/ai/reasoning";
import styles from "./ReasoningControls.module.css";

/** The separate-effort dial's levels, for the disabled preview. */
const EFFORT_PREVIEW: ReasoningEffort[] = ["low", "medium", "high"];

function labelKeyFor(e: ReasoningEffort): string {
  return `aiConfig.models.reasoningEffort${e[0].toUpperCase()}${e.slice(1)}`;
}

interface Props {
  /**
   * `row` — labelled chip rows, for the panel's settings block.
   * `compact` — a dropdown chip, for a toolbar with no room for a row.
   */
  variant: "row" | "compact";
}

export function ReasoningControls({ variant }: Props) {
  const { t } = useTranslation();
  const model = useAiStore((s) => s.models.find((m) => m.id === s.activeModelId));
  const provider = useAiStore((s) =>
    model ? s.providers.find((p) => p.id === model.providerId) : undefined,
  );
  const updateModel = useAiStore((s) => s.updateModel);

  if (!model || !provider) return null;

  const thinkable = supportsThinkingLevel(provider.apiStandard);
  const separateEffort = supportsSeparateEffort(provider.apiStandard);
  // A model whose protocol carries neither dial gets no row at all. Rendering
  // two disabled groups would spend three lines of a crowded panel saying only
  // "here are two things you cannot do" — a disabled control earns its place by
  // sitting next to a live sibling that explains what it is, which is exactly
  // the case below, where the effort group is off but thinking is not.
  if (!thinkable && !separateEffort) return null;

  const current = model.reasoningEffort ?? "default";
  const set = (e: ReasoningEffort) => {
    // "default" is stored as absent — one representation for "send nothing".
    void updateModel({ ...model, reasoningEffort: e === "default" ? undefined : e });
  };

  if (variant === "compact") {
    return (
      <div className={styles.compactGroup}>
        <CompactDial
          label={t("ai.panel.thinkingLabel")}
          value={t(labelKeyFor(current))}
          options={REASONING_EFFORTS}
          current={current}
          onPick={set}
          disabled={!thinkable}
          disabledHint={t("ai.panel.thinkingUnsupported")}
        />
        {/* The effort dial has no compact form yet: nothing can carry it, and a
            toolbar is the wrong place to explain why. It appears in the row
            variant, where there is space for the reason. */}
      </div>
    );
  }

  return (
    <>
      <div className={styles.row}>
        <span className={styles.label}>{t("ai.panel.thinkingLabel")}</span>
        <div className={styles.chipGroup}>
          {REASONING_EFFORTS.map((e) => (
            <button
              key={e}
              className={`${styles.chip} ${current === e ? styles.chipActive : ""}`}
              onClick={() => set(e)}
              disabled={!thinkable}
              title={thinkable ? undefined : t("ai.panel.thinkingUnsupported")}
            >
              {t(labelKeyFor(e))}
            </button>
          ))}
        </div>

        <span className={`${styles.label} ${styles.labelSecondary}`}>
          {t("ai.panel.effortLabel")}
        </span>
        <div className={`${styles.chipGroup} ${separateEffort ? "" : styles.chipGroupOff}`}>
          {EFFORT_PREVIEW.map((e) => (
            <button key={e} className={styles.chip} disabled title={t("ai.panel.effortUnsupported")}>
              {t(labelKeyFor(e))}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.hint}>
        {/* Reached only when at least one dial is live (see the guard above),
            so this explains whichever one is not. */}
        {thinkable ? t("ai.panel.effortUnsupported") : t("ai.panel.thinkingUnsupported")}
      </div>
    </>
  );
}

/** A toolbar-sized dial: current value on the chip, levels in a popover. */
function CompactDial({
  label, value, options, current, onPick, disabled, disabledHint,
}: {
  label: string;
  value: string;
  options: ReasoningEffort[];
  current: ReasoningEffort;
  onPick: (e: ReasoningEffort) => void;
  disabled: boolean;
  disabledHint: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Dismiss on outside click, and on Escape in the capture phase so the key
  // doesn't also close whatever drawer this dial is sitting in.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className={styles.compactRoot} ref={root}>
      <button
        className={styles.compactTrigger}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title={disabled ? disabledHint : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {label}
        <span className={styles.compactValue}>{value}</span>
        <ChevronDown size={11} className={styles.compactCaret} />
      </button>
      {open && (
        <div className={styles.compactPopover} role="menu">
          {options.map((e) => (
            <button
              key={e}
              className={`${styles.compactItem} ${current === e ? styles.compactItemActive : ""}`}
              role="menuitemradio"
              aria-checked={current === e}
              onClick={() => { onPick(e); setOpen(false); }}
            >
              {t(`aiConfig.models.reasoningEffort${e[0].toUpperCase()}${e.slice(1)}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
