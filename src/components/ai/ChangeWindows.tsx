/**
 * The change window — the one shape every editing card draws (设计稿 02h 1a, 1z A/C).
 *
 * A window is the changed place plus enough of the file either side to know
 * where it is: line numbers down the left, a − / + column, removed lines above
 * added ones. What it is *not* is a reading surface — the model that decides
 * how much fits (`lib/diff/windows`, `lib/diff/blocks`) has already folded away
 * everything that would turn this into one.
 *
 * Whitespace only shows itself when that is the whole change: ␣ for a space,
 * ↵ for an empty line, → for a tab. Marking them always would put a symbol on
 * every line of every diff, which is how a card stops being readable.
 */

import { useTranslation } from "react-i18next";
import type { ChangeWindow, WindowRow } from "../../lib/diff/windows";
import styles from "./ChangeWindows.module.css";

export function ChangeWindows({
  windows,
  lineNumbers,
  whitespace,
}: {
  windows: readonly ChangeWindow[];
  /** The rail drops the number column and puts the line in the locator instead. */
  lineNumbers: boolean;
  /** Draw whitespace as visible marks — only ever true when it is the whole change. */
  whitespace?: boolean;
}) {
  return (
    <div className={styles.windows}>
      {windows.map((window, i) => (
        <WindowRows key={i} rows={window.rows} lineNumbers={lineNumbers} whitespace={whitespace} />
      ))}
    </div>
  );
}

/**
 * One window's rows. Shared with the rewrite card, which wraps the same rows in
 * a header — the geometry has to be identical or the two cards stop reading as
 * one vocabulary.
 */
export function WindowRows({
  rows,
  lineNumbers,
  whitespace,
  onFold,
}: {
  rows: readonly WindowRow[];
  lineNumbers: boolean;
  whitespace?: boolean;
  /** Called when a fold row is pressed; without it a fold row is just a count. */
  onFold?: () => void;
}) {
  return (
    <div className={styles.window}>
      {rows.map((row, i) => (
        <Row key={i} row={row} lineNumbers={lineNumbers} whitespace={whitespace} onFold={onFold} />
      ))}
    </div>
  );
}

function Row({
  row,
  lineNumbers,
  whitespace,
  onFold,
}: {
  row: WindowRow;
  lineNumbers: boolean;
  whitespace?: boolean;
  onFold?: () => void;
}) {
  const { t } = useTranslation();

  if (row.type === "gap" || row.type === "fold") {
    const label =
      row.type === "gap"
        ? t("ai.approval.gapUnchanged", { n: row.hidden, defaultValue: "⋯ 中间 {{n}} 行没有改动" })
        : row.side === "del"
          ? t("ai.approval.foldRemoved", { n: row.hidden, defaultValue: "⋯ 还有 {{n}} 行删掉的" })
          : t("ai.approval.foldAdded", { n: row.hidden, defaultValue: "⋯ 还有 {{n}} 行新增的" });
    const body = (
      <>
        {lineNumbers && <span className={styles.line} />}
        <span className={styles.mark} />
        <span className={styles.gapText}>
          {label}
          {row.type === "fold" && onFold && (
            <span className={styles.foldAction}> {t("ai.approval.expand")}</span>
          )}
        </span>
      </>
    );
    return row.type === "fold" && onFold ? (
      <button type="button" className={`${styles.gap} ${styles.gapButton}`} onClick={onFold}>
        {body}
      </button>
    ) : (
      <div className={styles.gap}>{body}</div>
    );
  }

  const rowClass =
    row.type === "del" ? styles.del : row.type === "add" ? styles.add : styles.context;
  return (
    <div className={`${styles.row} ${rowClass}`}>
      {lineNumbers && <span className={styles.line}>{row.line}</span>}
      <span className={styles.mark}>{row.type === "del" ? "−" : row.type === "add" ? "+" : ""}</span>
      <span className={styles.text}>
        {row.inline ? (
          row.inline
            // The del row shows what was there, the add row what arrives: each
            // skips the other's segments rather than drawing a merged sentence.
            .filter((seg) => seg.type === "equal" || seg.type === row.type)
            .map((seg, i) =>
              seg.type === "equal" ? (
                <span key={i}>{show(seg.text, whitespace)}</span>
              ) : (
                <mark key={i} className={row.type === "del" ? styles.litDel : styles.litAdd}>
                  {show(seg.text, whitespace)}
                </mark>
              ),
            )
        ) : (
          show(row.text, whitespace)
        )}
      </span>
    </div>
  );
}

/** An empty line has nothing to draw, so it draws its own newline instead. */
function show(text: string, whitespace?: boolean): string {
  if (!whitespace) return text;
  if (text === "") return "↵";
  return text.replace(/\t/g, "→").replace(/[ 　]/g, "␣");
}
