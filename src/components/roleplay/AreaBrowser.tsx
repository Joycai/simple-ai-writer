/**
 * 记忆区的浏览与编辑。设计稿 08 TURN 2 屏 2d。
 *
 * **它必须一眼看出不是知识库。** 知识库是世界的事实：格纸墙、硬阴影卡片、按分类
 * 着色。这里是**某个角色以为的事**：横格纸内页、单色、细线分行、卡片不浮起。
 * 同一套材料，两种装订。顶上那条斜纹带把这句话直接说出来。
 *
 * 它可以和正典矛盾，而那是**特性**——所以这里从不「纠正」，也不提供任何把它同步回
 * 知识库的入口。
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Search, X } from "lucide-react";
import { useProjectStore } from "../../stores/projectStore";
import { useRoleplayStore } from "../../stores/roleplayStore";
import { estimateTextTokens } from "../../lib/ai/tokenEstimate";
import { readFile } from "../../lib/fs/fileio";
import { parseFrontmatter } from "../../lib/fs/markdown";
import {
  addAreaEntry, areaEntities, deleteAreaEntry, scanArea, updateAreaEntry,
  type AreaMeta,
} from "../../lib/roleplay/area";
import { avatarGlyph } from "../../lib/roleplay/model";
import type { LoreEntity } from "../../lib/lore/model";
import styles from "./AreaBrowser.module.css";

/** 条目目录名就是它的 id（`e001`）——`dirPath` 的最后一段。 */
function entryIdOf(e: LoreEntity): string {
  return e.dirPath.split(/[/\\]/).pop() ?? e.id;
}

