/**
 * 转场。设计稿 08 TURN 2 屏 2a / 2b；功能设计见
 * `docs/feature/roleplay/06-scene-and-memory-area.md` §5。
 *
 * **就地向上展开，不是弹层。** 第一版做成了 560px 居中卡片，稿子否掉了：转场是
 * 作者一天可能用好几次的操作，「不居中、不遮挡、不加第二层阴影——只是从一行变成
 * 了一块」。
 *
 * 两支的差别用**一道线**表达，不用图标也不用第二个颜色：另起一场是**断掉的线**
 * （＝什么都不带过去），接续是**中间嵌一个赭石实心方块的线**（＝带一块东西过去）。
 *
 * 三态在同一块里原地替换：选择 → 生成中 → 预览确认。预览是**最后一次拦住模型
 * 写进角色脑子的机会**，所以确认按钮说的是「封存并开始」，不是「保存」。
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { useRoleplayStore } from "../../stores/roleplayStore";
import { estimateTextTokens } from "../../lib/ai/tokenEstimate";
import type { SceneRecap } from "../../lib/roleplay/recap";
import type { RoleplayAgent, SceneTurn } from "../../lib/roleplay/model";
import styles from "./SceneTransition.module.css";

type Mode = "fresh" | "continue";

function formatTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

export function SceneTransition({ agent, turns, sceneNo, onClose }: {
  agent: RoleplayAgent;
  turns: readonly SceneTurn[];
  /** 这是第几场：归档数 + 1。稿面和这里说的必须是同一个数。 */
  sceneNo: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { newSession, previewRecap } = useRoleplayStore();

  const [mode, setMode] = useState<Mode>("continue");
  const [clearMemory, setClearMemory] = useState(false);
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [seconds, setSeconds] = useState(0);
  /** 跑出来的前情。在它落盘之前作者可以改。 */
  const [recap, setRecap] = useState<SceneRecap | null>(null);
  const [newKey, setNewKey] = useState("");
  const [failed, setFailed] = useState(false);

  const empty = turns.length === 0;
  const tokens = estimateTextTokens(turns.map((x) => x.text).join("\n"));

  // Esc 收起。跑着的时候不收——那一步有自己的「取消」，而误触 Esc 丢掉一次已经
  // 花掉的模型调用是很恼人的。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) { e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  useEffect(() => {
    if (!busy) { setSeconds(0); return; }
    const started = Date.now();
    const id = window.setInterval(() => setSeconds((Date.now() - started) / 1000), 100);
    return () => window.clearInterval(id);
  }, [busy]);

  const run = async () => {
    setBusy(true);
    setFailed(false);
    const result = await previewRecap(agent.id, brief);
    setBusy(false);
    if (!result) { setFailed(true); return; }
    setRecap(result);
  };

  /** 「另起一场」：这一场作废。本场记下的东西一并丢弃，归档打废弃标记。 */
  const commitFresh = () => {
    void newSession(agent.id, { mode: "fresh", clearMemory });
    onClose();
  };

  /**
   * 预览态的两个出口。**都是接续**——作者点进这里的时候已经选了「这一场算数」。
   *
   * 设计稿 2b 的注解说「不要前情」按另起一场落地，那在当时是对的：那时两支的
   * 差别只是「留不留前情」。现在「另起一场」＝**这一场作废**，再让一个「这份
   * 摘要写得不好」的按钮落到那条路上，就是拿一次文字上的不满意去删掉整整一场。
   * 所以它走的是接续里不带 recap 的那一支：照常分拣、照常算正史，只是常驻层
   * 不多一条前情。
   */
  const commitContinue = (withRecap: boolean) => {
    void newSession(agent.id, withRecap && recap
      ? { mode: "continue", recap }
      : { mode: "continue" });
    onClose();
  };

  const scale = t("roleplay.transition.scale", {
    scene: sceneNo, n: turns.length, tok: formatTokens(tokens),
    defaultValue: `当前第 ${sceneNo} 场 · ${turns.length} 轮 · 约 ${formatTokens(tokens)} tok`,
  });

  // ── 生成中：原地替换整块 ────────────────────────────────────────────────
  if (busy) {
    return (
      <div className={styles.block}>
        <div className={styles.runHead}>
          <span className={styles.spinner} aria-hidden />
          <span className={styles.runTitle}>
            {t("roleplay.transition.working", { name: agent.name, defaultValue: `${agent.name}在整理这一场` })}
          </span>
          <div className={styles.spacer} />
          <span className={styles.mono}>
            {t("roleplay.transition.runClock", {
              n: turns.length, s: seconds.toFixed(1),
              defaultValue: `${turns.length} 轮 · ${seconds.toFixed(1)}s`,
            })}
          </span>
        </div>
        <div className={styles.steps}>
          <div className={styles.step}>
            <span className={styles.stepDone} aria-hidden />
            <span className={styles.stepText}>
              {t("roleplay.transition.stepRead", { n: turns.length, defaultValue: `读完 ${turns.length} 轮` })}
            </span>
          </div>
          {brief.trim() && (
            <div className={styles.step}>
              <span className={styles.stepDone} aria-hidden />
              <span className={styles.stepText}>
                {t("roleplay.transition.stepBrief", { brief: brief.trim(), defaultValue: `侧重：${brief.trim()}` })}
              </span>
            </div>
          )}
          <div className={styles.step}>
            <span className={styles.stepLive} aria-hidden />
            <span className={styles.stepTextLive}>
              {t("roleplay.transition.stepWrite", { defaultValue: "写前情与关键字" })}
            </span>
          </div>
        </div>
        <div className={styles.foot}>
          <span className={styles.mono}>
            {t("roleplay.transition.runNote", { defaultValue: "生成完才封存，中途取消不影响这一场" })}
          </span>
          <div className={styles.spacer} />
          <button type="button" className={styles.linkBtn} onClick={onClose}>
            {t("common.cancel", { defaultValue: "取消" })}
          </button>
        </div>
      </div>
    );
  }

  // ── 预览：落盘之前的最后一次拦截 ────────────────────────────────────────
  if (recap) {
    const addKey = () => {
      const k = newKey.trim();
      if (!k || recap.keys.includes(k)) { setNewKey(""); return; }
      setRecap({ ...recap, keys: [...recap.keys, k] });
      setNewKey("");
    };
    return (
      <div className={styles.block}>
        <div className={styles.head}>
          <span className={styles.title}>
            {t("roleplay.transition.previewTitle", {
              name: agent.name, defaultValue: `这份前情将成为${agent.name}的记忆`,
            })}
          </span>
          <div className={styles.spacer} />
          <span className={styles.tierChip}>
            {t("roleplay.transition.tierChip", { defaultValue: "常驻 · 下次转场沉入记忆区" })}
          </span>
        </div>

        <div className={styles.field}>
          <div className={styles.fieldLabel}>
            {t("roleplay.transition.fieldTitle", { defaultValue: "标题" })}
          </div>
          <input
            className={styles.titleInput}
            value={recap.title}
            onChange={(e) => setRecap({ ...recap, title: e.target.value })}
          />
        </div>

        <div className={styles.field}>
          <div className={styles.fieldLabel}>
            {t("roleplay.transition.fieldBody", { defaultValue: "正文" })}
            <span className={styles.fieldNote}>
              {t("roleplay.transition.bodyNote", {
                name: agent.name, defaultValue: `以${agent.name}的口吻，不是旁白`,
              })}
            </span>
            <div className={styles.spacer} />
            <span className={styles.mono}>
              {t("roleplay.transition.charCount", {
                n: recap.body.length, defaultValue: `${recap.body.length} 字`,
              })}
            </span>
          </div>
          <textarea
            className={styles.bodyInput}
            value={recap.body}
            onChange={(e) => setRecap({ ...recap, body: e.target.value })}
          />
        </div>

        {/* 关键字是芯片而不是一行文本：它们是一组独立的东西，每个都要能单独去掉。
            现在还没人读它（记忆区是下一期），但已经在往盘上写，所以必须可见可改。 */}
        <div className={styles.field}>
          <div className={styles.fieldLabel}>
            {t("roleplay.transition.keys", { defaultValue: "关键字" })}
            <span className={styles.fieldNote}>
              {t("roleplay.transition.keysNote", { defaultValue: "日后靠它被想起" })}
            </span>
          </div>
          <div className={styles.keys}>
            {recap.keys.map((k) => (
              <button
                key={k}
                type="button"
                className={styles.key}
                onClick={() => setRecap({ ...recap, keys: recap.keys.filter((x) => x !== k) })}
              >
                {k}
                <X size={8} strokeWidth={2.4} />
              </button>
            ))}
            <span className={styles.keyAdd}>
              <Plus size={9} strokeWidth={2.2} />
              <input
                className={styles.keyInput}
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addKey(); } }}
                onBlur={addKey}
                placeholder={t("roleplay.transition.keys", { defaultValue: "关键字" })}
              />
            </span>
          </div>
        </div>

        <div className={styles.foot}>
          <button type="button" className={styles.linkBtn} onClick={() => setRecap(null)}>
            {t("roleplay.transition.regen", { defaultValue: "重新生成" })}
          </button>
          <span className={styles.footSep} />
          <span className={styles.mono}>
            {t("roleplay.transition.readScope", { n: turns.length, defaultValue: `读这 ${turns.length} 轮` })}
          </span>
          <div className={styles.spacer} />
          {/* 不是「取消转场」——它按另起一场落地。 */}
          <button type="button" className={styles.ghostBtn} onClick={() => commitContinue(false)}>
            {t("roleplay.transition.noRecap", { defaultValue: "不要前情" })}
          </button>
          <button type="button" className={styles.primaryBtn} onClick={() => commitContinue(true)}>
            {t("roleplay.transition.commit", { defaultValue: "封存并开始" })}
          </button>
        </div>
      </div>
    );
  }

  // ── 选择 ────────────────────────────────────────────────────────────────
  return (
    <div className={styles.block}>
      <div className={styles.head}>
        <span className={styles.title}>{t("roleplay.transition.title", { defaultValue: "转场" })}</span>
        <span className={styles.mono}>{scale}</span>
        <div className={styles.spacer} />
        <span className={styles.esc}>{t("roleplay.transition.esc", { defaultValue: "Esc 收起" })}</span>
      </div>

      <div className={styles.modes}>
        <button
          type="button"
          className={`${styles.mode} ${mode === "fresh" ? styles.modeOn : ""}`}
          onClick={() => setMode("fresh")}
        >
          <span className={styles.modeHead}>
            <span className={styles.radio} />
            <span className={styles.modeName}>
              {t("roleplay.transition.fresh", { defaultValue: "另起一场" })}
            </span>
          </span>
          {/* 断掉的线＝什么都不带过去。 */}
          <span className={styles.markRow}>
            <span className={styles.markLine} />
            <span className={styles.markStop} />
            <span className={styles.spacer} />
            <span className={styles.markLabel}>
              {t("roleplay.transition.freshMark", { defaultValue: "这一场作废" })}
            </span>
          </span>
          <span className={styles.modeDesc}>
            {t("roleplay.transition.freshDesc", {
              defaultValue: "试的、演砸的。这一场不算数：角色不会记得，旁白也不会读到。",
            })}
          </span>
        </button>

        <button
          type="button"
          className={`${styles.mode} ${mode === "continue" ? styles.modeOn : ""}`}
          onClick={() => setMode("continue")}
        >
          <span className={styles.modeHead}>
            <span className={styles.radio} />
            <span className={styles.modeName}>
              {t("roleplay.transition.continue", { defaultValue: "接续" })}
            </span>
          </span>
          {/* 中间嵌一个实心方块的线＝带一块东西过去。 */}
          <span className={styles.markRow}>
            <span className={styles.markLine} />
            <span className={styles.markBlock} />
            <span className={styles.markLineOn} />
            <span className={styles.markLabel}>
              {t("roleplay.transition.continueMark", { defaultValue: "留一份前情" })}
            </span>
          </span>
          <span className={styles.modeDesc}>
            {t("roleplay.transition.continueDesc", {
              defaultValue: "这一场算数。换个地方继续：细节封存，前情跟着走。",
            })}
          </span>
        </button>
      </div>

      {/* 两支各带一个附加项，位置相同、只出现一个。 */}
      {mode === "continue" ? (
        <div className={styles.field}>
          <div className={styles.fieldLabel}>
            {t("roleplay.transition.briefLabel", { defaultValue: "摘要侧重" })}
            <span className={styles.fieldNoteItalic}>
              {t("roleplay.transition.briefNote", { defaultValue: "可留空" })}
            </span>
          </div>
          <textarea
            className={styles.brief}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder={t("roleplay.transition.briefPlaceholder", {
              name: agent.name, defaultValue: `留空则由${agent.name}自己决定记住什么`,
            })}
          />
          {failed && (
            <div className={styles.failed}>
              {t("roleplay.transition.failed", {
                defaultValue: "前情没跑出来。可以重试，或者改用「另起一场」。",
              })}
            </div>
          )}
        </div>
      ) : (
        <div className={styles.field}>
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={clearMemory}
              onChange={(e) => setClearMemory(e.target.checked)}
            />
            {t("roleplay.transition.alsoMemory", { defaultValue: "连更早的记忆一起清空" })}
          </label>
          <div className={styles.checkNote}>
            {t("roleplay.transition.clearNote", {
              defaultValue: "这一场记下的东西本来就会作废。勾上它，连更早的约定、待办和关系也一并清掉——推倒重来。",
            })}
          </div>
        </div>
      )}

      <div className={styles.archiveNote}>
        <span className={styles.boxIcon} aria-hidden />
        <span>
          {/* 「作废」是语义上的，不是物理上的：文件一个字都不删，作者随时能翻回来读。
              这一句是那个区别唯一被说出来的地方，所以两支各说各的。 */}
          {mode === "fresh"
            ? t("roleplay.transition.archiveNoteFresh", {
              n: turns.length,
              defaultValue: `对话不会被删除。这 ${turns.length} 轮移进存档并标为作废——你仍然能翻回来读，只是角色和旁白不会。`,
            })
            : t("roleplay.transition.archiveNote", {
              n: turns.length,
              defaultValue: `对话不会被删除。这 ${turns.length} 轮移进存档，随时可以翻回来读。`,
            })}
        </span>
      </div>

      <div className={styles.foot}>
        <span className={styles.mono}>
          {mode === "continue"
            ? t("roleplay.transition.nextStep", { defaultValue: "下一步：生成前情 · 你可以改" })
            : t("roleplay.transition.freshStep", { defaultValue: "不生成前情 · 这一场作废" })}
        </span>
        <div className={styles.spacer} />
        <button type="button" className={styles.ghostBtn} onClick={onClose}>
          {t("common.cancel", { defaultValue: "取消" })}
        </button>
        <button
          type="button"
          className={styles.primaryBtn}
          onClick={() => (mode === "continue" ? void run() : commitFresh())}
          disabled={mode === "continue" && empty}
        >
          {mode === "continue"
            ? t("roleplay.transition.goContinue", { defaultValue: "接续这一场" })
            : t("roleplay.transition.goFresh", { defaultValue: "另起一场" })}
        </button>
      </div>
    </div>
  );
}
