/**
 * 删除一个知识库分类——**先说清楚里面有多少条，再让作者说它们去哪**。
 *
 * 这块板子存在的理由，是它取代的那个东西：设置页里一颗没有确认、不报数的 `X`，
 * 按下去只把这一条从 `profile.json` 摘掉，磁盘上的文件夹和里面的条目一条不动，随即
 * 变成 orphan 分类继续挂在墙上、标签退化成文件夹 id。作者的感受是「我删了，它还在，
 * 而且名字变丑了」。「不删条目」那一半是对的（见 `lore-category-manage-plan.md` 的
 * 不变量 2），错的是不说。
 *
 * 所以两个出口是**并列的两张卡**而不是一个复选框：复选框会让「没勾」也成为一个
 * 默认后果，而这里两条路的结果差得很远。默认一条都不选，确认键跟着禁用——删除是
 * 不可逆那一侧，作者必须主动说出他要哪一条。
 *
 * 组件本身不写盘：它只回一个 `CategoryDeleteChoice`，搬条目和摘声明由调用方组合。
 * 两个调用方（知识库墙的分类芯片右键、设置 → 工作台）因此共用同一次确认，不会有
 * 一扇门带确认、另一扇门不带。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import type { IndexedCategory, LoreEntity } from "../../lib/lore";
import { categoryLabel } from "../../lib/profile";
import { ModalShell } from "../common/ModalShell";
import { categoryColor } from "./catColor";
import styles from "./CategoryDeleteModal.module.css";

/** `move` 连同条目搬去 `target` 再删；`keep` 只摘声明，文件夹与条目原样留下。 */
export type CategoryDeleteChoice = { kind: "move"; target: string } | { kind: "keep" };

export function CategoryDeleteModal({
  categoryId,
  label,
  entities,
  targets,
  orphan = false,
  onConfirm,
  onClose,
}: {
  categoryId: string;
  label: string;
  /** 这个分类现有的条目。空数组＝界面收成一句确认，没有出口可选。 */
  entities: LoreEntity[];
  /** 可以搬去哪：非 orphan、且不是它自己。 */
  targets: IndexedCategory[];
  /**
   * orphan 分类（有条目、但没有能力包声明它）没有声明可摘，「保留文件夹」对它不是
   * 一条出口而是「什么都不做」。所以它只剩搬空这一条，标题也跟着换成「清空」。
   */
  orphan?: boolean;
  onConfirm: (choice: CategoryDeleteChoice) => Promise<void>;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const n = entities.length;
  const [choice, setChoice] = useState<"move" | "keep" | null>(
    // 空分类没有出口要选；orphan 只有一条，替作者选掉它不算替他做决定。
    n === 0 ? "keep" : orphan ? "move" : null,
  );
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canMove = targets.length > 0;
  const ready = choice === "keep" || (choice === "move" && target !== null);

  const confirm = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(
        choice === "move" && target ? { kind: "move", target } : { kind: "keep" },
      );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell overlayClassName={styles.backdrop} onClose={onClose} closeOnBackdrop={!busy}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <div className={styles.eyebrow}>
            {orphan ? t("lore.categoryDelete.eyebrowEmpty") : t("lore.categoryDelete.eyebrow")}
          </div>
          <div className={styles.title}>
            <span className={styles.dot} style={{ background: categoryColor(categoryId) }} />
            {label}
          </div>
        </div>

        <div className={styles.body}>
          <div className={styles.count}>
            {n === 0 ? (
              t("lore.categoryDelete.empty")
            ) : (
              <>
                <span className={styles.countNum}>{n}</span>{" "}
                {t("lore.categoryDelete.count")}
              </>
            )}
          </div>

          {n > 0 && (
            <>
              <button
                type="button"
                className={`${styles.choice} ${choice === "move" ? styles.choiceOn : ""}`}
                disabled={!canMove}
                onClick={() => setChoice("move")}
              >
                <span className={styles.choiceHead}>
                  <span className={`${styles.radio} ${choice === "move" ? styles.radioOn : ""}`}>
                    {choice === "move" && <span className={styles.radioDot} />}
                  </span>
                  <span className={styles.choiceName}>
                    {t("lore.categoryDelete.moveLabel", { n })}
                  </span>
                </span>
                <span className={styles.choiceNote}>
                  {canMove ? t("lore.categoryDelete.moveNote") : t("lore.categoryDelete.noTargets")}
                </span>
              </button>

              {choice === "move" && canMove && (
                <div className={styles.targets}>
                  {targets.map((cat) => (
                    <button
                      type="button"
                      key={cat.id}
                      className={`${styles.target} ${target === cat.id ? styles.targetOn : ""}`}
                      onClick={() => setTarget(cat.id)}
                    >
                      <span
                        className={styles.targetDot}
                        style={{ background: categoryColor(cat.id) }}
                      />
                      {categoryLabel(cat, isZh)}
                    </button>
                  ))}
                </div>
              )}

              {/* orphan 没有声明可摘，这条出口对它等于「什么都不做」。 */}
              {!orphan && (
                <button
                  type="button"
                  className={`${styles.choice} ${choice === "keep" ? styles.choiceOn : ""}`}
                  onClick={() => setChoice("keep")}
                >
                  <span className={styles.choiceHead}>
                    <span className={`${styles.radio} ${choice === "keep" ? styles.radioOn : ""}`}>
                      {choice === "keep" && <span className={styles.radioDot} />}
                    </span>
                    <span className={styles.choiceName}>{t("lore.categoryDelete.keepLabel")}</span>
                  </span>
                  <span className={styles.choiceNote}>
                    {t("lore.categoryDelete.keepNote", { id: categoryId })}
                  </span>
                </button>
              )}
            </>
          )}

          {error && <div className={styles.error}>{error}</div>}
        </div>

        <div className={styles.actions}>
          <button className={styles.btnSecondary} onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button className={styles.btnDanger} onClick={() => void confirm()} disabled={!ready || busy}>
            <AlertTriangle size={12} style={{ verticalAlign: "-1px", marginRight: 6 }} />
            {busy
              ? t("lore.categoryDelete.working")
              : orphan
                ? t("lore.categoryDelete.confirmEmpty")
                : t("lore.categoryDelete.confirm")}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
