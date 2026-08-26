/**
 * 输入框上边那条线（设计稿 12 · 屏 5a / 8a）。
 *
 * 前六个子代理开关是「这个能力可用」——一排等大的方框，开着也不一定用得上。写手
 * 是「从现在起每句话都由它写」：它一定会生效，而且改变每一轮的成本和时长。第七个
 * 一模一样的方框，会把这一排里最有后果的开关归进最没后果的形状。
 *
 * 所以它**从方框里出来，变成输入框上边那条分隔线本身**：无框、贯通整宽、位置固定
 * 在芯片行之上。密度不同，层级也就不同。它和回复左槽那道竖线是同一个记号系统——
 * 13px 横刻度起头、发丝线贯通：上边这条说「接下来谁写」，回复左边那条说「这段是
 * 谁写的」。
 *
 * 角色扮演面板不渲染它，也不渲染第七个芯片。那里不经过写手，而一个按下去没反应的
 * 开关比没有开关更糟——作者在两个面板间来回时唯一的差别是「上面那条线没了」，这
 * 本身就是最准确的说明。
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAiStore } from "../../stores/aiStore";
import { useAgentStore } from "../../stores/agentStore";
import { useAppStore } from "../../stores/appStore";
import { subAgentModel, withSessionOverrides } from "../../lib/agent/subagent";
import { readPref, writePref } from "../../lib/prefs";
import styles from "./WriterTurn.module.css";

/** Has the author been told, once, what changed? See {@link WriterIntro}. */
export function writerIntroSeen(): boolean {
  return readPref("ai:writerIntroSeen") === "1";
}
export function markWriterIntroSeen(seen: boolean): void {
  writePref("ai:writerIntroSeen", seen ? "1" : "0");
}

/** Seconds since `since`, ticking — only mounted while the writer is composing. */
function useElapsed(since: number | null): number {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (since === null) return;
    setSecs(Math.floor((Date.now() - since) / 1000));
    const id = window.setInterval(() => setSecs(Math.floor((Date.now() - since) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [since]);
  return secs;
}

export function WriterStrip({ composingSince }: {
  /** Epoch ms the current turn handed off, or null when nothing is composing. */
  composingSince: number | null;
}) {
  const { t } = useTranslation();
  const subAgents = useAiStore((s) => s.subAgents);
  const models = useAiStore((s) => s.models);
  const disabled = useAgentStore((s) => s.disabledSubAgents);
  const toggleSubAgent = useAgentStore((s) => s.toggleSubAgent);
  const openSettings = useAppStore((s) => s.openSettings);
  const elapsed = useElapsed(composingSince);

  const cfg = subAgents.writer;
  // Settings hasn't enabled it: this line does not exist. Not a disabled line —
  // absent. The composer looks exactly like it did before the feature shipped.
  if (!cfg?.enabled) return null;

  const offThisSession = disabled.includes("writer");
  const live = subAgentModel("writer", models, withSessionOverrides(subAgents, disabled)) !== null;
  const bound = subAgentModel("writer", models, subAgents);

  if (offThisSession) {
    return (
      <div className={styles.strip}>
        <span className={`${styles.stripTick} ${styles.stripTickOff}`} />
        <span className={`${styles.stripLabel} ${styles.stripLabelOff}`}>
          {t("ai.writer.stripOff")}
        </span>
        <span className={styles.stripCostOff}>{t("ai.writer.stripOffWho")}</span>
        <span className={styles.stripFillOff} />
        <button
          type="button"
          className={`${styles.stripAction} ${styles.stripActionAccent}`}
          onClick={() => toggleSubAgent("writer")}
        >
          {t("ai.writer.stripRestore")}
        </button>
      </div>
    );
  }

  // Enabled, but nothing usable is bound — the turn will refuse rather than
  // answer, so say it here instead of letting the author find out by sending.
  if (!bound) {
    return (
      <div className={styles.strip}>
        <span className={styles.stripTick} />
        <span className={styles.stripLabel}>{t("ai.writer.stripNoModel")}</span>
        <span className={styles.stripFill} />
        <button
          type="button"
          className={`${styles.stripAction} ${styles.stripActionAccent}`}
          onClick={() => openSettings("subagents")}
        >
          {t("ai.writer.goToSettingsShort")}
        </button>
      </div>
    );
  }

  if (composingSince !== null && live) {
    return (
      <div className={styles.strip}>
        <span className={`${styles.stripTick} ${styles.stripTickLive}`} />
        <span className={`${styles.stripLabel} ${styles.stripLabelLive}`}>
          {t("ai.writer.stripComposing")}
        </span>
        <span className={styles.stripPulse} />
        <span className={styles.stripFill} />
        <span className={styles.stripCost}>{elapsed}s</span>
      </div>
    );
  }

  return (
    <div className={styles.strip}>
      <span className={styles.stripTick} />
      <span className={styles.stripLabel}>{t("ai.writer.stripOn")}</span>
      <span className={styles.stripModel}>{bound.name}</span>
      {/* 代价写在这里，常驻，一句陈述——不是一个需要点掉的警告横幅。 */}
      <span className={styles.stripCost}>{t("ai.writer.twoRequests")}</span>
      <span className={styles.stripFill} />
      <button
        type="button"
        className={styles.stripAction}
        onClick={() => toggleSubAgent("writer")}
      >
        {t("ai.writer.stripOffAction")}
      </button>
    </div>
  );
}

/**
 * 第一次打开开关之后说一次的话。
 *
 * 不是模态，不压暗背景，不挡住任何东西：它就长在**刚刚变了的那条线上面**，与线
 * 共享同一个刻度起头，所以「说明」和「被说明的东西」在同一列。关掉后不再出现，
 * 设置卡上留一个「再看一次说明」。
 */
export function WriterIntro({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useTranslation();
  const subAgents = useAiStore((s) => s.subAgents);
  const models = useAiStore((s) => s.models);
  const toggleSubAgent = useAgentStore((s) => s.toggleSubAgent);
  const bound = subAgentModel("writer", models, subAgents);

  return (
    <div className={styles.intro}>
      <div className={styles.introHead}>
        <span className={styles.stripTick} />
        <span className={styles.introTitle}>{t("ai.writer.introTitle")}</span>
        <span className={styles.introOnce}>{t("ai.writer.introOnce")}</span>
      </div>
      <div className={styles.introList}>
        {[1, 2, 3].map((n) => (
          <div className={styles.introItem} key={n}>
            <span className={styles.introNo}>{String(n).padStart(2, "0")}</span>
            <span className={styles.introText}>
              {n === 1 ? (
                <>
                  {t("ai.writer.intro1a")}
                  <span className={styles.introMono}>{bound?.name ?? ""}</span>
                  {t("ai.writer.intro1b")}
                </>
              ) : (
                t(`ai.writer.intro${n}`)
              )}
            </span>
          </div>
        ))}
      </div>
      <div className={styles.introActions}>
        <button
          type="button"
          className={`${styles.stripAction} ${styles.stripActionAccent}`}
          onClick={onDismiss}
        >
          {t("ai.writer.introOk")}
        </button>
        <button
          type="button"
          className={styles.stripAction}
          onClick={() => { toggleSubAgent("writer"); onDismiss(); }}
        >
          {t("ai.writer.introOff")}
        </button>
      </div>
    </div>
  );
}
