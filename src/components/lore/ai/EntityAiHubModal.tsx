/**
 * Entity-level AI task chooser — the single "AI 编辑助手" entry that replaces the
 * three separate buttons on the entity toolbar. Picking a card hands the choice
 * back to LoreDetail, which opens the matching flow (meta improve / update /
 * split). Deliberately dumb: no AI logic here, just routing.
 */

import { useTranslation } from "react-i18next";
import { X, Sparkles, Wand2, Scissors, ChevronRight } from "lucide-react";
import { ModalShell } from "../../common/ModalShell";
import styles from "../LoreImproveModal.module.css";
import hub from "./EntityAiHubModal.module.css";

export type EntityAiTask = "meta" | "improve" | "split";

interface Props {
  entityName: string;
  onPick: (task: EntityAiTask) => void;
  onClose: () => void;
}

export function EntityAiHubModal({ entityName, onPick, onClose }: Props) {
  const { t } = useTranslation();

  const cards: { task: EntityAiTask; icon: React.ReactNode; name: string; desc: string }[] = [
    {
      task: "meta",
      icon: <Sparkles size={17} strokeWidth={1.6} />,
      name: t("lore.aiHub.metaName", { defaultValue: "优化元数据" }),
      desc: t("lore.aiHub.metaDesc", { defaultValue: "重写名称、别名、分类与概要" }),
    },
    {
      task: "improve",
      icon: <Wand2 size={17} strokeWidth={1.6} />,
      name: t("lore.aiHub.improveName", { defaultValue: "更新条目" }),
      desc: t("lore.aiHub.improveDesc", { defaultValue: "结合资料/图片更新内容，可写入整体或指定特征" }),
    },
    {
      task: "split",
      icon: <Scissors size={17} strokeWidth={1.6} />,
      name: t("lore.aiHub.splitName", { defaultValue: "拆分整理" }),
      desc: t("lore.aiHub.splitDesc", { defaultValue: "把条目内容重新整理并拆分为特征" }),
    },
  ];

  return (
    <ModalShell overlayClassName={styles.overlay} onClose={onClose}>
      <div className={styles.panel} style={{ maxWidth: 480 }}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <div className={styles.headerAvatarPlaceholder}><Sparkles size={16} strokeWidth={1.5} /></div>
            <div>
              <div className={styles.headerName}>{t("lore.aiHub.title", { defaultValue: "AI 编辑助手" })}</div>
              <div className={styles.headerSub}>{entityName}</div>
            </div>
          </div>
          <button className={styles.closeBtn} onClick={onClose}><X size={16} /></button>
        </div>

        <div className={styles.body}>
          <div className={hub.list}>
            {cards.map((c) => (
              <button key={c.task} className={hub.card} onClick={() => onPick(c.task)}>
                <div className={hub.icon}>{c.icon}</div>
                <div className={hub.text}>
                  <div className={hub.name}>{c.name}</div>
                  <div className={hub.desc}>{c.desc}</div>
                </div>
                <ChevronRight size={16} className={hub.chevron} />
              </button>
            ))}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
