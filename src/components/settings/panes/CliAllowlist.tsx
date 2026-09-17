import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import {
  CLI_ALLOW_SUGGESTIONS,
  addCliAllowed,
  readCliAllowlist,
  removeCliAllowed,
  type AllowAddResult,
} from "../../../lib/cli/allowlist";
import { useImeGuard } from "../../../lib/ime";
import styles from "./Lab.module.css";

/**
 * 实验室 → 命令行 → 免审批命令（设计稿「命令行 · 免审批命令」Main 画板）。
 *
 * 一排可移除的程序名 + 一个添加框 + 常用建议。只在命令行开关打开时画：
 * 关着时整个工具缺席，清单没有意义（但保留，重新打开时还在）。
 * 什么算被覆盖、什么不能加入，都在 `lib/cli/command`；这里只管画和转述原因。
 */
export function CliAllowlist() {
  const { t } = useTranslation();
  const [list, setList] = useState<string[]>(() => readCliAllowlist());
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ime = useImeGuard();
  const inputId = useId();
  const errorId = useId();

  const explain = (res: Extract<AllowAddResult, { ok: false }>): string | null => {
    switch (res.reason) {
      case "empty":
        return null;
      case "duplicate":
        return t("systemSettings.lab.cliAllowDuplicate", { name: res.name });
      case "invalid":
        return t("systemSettings.lab.cliAllowInvalid", { name: draft.trim() || res.name });
      case "runs-code":
        return t("systemSettings.lab.cliAllowRunsCode", { name: res.name });
      case "changes-shell":
        return t("systemSettings.lab.cliAllowChangesShell", { name: res.name });
    }
  };

  /** `fromField`: a suggestion chip leaves whatever the author is typing alone. */
  const add = (raw: string, fromField: boolean) => {
    const res = addCliAllowed(raw);
    if (res.ok) {
      setList(res.list);
      if (fromField) setDraft("");
      setError(null);
    } else if (fromField) {
      setError(explain(res));
      if (res.reason === "duplicate") setDraft("");
    }
  };

  const suggestions = CLI_ALLOW_SUGGESTIONS.filter((n) => !list.includes(n));

  return (
    <div className={styles.allow}>
      <div className={styles.allowHead}>
        <span className={styles.allowTitle}>{t("systemSettings.lab.cliAllowTitle")}</span>
        {list.length > 0 && (
          <span className={styles.allowCount}>{t("systemSettings.lab.cliAllowCount", { count: list.length })}</span>
        )}
      </div>
      <div className={styles.allowDesc}>{t("systemSettings.lab.cliAllowDesc")}</div>

      {list.length > 0 ? (
        <ul className={styles.allowChips} aria-label={t("systemSettings.lab.cliAllowTitle")}>
          {list.map((name) => (
            <li key={name} className={styles.allowChip}>
              <span className={styles.allowChipName}>{name}</span>
              <button
                type="button"
                className={styles.allowChipRemove}
                aria-label={t("systemSettings.lab.cliAllowRemove", { name })}
                title={t("systemSettings.lab.cliAllowRemove", { name })}
                onClick={() => {
                  setList(removeCliAllowed(name));
                  setError(null);
                }}
              >
                <X size={10} strokeWidth={1.6} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className={styles.allowEmpty}>{t("systemSettings.lab.cliAllowEmpty")}</div>
      )}

      <div className={styles.allowAdd}>
        <label htmlFor={inputId} className={styles.srOnly}>
          {t("systemSettings.lab.cliAllowAddLabel")}
        </label>
        <input
          id={inputId}
          className={error ? `${styles.allowInput} ${styles.allowInputBad}` : styles.allowInput}
          value={draft}
          placeholder={t("systemSettings.lab.cliAllowPlaceholder")}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          {...ime.imeProps}
          onKeyDown={(e) => {
            if (ime.isComposing(e)) return;
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft, true);
            }
          }}
        />
        <button
          type="button"
          className={styles.allowAddBtn}
          disabled={!draft.trim()}
          onClick={() => add(draft, true)}
        >
          {t("systemSettings.lab.cliAllowAdd")}
        </button>
      </div>
      {error && (
        <div id={errorId} role="alert" className={styles.allowError}>
          {error}
        </div>
      )}

      {suggestions.length > 0 && (
        <div className={styles.allowSuggest}>
          <span>{t("systemSettings.lab.cliAllowSuggest")}</span>
          {suggestions.map((name) => (
            <button key={name} type="button" className={styles.allowSuggestBtn} onClick={() => add(name, false)}>
              + {name}
            </button>
          ))}
        </div>
      )}

      <div className={styles.allowFoot}>{t("systemSettings.lab.cliAllowBuiltin")}</div>
    </div>
  );
}
