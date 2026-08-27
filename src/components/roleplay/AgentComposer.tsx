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
import { SceneTransition } from "./SceneTransition";
import { AreaPicker, type AreaChoice } from "./AreaPicker";
import { listArchives, loadPersonaCard } from "../../lib/roleplay/store";
import { useProjectStore } from "../../stores/projectStore";
import {
  avatarGlyph, type AgentKind, type RoleplayAgent, type SceneTurn,
} from "../../lib/roleplay/model";

/** 稳定的空数组：会话还没建起来时给它，省得每帧换一个新引用。 */
const EMPTY_TURNS: SceneTurn[] = [];
import type { LoreEntity } from "../../lib/lore/model";
import { indexCategories } from "../../lib/lore/categories";
import { categoryLabel } from "../../lib/profile/model";
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
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const loreIndex = useLoreStore((s) => s.index);
  const projectPath = useProjectStore((s) => s.projectPath);
  const { createAgent, updateAgent, removeAgent, bindArea, refreshAreas } = useRoleplayStore();
  const areas = useRoleplayStore((s) => s.areas);
  const agents = useRoleplayStore((s) => s.agents);
  useEffect(() => { void refreshAreas(); }, [refreshAreas]);

  const [kind, setKind] = useState<AgentKind>(editing?.kind ?? "character");
  const [primary, setPrimary] = useState<string | null>(editing?.primaryDirPath ?? null);
  const [bound, setBound] = useState<string[]>(editing?.boundPaths ?? []);
  const [modelId, setModelId] = useState<string | null>(editing?.modelId ?? null);
  const [instruction, setInstruction] = useState("");
  const [query, setQuery] = useState("");
  /** 分类过滤，null = 全部。分类来自 `loreCategories()`，不是写死的六个。 */
  const [cat, setCat] = useState<string | null>(null);
  const [openEntity, setOpenEntity] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 转场面板。原来是 footer 上的就地确认条——「接续」那一支要跑一次模型、还要
  // 让作者过目改稿，一行装不下了（见 SceneTransition 的头注）。
  const [transition, setTransition] = useState(false);
  // 记忆区：新建时默认「新建一个」，编辑时保持现状。
  const [area, setArea] = useState<AreaChoice>(editing ? editing.areaId : "new");
  const [areaQuery, setAreaQuery] = useState("");

  useEffect(() => {
    if (!editing || !projectPath) return;
    void loadPersonaCard(projectPath, editing.id).then(setInstruction);
  }, [editing, projectPath]);

  // 「当前第 N 场」＝归档数 + 1。稿面顶端那条存档带说的必须是同一个数，所以两边
  // 都从 `listArchives` 数，而不是各记一个计数器。
  const [archiveCount, setArchiveCount] = useState(0);
  useEffect(() => {
    if (!editing || !projectPath) { setArchiveCount(0); return; }
    let alive = true;
    void listArchives(projectPath, editing.id)
      .then((list) => { if (alive) setArchiveCount(list.length); })
      .catch(() => { if (alive) setArchiveCount(0); });
    return () => { alive = false; };
  }, [editing, projectPath]);
  const sceneNo = archiveCount + 1;
  const turns = useRoleplayStore((s) => (editing ? s.sessions[editing.id]?.turns : undefined)) ?? EMPTY_TURNS;

  const entities = useMemo(
    () => Object.values(loreIndex).flat().sort((a, b) => a.name.localeCompare(b.name)),
    [loreIndex],
  );
  /**
   * 分类计数。读 `loreIndex` 的键而不是 `loreCategories()`：这里要的是**这个
   * 项目实际有条目的**分类，一个空分类的 chip 点下去只会得到一张空列表。
   */
  const cats = useMemo(
    () => indexCategories(loreIndex)
      .map((c) => ({ id: c.id, label: categoryLabel(c, isZh), n: (loreIndex[c.id] ?? []).length }))
      .filter((c) => c.n > 0),
    [loreIndex, isZh],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byCat = cat ? entities.filter((e) => e.category === cat) : entities;
    return q ? byCat.filter((e) => e.name.toLowerCase().includes(q)) : byCat;
  }, [entities, query, cat]);

  const primaryEntity = entities.find((e) => e.dirPath === primary) ?? null;
  const active = entities.find((e) => e.dirPath === openEntity) ?? visible[0] ?? null;
  /** 主角条目的正文常驻在 system 层，所以它的「整条」在这里不是一个可选项。 */
  const activeIsPrimary = !!active && active.dirPath === primary;
  const boundSet = new Set(bound);

  const toggle = (pin: string) =>
    setBound((prev) => (prev.includes(pin) ? prev.filter((p) => p !== pin) : [...prev, pin]));

  /** 选定主角：顺手摘掉它的裸 pin，否则同一份正文会在上下文里出现两遍。 */
  const choosePrimary = (dirPath: string) => {
    setPrimary(dirPath);
    setBound((prev) => prev.filter((p) => p !== dirPath));
  };

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
    // 主角条目的主条目不算一个可选项——它常驻，分母里没有它。
    const isPrimary = e.dirPath === primary;
    const picked = facets.filter((f) => boundSet.has(pinFor(e, f.file))).length
      + (!isPrimary && boundSet.has(pinFor(e)) ? 1 : 0);
    return `${picked}/${facets.length + (isPrimary ? 0 : 1)}`;
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
      // 主角条目的正文住在 system 层；再绑一次就是同一个文件进两遍上下文。
      // 读花名册时也有同样一道过滤（lib/roleplay/store），管的是这次改动之前的数据。
      boundPaths: kind === "narrator" || !primary ? bound : bound.filter((p) => p !== primary),
      modelId,
      instruction,
    };
    // 记忆区的绑定走 `bindArea` 而不是塞进 draft：它要摘掉旧的、抢占新的、写两份
    // meta.json——那是一串必须成对发生的写，属于 store 的一个动作，不属于表单。
    if (editing) {
      await updateAgent(editing.id, draft);
      if (kind === "character" && area !== editing.areaId) await bindArea(editing.id, area);
    } else {
      const id = await createAgent({ ...draft, areaId: null });
      if (id && kind === "character" && area !== null) await bindArea(id, area);
    }
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
                    <button key={e.dirPath} type="button" className={styles.pickChip} onClick={() => choosePrimary(e.dirPath)}>
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

          {/* 绑定条目 */}
          <section>
            <div className={styles.labelRow}>
              <span className={styles.label}>{t("roleplay.composer.bound", { defaultValue: "绑定条目" })}</span>
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
              {/* 分类计数：只在真的有两类以上时出现——一个项目只有「人物」时，
                  一排唯一的 chip 是纯装饰，还占掉一行。 */}
              {cats.length > 1 && (
                <div className={styles.catRow}>
                  <button
                    type="button"
                    className={`${styles.catChip} ${cat === null ? styles.catChipOn : ""}`}
                    onClick={() => setCat(null)}
                  >
                    {t("roleplay.composer.catAll", { defaultValue: "全部" })}
                    <span className={styles.catN}>{entities.length}</span>
                  </button>
                  {cats.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={`${styles.catChip} ${cat === c.id ? styles.catChipOn : ""}`}
                      onClick={() => setCat(cat === c.id ? null : c.id)}
                    >
                      {c.label}
                      <span className={styles.catN}>{c.n}</span>
                    </button>
                  ))}
                </div>
              )}
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
                        {!activeIsPrimary && (
                          <button type="button" className={styles.linkBtn} onClick={() => toggle(pinFor(active))}>
                            {boundSet.has(pinFor(active))
                              ? t("roleplay.composer.unpickWhole", { defaultValue: "取消整条" })
                              : t("roleplay.composer.pickWhole", { defaultValue: "整条绑定" })}
                          </button>
                        )}
                      </div>
                      <button
                        type="button"
                        className={`${styles.facetRow} ${boundSet.has(pinFor(active)) ? styles.facetRowOn : ""} ${activeIsPrimary ? styles.facetRowResident : ""}`}
                        onClick={() => { if (!activeIsPrimary) toggle(pinFor(active)); }}
                        disabled={activeIsPrimary}
                      >
                        <span className={styles.check}>
                          {(activeIsPrimary || boundSet.has(pinFor(active))) && <Check size={9} strokeWidth={3} />}
                        </span>
                        <div className={styles.facetBody}>
                          <div className={styles.facetTitle}>{t("roleplay.composer.core", { defaultValue: "主条目（index.md）" })}</div>
                          <div className={styles.facetDesc}>
                            {activeIsPrimary
                              ? t("roleplay.composer.primaryResident", {
                                  defaultValue: "已常驻——主角条目的正文一直在上下文里，不用再绑一次",
                                })
                              : active.summary}
                          </div>
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
                    {t("roleplay.composer.boundEmpty", { defaultValue: "没有绑定任何条目——角色只会知道主条目里写的东西。" })}
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

          {/* 记忆区。旁白没有这一节——它不扮演任何人，也就没有「它以为的事」。 */}
          {kind === "character" && (
            <AreaPicker
              areas={areas}
              value={area}
              agentId={editing?.id ?? null}
              nameOf={(id) => agents[id]?.name ?? null}
              query={areaQuery}
              onQuery={setAreaQuery}
              onPick={setArea}
            />
          )}

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

        {/* 转场就地替换 footer 向上展开——不居中、不遮挡（设计稿 2a）。 */}
        {transition && editing ? (
          <SceneTransition
            agent={editing}
            turns={turns}
            sceneNo={sceneNo}
            onClose={() => setTransition(false)}
          />
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
              onClick={() => setTransition(true)}
            >
              {t("roleplay.transition.open", { defaultValue: "转场" })}
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
