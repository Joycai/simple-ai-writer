/**
 * 归集勾选清单（设计稿 03 屏 27/28）。三种用法共用一份：
 *
 *   single — 详情页的「改 ▾」和墙上右键的子菜单。**点一下立即生效、不弹确认**，
 *            因为改的是一个字段而不是文件，且 ⌘Z 之外还有再点一下。
 *   add    — 多选状态下的「归入集合 ▾」。**只加不减**：勾一个集合的意思是「这批
 *            都进去」，而不是「这批的归属变成这一个」——后者会在作者只想补一个
 *            标签时静静抹掉别的归属。
 *   remove — 「移出集合 ▾」，减的那一半，单独一个入口。
 *
 * 批量里的三态是必须的：勾＝全部已在/将全部归入，空＝一条都不在，**短横＝部分已在**。
 * 少了短横这一态，同样一个空框既可能是「都不在」也可能是「有几条在」，而作者据此
 * 做的两种操作后果完全不同。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  collectionViews,
  entityCollections,
  sameCollection,
  type LoreEntity,
  type LoreIndex,
} from "../../../lib/lore";
import { useImeGuard } from "../../../lib/ime";
import styles from "./collections.module.css";

export type AssignMode = "single" | "add" | "remove";

export function CollectionAssignMenu({
  index,
  declared,
  entities,
  mode,
  anchor,
  onCommit,
  onClose,
}: {
  index: LoreIndex;
  declared: string[];
  /** 要改的条目：single 传一条，批量传选中的那些。 */
  entities: LoreEntity[];
  mode: AssignMode;
  anchor: { x: number; y: number; above?: boolean };
  /** 加入哪些集合 / 移出哪些集合。single 每次只带一个。 */
  onCommit: (add: string[], remove: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const ime = useImeGuard();

  const total = entities.length;
  const rows = useMemo(() => {
    const views = collectionViews(index, declared);
    return views.map((v) => {
      const inCount = entities.filter((e) =>
        entityCollections(e).some((c) => sameCollection(c, v.name)),
      ).length;
      return { name: v.name, inCount };
    });
  }, [index, declared, entities]);

  // remove 模式只列这批条目**真的在**的集合：列一个谁都不在的集合，点它什么也不会
  // 发生，而作者会以为自己漏点了。
  const visible = mode === "remove" ? rows.filter((r) => r.inCount > 0) : rows;

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
  }, [anchor.x, anchor.y, anchor.above, visible.length, creating]);

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

  const isPicked = (name: string) => picked.some((p) => sameCollection(p, name));

  const clickRow = (name: string, inCount: number) => {
    if (mode === "single") {
      // 单条：inCount 只可能是 0 或 1，点一下就是反转。
      if (inCount > 0) onCommit([], [name]);
      else onCommit([name], []);
      onClose();
      return;
    }
    setPicked((cur) =>
      isPicked(name) ? cur.filter((p) => !sameCollection(p, name)) : [...cur, name],
    );
  };

  const commitNew = () => {
    const name = draft.trim();
    if (!name) { setCreating(false); return; }
    // 新建即归入——这个入口的名字就是「新建集合并归入」。声明由调用方在提交时补上。
    if (mode === "single") { onCommit([name], []); onClose(); return; }
    setPicked((cur) => (isPicked(name) ? cur : [...cur, name]));
    setDraft("");
    setCreating(false);
  };

  const apply = () => {
    if (picked.length === 0) { onClose(); return; }
    if (mode === "remove") onCommit([], picked);
    else onCommit(picked, []);
    onClose();
  };

  return createPortal(
    <div
      ref={ref}
      className={styles.assign}
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      <div className={styles.assignHead}>
        <span className={styles.assignTitle}>
          {mode === "single"
            ? t("lore.collections.assign.title")
            : mode === "remove"
              ? t("lore.collections.select.removeFrom")
              : t("lore.collections.assign.batchTitle", { n: total })}
        </span>
        <span className={mode === "single" ? styles.assignHint : styles.assignHintMono}>
          {mode === "single"
            ? t("lore.collections.assign.hint")
            : t("lore.collections.assign.batchHint")}
        </span>
      </div>

      <div className={styles.assignList}>
        {visible.map(({ name, inCount }) => {
          const all = inCount === total;
          const some = inCount > 0 && inCount < total;
          const checked = mode === "single" ? all : isPicked(name);
          return (
            <button
              type="button"
              key={name}
              className={styles.assignRow}
              onClick={() => clickRow(name, inCount)}
            >
              <span
                className={`${styles.check} ${checked ? styles.checkOn : some ? styles.checkSome : ""}`}
              >
                {checked ? "✓" : some ? <span className={styles.checkDash} /> : null}
              </span>
              <span className={styles.assignName} title={name}>{name}</span>
              <span style={{ flex: 1 }} />
              {mode !== "single" && (
                <span className={`${styles.assignCount} ${inCount > 0 ? styles.assignCountSome : ""}`}>
                  {inCount > 0
                    ? t("lore.collections.assign.partial", { n: inCount, total })
                    : t("lore.collections.assign.none", { total })}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {mode !== "remove" && (
        creating ? (
          <div className={styles.assignNewRow}>
            <input
              className={styles.assignNewInput}
              autoFocus
              value={draft}
              placeholder={t("lore.collections.assign.newPlaceholder")}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // IME 拥有这一下时直接让开：组字中的 Enter 是「选这个候选」，
                // Escape 是「丢掉候选」，两个都不是提交或取消。
                if (ime.isComposing(e)) return;
                if (e.key === "Enter") commitNew();
                if (e.key === "Escape") { e.stopPropagation(); setCreating(false); }
              }}
              {...ime.imeProps}
            />
          </div>
        ) : (
          <button type="button" className={styles.assignNew} onClick={() => setCreating(true)}>
            {t("lore.collections.assign.newAndFile")}
          </button>
        )
      )}

      {mode !== "single" && (
        <div className={styles.assignFoot}>
          <span className={styles.assignFootHint}>
            {mode === "add" ? t("lore.collections.assign.onlyAdds") : ""}
          </span>
          <span style={{ flex: 1 }} />
          <button type="button" className={styles.assignApply} onClick={apply}>
            {mode === "remove"
              ? t("lore.collections.select.removeApply")
              : t("lore.collections.assign.apply")}
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
