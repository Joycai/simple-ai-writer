import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import { Sparkles } from "lucide-react";
import { MOD_KEY } from "../../lib/platform";
import styles from "./AiRail.module.css";

export function AiRail() {
  const { t } = useTranslation();
  const setShowAiDrawer = useAppStore((s) => s.setShowAiDrawer);
  const label = t("titleBar.summonAi");
  const labelRows = label.match(/AI|[^\s]/gu) ?? [];

  return (
    <div className={styles.rail}>
      {/* No mode passed: reopen the last-used tab. Explicit horizontal rows
          keep AI together and avoid vertical-writing wrapping in the webview. */}
      <button
        className={styles.handle}
        onClick={() => setShowAiDrawer(true)}
        aria-label={label}
        title={`${label} · ${MOD_KEY === "⌘" ? "⌘J" : "Ctrl+J"}`}
      >
        <Sparkles size={14} aria-hidden="true" />
        <span className={styles.label} aria-hidden="true">
          {labelRows.map((row, index) => <span key={index}>{row}</span>)}
        </span>
      </button>
      <span className={styles.spacer} />
    </div>
  );
}
