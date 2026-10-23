import { useTranslation } from "react-i18next";
import styles from "./ChatError.module.css";

/** Keep gateway HTML out of the summary; preserve the raw response as text. */
export function errorPreview(error: string): string {
  return error.split(/<(?:[a-z][\w:-]*(?:\s|\/?>)|!doctype\b|\?xml\b)/i)[0]
    .replace(/\s+/g, " ").trim().slice(0, 180);
}

export function ChatError({ error, onRetry }: { error: string; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className={styles.error}>
      <div className={styles.header}>
        <span className={styles.title} role="alert">{t("ai.chat.errorTitle")}</span>
        {onRetry && (
          <button type="button" className={styles.retry} onClick={onRetry} title={t("ai.chat.retryHint")}>
            {t("ai.chat.retry")}
          </button>
        )}
      </div>
      <details className={styles.details}>
        <summary>
          <span>{t("ai.chat.errorDetails")}</span>
          <span className={styles.preview}>{errorPreview(error)}</span>
        </summary>
        <pre className={styles.body}>{error}</pre>
      </details>
    </div>
  );
}
