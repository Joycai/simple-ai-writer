/**
 * 编辑区里「这个文件没有进编辑器」的那一页——三种原因，三种说法：
 *
 * - `convertible`：`docx / xlsx / pdf / pptx`。应用认得它，只是不在这里编辑；
 *   有产出的动作是「转换文档」。按扩展名就知道，**根本不去读**。
 * - `notText`：读了才知道的二进制（`.zip`、`.psd`、一段录音）。同样不是故障——
 *   再读一遍还是这些字节，所以没有「重试」，只剩交给系统。
 * - `error`：真的没读出来（权限、文件不见了、I/O）。只有这一种叫「失败」，也只有
 *   它带着原因和「重试」。
 *
 * 前两种原先也落在第三种的页面上：作者点开一份 `.pptx`，看到的是「文件打开失败」
 * 和一句 `not a text file (contains NUL bytes)`——一次按设计必然发生的事，用了
 * 出故障的措辞。哪一种由 `lib/fs/docKind` 的 `fileNoticeReason` 判，这里只管
 * 把话说对。
 *
 * 由 `EditorArea` 带 `key={path}` 渲染：上一个文件的失败回执不挂到下一个文件上。
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { loadIntoEditor } from "../../stores/openDocument";
import type { FileNoticeReason } from "../../lib/fs/docKind";
import { openWithDefaultApp } from "../../lib/fs/fileio";
import { extOf } from "../../lib/fs/rowMeta";
import { baseName } from "../../lib/paths";
import { useConvertDoc } from "./useConvertDoc";
import styles from "./EditorArea.module.css";

interface Props {
  path: string;
  reason: FileNoticeReason;
  /** `error` only: what the read said. */
  message?: string;
}

export function FileNotice({ path, reason, message }: Props) {
  const { t } = useTranslation();
  // A failed action's reason stays until the next attempt — the author came
  // here to act, not to watch a two-second flash. (The title bar's twin
  // buttons keep their own short receipt; this page has room for the sentence.)
  const [actionError, setActionError] = useState<string | null>(null);
  const name = baseName(path);
  const ext = extOf(name).toUpperCase();

  const openExternal = () => {
    setActionError(null);
    // No saveNow() first: this file never reached the buffer, so there is
    // nothing of it that could be dirty.
    openWithDefaultApp(path).catch((e) => {
      console.error("[FileNotice] open with default app failed:", e);
      setActionError(`${t("fileTree.openExternalFailed", { name })} ${e instanceof Error ? e.message : String(e)}`);
    });
  };

  return (
    <div className={styles.empty}>
      <div className={styles.emptyInner}>
        <div className={styles.emptyEyebrow}>
          {reason === "error"
            ? t("editor.loadErrorEyebrow")
            : ext
              ? t("editor.noticeEyebrow", { ext })
              : t("editor.noticeEyebrowNoExt")}
        </div>
        <h1 className={styles.emptyTitle}>
          {reason === "error"
            ? t("editor.loadErrorTitle")
            : reason === "convertible"
              ? t("editor.convertibleTitle")
              : t("editor.notTextTitle")}
        </h1>
        <p className={styles.emptyHint}>
          {reason === "error"
            ? t("editor.loadErrorHint", { message })
            : reason === "convertible"
              ? t("editor.convertibleHint", { convert: t("fileTree.convertDoc") })
              : t("editor.notTextHint")}
        </p>
        <div className={styles.emptyCta}>
          {reason === "error" && (
            <button className={styles.emptyCtaBtn} onClick={() => void loadIntoEditor(path)}>
              {t("editor.loadErrorRetry")}
            </button>
          )}
          {reason === "convertible" && (
            <ConvertCta
              path={path}
              onStart={() => setActionError(null)}
              onFail={(why) => setActionError(`${t("fileTree.convertFailed", { name })} ${why}`)}
            />
          )}
          <button className={styles.emptyCtaBtn} onClick={openExternal}>
            {t("editor.loadErrorOpenExternal")}
          </button>
        </div>
        {/* Same register as the page's own hint above — one more line of the
            page, not a new surface. */}
        {actionError && (
          <p className={`${styles.emptyHint} ${styles.emptyCtaNote}`} role="alert">{actionError}</p>
        )}
      </div>
    </div>
  );
}

/** Its own component so the hook only runs for files that can be converted. */
function ConvertCta({ path, onStart, onFail }: {
  path: string;
  onStart: () => void;
  onFail: (why: string) => void;
}) {
  const { t } = useTranslation();
  const { run, busy, waitingOn } = useConvertDoc(path);

  return (
    <button
      className={styles.emptyCtaBtn}
      disabled={busy}
      title={waitingOn ? t("titleBar.convertWaiting", { name: baseName(waitingOn) }) : undefined}
      onClick={() => {
        onStart();
        void run().then((why) => { if (why !== null) onFail(why); });
      }}
    >
      {busy && !waitingOn ? t("titleBar.converting") : t("fileTree.convertDoc")}
    </button>
  );
}
