import { useTranslation } from "react-i18next";
import { SHORTCUTS, comboLabel, type ShortcutCategory } from "../../../lib/shortcuts";
import styles from "../settingsCommon.module.css";

const SHORTCUT_CATEGORY_ORDER: ShortcutCategory[] = ["global", "file", "ai", "editor", "contextual"];

export function ShortcutsPane() {
  const { t } = useTranslation();
  return (
    <div>
      {SHORTCUT_CATEGORY_ORDER.map((cat) => {
        const items = SHORTCUTS.filter((s) => s.category === cat);
        if (items.length === 0) return null;
        return (
          <div className={styles.section} key={cat}>
            <div className={styles.sectionTitle}>{t(`systemSettings.shortcuts.categories.${cat}`)}</div>
            <div className={styles.itemList}>
              {items.map((s) => (
                <div className={styles.item} key={s.id}>
                  <div className={styles.itemInfo}>
                    <div className={styles.itemName}>{t(`systemSettings.shortcuts.items.${s.labelKey}`)}</div>
                  </div>
                  <span className={styles.badge}>{s.combo ? comboLabel(s.combo) : s.keysLabel}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
