/**
 * 「从 Word 文件读取格式」（设计稿 1h/1i）。
 *
 * 这一屏的重点是**来源那一列**，不是值那一列。一份 .docx 总能读出一整套规格，
 * 但其中哪些是这份文件**自己写死的**、哪些是 Word 出厂值补的，是两件完全不同
 * 的事——作者把它当模板照抄之前必须看见这个区别。全是「Word 默认」的文件读取
 * 并没有失败，它只是不能当格式要求用，这句话要说出来（1i）。
 *
 * 只收 .docx/.dotx：确切数值只存在于 Word 文件里，从 PDF 或截图推断磅值是猜。
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, FileText, X } from "lucide-react";
import { BUILTIN_FORMATS } from "../../../lib/docx/format";
import { readPickedDocFormat, type ReadResult } from "../../../lib/docx/read";
import { baseName } from "../../../lib/paths";
import styles from "./DocFormat.module.css";

type State =
  | { phase: "idle" }
  | { phase: "reading"; file: string }
  | { phase: "read"; file: string; path: string; result: ReadResult }
  | { phase: "error"; file: string; message: string };

export function DocxImportModal({
  onClose,
  onAdopt,
}: {
  onClose: () => void;
  /** `save` 为真＝存成预设并留在列表里；否则只挂进本次会话。 */
  onAdopt: (args: { file: string; path: string; result: ReadResult; name: string; save: boolean; makeDefault: boolean }) => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ phase: "idle" });
  const [name, setName] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);

  const pick = async () => {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Word", extensions: ["docx", "dotx"] }],
    });
    if (typeof picked !== "string") return;
    const file = baseName(picked);
    if (!/\.(docx|dotx)$/i.test(picked)) {
      setState({ phase: "error", file, message: t("docxFormat.import.wrongKind", { ext: file.split(".").pop() ?? "?" }) });
      return;
    }
    setState({ phase: "reading", file });
    setName(file.replace(/\.(docx|dotx)$/i, ""));
    try {
      const result = await readPickedDocFormat(picked);
      setState({ phase: "read", file, path: picked, result });
    } catch (e) {
      setState({ phase: "error", file, message: e instanceof Error ? e.message : String(e) });
    }
  };

  const clean = BUILTIN_FORMATS.find((p) => p.id === "clean")!;

  return (
    <>
      <div className={styles.scrim} onClick={onClose} />
      <div className={styles.modal} role="dialog" aria-label={t("docxFormat.import.title")}>
        <div className={styles.modalHead}>
          <div>
            <div className={styles.modalTitle}>{t("docxFormat.import.title")}</div>
            <div className={styles.modalSub}>{t("docxFormat.import.sub")}</div>
          </div>
          <button className={styles.iconBtn} onClick={onClose} aria-label={t("common.close")}>
            <X size={15} />
          </button>
        </div>

        <div className={styles.modalBody}>
          {state.phase === "idle" && (
            <button className={styles.dropZone} onClick={() => void pick()}>
              <FileText size={18} />
              {t("docxFormat.import.pick")}
              <span className={styles.echo}>{t("docxFormat.import.onlyDocx")}</span>
            </button>
          )}

          {state.phase === "reading" && <div className={styles.modalNote}>{t("docxFormat.import.reading", { file: state.file })}</div>}

          {state.phase === "error" && (
            <>
              <div className={styles.errorBlock}>
                <AlertTriangle size={16} className={styles.errorIcon} />
                <div>
                  <div className={styles.errorTitle}>{t("docxFormat.import.cannotRead", { file: state.file })}</div>
                  <div className={styles.errorText}>{state.message}</div>
                  <div className={styles.errorAlso}>{t("docxFormat.import.alsoUnreadable")}</div>
                </div>
              </div>
              <div className={styles.modalFoot}>
                <button className={styles.ghostBtn} onClick={() => void pick()}>{t("docxFormat.import.pickAgain")}</button>
                <span className={styles.grow} />
                <button className={styles.ghostBtn} onClick={onClose}>{t("common.cancel")}</button>
              </div>
            </>
          )}

          {state.phase === "read" && (
            <>
              <div className={styles.fileChip}>
                <FileText size={13} />
                <span className={styles.fileName}>{state.file}</span>
                <span className={styles.grow} />
                <button className={styles.rowAction} onClick={() => void pick()}>{t("docxFormat.import.another")}</button>
              </div>

              {state.result.declaredCount === 0 && (
                <div className={styles.warnBlock}>
                  <div className={styles.warnTitle}>{t("docxFormat.import.nothingPinnedTitle")}</div>
                  <div className={styles.warnText}>{t("docxFormat.import.nothingPinned", { name: clean.label })}</div>
                </div>
              )}

              <div className={styles.readHead}>
                <span className={styles.readHeadLabel}>{t("docxFormat.import.readSpec")}</span>
                <span className={styles.echo}>
                  {t("docxFormat.import.declaredCount", { n: state.result.declaredCount, total: state.result.rows.length })}
                </span>
              </div>
              <div className={styles.readTable}>
                <div className={styles.readRowHead}>
                  <span>{t("docxFormat.import.colItem")}</span>
                  <span>{t("docxFormat.import.colValue")}</span>
                  <span>{t("docxFormat.import.colSource")}</span>
                </div>
                {state.result.rows.map((r) => (
                  <div key={r.label} className={styles.readRow}>
                    <span className={styles.readLabel}>{r.label}</span>
                    <span className={styles.readValue}>{r.value}</span>
                    <span className={r.source === "declared" ? styles.sourceDeclared : styles.sourceDefault}>
                      {t(`docxFormat.import.source_${r.source}`)}
                    </span>
                  </div>
                ))}
              </div>

              {state.result.notes.map((n) => (
                <div key={n} className={styles.modalNote}>{n}</div>
              ))}

              <div className={styles.adopt}>
                <div className={styles.adoptLabel}>{t("docxFormat.import.next")}</div>
                <div className={styles.adoptRow}>
                  <input
                    className={styles.textInput}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    aria-label={t("docxFormat.import.presetName")}
                    placeholder={t("docxFormat.import.presetName")}
                  />
                  <button
                    className={styles.primaryBtn}
                    disabled={!name.trim()}
                    onClick={() => onAdopt({ file: state.file, path: state.path, result: state.result, name: name.trim(), save: true, makeDefault })}
                  >
                    {t("docxFormat.import.saveAsPreset")}
                  </button>
                </div>
                <label className={styles.adoptCheck}>
                  <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
                  {t("docxFormat.import.alsoDefault")}
                </label>
                <div className={styles.adoptAlt}>
                  <button
                    className={styles.ghostBtn}
                    onClick={() => onAdopt({ file: state.file, path: state.path, result: state.result, name: state.file, save: false, makeDefault: false })}
                  >
                    {t("docxFormat.import.useOnce")}
                  </button>
                  <span className={styles.echo}>{t("docxFormat.import.useOnceHint")}</span>
                  <span className={styles.grow} />
                  <button className={styles.ghostBtn} onClick={onClose}>{t("common.cancel")}</button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
