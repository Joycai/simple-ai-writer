/**
 * Entity-level AI task chooser (设计稿 03 · 实体 AI 中心) — the single
 * "AI 编辑助手" entry on the entity hero. A 2×2 action grid; picking a cell
 * hands the choice back to LoreDetail, which opens the matching flow
 * (improve / meta improve / image gen / split). Deliberately dumb: no AI
 * logic here, just routing.
 */

import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { X, Sparkles } from "lucide-react";
import { ModalShell } from "../../common/ModalShell";
import styles from "../LoreImproveModal.module.css";
import hub from "./EntityAiHubModal.module.css";

export type EntityAiTask = "meta" | "improve" | "image" | "split" | "dict";

interface Props {
  entityName: string;
  /** Whether an image model is configured — gates the 生成配图 cell. */
  imageGenReady?: boolean;
  /** This entry is a 翻译词典 (LoreEntity.dict) — shows the 词典标准化 cell. */
  dictEntry?: boolean;
  onPick: (task: EntityAiTask) => void;
  onClose: () => void;
}

export function EntityAiHubModal({ entityName, imageGenReady = false, dictEntry = false, onPick, onClose }: Props) {
  const { t } = useTranslation();
  const shellCloseRef = useRef<(() => void) | null>(null);
  const requestClose = () => (shellCloseRef.current ?? onClose)();

  const cells: { task: EntityAiTask; name: string; desc: string; disabled?: boolean; title?: string }[] = [
    {
      task: "improve",
      name: t("lore.aiHub.improveName", { defaultValue: "更新条目" }),
      desc: t("lore.aiHub.improveDesc", { defaultValue: "结合资料/图片更新内容，可写入指定特征或生成新特征" }),
    },
    {
      task: "meta",
      name: t("lore.aiHub.metaName", { defaultValue: "优化元数据" }),
      desc: t("lore.aiHub.metaDesc", { defaultValue: "重写名称、别名、分类与概要" }),
    },
    {
      task: "image",
      name: t("lore.aiHub.imageName", { defaultValue: "生成配图" }),
      desc: t("lore.aiHub.imageDesc", { defaultValue: "按正文描述出图 · 存入条目图库" }),
      disabled: !imageGenReady,
      title: imageGenReady ? undefined : t("lore.detail.aiGenImageNeedModel", { defaultValue: "需要先配置图像模型" }),
    },
    {
      task: "split",
      name: t("lore.aiHub.splitName", { defaultValue: "拆分整理" }),
      desc: t("lore.aiHub.splitDesc", { defaultValue: "把条目内容重新整理并拆分为特征" }),
    },
    // 只有勾了「翻译词典」开关的条目才有这一格：别的条目没有"Sakura 词典格式"
    // 这个概念，摆在那里只会让人点出一个空结果。
    ...(dictEntry
      ? [{
          task: "dict" as const,
          name: t("lore.aiHub.dictName"),
          desc: t("lore.aiHub.dictDesc"),
        }]
      : []),
  ];

  return (
    <ModalShell overlayClassName={styles.overlay} onClose={onClose} closeRef={shellCloseRef}>
      <div className={styles.panel} style={{ maxWidth: 660 }}>
        <div className={hub.head}>
          <Sparkles size={13} strokeWidth={1.8} color="var(--color-sienna)" />
          <span className={hub.headTitle}>
            {entityName} · {t("lore.aiHub.title", { defaultValue: "AI 编辑助手" })}
          </span>
          <span className={hub.spacer} />
          <span className={hub.headKbd}>Esc {t("common.close", { defaultValue: "关闭" })}</span>
          <button className={styles.closeBtn} onClick={requestClose}><X size={14} /></button>
        </div>

        <div className={hub.grid}>
          {cells.map((c) => (
            <button
              key={c.task}
              className={hub.cell}
              onClick={() => onPick(c.task)}
              disabled={c.disabled}
              title={c.title}
            >
              <div className={hub.name}>{c.name}</div>
              <div className={hub.desc}>{c.desc}</div>
            </button>
          ))}
        </div>
      </div>
    </ModalShell>
  );
}
