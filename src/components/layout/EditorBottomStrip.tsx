import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import { useProjectStore } from "../../stores/projectStore";
import { MOD_KEY } from "../../lib/platform";
import styles from "./EditorBottomStrip.module.css";

interface Props {
  paragraph?: number;
  sentence?: number;
  refsCount?: number;
}

export function EditorBottomStrip({ paragraph, sentence, refsCount = 0 }: Props) {
  const { t, i18n } = useTranslation();
  const setShowCommandPalette = useAppStore((s) => s.setShowCommandPalette);
  const { wordCount } = useProjectStore();
  const isZh = i18n.language === "zh-CN";

  return (
    <div className={styles.strip}>
      <span>
        {paragraph !== undefined && sentence !== undefined
          ? t("editorStrip.paragraph", { p: paragraph, s: sentence })
          : ""}
      </span>
      <span className={styles.right}>
        <span>
          {isZh ? "累计 " : "Total "}
          <span className={styles.value}>{wordCount.toLocaleString()}</span>
          {isZh ? " 字" : " words"}
        </span>
        <span>
          {isZh ? "引用 " : ""}
          <span className={styles.value}>{refsCount}</span>
          {isZh ? " 设定" : " lore refs"}
        </span>
        <span className={styles.summon} onClick={() => setShowCommandPalette(true)}>
          {t("editorStrip.summon", { mod: MOD_KEY })}
        </span>
      </span>
    </div>
  );
}
