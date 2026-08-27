/**
 * 编辑抽屉里的「记忆区」一节。设计稿 08 TURN 2 屏 2e。
 *
 * 这一节要说清的唯一一件事是**继承**：绑定一个已存在的记忆区，新角色一上场就
 * 记得里面那些旧事——包括上一个角色答应过、误会过、记错过的东西。删掉角色不会
 * 删掉记忆区。
 *
 * 一个区同时只能挂在一个角色身上（`06-scene-and-memory-area.md` §4.1），所以
 * 已占用的条目在列表里**显示但不可选**——藏起来的话，作者会以为它不见了。
 */

import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { avatarGlyph } from "../../lib/roleplay/model";
import type { AreaSummary } from "../../lib/roleplay/area";
import styles from "./AreaPicker.module.css";

export type AreaChoice = string | "new" | null;

export function AreaPicker({ areas, value, agentId, nameOf, query, onQuery, onPick }: {
  areas: AreaSummary[];
  /** 当前选择。`"new"` = 新建一个空的。 */
  value: AreaChoice;
  /** 正在编辑的 agent；它自己占着的那个区不算「被别人占用」。 */
  agentId: string | null;
  /** agentId → 显示名，用来说清「已被谁占用」。 */
  nameOf: (id: string) => string | null;
  query: string;
  onQuery: (q: string) => void;
  onPick: (choice: AreaChoice) => void;
}) {
  const { t } = useTranslation();

  const q = query.trim().toLowerCase();
  const visible = q ? areas.filter((a) => a.name.toLowerCase().includes(q)) : areas;
  const free = areas.filter((a) => a.boundTo === null || a.boundTo === agentId).length;

  return (
    <section className={styles.section}>
      <div className={styles.labelRow}>
        <span className={styles.label}>
          {t("roleplay.area.label", { defaultValue: "记忆区" })}
        </span>
        <span className={styles.labelNote}>
          {t("roleplay.area.labelNote", { defaultValue: "这个角色以为的事" })}
        </span>
      </div>
      <div className={styles.lede}>
        {t("roleplay.area.lede", {
          defaultValue: "绑定一个已存在的记忆区，就是继承：新角色一上场就记得里面的旧事。一个记忆区同时只能挂在一个角色身上。",
        })}
      </div>

      <div className={styles.modes}>
        <button
          type="button"
          className={`${styles.mode} ${value === "new" ? styles.modeOn : ""}`}
          onClick={() => onPick("new")}
        >
          <span className={styles.modeHead}>
            <span className={styles.radio} />
            <span className={styles.modeName}>
              {t("roleplay.area.makeNew", { defaultValue: "新建一个" })}
            </span>
          </span>
          <span className={styles.modeDesc}>
            {t("roleplay.area.makeNewDesc", { defaultValue: "空的。从第一场开始攒。" })}
          </span>
        </button>
        <button
          type="button"
          className={`${styles.mode} ${value !== "new" && value !== null ? styles.modeOn : ""}`}
          onClick={() => onPick(visible.find((a) => a.boundTo === null)?.id ?? null)}
        >
          <span className={styles.modeHead}>
            <span className={styles.radio} />
            <span className={styles.modeName}>
              {t("roleplay.area.bindExisting", { defaultValue: "绑定已存在的" })}
            </span>
          </span>
          <span className={styles.modeDesc}>
            {t("roleplay.area.bindExistingDesc", { defaultValue: "接上一个角色留下的记忆。" })}
          </span>
        </button>
      </div>

      {/* 没有区不是一个中性的选择：转场分拣无处可去，上一场的前情只能标 `void`，
          于是这个角色两场之后就永久失忆。这里说出后果，而不是替作者选。 */}
      {value === null && (
        <div className={styles.warn}>
          {t("roleplay.area.noneWarn", {
            defaultValue: "没有记忆区：转场时这个角色会忘掉上一场，而且找不回来。",
          })}
        </div>
      )}

      {value !== "new" && (
        <div className={styles.list}>
          <div className={styles.listHead}>
            <Search size={12} strokeWidth={2} />
            <input
              className={styles.search}
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder={t("roleplay.area.search", {
                n: areas.length, defaultValue: `搜索 ${areas.length} 个记忆区`,
              })}
            />
            <span className={styles.counts}>
              {t("roleplay.area.counts", {
                free, taken: areas.length - free,
                defaultValue: `空闲 ${free} · 已占用 ${areas.length - free}`,
              })}
            </span>
          </div>

          {visible.length === 0 && (
            <div className={styles.empty}>
              {t("roleplay.area.none", { defaultValue: "还没有记忆区。选「新建一个」开始攒。" })}
            </div>
          )}

          {visible.map((a) => {
            const takenBy = a.boundTo && a.boundTo !== agentId ? nameOf(a.boundTo) : null;
            const selected = value === a.id;
            return (
              <button
                key={a.id}
                type="button"
                className={`${styles.row} ${selected ? styles.rowOn : ""} ${takenBy ? styles.rowTaken : ""}`}
                onClick={() => !takenBy && onPick(a.id)}
                disabled={!!takenBy}
              >
                <span className={styles.rowHead}>
                  <span className={styles.rowName}>{a.name}</span>
                  <span className={styles.rowCount}>
                    {t("roleplay.area.entryCount", { n: a.count, defaultValue: `${a.count} 条` })}
                  </span>
                  <span className={styles.spacer} />
                  {takenBy ? (
                    <>
                      <span className={styles.holderGlyph}>{avatarGlyph(takenBy)}</span>
                      <span className={styles.takenTag}>
                        {t("roleplay.area.takenBy", { name: takenBy, defaultValue: `已被 ${takenBy} 占用` })}
                      </span>
                    </>
                  ) : (
                    <span className={styles.pickTag}>
                      {selected
                        ? t("roleplay.area.picked", { defaultValue: "已选" })
                        : t("roleplay.area.pick", { defaultValue: "选它" })}
                    </span>
                  )}
                </span>
                {/* 上一个使用者：角色删了之后，这是唯一还能说清它从哪来的东西。 */}
                {!takenBy && (a.formerName || a.lastScene > 0) && (
                  <span className={styles.rowNote}>
                    {a.formerName
                      ? t("roleplay.area.former", {
                          name: a.formerName, defaultValue: `上一个使用者：${a.formerName}`,
                        })
                      : ""}
                    {a.formerName && a.lastScene > 0 ? " · " : ""}
                    {a.lastScene > 0
                      ? t("roleplay.area.lastScene", {
                          n: a.lastScene, defaultValue: `最后写入 第 ${a.lastScene} 场`,
                        })
                      : ""}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
