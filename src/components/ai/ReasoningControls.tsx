/**
 * The thinking dial, shared by the three surfaces that run a model: the task
 * panel, the conversational assistant, and 一致性检查.
 *
 * What it edits is the **active model's own setting** (`Model.reasoningEffort`,
 * and `Model.thinkingBudget` for budget categories), not a per-run override —
 * thinking depth is a property of the model (`docs/api/provider-layering.md`
 * L3), so the same value shows here and in Settings › 模型.
 *
 * **The dial adapts to the model's thinking category.** Each per-vendor
 * category (`resolveThinkingCategory`) declares its own legal menu, so this
 * renders exactly what the endpoint accepts: level chips for a `levels`
 * category (Gemini's minimal/low/medium/high, Qwen-Max's xhigh, …), an on/off
 * toggle for a switch-style one (MiniMax, Qwen's enable_thinking), and a token
 * field for a `budget` one (Claude extended, Qwen). The label follows what the
 * level governs — the whole response on Anthropic, thinking alone elsewhere.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { useAiStore } from "../../stores/aiStore";
import { usePopoverDismiss } from "./usePopoverDismiss";
import {
  categoryHasControl, isOnOffCategory, onEffort, resolveThinkingCategory, thinkingIsOn,
  type ReasoningEffort, type ThinkingBudgetSpec,
} from "../../lib/ai/reasoning";
import styles from "./ReasoningControls.module.css";

function labelKeyFor(e: ReasoningEffort): string {
  return `aiConfig.models.reasoningEffort${e[0].toUpperCase()}${e.slice(1)}`;
}

interface Props {
  /**
   * `row` — labelled chip rows, for the panel's settings block.
   * `compact` — a dropdown chip, for a toolbar with no room for a row.
   * `footer` — one mono word in the assistant composer's footer, with the real
   *   controls in a popover (设计稿 02g 屏 1c). The word is generated from the
   *   value, whatever shape the vendor's category has, so the setting is always
   *   readable without opening anything; the popover is headed 「写进模型行」
   *   because this is the one control in the composer that is not scoped to the
   *   conversation (屏 1z §5).
   */
  variant: "row" | "compact" | "footer";
}

/**
 * The one word the footer shows for the current value — 屏 1f's four forms:
 * a switch reads 开 / 关, a budget reads its number, a level reads its name,
 * and Qwen's switch-plus-budget reads 开 · 8192. `默认` is what "send nothing"
 * looks like, and it is the only word that is not a value.
 */
function footerValueWord(
  t: (k: string, o?: Record<string, unknown>) => string,
  cat: ReturnType<typeof resolveThinkingCategory>,
  current: ReasoningEffort,
  budget: number | undefined,
): string {
  const onOff = isOnOffCategory(cat);
  const hasBudget = cat.shape === "budget";
  const off = current === "off";
  if (onOff && hasBudget) {
    const state = off
      ? t("aiConfig.models.reasoningEffortOff")
      : t("aiConfig.models.reasoningEffortOn");
    return budget != null && !off ? `${state} · ${budget}` : state;
  }
  if (onOff) {
    return off ? t("aiConfig.models.reasoningEffortOff") : t("aiConfig.models.reasoningEffortOn");
  }
  if (hasBudget) {
    // No budget stored means the endpoint's own default — say so rather than
    // showing the placeholder number as though the author had chosen it.
    return budget != null ? String(budget) : t(labelKeyFor("default"));
  }
  return t(labelKeyFor(current));
}

