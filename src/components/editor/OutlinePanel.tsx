import { useTranslation } from "react-i18next";
import type { HeadingNode } from "../../lib/markdown";
import styles from "./OutlinePanel.module.css";

const LEVEL_CLASS: Record<number, string> = {
  1: styles.h1,
  2: styles.h2,
  3: styles.h3,
  4: styles.h4,
  5: styles.h5,
  6: styles.h6,
};

interface Props {
  headings: HeadingNode[];
  onClickHeading?: (heading: HeadingNode) => void;
}

export function OutlinePanel({ headings, onClickHeading }: Props) {
  const { t } = useTranslation();
  if (headings.length === 0) {
    return <div className={styles.empty}>{t("editor.noHeadings")}</div>;
  }

  return (
    <div className={styles.outline}>
      {headings.map((h) => (
        <div
          key={h.id}
          className={`${styles.item} ${LEVEL_CLASS[h.level] ?? ""}`}
          onClick={() => onClickHeading?.(h)}
          title={h.text}
        >
          {h.text}
        </div>
      ))}
    </div>
  );
}
