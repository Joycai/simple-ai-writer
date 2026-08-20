/**
 * 新建 / 编辑 agent 的二层抽屉（设计稿 08 屏 1f，760px）。
 *
 * 绑定选择器是这个抽屉里唯一复杂的东西：左边条目、右边该条目的特征，勾选
 * 到底部的芯片行。作者可能有几十个条目、上百段特征，所以计数（`3/6`）落在
 * 条目行上——不点进去也知道哪条已经绑了东西。
 *
 * 选「旁白」时隐去主角一节，其余相同。
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Search, X } from "lucide-react";
import { useLoreStore } from "../../stores/loreStore";
import { useRoleplayStore, type AgentDraft } from "../../stores/roleplayStore";
import { ModelSelector } from "../ai/ModelSelector";
import { loadPersonaCard } from "../../lib/roleplay/store";
import { useProjectStore } from "../../stores/projectStore";
import { avatarGlyph, type AgentKind, type RoleplayAgent } from "../../lib/roleplay/model";
import type { LoreEntity } from "../../lib/lore/model";
import styles from "./AgentComposer.module.css";

/**
 * 特征的 token 估算只有字数可用——特征正文是懒加载的，为了一个参考数字去读
 * 几十个文件不值得。按 CJK 一字一 token 折算，与 lib/ai/tokenEstimate 的
 * 启发式同口径；这个数字的用途是让作者看出「这条很大」，不是计费。
 */
function facetTokens(chars: number): number {
  return Math.max(1, chars);
}

function pinFor(entity: LoreEntity, facetFile?: string): string {
  return facetFile ? `${entity.dirPath}#${facetFile}` : entity.dirPath;
}

