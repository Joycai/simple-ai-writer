/**
 * 墙左侧的装订栏（设计稿 03 屏 24）。
 *
 * 一栏里同时住着两种性质不同的动作，界面必须把它们分开：
 *   - **点集合名＝筛选**，只影响眼睛，随手可点；
 *   - **点「设为取材范围」＝改 AI 视野**，所以它藏在悬停里，且带自己的赭石下划线。
 *
 * 计数按**归属**计，因此各集合之和会大于条目总数（一条可属多集）。栏底那行 mono
 * 算式就是为这件事写的——不写，作者第一次看见 7+5+4+3=19 > 18 会以为哪里错了。
 */
import { useTranslation } from "react-i18next";
import {
  UNGROUPED,
  collectionViews,
  loreEntityCount,
  scopeHas,
  scopeWith,
  ungroupedCount,
  type CollectionFilter,
  type LoreIndex,
  type LoreScope,
} from "../../../lib/lore";
import styles from "./collections.module.css";

export function CollectionRail({
  index,
  declared,
  filter,
  scope,
  onFilter,
  onScope,
  onManage,
  onCreate,
}: {
  index: LoreIndex;
  declared: string[];
  filter: CollectionFilter;
  scope: LoreScope;
  onFilter: (next: CollectionFilter) => void;
  onScope: (next: LoreScope) => void;
  onManage: () => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation();
  const views = collectionViews(index, declared);
  const total = loreEntityCount(index);
  const unfiled = ungroupedCount(index);
  const sum = views.reduce((n, v) => n + v.count, 0) + unfiled;

  return (
    <div className={styles.rail}>
      <div className={styles.railHead}>
        <span className={styles.railEyebrow}>{t("lore.collections.eyebrow")}</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className={styles.railAdd}
          onClick={onCreate}
          title={t("lore.collections.manage.create")}
        >
          ＋
        </button>
      </div>

      {views.length === 0 ? (
        // 一个集合都还没有：栏本身就是引导，不另开空态屏。
        <div className={styles.railEmpty}>
          <span className={styles.railEmptyZh}>{t("lore.collections.emptyRail")}</span>
          <span className={styles.railEmptyEn}>{t("lore.collections.emptyRailEn")}</span>
          <button type="button" className={styles.railEmptyCta} onClick={onCreate}>
            {t("lore.collections.newFirst")}
          </button>
          <span className={styles.railEmptyAfter}>{t("lore.collections.emptyRailAfter")}</span>
        </div>
      ) : (
        <div className={styles.railList}>
          <button
            type="button"
            className={`${styles.railRow} ${filter === null ? styles.railRowOn : ""}`}
            onClick={() => onFilter(null)}
          >
            <span className={styles.railRowName}>{t("lore.collections.all")}</span>
            <span style={{ flex: 1 }} />
            <span className={styles.railRowCount}>{total}</span>
          </button>

          {views.map((v) => {
            const scoped = scopeHas(scope, v.name);
            return (
              <div key={v.name} className={styles.railRowWrap}>
                <button
                  type="button"
                  className={`${styles.railRow} ${filter === v.name ? styles.railRowOn : ""} ${scoped ? styles.railRowScoped : ""}`}
                  onClick={() => onFilter(v.name)}
                >
                  {scoped && <span className={styles.railScopeDot} />}
                  <span className={styles.railRowName} title={v.name}>{v.name}</span>
                  <span style={{ flex: 1 }} />
                  <span className={styles.railRowCount}>{v.count}</span>
                </button>
                {scoped ? (
                  <div className={styles.railScopeNote}>
                    {t("lore.collections.scope.activeNote")}
                  </div>
                ) : (
                  <div className={styles.railSetScope}>
                    <button
                      type="button"
                      className={styles.railSetScopeLink}
                      // 多选：把这个集合**加入**当前范围（并集），而不是替换掉已立起的围栏。
                      onClick={() => onScope(scopeWith(scope, v.name))}
                    >
                      {t("lore.collections.setScope")}
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          <div className={styles.railDivider} />
          <button
            type="button"
            className={`${styles.railRow} ${filter === UNGROUPED ? styles.railRowOn : ""}`}
            onClick={() => onFilter(UNGROUPED)}
          >
            <span className={`${styles.railRowName} ${styles.railRowGhost}`}>
              {t("lore.collections.ungrouped")}
            </span>
            <span style={{ flex: 1 }} />
            <span className={styles.railRowCount}>{unfiled}</span>
          </button>

          <div className={styles.railNote}>
            {t("lore.collections.railNote", {
              sum: views.map((v) => v.count).concat(unfiled).join("+"),
              total: sum,
            })}
          </div>
        </div>
      )}

      <span className={styles.railSpacer} />

      {scope !== null && (
        <div className={styles.railFence}>
          <span className={styles.railFenceTitle}>{t("lore.collections.scope.passesTitle")}</span>
          <span className={styles.railFenceBody}>{t("lore.collections.scope.passesBody")}</span>
        </div>
      )}

      {views.length > 0 && (
        <div className={styles.railFoot}>
          <button type="button" className={styles.railFootLink} onClick={onManage}>
            {t("lore.collections.manageArrow")}
          </button>
          <span className={styles.railFootHint}>{t("lore.collections.railHowto")}</span>
        </div>
      )}
    </div>
  );
}
