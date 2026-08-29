/**
 * 「移到分类 ▾」——知识库墙多选之后把这一批搬进另一个分类。
 *
 * 为什么它不是归集清单的第三种 mode（`CollectionAssignMenu` 的 single/add/remove）：
 *
 *   - 分类是**替换**语义，一条只能在一个分类里。归集清单的三态复选框（勾／空／短横）
 *     在这里全是错的话术——「部分已在」对一个单值字段不是一种状态，而是「这批来自
 *     不同分类」，那是标题该说的事，不是每一行该说的事。
 *   - 点一下就搬，没有「应用」按钮：批量归集要攒一串勾选才成立，选一个分类不用攒。
 *   - 分类是磁盘文件夹，搬一次是真搬家。所以这块板子上多一行常驻脚注，归集清单没有。
 *
 * 目标列表用 `loreCategories()` 而不是 `assignableCategories()`：**orphan 分类不能当
 * 目标**。orphan 是「有条目、但没有能力包声明它」的降级态，往里面搬东西是在手工制造
 * 更多降级态；而 `assignableCategories` 之所以带上 orphan，是为了让单条编辑时「留在
 * 原地」还在菜单上，那是另一回事。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { LoreEntity } from "../../lib/lore";
import { categoryLabel, findCategory, loreCategories } from "../../lib/profile";
import { categoryColor } from "./catColor";
import styles from "./CategoryMoveMenu.module.css";

export function CategoryMoveMenu({
  entities,
  anchor,
  onPick,
  onClose,
}: {
  /** 要搬的条目：墙上多选中的那些。 */
  entities: LoreEntity[];
  anchor: { x: number; y: number; above?: boolean };
  /** 选中一个分类。已在该分类的条目由调用方跳过，这里不做过滤。 */
  onPick: (category: string) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const total = entities.length;

  /** 这一批此刻分布在哪几个分类里——标题下那行「从哪来」。 */
  const from = useMemo(() => {
    const byCat = new Map<string, number>();
    for (const e of entities) byCat.set(e.category, (byCat.get(e.category) ?? 0) + 1);
    return [...byCat.entries()].map(([id, n]) => {
      const cat = findCategory(id);
      return `${cat ? categoryLabel(cat, isZh) : id} ${n}`;
    });
  }, [entities, isZh]);

  const rows = useMemo(() => {
    return loreCategories().map((cat) => ({
      id: cat.id,
      label: categoryLabel(cat, isZh),
      // 已经在这个分类里的条数：选它只会搬剩下的，先说清楚。
      here: entities.filter((e) => e.category === cat.id).length,
    }));
  }, [entities, isZh]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(Math.max(margin, anchor.x), window.innerWidth - rect.width - margin);
    const top = anchor.above
      ? Math.max(margin, anchor.y - rect.height)
      : Math.min(anchor.y, window.innerHeight - rect.height - margin);
    setPos({ left, top: Math.max(margin, top) });
  }, [anchor.x, anchor.y, anchor.above, rows.length]);

  useEffect(() => {
    const onDown = (ev: MouseEvent) => {
      if (!ref.current?.contains(ev.target as Node)) onClose();
    };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className={styles.menu}
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      <div className={styles.head}>
        <span className={styles.title}>{t("lore.categoryMove.title", { n: total })}</span>
        <span className={styles.breakdown}>
          {t("lore.categoryMove.from", { list: from.join(" · ") })}
        </span>
      </div>

      <div className={styles.list}>
        {rows.map(({ id, label, here }) => {
          const allHere = here === total;
          return (
            <button
              type="button"
              key={id}
              className={`${styles.row} ${allHere ? styles.rowHere : ""}`}
              disabled={allHere}
              onClick={() => {
                if (allHere) return;
                onPick(id);
                onClose();
              }}
            >
              <span className={styles.dot} style={{ background: categoryColor(id) }} />
              <span className={styles.name} title={label}>{label}</span>
              <span style={{ flex: 1 }} />
              {here > 0 && (
                <span className={styles.count}>
                  {allHere
                    ? t("lore.categoryMove.allHere")
                    : t("lore.categoryMove.someHere", { n: here })}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className={styles.foot}>
        <span className={styles.note}>{t("lore.categoryMove.note")}</span>
      </div>
    </div>,
    document.body,
  );
}