export function ReasoningControls({ variant }: Props) {
  const { t } = useTranslation();
  const model = useAiStore((s) => s.models.find((m) => m.id === s.activeModelId));
  const provider = useAiStore((s) =>
    model ? s.providers.find((p) => p.id === model.providerId) : undefined,
  );
  const updateModel = useAiStore((s) => s.updateModel);

  if (!model || !provider) return null;

  const cat = resolveThinkingCategory(model, provider.apiStandard);
  // A category with no control (the `off` category, or a model that resolves to
  // it) gets no row at all, rather than a dead one: a control that never lights
  // up is worse than its absence.
  if (!categoryHasControl(cat)) return null;

  // What the level actually governs here. On Anthropic it is the whole response
  // — prose, tool calls and thinking together — so "thinking depth" understates
  // what the author is changing.
  const wholeResponse = !!cat.governsWholeResponse;
  const label = wholeResponse ? t("ai.panel.effortLabel") : t("ai.panel.thinkingLabel");

  const current = model.reasoningEffort ?? "default";
  const set = (e: ReasoningEffort) => {
    // "default" is stored as absent — one representation for "send nothing".
    void updateModel({ ...model, reasoningEffort: e === "default" ? undefined : e });
  };
  const setBudget = (v: string) => {
    const n = Math.round(Number(v));
    void updateModel({
      ...model,
      thinkingBudget: v.trim() !== "" && Number.isFinite(n) && n > 0 ? n : undefined,
    });
  };
  const budgetValue = model.thinkingBudget != null ? String(model.thinkingBudget) : "";

  const onOff = isOnOffCategory(cat);
  const hasBudget = cat.shape === "budget";
  const levels = cat.shape === "levels";

  const onOffChips = (
    <div className={styles.chipGroup}>
      <button
        className={`${styles.chip} ${thinkingIsOn(cat, current) ? styles.chipActive : ""}`}
        onClick={() => set(onEffort(cat) ?? "default")}
      >
        {t("aiConfig.models.reasoningEffortOn")}
      </button>
      <button
        className={`${styles.chip} ${current === "off" ? styles.chipActive : ""}`}
        onClick={() => set("off")}
      >
        {t("aiConfig.models.reasoningEffortOff")}
      </button>
    </div>
  );

  const budgetField = (
    <BudgetField
      value={budgetValue}
      spec={cat.budget}
      label={t("aiConfig.models.thinkingBudgetLabel")}
      onCommit={setBudget}
    />
  );

  if (variant === "footer") {
    return (
      <FooterDial
        label={label}
        value={footerValueWord(t, cat, current, model.thinkingBudget)}
      >
        {onOff && onOffChips}
        {hasBudget && (
          <div className={styles.footerField}>
            {budgetField}
            <span className={styles.footerFieldNote}>
              {t("ai.chat.thinkingBudgetUnit", { defaultValue: "tk · 失焦提交" })}
            </span>
          </div>
        )}
        {levels && (
          <div className={styles.chipGroup}>
            {cat.menu.map((e) => (
              <button
                key={e}
                className={`${styles.chip} ${current === e ? styles.chipActive : ""}`}
                onClick={() => set(e)}
              >
                {t(labelKeyFor(e))}
              </button>
            ))}
          </div>
        )}
      </FooterDial>
    );
  }

  if (variant === "compact") {
    return (
      <div className={styles.compactGroup}>
        {onOff && onOffChips}
        {hasBudget && budgetField}
        {levels && (
          <CompactDial
            label={label}
            value={t(labelKeyFor(current))}
            options={cat.menu}
            current={current}
            onPick={set}
          />
        )}
      </div>
    );
  }

  return (
    <>
      <div className={styles.row}>
        <span className={styles.label}>{label}</span>
        {onOff && onOffChips}
        {levels && (
          <div className={styles.chipGroup}>
            {cat.menu.map((e) => (
              <button
                key={e}
                className={`${styles.chip} ${current === e ? styles.chipActive : ""}`}
                onClick={() => set(e)}
              >
                {t(labelKeyFor(e))}
              </button>
            ))}
          </div>
        )}
        {hasBudget && budgetField}
      </div>
      <div className={styles.hint}>
        {hasBudget
          ? t("aiConfig.models.thinkingBudgetHint")
          : wholeResponse
            ? t("ai.panel.effortHint")
            : t("ai.panel.thinkingHint")}
      </div>
    </>
  );
}

/**
 * The composer footer's dial: the value as one mono word, the real control in
 * a popover above it (设计稿 02g 屏 1c · 1f).
 *
 * The header is not decoration. This is the only control on the composer that
 * outlives the conversation — it writes the model row, and Settings › 模型 shows
 * the same value — so the popover says so before the author changes anything
 * (屏 1z §5 weighs that against moving it up beside the model name).
 */
function FooterDial({ label, value, children }: {
  label: string;
  value: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, useCallback(() => setOpen(false), []), root);

  return (
    <div className={styles.footerRoot} ref={root}>
      <button
        type="button"
        className={styles.footerTrigger}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {label}
        <span className={styles.footerValue}>{value}</span>
        <ChevronDown size={9} className={styles.footerCaret} aria-hidden />
      </button>
      {open && (
        <div className={styles.footerPopover} role="menu">
          <div className={styles.footerHead}>
            <span className={styles.footerHeadLabel}>{label}</span>
            <span className={styles.footerHeadFill} />
            <span className={styles.footerHeadMeta}>
              {t("ai.chat.thinkingScope", { defaultValue: "写进模型行" })}
            </span>
          </div>
          <div className={styles.footerBody}>{children}</div>
        </div>
      )}
    </div>
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
              {t(labelKeyFor(e))}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The token-budget field. Holds a local draft and commits on blur / Enter, so a
 * multi-digit value is one model save, not one per keystroke — `onCommit` writes
 * the whole model row to SQLite (`aiStore.updateModel` → `saveModel`), which is
 * far too expensive to fire on every character. The draft re-syncs whenever the
 * persisted value changes (model switch, external update).
 */
function BudgetField({ value, spec, label, onCommit }: {
  value: string;
  spec?: ThinkingBudgetSpec;
  label: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <input
      className={styles.budgetInput}
      type="number"
      min={spec?.min}
      max={spec?.max}
      step={256}
      placeholder={spec ? String(spec.default) : undefined}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== value) onCommit(draft); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      aria-label={label}
    />
  );
}
