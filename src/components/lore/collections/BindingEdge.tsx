/**
 * 卡片左侧的装订边（设计稿 03 屏 24/28）——集合归属在墙上唯一的表达。
 *
 * 三条判断都写在这里：
 *   1. **归属画在边上，不改变卡片的位置**。墙从不按集合分区，所以一条属于两个集合
 *      的条目在墙上只出现一次，装订边上有两道标——计数会大于条目数，位置不会骗人。
 *   2. **未归集不写字**。空着的边就是答案；给每张未归集的卡挂一个提示徽标，等于把
 *      「还没分类」渲染成一种错误。
 *   3. **勾选框落在这条边上**。卡身已经是「打开条目」、方头像已经是「换图」，装订边
 *      是这一轮新增的第三条竖带，本来就只讲归属，多选放这里不与任何旧手势抢位置。
 */
import { useTranslation } from "react-i18next";
import { bindingLabel, sameCollection, type LoreScope } from "../../../lib/lore";
import styles from "./collections.module.css";

export function BindingEdge({
  collections,
  scope,
  selectMode,
  selected,
  onToggleSelect,
}: {
  collections: string[];
  scope: LoreScope;
  /** 多选中：勾选框常显，边加宽一点并换成实线（它此刻是个控件）。 */
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (ev: React.MouseEvent) => void;
}) {
  const { t } = useTranslation();
  const empty = collections.length === 0;

  return (
    <div
      className={`${styles.edge} ${empty && !selectMode ? styles.edgeEmpty : ""} ${selectMode ? styles.edgeSelectable : ""}`}
    >
      <button
        type="button"
        className={`${styles.edgeCheck} ${selected ? styles.edgeCheckOn : ""}`}
        aria-label={t("lore.collections.assign.checkHint")}
        onClick={(ev) => { ev.stopPropagation(); onToggleSelect(ev); }}
      >
        {selected ? "✓" : ""}
      </button>

      {empty ? (
        <span className={`${styles.edgeMark} ${styles.edgeMarkGhost}`}>
          {t("lore.collections.ungrouped")}
        </span>
      ) : (
        collections.map((name, i) => (
          <span key={name} style={{ display: "contents" }}>
            {i > 0 && <span className={styles.edgeRule} />}
            <span
              className={`${styles.edgeMark} ${
                scope === null
                  ? ""
                  : sameCollection(name, scope)
                    ? styles.edgeMarkIn
                    : styles.edgeMarkOut
              }`}
              title={name}
            >
              {bindingLabel(name)}
            </span>
          </span>
        ))
      )}
    </div>
  );
}
