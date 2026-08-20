/**
 * 扮演面板的外壳（设计稿 08 屏 1a / 1g）：花名册 + 对话区，没有 agent 时是空态。
 *
 * 空态是作者第一次看见这个功能的地方，所以它不是一句「暂无内容」：标题说清
 * 这功能是什么，中间给一段真的对话长什么样，底下直接列出知识库里现成的人物
 * ——从「有兴趣」到「开始」之间不该再隔一层菜单。
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "../../stores/projectStore";
import { useLoreStore } from "../../stores/loreStore";
import { useRoleplayStore } from "../../stores/roleplayStore";
import { RoleplayRoster } from "./RoleplayRoster";
import { RoleplayChat } from "./RoleplayChat";
import { AgentComposer } from "./AgentComposer";
import { ScriptText } from "./ScriptText";
import { avatarGlyph, type RoleplayAgent } from "../../lib/roleplay/model";
import styles from "./RoleplayPanel.module.css";

const SAMPLE = "*推开门，屋里没有点灯。*\n「你还在等？」";

export function RoleplayPanel() {
  const { t } = useTranslation();
  const projectPath = useProjectStore((s) => s.projectPath);
  const loreIndex = useLoreStore((s) => s.index);
  const {
    loaded, rosterError, order, agents, activeAgentId, load, reset, checkBindings, createAgent,
  } = useRoleplayStore();

  const [editing, setEditing] = useState<RoleplayAgent | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);

  useEffect(() => {
    if (projectPath) void load(projectPath);
    else reset();
  }, [projectPath, load, reset]);

  // 知识库重扫过就重新比对绑定内容——「设定已更新」那条提示靠它出现。
  // 依赖 index 的**对象身份**而不是条目数：改一段特征不会改变条目数，用计数
  // 当信号的话，最常见的一种「设定变了」恰好是它看不见的那一种。
  useEffect(() => {
    if (loaded) void checkBindings();
  }, [loreIndex, loaded, checkBindings]);

  const active = activeAgentId ? agents[activeAgentId] : null;
  const characters = Object.values(loreIndex).flat();

  if (!projectPath) {
    return (
      <div className={styles.blank}>
        {t("roleplay.noProject", { defaultValue: "先打开一个项目。" })}
      </div>
    );
  }

  if (!loaded) return <div className={styles.blank} />;

  const openNew = () => { setEditing(null); setComposerOpen(true); };

  if (order.length === 0) {
    return (
      <>
        <div className={styles.empty}>
          <div className={styles.emptyInner}>
            <div className={styles.emptyTitle}>
              {t("roleplay.empty.title", { defaultValue: "和你写的人对话，用第一人称。" })}
            </div>
            <div className={styles.emptyBody}>
              {t("roleplay.empty.body", {
                defaultValue: "挑一个人物条目，AI 就演他。你说台词、写动作、描述环境，他按自己的设定回你。每个角色的记忆完全独立，互相不知道对方存在。",
              })}
            </div>

            <div className={styles.sample}>
              <div className={styles.sampleLabel}>
                {t("roleplay.empty.sampleLabel", { defaultValue: "看起来像这样" })}
              </div>
              <div className={styles.sampleBody}>
                <ScriptText text={SAMPLE} />
              </div>
            </div>

            <div className={styles.emptyActions}>
              <button type="button" className={styles.primaryBtn} onClick={openNew}>
                {t("roleplay.empty.pickCharacter", { defaultValue: "选一个人物开始" })}
              </button>
              <button
                type="button"
                className={styles.ghostBtn}
                onClick={() => void createAgent({
                  kind: "narrator",
                  name: t("roleplay.kind.narrator", { defaultValue: "旁白" }),
                  primaryDirPath: null,
                  boundPaths: [],
                  modelId: null,
                  instruction: "",
                })}
              >
                {t("roleplay.empty.newNarrator", { defaultValue: "建一个旁白" })}
              </button>
              <div className={styles.spacer} />
              <span className={styles.emptyNote}>
                {t("roleplay.empty.narratorNote", { defaultValue: "旁白不演人，帮你把互动写进正文" })}
              </span>
            </div>

            {characters.length > 0 && (
              <div className={styles.readyList}>
                <div className={styles.readyLabel}>
                  {t("roleplay.empty.ready", { n: characters.length, defaultValue: `知识库里现成的条目 · ${characters.length}` })}
                </div>
                <div className={styles.readyChips}>
                  {characters.slice(0, 6).map((e) => (
                    <button
                      key={e.dirPath}
                      type="button"
                      className={styles.readyChip}
                      onClick={() => void createAgent({
                        kind: "character",
                        name: e.name,
                        primaryDirPath: e.dirPath,
                        boundPaths: [],
                        modelId: null,
                        instruction: "",
                      })}
                    >
                      <span className={styles.readyAvatar}>{avatarGlyph(e.name)}</span>
                      {e.name}
                    </button>
                  ))}
                  {characters.length > 6 && (
                    <span className={styles.readyMore}>
                      {t("roleplay.empty.more", { n: characters.length - 6, defaultValue: `还有 ${characters.length - 6} 个…` })}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
        {composerOpen && <AgentComposer editing={null} onClose={() => setComposerOpen(false)} />}
      </>
    );
  }

  return (
    <>
      {rosterError && <div className={styles.rosterError}>{rosterError}</div>}
      <div className={styles.split}>
        <RoleplayRoster onNew={openNew} />
        {active ? (
          <RoleplayChat
            key={active.id}
            agent={active}
            onEdit={() => { setEditing(active); setComposerOpen(true); }}
          />
        ) : (
          <div className={styles.pickPrompt}>
            {t("roleplay.pickAgent", { defaultValue: "从左边挑一个 agent 开始说话。" })}
          </div>
        )}
      </div>
      {composerOpen && (
        <AgentComposer editing={editing} onClose={() => { setComposerOpen(false); setEditing(null); }} />
      )}
    </>
  );
}
