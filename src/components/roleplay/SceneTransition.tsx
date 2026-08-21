/**
 * 转场。设计见 `docs/feature/roleplay/06-scene-and-memory-area.md` §5。
 *
 * **设计稿（TURN 2 屏 2a/2b）还没到，这一屏是按现有视觉语言自己定的**——和第一轮
 * 的记事本面板一样。拿到稿子时要和它对齐，不是当空白重画。
 *
 * 为什么是一个独立的面板而不是 footer 上的就地确认条（`newSession` 原来那样）：
 * 「接续」这一支要跑一次模型，而它的产物会成为角色的长期记忆——那份东西**必须
 * 让作者先看见、能改**，再落盘。一行确认条装不下这件事。
 *
 * 但它也刻意不大：转场是作者一天可能按好几次的操作，不是一次郑重其事的决定。
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { useRoleplayStore } from "../../stores/roleplayStore";
import type { SceneRecap } from "../../lib/roleplay/recap";
import type { RoleplayAgent } from "../../lib/roleplay/model";
import styles from "./SceneTransition.module.css";

type Mode = "fresh" | "continue";

export function SceneTransition({ agent, turnCount, onClose }: {
  agent: RoleplayAgent;
  turnCount: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { newSession, previewRecap } = useRoleplayStore();

  const [mode, setMode] = useState<Mode>("continue");
  const [clearMemory, setClearMemory] = useState(false);
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  /** 跑出来的前情。在它落盘之前作者可以改。 */
  const [recap, setRecap] = useState<SceneRecap | null>(null);
  const [failed, setFailed] = useState(false);

  const empty = turnCount === 0;

  const run = async () => {
    setBusy(true);
    setFailed(false);
    const result = await previewRecap(agent.id, brief);
    setBusy(false);
    if (!result) { setFailed(true); return; }
    setRecap(result);
  };

  const commit = () => {
    void newSession(agent.id, mode === "continue"
      ? { mode: "continue", recap: recap ?? undefined }
      : { mode: "fresh", clearMemory });
    onClose();
  };

  return (
    <>
      <div className={styles.scrim} onClick={busy ? undefined : onClose} />
      <div className={styles.card} role="dialog" aria-modal>
        <header className={styles.head}>
          <span className={styles.title}>
            {t("roleplay.transition.title", { defaultValue: "转场" })}
          </span>
          <span className={styles.scale}>
            {t("roleplay.transition.scale", {
              n: turnCount, defaultValue: `当前这一场 ${turnCount} 轮`,
            })}
          </span>
          <div className={styles.spacer} />
          <button type="button" className={styles.iconBtn} onClick={onClose} disabled={busy}>
            <X size={14} strokeWidth={1.8} />
          </button>
        </header>

        <div className={styles.body}>
          {/* 两支的差别是「前情留不留」，不是「归不归档」——两边都归档。文案要
              说的是这一点，不是文件搬去哪。 */}
          <div className={styles.modes}>
            <button
              type="button"
              className={`${styles.mode} ${mode === "continue" ? styles.modeOn : ""}`}
              onClick={() => { setMode("continue"); setRecap(null); }}
              disabled={busy}
            >
              <span className={styles.modeName}>
                {t("roleplay.transition.continue", { defaultValue: "接续" })}
              </span>
              <span className={styles.modeDesc}>
                {t("roleplay.transition.continueDesc", {
                  name: agent.name,
                  defaultValue: `换个地方继续。细节不再带着，但${agent.name}会记得刚才发生了什么。`,
                })}
              </span>
            </button>
            <button
              type="button"
              className={`${styles.mode} ${mode === "fresh" ? styles.modeOn : ""}`}
              onClick={() => { setMode("fresh"); setRecap(null); }}
              disabled={busy}
            >
              <span className={styles.modeName}>
                {t("roleplay.transition.fresh", { defaultValue: "另起一场" })}
              </span>
              <span className={styles.modeDesc}>
                {t("roleplay.transition.freshDesc", {
                  defaultValue: "和刚才无关。这一场整个封存，不留前情。",
                })}
              </span>
            </button>
          </div>

          {mode === "continue" && !recap && (
            <div className={styles.section}>
              <div className={styles.label}>
                {t("roleplay.transition.briefLabel", { defaultValue: "摘要侧重" })}
                <span className={styles.labelNote}>
                  {t("roleplay.transition.briefNote", { defaultValue: "可留空" })}
                </span>
              </div>
              <textarea
                className={styles.brief}
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                disabled={busy}
                placeholder={t("roleplay.transition.briefPlaceholder", {
                  defaultValue: "重点记下和塔有关的。留空则由角色自己决定记住什么。",
                })}
              />
              {empty && (
                <div className={styles.note}>
                  {t("roleplay.transition.emptyScene", {
                    defaultValue: "这一场还没有对话，没有可以摘要的东西。",
                  })}
                </div>
              )}
              {failed && (
                <div className={styles.failed}>
                  {t("roleplay.transition.failed", {
                    defaultValue: "前情没跑出来。可以重试，或者改用「另起一场」。",
                  })}
                </div>
              )}
            </div>
          )}

          {/* 落盘之前先给作者看。这份东西会成为角色的长期记忆，不该在他没看见
              的时候就写进去。 */}
          {mode === "continue" && recap && (
            <div className={styles.section}>
              <div className={styles.label}>
                {t("roleplay.transition.recapLabel", { name: agent.name, defaultValue: `${agent.name}会记住的` })}
              </div>
              <input
                className={styles.recapTitle}
                value={recap.title}
                onChange={(e) => setRecap({ ...recap, title: e.target.value })}
              />
              <textarea
                className={styles.recapBody}
                value={recap.body}
                onChange={(e) => setRecap({ ...recap, body: e.target.value })}
              />
              {/* 关键字现在还没人读（记忆区是下一期），但已经在往盘上写——所以
                  它必须可见可改，而不是一个作者看不到的隐藏字段。 */}
              <div className={styles.keysRow}>
                <span className={styles.keysLabel}>
                  {t("roleplay.transition.keys", { defaultValue: "关键字" })}
                </span>
                <input
                  className={styles.keysInput}
                  value={recap.keys.join(" ")}
                  onChange={(e) => setRecap({
                    ...recap,
                    keys: e.target.value.split(/\s+/).map((k) => k.trim()).filter(Boolean),
                  })}
                  placeholder={t("roleplay.transition.keysPlaceholder", { defaultValue: "空格分隔" })}
                />
              </div>
              <div className={styles.note}>
                {t("roleplay.transition.keysNote", {
                  defaultValue: "关键字用于以后把这段记忆找回来。这一期还没接上检索，先存着。",
                })}
              </div>
            </div>
          )}

          {mode === "fresh" && (
            <div className={styles.section}>
              <label className={styles.checkRow}>
                <input
                  type="checkbox"
                  checked={clearMemory}
                  onChange={(e) => setClearMemory(e.target.checked)}
                />
                {t("roleplay.transition.alsoMemory", { defaultValue: "同时清空记忆" })}
              </label>
              <div className={styles.note}>
                {t("roleplay.transition.clearNote", {
                  defaultValue: "不勾选时，约定、待办、关系都留着——换一场戏不该让角色忘掉约好的事。",
                })}
              </div>
            </div>
          )}
        </div>

        <footer className={styles.foot}>
          <span className={styles.hint}>
            {t("roleplay.transition.archiveNote", {
              defaultValue: "对话不会被删除，移进存档，随时可以翻回去看。",
            })}
          </span>
          <div className={styles.spacer} />
          <button type="button" className={styles.ghostBtn} onClick={onClose} disabled={busy}>
            {t("common.cancel", { defaultValue: "取消" })}
          </button>
          {mode === "continue" && !recap ? (
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={() => void run()}
              disabled={busy || empty}
            >
              {busy
                ? t("roleplay.transition.running", { defaultValue: "正在回忆…" })
                : failed
                  ? t("roleplay.transition.retry", { defaultValue: "重试" })
                  : t("roleplay.transition.makeRecap", { defaultValue: "生成前情" })}
            </button>
          ) : (
            <button type="button" className={styles.primaryBtn} onClick={commit}>
              {t("roleplay.transition.go", { defaultValue: "转场" })}
            </button>
          )}
        </footer>
      </div>
    </>
  );
}
