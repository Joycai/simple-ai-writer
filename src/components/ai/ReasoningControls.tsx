/**
 * The thinking dial, shared by the three surfaces that run a model: the task
 * panel, the conversational assistant, and 一致性检查.
 *
 * What it edits is the **active model's own setting** (`Model.reasoningEffort`),
 * not a per-run override — thinking depth is a property of the model
 * (`docs/provider-layering.md` L3), so the same value shows here and in
 * Settings › 模型, and switching models switches the value with it.
 *
 * **One dial, not two.** The design sketched a second "effort" dial beside the
 * thinking one, because at protocol level they are two axes: how deep to think,
 * and how much work to spend on the whole response. But no endpoint exposes
 * both as separate inputs — on the OpenAI family they collapse into one field,
 * and on Anthropic the single `output_config.effort` governs both. Two controls
 * writing one value would be a lie about what the author is choosing, so what
 * varies instead is the **label**: `supportsSeparateEffort` picks the wording
 * that matches what the level actually governs on this endpoint.
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
  // A model whose protocol can't carry the level gets no row at all, rather
  // than a disabled one: a control that never lights up is three lines of a
  // crowded panel saying "here is something you cannot do".
  if (!thinkable) return null;
  // What the level actually governs here. On Anthropic it is the whole
  // response — prose, tool calls and thinking together — so calling it
  // "thinking depth" would understate what the author is changing.
  const wholeResponse = supportsSeparateEffort(provider.apiStandard);
  const label = wholeResponse ? t("ai.panel.effortLabel") : t("ai.panel.thinkingLabel");

  const current = model.reasoningEffort ?? "default";
  const set = (e: ReasoningEffort) => {
    // "default" is stored as absent — one representation for "send nothing".
    void updateModel({ ...model, reasoningEffort: e === "default" ? undefined : e });
  };

  if (variant === "compact") {
    return (
      <div className={styles.compactGroup}>
        <CompactDial
          label={label}
          value={t(labelKeyFor(current))}
          options={REASONING_EFFORTS}
          current={current}
          onPick={set}
        />
      </div>
    );
  }

  return (
    <>
      <div className={styles.row}>
        <span className={styles.label}>{label}</span>
        <div className={styles.chipGroup}>
          {REASONING_EFFORTS.map((e) => (
            <button
              key={e}
              className={`${styles.chip} ${current === e ? styles.chipActive : ""}`}
              onClick={() => set(e)}
            >
              {t(labelKeyFor(e))}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.hint}>
        {wholeResponse ? t("ai.panel.effortHint") : t("ai.panel.thinkingHint")}
      </div>
    </>
  );
}

/** A toolbar-sized dial: current value on the chip, levels in a popover. */
function CompactDial({ label, value, options, current, onPick }: {
  label: string;
  value: string;
  options: ReasoningEffort[];
  current: ReasoningEffort;
  onPick: (e: ReasoningEffort) => void;
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
