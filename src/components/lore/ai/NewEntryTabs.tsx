/**
 * Mode toggle for the unified "new entry" flow. Placed at the top of both the
 * manual create form and the AI-extract (LoreGenerator) modal; switching swaps
 * one modal for the other so they read as a single entry point.
 */

import { useTranslation } from "react-i18next";
import { Plus, Sparkles } from "lucide-react";
import styles from "./NewEntryTabs.module.css";

export type NewEntryMode = "manual" | "ai";

interface Props {
  value: NewEntryMode;
  onChange: (mode: NewEntryMode) => void;
}

export function NewEntryTabs({ value, onChange }: Props) {
  const { t } = useTranslation();
  return (
    <div className={styles.tabs}>
      <button
        className={`${styles.tab} ${value === "manual" ? styles.tabActive : ""}`}
        onClick={() => onChange("manual")}
      >
        <Plus size={13} strokeWidth={2} /> {t("lore.newEntry.manual", { defaultValue: "手动创建" })}
      </button>
      <button
        className={`${styles.tab} ${value === "ai" ? styles.tabActive : ""}`}
        onClick={() => onChange("ai")}
      >
        <Sparkles size={13} strokeWidth={1.7} /> {t("lore.newEntry.ai", { defaultValue: "AI 提取" })}
      </button>
    </div>
  );
}