export function AreaBrowser({ meta, holderName, onClose }: {
  meta: AreaMeta;
  /** 当前绑定它的角色名。`null` = 空闲。 */
  holderName: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const projectPath = useProjectStore((s) => s.projectPath);
  const refreshAreas = useRoleplayStore((s) => s.refreshAreas);

  const [items, setItems] = useState<LoreEntity[]>([]);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [scene, setScene] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    if (!projectPath) return;
    const list = areaEntities(await scanArea(projectPath, meta.id));
    setItems(list);
    return list;
  };
  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [projectPath, meta.id]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((e) =>
      e.name.toLowerCase().includes(q) || e.aliases.some((k) => k.toLowerCase().includes(q)));
  }, [items, query]);

  const active = items.find((e) => entryIdOf(e) === activeId) ?? null;

  // 正文和「来自第几场」都在文件里，列表上没有——点开时才读。
  useEffect(() => {
    if (!projectPath || !active) { setBody(""); setScene(0); setDirty(false); return; }
    let alive = true;
    void readFile(`${active.dirPath}/index.md`)
      .then((raw) => {
        if (!alive) return;
        const { data, content } = parseFrontmatter(raw);
        setBody(content.trim());
        setScene(typeof data.scene === "number" ? data.scene : 0);
        setDirty(false);
      })
      .catch(() => { if (alive) { setBody(""); setScene(0); } });
    return () => { alive = false; };
  }, [projectPath, active]);

  const patch = async (p: Parameters<typeof updateAreaEntry>[3]) => {
    if (!projectPath || !active || busy) return;
    setBusy(true);
    try {
      await updateAreaEntry(projectPath, meta.id, entryIdOf(active), p);
      await reload();
      setDirty(false);
    } finally { setBusy(false); }
  };

  const addManual = async () => {
    if (!projectPath || busy) return;
    setBusy(true);
    try {
      const id = await addAreaEntry(projectPath, meta.id, {
        title: t("roleplay.areaBrowser.newTitle", { defaultValue: "新记的一条" }),
        body: "",
        keys: [],
        // 手写的一条不属于任何一场——它不是从哪一场沉下来的。
        scene: 0,
      }, Math.floor(Date.now() / 1000));
      await reload();
      setActiveId(id);
      await refreshAreas();
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!projectPath || !active || busy) return;
    setBusy(true);
    try {
      await deleteAreaEntry(projectPath, meta.id, entryIdOf(active), Date.now());
      setActiveId(null);
      await reload();
      await refreshAreas();
    } finally { setBusy(false); }
  };

  const totalTokens = items.reduce(
    (n, e) => n + estimateTextTokens(`${e.name}${e.summary}${e.aliases.join("")}`), 0);

  return (
    <>
      <div className={styles.scrim} onClick={onClose} />
      <div className={styles.surface} role="dialog" aria-modal>
        <header className={styles.head}>
          <div className={styles.headMain}>
            <div className={styles.titleRow}>
              <span className={styles.title}>{meta.name}</span>
              <span className={styles.mono}>
                {t("roleplay.areaBrowser.count", {
                  n: items.length, defaultValue: `${items.length} 条 · 记忆区`,
                })}
              </span>
            </div>
            <div className={styles.holderRow}>
              {holderName ? (
                <>
                  <span className={styles.glyph}>{avatarGlyph(holderName)}</span>
                  <span className={styles.holder}>
                    {t("roleplay.areaBrowser.boundTo", {
                      name: holderName, defaultValue: `当前绑定 ${holderName}`,
                    })}
                  </span>
                </>
              ) : (
                <span className={styles.holder}>
                  {t("roleplay.areaBrowser.free", { defaultValue: "空闲 · 可以被继承" })}
                </span>
              )}
              {meta.formerName && (
                <>
                  <span className={styles.sep} />
                  <span className={styles.mono}>
                    {t("roleplay.areaBrowser.former", {
                      name: meta.formerName, defaultValue: `曾属于 ${meta.formerName}`,
                    })}
                  </span>
                </>
              )}
            </div>
          </div>
          <div className={styles.spacer} />
          <div className={styles.searchBox}>
            <Search size={12} strokeWidth={2} />
            <input
              className={styles.search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("roleplay.areaBrowser.search", { defaultValue: "搜条目或关键字" })}
            />
          </div>
          <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="close">
            <X size={15} strokeWidth={1.8} />
          </button>
        </header>

        {/* 区隔标记。斜纹是这一屏唯一张扬的东西——它要说的就是「这里不是知识库」。 */}
        <div className={styles.marker}>
          <span className={styles.markerTag}>
            {t("roleplay.areaBrowser.markerTag", { defaultValue: "角色记忆" })}
          </span>
          <span className={styles.markerText}>
            {t("roleplay.areaBrowser.markerText", {
              name: holderName ?? meta.name,
              defaultValue: `这里写的是${holderName ?? meta.name}以为的事。它可以和知识库的正典矛盾，不作纠正。`,
            })}
          </span>
        </div>

        <div className={styles.body}>
          <div className={styles.list}>
            {visible.length === 0 && (
              <div className={styles.empty}>
                {items.length === 0
                  ? t("roleplay.areaBrowser.empty", {
                      defaultValue: "还是空的。转场的时候，不再欠着的东西会沉到这里。",
                    })
                  : t("roleplay.areaBrowser.noMatch", { defaultValue: "没有匹配的条目。" })}
              </div>
            )}
            {visible.map((e) => {
              const id = entryIdOf(e);
              return (
                <button
                  key={id}
                  type="button"
                  className={`${styles.row} ${id === activeId ? styles.rowOn : ""}`}
                  onClick={() => setActiveId(id)}
                >
                  <span className={styles.rowHead}>
                    <span className={styles.rowName}>{e.name}</span>
                    <span className={styles.spacer} />
                    <span className={styles.rowScene}>{sceneTagOf(e, t)}</span>
                  </span>
                  {e.summary && <span className={styles.rowSummary}>{e.summary}</span>}
                  {e.aliases.length > 0 && (
                    <span className={styles.rowKeys}>
                      {e.aliases.map((k) => <span key={k} className={styles.key}>{k}</span>)}
                    </span>
                  )}
                </button>
              );
            })}
            <div className={styles.listFoot}>
              <button type="button" className={styles.addBtn} onClick={() => void addManual()} disabled={busy}>
                <Plus size={11} strokeWidth={2} />
                {t("roleplay.areaBrowser.addManual", { defaultValue: "手写一条" })}
              </button>
              <div className={styles.spacer} />
              <span className={styles.mono}>
                {t("roleplay.areaBrowser.total", {
                  n: items.length, tok: totalTokens < 1000 ? `${totalTokens}` : `${(totalTokens / 1000).toFixed(1)}k`,
                  defaultValue: `${items.length} 条 · 约 ${totalTokens} tok`,
                })}
              </span>
            </div>
          </div>

          {/* 详情在**横格纸**上：它是一本内页，不是一张卡片。 */}
          <div className={styles.detail}>
            {!active ? (
              <div className={styles.detailEmpty}>
                {t("roleplay.areaBrowser.pickOne", { defaultValue: "选一条看看。" })}
              </div>
            ) : (
              <>
                <div className={styles.detailHead}>
                  <input
                    className={styles.detailTitle}
                    value={active.name}
                    onChange={(e) => { void patch({ title: e.target.value }); }}
                  />
                  <div className={styles.spacer} />
                  <button type="button" className={styles.detailAction} onClick={() => void remove()} disabled={busy}>
                    {t("common.delete", { defaultValue: "删除" })}
                  </button>
                </div>
                <div className={styles.detailMeta}>
                  {scene > 0
                    ? t("roleplay.areaBrowser.fromScene", {
                        n: scene, defaultValue: `来自第 ${scene} 场 · 转场时沉入`,
                      })
                    : t("roleplay.areaBrowser.handwritten", { defaultValue: "作者手写" })}
                </div>

                <div className={styles.field}>
                  <div className={styles.fieldLabel}>
                    {t("roleplay.areaBrowser.bodyLabel", { defaultValue: "正文" })}
                    <span className={styles.fieldNote}>
                      {t("roleplay.areaBrowser.bodyNote", {
                        name: holderName ?? meta.name,
                        defaultValue: `改动只影响${holderName ?? meta.name}记得什么，不动正文和知识库`,
                      })}
                    </span>
                  </div>
                  <textarea
                    className={styles.bodyInput}
                    value={body}
                    onChange={(e) => { setBody(e.target.value); setDirty(true); }}
                    onBlur={() => { if (dirty) void patch({ body }); }}
                  />
                </div>

                <div className={styles.field}>
                  <div className={styles.fieldLabel}>
                    {t("roleplay.transition.keys", { defaultValue: "关键字" })}
                    <span className={styles.fieldNote}>
                      {t("roleplay.areaBrowser.keysNote", {
                        defaultValue: "对话里出现这些词，这条才会被想起",
                      })}
                    </span>
                  </div>
                  <KeyEditor
                    keys={active.aliases}
                    onChange={(keys) => void patch({ keys })}
                    addLabel={t("roleplay.transition.keys", { defaultValue: "关键字" })}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function sceneTagOf(e: LoreEntity, t: (k: string, o?: Record<string, unknown>) => string): string {
  // 列表上不读文件，所以场号只能从 summary 之外的地方来——没有就留空，别猜。
  return e.mdFiles.length > 1 ? t("roleplay.areaBrowser.multi", { defaultValue: "多页" }) : "";
}

function KeyEditor({ keys, onChange, addLabel }: {
  keys: readonly string[];
  onChange: (keys: string[]) => void;
  addLabel: string;
}) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    const k = draft.trim();
    setDraft("");
    if (k && !keys.includes(k)) onChange([...keys, k]);
  };
  return (
    <div className={styles.keys}>
      {keys.map((k) => (
        <button
          key={k}
          type="button"
          className={styles.keyChip}
          onClick={() => onChange(keys.filter((x) => x !== k))}
        >
          {k}
          <X size={8} strokeWidth={2.4} />
        </button>
      ))}
      <span className={styles.keyAdd}>
        <Plus size={9} strokeWidth={2.2} />
        <input
          className={styles.keyInput}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
          onBlur={commit}
          placeholder={addLabel}
        />
      </span>
    </div>
  );
}
