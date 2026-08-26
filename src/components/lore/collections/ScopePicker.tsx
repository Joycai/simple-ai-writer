/**
 * 取材范围（scope）的三个部件：常驻的骑缝带、头部的按钮、以及两者共用的切换器弹层。
 * 设计稿 03 屏 25/26。
 *
 * 这一组件存在的理由是**围栏必须一直看得见**。范围指向一个空集合、或者作者忘了自己
 * 上次切过——这两种情况下 AI 一条设定也找不到，而唯一的止损就是界面上始终写着当前
 * 生效的是哪一个。所以带子是常驻的，不是一个可关掉的提示。
 *
 * 与普通筛选的分界写在样式里而不是文案里：**3px double 的骑缝线只属于围栏**，
 * 分类 chips 和装订栏的筛选永远不产生它（见 collections.module.css 的注释）。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import {
  collectionBreakdown,
  collectionViews,
  scopeLoreIndex,
  ungroupedCount,
  loreEntityCount,
  type LoreIndex,
  type LoreScope,
} from "../../../lib/lore";
import { categoryLabel, findCategory } from "../../../lib/profile";
import styles from "./collections.module.css";

/** 超过这个数就折起，并显示过滤框——设计稿 26-C 的退化规则。 */
const FOLD_AFTER = 8;

export interface ScopeMenuAnchor {
  x: number;
  y: number;
  /** 从下往上展开（AI 面板窄栏在底部时）。 */
  above?: boolean;
}

function useCollectionRows(index: LoreIndex, declared: string[], isZh: boolean) {
  return useMemo(() => {
    const views = collectionViews(index, declared);
    return views.map((v) => ({
      ...v,
      breakdown: collectionBreakdown(index, v.name)
        .map(({ category, count }) => {
          const cat = findCategory(category);
          return `${cat ? categoryLabel(cat, isZh) : category} ${count}`;
        })
        .join(" · "),
    }));
  }, [index, declared, isZh]);
}

/**
 * 切换器弹层。`variant`:
 *   - "wall"   墙头部：带分类分布、说明区、管理入口
 *   - "narrow" AI 面板：只留条目数（窄栏塞不下分布，塞进去就是两行折行）
 */