export function AgentComposer({
  editing,
  onClose,
}: {
  /** null = 新建。 */
  editing: RoleplayAgent | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const loreIndex = useLoreStore((s) => s.index);
  const projectPath = useProjectStore((s) => s.projectPath);
  const { createAgent, updateAgent, removeAgent, newSession } = useRoleplayStore();

  const [kind, setKind] = useState<AgentKind>(editing?.kind ?? "character");
  const [primary, setPrimary] = useState<string | null>(editing?.primaryDirPath ?? null);
  const [bound, setBound] = useState<string[]>(editing?.boundPaths ?? []);
  const [modelId, setModelId] = useState<string | null>(editing?.modelId ?? null);
  const [instruction, setInstruction] = useState("");
  const [query, setQuery] = useState("");
  const [openEntity, setOpenEntity] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 「新开会话」的两段式确认。就地展开而不是弹一个模态：这一步要带一个勾选项，
  // 而一个只有一句话加一个勾的模态，比它要确认的动作本身还重。
  const [confirmNew, setConfirmNew] = useState(false);
  const [alsoClearMemory, setAlsoClearMemory] = useState(false);

  useEffect(() => {
    if (!editing || !projectPath) return;
    void loadPersonaCard(projectPath, editing.id).then(setInstruction);
  }, [editing, projectPath]);

  const entities = useMemo(
    () => Object.values(loreIndex).flat().sort((a, b) => a.name.localeCompare(b.name)),
    [loreIndex],
  );
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? entities.filter((e) => e.name.toLowerCase().includes(q)) : entities;
  }, [entities, query]);

  const primaryEntity = entities.find((e) => e.dirPath === primary) ?? null;
  const active = entities.find((e) => e.dirPath === openEntity) ?? visible[0] ?? null;
  const boundSet = new Set(bound);

  const toggle = (pin: string) =>
    setBound((prev) => (prev.includes(pin) ? prev.filter((p) => p !== pin) : [...prev, pin]));

  const boundTokens = useMemo(() => {
    let total = 0;
    for (const pin of bound) {
      const hash = pin.lastIndexOf("#");
      const dir = hash < 0 ? pin : pin.slice(0, hash);
      const entity = entities.find((e) => e.dirPath === dir);
      if (!entity) continue;
      if (hash < 0) {
        total += facetTokens(entity.summary.length + 400);
      } else {
        const facet = (entity.facets ?? []).find((f) => f.file === pin.slice(hash + 1));
        total += facetTokens(facet?.charCount ?? 200);
      }
    }
    return total;
  }, [bound, entities]);

  const nameFor = (e: LoreEntity) => e.name;
  const countFor = (e: LoreEntity) => {
    const facets = e.facets ?? [];
    const picked = facets.filter((f) => boundSet.has(pinFor(e, f.file))).length
      + (boundSet.has(pinFor(e)) ? 1 : 0);
    return `${picked}/${facets.length + 1}`;
  };

  const canSave = kind === "narrator" || primary !== null;

  const save = async () => {
    if (!canSave || busy) return;
    setBusy(true);
    const draft: AgentDraft = {
      kind,
      name: kind === "narrator"
        ? (editing?.name ?? t("roleplay.kind.narrator", { defaultValue: "旁白" }))
        : primaryEntity?.name ?? "",
      primaryDirPath: kind === "narrator" ? null : primary,
      boundPaths: bound,
      modelId,
      instruction,
    };
    if (editing) await updateAgent(editing.id, draft);
    else await createAgent(draft);
    setBusy(false);
    onClose();
  };

  return (
    <>
      <div className={styles.scrim} onClick={onClose} />
      <aside className={styles.drawer} role="dialog" aria-modal>
        <header className={styles.head}>
          <span className={styles.title}>
            {editing
              ? t("roleplay.editAgentTitle", { defaultValue: "编辑 agent" })
              : t("roleplay.newAgent", { defaultValue: "新建 agent" })}
          </span>
          <div className={styles.spacer} />
          <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Close">
            <X size={15} strokeWidth={1.6} />
          </button>
        </header>

        <div className={styles.body}>
          {/* 类型 */}
          <section>
            <div className={styles.label}>{t("roleplay.composer.kind", { defaultValue: "类型" })}</div>
            <div className={styles.kindGrid}>
              {(["character", "narrator"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`${styles.kindCard} ${kind === k ? styles.kindCardOn : ""}`}
                  onClick={() => !editing && setKind(k)}
                  disabled={!!editing}
                >
                  <div className={styles.kindHead}>
                    <span className={styles.radio} />
                    <span className={styles.kindName}>
                      {t(`roleplay.kind.${k}`, { defaultValue: k === "character" ? "扮演" : "旁白" })}
                    </span>
                  </div>
                  <div className={styles.kindDesc}>
                    {k === "character"
                      ? t("roleplay.composer.kindCharacterDesc", { defaultValue: "绑定一个人物条目，AI 就是他。记忆独立，不知道别的角色存在。" })
                      : t("roleplay.composer.kindNarratorDesc", { defaultValue: "不演任何人。读得到全部对话，能把互动整理进正文。" })}
                  </div>
                </button>
              ))}
            </div>
            {editing && (
              <div className={styles.hint}>
                {t("roleplay.composer.kindLocked", { defaultValue: "类型建好之后不能改——记忆结构不同。" })}
              </div>
            )}
          </section>

          {/* 主角条目 */}
          {kind === "character" && (
            <section>
              <div className={styles.labelRow}>
                <span className={styles.label}>{t("roleplay.composer.primary", { defaultValue: "主角条目" })}</span>
                <span className={styles.labelNote}>
                  {t("roleplay.composer.primaryNote", { defaultValue: "从知识库里挑一个" })}
                </span>
              </div>
              {primaryEntity ? (
                <div className={styles.primaryCard}>
                  <span className={styles.primaryAvatar}>{avatarGlyph(primaryEntity.name)}</span>
                  <div className={styles.primaryBody}>
                    <div className={styles.primaryName}>{primaryEntity.name}</div>
                    <div className={styles.primarySummary}>{primaryEntity.summary}</div>
                  </div>
                  <button type="button" className={styles.linkBtn} onClick={() => setPrimary(null)}>
                    {t("roleplay.composer.change", { defaultValue: "更换" })}
                  </button>
                </div>
              ) : (
                <div className={styles.primaryPick}>
                  {visible.slice(0, 12).map((e) => (
                    <button key={e.dirPath} type="button" className={styles.pickChip} onClick={() => setPrimary(e.dirPath)}>
                      <span className={styles.pickAvatar}>{avatarGlyph(e.name)}</span>
                      {e.name}
                    </button>
                  ))}
                  {visible.length === 0 && (
                    <div className={styles.hint}>{t("roleplay.composer.noEntities", { defaultValue: "知识库里还没有条目。" })}</div>
                  )}
                </div>
              )}
            </section>
          )}

          {/* 绑定词条 */}
          <section>
            <div className={styles.labelRow}>
              <span className={styles.label}>{t("roleplay.composer.bound", { defaultValue: "绑定词条" })}</span>
              <span className={styles.labelNote}>
                {t("roleplay.composer.boundNote", { defaultValue: "整条或其中一段特征" })}
              </span>
              <div className={styles.spacer} />
              <span className={styles.mono}>
                {t("roleplay.composer.boundCount", {
                  n: bound.length,
                  tok: boundTokens >= 1000 ? `${(boundTokens / 1000).toFixed(1)}k` : String(boundTokens),
                  defaultValue: `已选 ${bound.length} · 约 ${boundTokens} tok`,
                })}
              </span>
            </div>

            <div className={styles.picker}>
              <div className={styles.pickerHead}>
                <Search size={12} strokeWidth={2} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("roleplay.composer.searchEntries", {
                    n: entities.length,
                    defaultValue: `搜索 ${entities.length} 个条目`,
                  })}
                />
              </div>
              <div className={styles.pickerBody}>
                <div className={styles.entityList}>
                  {visible.map((e) => (
                    <button
                      key={e.dirPath}
                      type="button"
                      className={`${styles.entityRow} ${active?.dirPath === e.dirPath ? styles.entityRowOn : ""}`}
                      onClick={() => setOpenEntity(e.dirPath)}
                    >
                      <span className={styles.entityAvatar}>{avatarGlyph(e.name)}</span>
                      <span className={styles.entityName}>{nameFor(e)}</span>
                      <span className={styles.entityCount}>{countFor(e)}</span>
                    </button>
                  ))}
                </div>
                <div className={styles.facetList}>
                  {active ? (
                    <>
                      <div className={styles.facetHead}>
                        <span className={styles.facetHeadName}>
                          {t("roleplay.composer.facetsOf", {
                            name: active.name,
                            n: (active.facets ?? []).length,
                            defaultValue: `${active.name} · ${(active.facets ?? []).length} 段特征`,
                          })}
                        </span>
                        <div className={styles.spacer} />
                        <button type="button" className={styles.linkBtn} onClick={() => toggle(pinFor(active))}>
                          {boundSet.has(pinFor(active))
                            ? t("roleplay.composer.unpickWhole", { defaultValue: "取消整条" })
                            : t("roleplay.composer.pickWhole", { defaultValue: "整条绑定" })}
                        </button>
                      </div>
                      <button
                        type="button"
                        className={`${styles.facetRow} ${boundSet.has(pinFor(active)) ? styles.facetRowOn : ""}`}
                        onClick={() => toggle(pinFor(active))}
                      >
                        <span className={styles.check}>{boundSet.has(pinFor(active)) && <Check size={9} strokeWidth={3} />}</span>
                        <div className={styles.facetBody}>
                          <div className={styles.facetTitle}>{t("roleplay.composer.core", { defaultValue: "主词条（index.md）" })}</div>
                          <div className={styles.facetDesc}>{active.summary}</div>
                        </div>
                      </button>
                      {(active.facets ?? []).map((f) => {
                        const pin = pinFor(active, f.file);
                        const on = boundSet.has(pin);
                        return (
                          <button
                            key={f.file}
                            type="button"
                            className={`${styles.facetRow} ${on ? styles.facetRowOn : ""}`}
                            onClick={() => toggle(pin)}
                          >
                            <span className={styles.check}>{on && <Check size={9} strokeWidth={3} />}</span>
                            <div className={styles.facetBody}>
                              <div className={styles.facetTitle}>
                                {f.slot ? `${f.slot} · ${f.title}` : f.title}
                              </div>
                              {f.keys.length > 0 && (
                                <div className={styles.facetDesc}>{f.keys.join(" / ")}</div>
                              )}
                            </div>
                            <span className={styles.mono}>{facetTokens(f.charCount)} tok</span>
                          </button>
                        );
                      })}
                    </>
                  ) : (
                    <div className={styles.hint}>{t("roleplay.composer.noEntities", { defaultValue: "知识库里还没有条目。" })}</div>
                  )}
                </div>
              </div>

              <div className={styles.chips}>
                {bound.map((pin) => {
                  const hash = pin.lastIndexOf("#");
                  const dir = hash < 0 ? pin : pin.slice(0, hash);
                  const entity = entities.find((e) => e.dirPath === dir);
                  const facet = hash < 0
                    ? null
                    : (entity?.facets ?? []).find((f) => f.file === pin.slice(hash + 1));
                  const gone = !entity || (hash >= 0 && !facet);
                  return (
                    <button
                      key={pin}
                      type="button"
                      className={`${styles.chip} ${gone ? styles.chipGone : ""}`}
                      onClick={() => toggle(pin)}
                    >
                      {entity
                        ? `${entity.name} · ${facet ? facet.title : t("roleplay.composer.whole", { defaultValue: "整条" })}`
                        : dir.split(/[/\\]/).pop()}
                      <X size={9} strokeWidth={2.4} />
                    </button>
                  );
                })}
                {bound.length === 0 && (
                  <span className={styles.hint}>
                    {t("roleplay.composer.boundEmpty", { defaultValue: "没有绑定任何设定——角色只会知道主词条里写的东西。" })}
                  </span>
                )}
              </div>
            </div>
          </section>

          {/* 模型 */}
          <section className={styles.modelRow}>
            <span className={styles.label}>{t("roleplay.composer.model", { defaultValue: "模型" })}</span>
            {/* 「跟随全局」从旁边的链接挪进了菜单脚注：留空时触发器显示的是
                全局那一个 + 一个虚线的「跟随全局」签，所以撤销绑定的入口应该
                就在改绑定的地方，而不是它旁边再挂一个按钮。 */}
            <div className={styles.modelSlot}>
              <ModelSelector
                value={modelId ?? undefined}
                onChange={setModelId}
                onFollowGlobal={() => setModelId(null)}
                paper
              />
            </div>
          </section>

          {/* 指令 */}
          <section>
            <div className={styles.labelRow}>
              <span className={styles.label}>{t("roleplay.composer.instruction", { defaultValue: "扮演指令" })}</span>
              <span className={styles.labelNote}>
                {t("roleplay.composer.instructionNote", { defaultValue: "写给模型的，不会出现在对话里" })}
              </span>
            </div>
            <textarea
              className={styles.instruction}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder={t("roleplay.composer.instructionPlaceholder", {
                defaultValue: "说话短，从不解释动机。被问到那一夜时转移话题，但不撒谎。",
              })}
            />
          </section>
        </div>

        {editing && confirmNew ? (
          <footer className={styles.foot}>
            <label className={styles.checkRow}>
              <input
                type="checkbox"
                checked={alsoClearMemory}
                onChange={(e) => setAlsoClearMemory(e.target.checked)}
              />
              {t("roleplay.newSession.alsoMemory", { defaultValue: "同时清空记忆" })}
            </label>
            <span className={styles.hint}>
              {t("roleplay.newSession.confirmHint", {
                n: editing.turnCount,
                defaultValue: `封存当前 ${editing.turnCount} 轮，从空白开始。对话留在 archive/，一个字都不删。`,
              })}
            </span>
            <div className={styles.spacer} />
            <button
              type="button"
              className={styles.ghostBtn}
              onClick={() => { setConfirmNew(false); setAlsoClearMemory(false); }}
            >
              {t("common.cancel", { defaultValue: "取消" })}
            </button>
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={() => {
                void newSession(editing.id, { clearMemory: alsoClearMemory });
                onClose();
              }}
            >
              {t("roleplay.newSession.go", { defaultValue: "新开会话" })}
            </button>
          </footer>
        ) : (
        <footer className={styles.foot}>
          {editing && (
            <button
              type="button"
              className={styles.dangerBtn}
              onClick={() => { void removeAgent(editing.id); onClose(); }}
            >
              {t("roleplay.deleteAgent", { defaultValue: "删除" })}
            </button>
          )}
          {editing && (
            <button
              type="button"
              className={styles.ghostBtn}
              onClick={() => setConfirmNew(true)}
            >
              {t("roleplay.newSession.open", { defaultValue: "新开会话" })}
            </button>
          )}
          <span className={styles.hint}>
            {kind === "narrator"
              ? t("roleplay.composer.narratorHint", { defaultValue: "旁白没有主角，其余相同" })
              : t("roleplay.composer.deleteHint", { defaultValue: "删除会把对话记录移进 .ai-writer/backups，可恢复" })}
          </span>
          <div className={styles.spacer} />
          <button type="button" className={styles.ghostBtn} onClick={onClose}>
            {t("common.cancel", { defaultValue: "取消" })}
          </button>
          <button type="button" className={styles.primaryBtn} onClick={() => void save()} disabled={!canSave || busy}>
            {editing
              ? t("common.save", { defaultValue: "保存" })
              : t("roleplay.composer.create", { defaultValue: "创建" })}
          </button>
        </footer>
        )}
      </aside>
    </>
  );
}
