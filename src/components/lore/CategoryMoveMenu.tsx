/**
 * 「移到分类 ▾」——知识库墙多选之后把这一批搬进另一个分类（设计稿 03f 屏 1c）。
 *
 * 为什么它不是归集清单的第三种 mode（`CollectionAssignMenu` 的 single/add/remove）：
 *
 *   - 分类是**替换**语义，一条只能在一个分类里。归集清单的三态复选框（勾／空／短横）
 *     在这里全是错的话术——「部分已在」对一个单值字段不是一种状态，而是「这批来自
 *     不同分类」，那是标题该说的事，不是每一行该说的事。
 *   - 点一下就搬，没有「应用」按钮：批量归集要攒一串勾选才成立，选一个分类不用攒。
 *     两块板子并排出现在同一条动作条上、颜色一模一样，分辨它们的就是「有没有确认键」
 *     （1z · B2）。
 *   - 分类是磁盘文件夹，搬一次是真搬家。所以这块板子上多一行常驻脚注，归集清单没有。
 *
 * 搬家的过程也在这块板子上：头部换成「搬到「术语」… 3/5」，整个浮层禁手，搬完自己关；
 * 失败只写一行「3 条已搬，2 条未动 · 重试」，不弹窗。
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

type Progress = { label: string; done: number; total: number };
type Failure = { category: string; moved: number; failed: number };

export function CategoryMoveMenu({
  entities,
  anchor,
  onPick,
  onNewCategory,
  onClose,
}: {
  /** 要搬的条目：墙上多选中的那些。 */
  entities: LoreEntity[];
  anchor: { x: number; y: number; above?: boolean };
  /**
   * 搬这一批到 `category`。已在该分类的条目由调用方跳过，这里不做过滤。
   * 回的是结果：菜单据此决定自己关掉（全成）还是留下写一行失败。
   */
  onPick: (
    category: string,
    onProgress: (done: number, total: number) => void,
  ) => Promise<{ moved: number; failed: number }>;
  /** 没有别处可搬时那颗「＋ 新建分类…」。 */
  onNewCategory?: () => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const busyRef = useRef(false);

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

  /** 有没有一行是真能搬过去的。全都「全部已在」＝没有别处可搬。 */
  const anyTarget = rows.some((r) => r.here < total);

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
  }, [anchor.x, anchor.y, anchor.above, rows.length, anyTarget, failure]);

  useEffect(() => {
    // 搬家中整个浮层禁手：点外面、按 Esc 都不关——关了作者就看不见 3/5 走到哪了。
    const onDown = (ev: MouseEvent) => {
      if (busyRef.current) return;
      if (!ref.current?.contains(ev.target as Node)) onClose();
    };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape" && !busyRef.current) onClose(); };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const pick = async (id: string) => {
    if (busyRef.current) return;
    const label = rows.find((r) => r.id === id)?.label ?? id;
    busyRef.current = true;
    setFailure(null);
    setProgress({ label, done: 0, total });
    try {
      const r = await onPick(id, (done, tot) => setProgress((p) => (p ? { ...p, done, total: tot } : p)));
      if (r.failed === 0) {
        onClose();
        return;
      }
      setFailure({ category: id, ...r });
    } catch {
      setFailure({ category: id, moved: 0, failed: total });
    } finally {
      busyRef.current = false;
      setProgress(null);
    }
  };

  // 脚注里的 [[lore:分类/id]] 是磁盘上真实的写法，走 mono；两种语言的句子都含这一段。
  const note = t("lore.categoryMove.note");
  const noteParts = note.match(/^([\s\S]*?)(\[\[lore:[^\]]*\]\])([\s\S]*)$/);

  return createPortal(
    <div
      ref={ref}
      className={styles.menu}
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        visibility: pos ? "visible" : "hidden",
      }}
      aria-busy={progress !== null || undefined}
    >
      <div className={styles.head}>
        {progress ? (
          <div className={styles.titleRow}>
            <span className={styles.spinner} />
            <span className={styles.titleWord}>{t("lore.categoryMove.movingTo", { label: progress.label })}</span>
            <span className={styles.grow} />
            <span className={styles.progress}>{progress.done}/{progress.total}</span>
          </div>
        ) : (
          <>
            <div className={styles.titleRow}>
              <span className={styles.titleWord}>{t("lore.categoryMove.titleWord")}</span>
              <span className={styles.titleCount}>{t("lore.categoryMove.titleCount", { n: total })}</span>
            </div>
            {anyTarget && (
              <div className={styles.breakdown}>
                {t("lore.categoryMove.from", { list: from.join(" · ") })}
              </div>
            )}
          </>
        )}
      </div>

      {!anyTarget ? (
        <>
          <div className={styles.emptyText}>{t("lore.categoryMove.noTarget")}</div>
          {onNewCategory && (
            <button
              type="button"
              className={styles.newCat}
              onClick={() => { onClose(); onNewCategory(); }}
            >
              {t("lore.categoryMove.newCategory")}
            </button>
          )}
        </>
      ) : (
        <>
          <div className={`${styles.list} ${progress ? styles.listBusy : ""}`}>
            {rows.map(({ id, label, here }) => {
              const allHere = here === total;
              return (
                <button
                  type="button"
                  key={id}
                  className={`${styles.row} ${allHere ? styles.rowHere : ""}`}
                  disabled={allHere || progress !== null}
                  onClick={() => void pick(id)}
                >
                  <span
                    className={`${styles.dot} ${allHere ? styles.dotHere : ""}`}
                    style={allHere ? undefined : { background: categoryColor(id) }}
                  />
                  <span className={styles.name} title={label}>{label}</span>
                  <span className={styles.grow} />
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
            {failure ? (
              // 失败只写一行，不弹窗。重试搬的是剩下的那几条——已搬的此刻已经「N 条已在」。
              <span className={styles.failLine}>
                {t("lore.categoryMove.partialFailed", { moved: failure.moved, failed: failure.failed })}
                {" · "}
                <button type="button" className={styles.retry} onClick={() => void pick(failure.category)}>
                  {t("lore.categoryMove.retry")}
                </button>
              </span>
            ) : (
              <span className={styles.note}>
                {noteParts
                  ? <>{noteParts[1]}<span className={styles.noteCode}>{noteParts[2]}</span>{noteParts[3]}</>
                  : note}
              </span>
            )}
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}
