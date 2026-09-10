/**
 * The rewrite card's windows (设计稿 02h 1b).
 *
 * Same rows as an edit's window, one thing added: a header that says what kind
 * of change this is, where it is, and what it weighs. A whole-file rewrite
 * arrives as several unrelated changes at once, so unlike an edit — where the
 * locator above the card covers the single place — each window here has to
 * introduce itself.
 *
 * The header's first word is the kind, in its own colour: 删 is the one an
 * author needs to find first, and the card's whole ordering exists to put it
 * at the top.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { BlockChangeKind, BlockWindow } from "../../lib/diff/blocks";
import { WindowRows } from "./ChangeWindows";
import styles from "./BlockWindows.module.css";

const KIND_STYLE: Record<BlockChangeKind, string> = {
  del: styles.kindDel,
  replace: styles.kindReplace,
  merge: styles.kindMerge,
  add: styles.kindAdd,
  punct: styles.kindPunct,
};

export function BlockWindows({
  windows,
  lineNumbers,
  expandable = true,
}: {
  windows: readonly BlockWindow[];
  lineNumbers: boolean;
  /**
   * False for windows read back from the log: the lines past each side's first
   * two were never kept, so a fold there is a count, not a door.
   */
  expandable?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<readonly number[]>([]);

  return (
    <div className={styles.blockWindows}>
      {windows.map((window, i) => {
        const expanded = open.includes(i);
        // Expanded shows every line and drops the fold rows; folded shows the
        // first lines of each side and the counts standing in for the rest.
        const rows = expanded
          ? window.rows.filter((r) => r.type !== "fold")
          : window.rows.filter((r) => !r.overflow);
        return (
          <div key={i} className={styles.blockWindow}>
            <div className={styles.head}>
              <span className={`${styles.kind} ${KIND_STYLE[window.kind]}`}>
                {t(`ai.approval.blockKind.${window.kind}`)}
              </span>
              {window.section && (
                <span className={styles.section}>
                  {t("ai.approval.editSection", { title: window.section })}
                </span>
              )}
              <span className={styles.range}>{rangeOf(window)}</span>
              {window.wholeBlocks && (
                <span className={styles.weight}>
                  {t("ai.approval.wholeBlocks", {
                    n: window.removedChars,
                    defaultValue: "整段 · {{n}} 字",
                  })}
                </span>
              )}
              {expanded && (
                <button className={styles.headAction} onClick={() => setOpen(open.filter((n) => n !== i))}>
                  {t("ai.approval.collapse")}
                </button>
              )}
            </div>
            <WindowRows
              rows={rows}
              lineNumbers={lineNumbers}
              onFold={expandable ? () => setOpen([...open, i]) : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}

/** `L88–101`, or `L12–19 → L12–15` when the change lands somewhere too. */
function rangeOf(window: BlockWindow): string {
  const old = window.from !== undefined ? `L${window.from}–${window.to}` : "";
  const next = window.newFrom !== undefined ? `L${window.newFrom}–${window.newTo}` : "";
  if (old && next) return `${old} → ${next}`;
  return old || next;
}
