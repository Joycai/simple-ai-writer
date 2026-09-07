import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { useActiveChat, useAgentStore } from "../../stores/agentStore";
import { isSkillStateEnabled } from "../../lib/agent/stateFlag";
import type { SubAgentKind } from "../../lib/agent/subagent";
import {
  useBoundModelName, useConfiguredKinds, FALLBACK_LABELS, type ChipKind,
} from "./subagentChipModel";
import { usePopoverDismiss } from "./usePopoverDismiss";
import styles from "./CapabilityMenu.module.css";

/**
 * 能力 —— the session switches, collapsed into one word (设计稿 02g 屏 1c).
 *
 * Six boxes plus 状态记忆 used to sit open on the composer, wearing the same
 * shape as the chips that carry a message's material. That row is paid for on
 * every message the author writes, and the shape said nothing about which of
 * the four kinds of control it was. So the switches collapse into a word — and
 * the word carries its own exceptions:
 *
 * **Nothing that is on may hide.** The trigger names every item in a
 * non-default state (a subagent stopped for this conversation, 状态记忆 on) and
 * drops the name again the moment it returns to default. There is no
 * hover-only state, and the count never stands in for the names (屏 1e: the row
 * wraps rather than abbreviate). All-default collapses to 「能力 6」; anything
 * off shows the fraction 「能力 4/6」 *plus* the names.
 *
 * 计划模式 is deliberately **not** in here — it is the one the author flips
 * most, so it stays outside as its own word (屏 1c「一键可达」).
 *
 * @param disabled  Session-off kinds. Chat reads its own; the roleplay panel
 *                  passes each agent's set, because four concurrent agents are
 *                  four unrelated conversations (see `SubAgentChips`' note).
 * @param onToggle  Paired with `disabled`; both or neither.
 * @param stateMemory Include the 状态记忆 row. Only the assistant has it: the
 *                  roleplay panel does not run on that mode at all, and a row
 *                  that changes nothing there would be worse than its absence.
 */