export function ScopeMenu({
  index,
  declared,
  scope,
  anchor,
  variant = "wall",
  onPick,
  onManage,
  onClose,
}: {
  index: LoreIndex;
  declared: string[];
  scope: LoreScope;
  anchor: ScopeMenuAnchor;
  variant?: "wall" | "narrow";
  onPick: (scope: LoreScope) => void;
  onManage?: () => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const rows = useCollectionRows(index, declared, isZh);
  const total = loreEntityCount(index);
  const unfiled = ungroupedCount(index);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const narrow = variant === "narrow";
  const needsFilter = rows.length > FOLD_AFTER;
  const filtered = query.trim()
    ? rows.filter((r) => r.name.toLowerCase().includes(query.trim().toLowerCase()))
    : rows;
  const folded = needsFilter && !expanded && !query.trim();
  const shown = folded ? filtered.slice(0, FOLD_AFTER) : filtered;

  // 位置在挂载后量一次：弹层的高度取决于集合数量，先渲染再摆位比预估靠谱。
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
  }, [anchor.x, anchor.y, anchor.above, shown.length]);

  useEffect(() => {
    const onDown = (ev: MouseEvent) => {
      if (!ref.current?.contains(ev.target as Node)) onClose();
    };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") onClose(); };
    // capture: a click on the trigger would otherwise re-open it immediately.
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const pick = (next: LoreScope) => { onPick(next); onClose(); };

  return createPortal(
    <div
      ref={ref}
      className={styles.menu}
      style={{
        width: narrow ? 300 : 400,
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        visibility: pos ? "visible" : "hidden",
      }}
      role="listbox"
    >
      <div className={styles.menuHead}>
        <div className={styles.menuHeadRow}>
          <span className={styles.bandEyebrow}>{t("lore.collections.scope.eyebrow")}</span>
          <span style={{ flex: 1 }} />
          {needsFilter && (
            <span className={styles.rowCount}>
              {t("lore.collections.scope.collectionCount", { n: rows.length })}
            </span>
          )}
        </div>
        {!narrow && <span className={styles.menuHint}>{t("lore.collections.scope.remember")}</span>}
      </div>

      {needsFilter && (
        <div className={styles.menuFilter}>
          <Search size={11} color="var(--color-text-muted)" strokeWidth={1.8} />
          <input
            className={styles.menuFilterInput}
            autoFocus
            value={query}
            placeholder={t("lore.collections.scope.filter")}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      <div className={styles.menuList}>
        <button
          type="button"
          className={`${styles.row} ${narrow ? styles.rowNarrow : ""} ${scope === null ? styles.rowActive : ""}`}
          onClick={() => pick(null)}
        >
          <span className={`${styles.dot} ${scope === null ? styles.dotOn : ""}`} />
          <div className={styles.rowMain}>
            <span className={styles.rowName}>{t("lore.collections.all")}</span>
          </div>
          <span style={{ flex: 1 }} />
          <div className={styles.rowTail}>
            <span className={styles.rowCount}>
              {narrow ? total : t("lore.collections.entries", { n: total })}
            </span>
            {scope === null && (
              <span className={styles.rowBadge}>{t("lore.collections.scope.active")}</span>
            )}
          </div>
        </button>

        {shown.map((row) => {
          const active = scope !== null && row.name === scope;
          return (
            <button
              type="button"
              key={row.name}
              className={`${styles.row} ${narrow ? styles.rowNarrow : ""} ${active ? styles.rowActive : ""}`}
              onClick={() => pick(row.name)}
            >
              <span className={`${styles.dot} ${active ? styles.dotOn : ""}`} />
              <div className={styles.rowMain}>
                <span className={styles.rowName} title={row.name}>{row.name}</span>
                {!narrow && row.breakdown && (
                  <span className={styles.rowBreakdown}>{row.breakdown}</span>
                )}
              </div>
              <span style={{ flex: 1 }} />
              <div className={styles.rowTail}>
                {active && <span className={styles.rowBadge}>{t("lore.collections.scope.active")}</span>}
                <span className={styles.rowCount}>
                  {narrow ? row.count : t("lore.collections.entries", { n: row.count })}
                </span>
              </div>
            </button>
          );
        })}

        {folded && filtered.length > FOLD_AFTER && (
          <button type="button" className={styles.menuFold} onClick={() => setExpanded(true)}>
            {t("lore.collections.scope.more", { n: filtered.length - FOLD_AFTER })}
            <span style={{ flex: 1 }} />
            <span className={styles.menuFoldNote}>{t("lore.collections.scope.moreOrder")}</span>
          </button>
        )}

        {/* 未归集只是一档**筛选**，不是取材意图——所以它在墙的装订栏里可点，
            在取材范围切换器里只作为一个数字出现，不可选。 */}
        <div className={styles.menuDivider} />
        <div className={`${styles.row} ${narrow ? styles.rowNarrow : ""}`} style={{ cursor: "default" }}>
          <span className={`${styles.dot} ${styles.dotDashed}`} />
          <div className={styles.rowMain}>
            <span className={`${styles.rowName} ${styles.rowNameGhost}`}>
              {t("lore.collections.ungrouped")}
            </span>
            {!narrow && <span className={styles.rowHint}>{t("lore.collections.ungroupedHint")}</span>}
          </div>
          <span style={{ flex: 1 }} />
          <span className={styles.rowCount}>
            {narrow ? unfiled : t("lore.collections.entries", { n: unfiled })}
          </span>
        </div>
      </div>

      {narrow ? (
        <div className={styles.menuNote}>
          <span className={styles.menuNoteMono}>{t("lore.collections.scope.narrowNote")}</span>
        </div>
      ) : (
        <div className={styles.menuNote}>
          <span className={styles.menuNoteZh}>{t("lore.collections.scope.passes")}</span>
          <span className={styles.menuNoteEn}>{t("lore.collections.scope.passesEn")}</span>
        </div>
      )}

      {needsFilter && (
        <div className={styles.menuNote}>
          <span className={styles.menuNoteMono}>{t("lore.collections.scope.degradeNote")}</span>
        </div>
      )}

      <div className={styles.menuFoot}>
        {onManage && (
          <button type="button" className={styles.menuFootLink} onClick={() => { onManage(); onClose(); }}>
            {t("lore.collections.manageLink")}
          </button>
        )}
        <span style={{ flex: 1 }} />
        {scope !== null && (
          <button
            type="button"
            className={`${styles.menuFootLink} ${styles.muted}`}
            onClick={() => pick(null)}
          >
            {t("lore.collections.scope.reset")}
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** 头部的取材范围按钮：「全部」是虚线边（围栏没立起来），生效是实线赭石。 */
export function ScopeButton({
  scope,
  onOpen,
}: {
  scope: LoreScope;
  onOpen: (anchor: ScopeMenuAnchor) => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={`${styles.scopeButton} ${scope !== null ? styles.scopeButtonActive : ""}`}
      onClick={(ev) => {
        const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
        onOpen({ x: r.left, y: r.bottom + 4 });
      }}
    >
      <span className={styles.scopeButtonLabel}>{t("lore.collections.scope.label")}</span>
      <span className={styles.scopeButtonValue}>{scope ?? t("lore.collections.all")}</span>
      <span className={styles.scopeButtonCaret}>▾</span>
    </button>
  );
}

/**
 * 常驻的骑缝带。只在范围生效时渲染——「全部」不是一种需要通告的状态。
 */
export function ScopeBand({
  index,
  scope,
  variant = "wall",
  onSwitch,
  onReset,
}: {
  index: LoreIndex;
  scope: string;
  variant?: "wall" | "narrow";
  onSwitch: (anchor: ScopeMenuAnchor) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const inScope = loreEntityCount(scopeLoreIndex(index, scope));
  const narrow = variant === "narrow";

  if (narrow) {
    return (
      <button
        type="button"
        className={`${styles.band} ${styles.bandNarrow}`}
        style={{ width: "100%", cursor: "pointer" }}
        onClick={(ev) => {
          const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
          onSwitch({ x: r.left, y: r.bottom + 4 });
        }}
      >
        <span className={styles.bandEyebrow}>{t("lore.collections.scope.label")}</span>
        <span className={styles.bandName}>{scope}</span>
        <span className={styles.bandCount}>{inScope}</span>
        <span style={{ flex: 1 }} />
        <span className={styles.scopeButtonCaret}>▾</span>
      </button>
    );
  }

  return (
    <div className={styles.band}>
      <span className={styles.bandEyebrow}>{t("lore.collections.scope.eyebrow")}</span>
      <span className={styles.bandRule} />
      <span className={styles.bandName}>{scope}</span>
      <span className={styles.bandCount}>{t("lore.collections.scope.candidates", { n: inScope })}</span>
      <span className={styles.bandRule} />
      <div className={styles.bandExplain}>
        <span className={styles.bandExplainZh}>
          {t("lore.collections.scope.explain", { n: inScope })}
        </span>
        <span className={styles.bandExplainEn}>{t("lore.collections.scope.explainEn")}</span>
      </div>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        className={styles.bandLink}
        onClick={(ev) => {
          const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
          onSwitch({ x: r.left - 320, y: r.bottom + 6 });
        }}
      >
        {t("lore.collections.scope.switch")}
      </button>
      <button type="button" className={styles.bandReset} onClick={onReset}>
        {t("lore.collections.scope.reset")}
      </button>
    </div>
  );
}