export function CapabilityMenu({ disabled, onToggle, stateMemory = false }: {
  disabled?: readonly SubAgentKind[];
  onToggle?: (kind: SubAgentKind) => void;
  stateMemory?: boolean;
} = {}) {
  const { t } = useTranslation();
  const chatDisabled = useActiveChat((c) => c.disabledSubAgents);
  const chatToggle = useAgentStore((s) => s.toggleSubAgent);
  const memoryOn = useActiveChat((c) => c.stateMemory);
  const setStateMemory = useAgentStore((s) => s.setStateMemory);
  const configuredKinds = useConfiguredKinds();
  const boundName = useBoundModelName();

  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, useCallback(() => setOpen(false), []), root);

  const disabledSubAgents = disabled ?? chatDisabled;
  const toggleSubAgent = onToggle ?? chatToggle;
  // The 状态记忆 row exists only where the surface asked for it *and* the Beta
  // is on (设置 → AI 配置 → 实验室). Absent, never disabled.
  const showMemory = stateMemory && isSkillStateEnabled();

  if (configuredKinds.length === 0 && !showMemory) return null;

  const label = (kind: ChipKind) =>
    t(`ai.chat.subagentChip.${kind}`, { defaultValue: FALLBACK_LABELS[kind] });

  const stopped = configuredKinds.filter((k) => disabledSubAgents.includes(k));
  const total = configuredKinds.length;
  const live = total - stopped.length;

  return (
    <div className={styles.root} ref={root}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("ai.chat.capabilityHint", {
          defaultValue: "本次对话可用的能力（只能关，不能在这里打开没配模型的）",
        })}
      >
        <span className={styles.triggerWord}>
          {t("ai.chat.capability", { defaultValue: "能力" })}
        </span>
        {/* All default → a bare count. Something stopped → the fraction, so the
            number itself says one is missing before the names are read. */}
        <span className={styles.count}>{stopped.length > 0 ? `${live}/${total}` : total}</span>
        {stopped.length > 0 && (
          <>
            <span className={styles.sep}>·</span>
            {/* Never truncated and never reduced to a count: this is the state,
                and 屏 1e would rather the row wrapped (see the CSS). */}
            <span className={styles.named}>
              {t("ai.chat.capabilityStopped", {
                defaultValue: "{{names}} 已停",
                names: stopped.map(label).join("、"),
              })}
            </span>
          </>
        )}
        {showMemory && memoryOn && (
          <>
            <span className={styles.sep}>·</span>
            <span className={styles.named}>
              {t("ai.chat.stateMemory", { defaultValue: "状态记忆" })}
            </span>
          </>
        )}
        <ChevronDown size={9} className={styles.caret} aria-hidden />
      </button>

      {open && (
        <div className={styles.popover} role="menu">
          <div className={styles.head}>
            <span className={styles.headLabel}>
              {t("ai.chat.capabilityScope", { defaultValue: "本次对话" })}
            </span>
            <span className={styles.headFill} />
            <span className={styles.headMeta}>
              {t("ai.chat.capabilityResets", { defaultValue: "换会话即重置" })}
            </span>
          </div>

          {configuredKinds.map((kind) => {
            const off = disabledSubAgents.includes(kind);
            return (
              <button
                key={kind}
                type="button"
                role="menuitemcheckbox"
                aria-checked={!off}
                className={`${styles.item} ${off ? styles.itemOff : ""}`}
                onClick={() => toggleSubAgent(kind)}
                // The sentence the six chips used to carry. It is also this
                // row's accessible name: the words are in nested spans, so
                // without it the menu reads as six unnamed checkboxes.
                title={off
                  ? t(`ai.chat.subagentChip.${kind}Disabled`, {
                      defaultValue: `${label(kind)}子代理已在本次对话停用（点击启用）`,
                    })
                  : t(`ai.chat.subagentChip.${kind}Active`, {
                      defaultValue: `${label(kind)}子代理已启用（点击在本次对话停用）`,
                    })}
                aria-label={label(kind)}
              >
                <span className={`${styles.mark} ${off ? styles.markOff : ""}`} aria-hidden />
                <span className={styles.itemName}>{label(kind)}</span>
                <span className={styles.itemFill} />
                {/* Off: what pressing this does, not what it is bound to — the
                    model name is what the author needs while deciding to turn
                    something off, and 「恢复」 is what they need after. */}
                {off ? (
                  <span className={styles.itemRestore}>
                    {t("ai.chat.capabilityRestore", { defaultValue: "本次已停 · 恢复" })}
                  </span>
                ) : (
                  <span className={styles.itemModel}>{boundName(kind)}</span>
                )}
              </button>
            );
          })}

          {showMemory && (
            <>
              {configuredKinds.length > 0 && <span className={styles.rule} />}
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={memoryOn}
                className={`${styles.item} ${memoryOn ? "" : styles.itemOff}`}
                onClick={() => setStateMemory(!memoryOn)}
                aria-label={t("ai.chat.stateMemory", { defaultValue: "状态记忆" })}
                title={memoryOn
                  ? t("ai.chat.stateMemoryOn", {
                      defaultValue: "状态记忆已开启：每次发送前把上一轮之前的对话折进一份结构化的执行状态，只保留上一轮原文（点击关闭）",
                    })
                  : t("ai.chat.stateMemoryOff", {
                      defaultValue: "状态记忆已关闭：对话原样累积，超过阈值再归纳成摘要（点击开启）",
                    })}
              >
                <span className={`${styles.mark} ${memoryOn ? "" : styles.markOff}`} aria-hidden />
                <span className={styles.itemName}>
                  {t("ai.chat.stateMemory", { defaultValue: "状态记忆" })}
                </span>
                <span className={styles.itemFill} />
                <span className={styles.itemModel}>
                  {t("ai.chat.stateMemoryMeta", { defaultValue: "beta · 发送前折成执行状态" })}
                </span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
