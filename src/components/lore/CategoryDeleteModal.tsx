/**
 * 删除一个知识库分类——**先说清楚里面有多少条，再让作者说它们去哪**（设计稿 03f 屏 1a/1b）。
 *
 * 这块板子存在的理由，是它取代的那个东西：设置页里一颗没有确认、不报数的 `X`，
 * 按下去只把这一条从 `profile.json` 摘掉，磁盘上的文件夹和里面的条目一条不动，随即
 * 变成 orphan 分类继续挂在墙上、标签退化成文件夹 id。作者的感受是「我删了，它还在，
 * 而且名字变丑了」。「不删条目」那一半是对的（见 `lore-category-manage-plan.md` 的
 * 不变量 2），错的是不说。
 *
 * 所以两个出口是**并列的两张卡**而不是一个复选框：复选框会让「没勾」也成为一个
 * 默认后果，而这里两条路的结果差得很远。默认一条都不选，确认键跟着禁用——删除是
 * 不可逆那一侧，作者必须主动说出他要哪一条。降级态里只剩一条出口时形制不变：还是
 * 卡、还是单选标记——同一个决定不因为选项少了就换一种问法（1z · A1）。
 *
 * 组件本身不写盘：它只回一个 `CategoryDeleteChoice`，搬条目和摘声明由调用方组合。
 * 两个调用方（知识库墙的分类芯片右键、设置 → 工作台）因此共用同一次确认，不会有
 * 一扇门带确认、另一扇门不带。
 */
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
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
  const twoExits = n > 0 && !orphan;

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

  const num = (v: number) => <span className={styles.num}>{v}</span>;

  return (
    <ModalShell overlayClassName={styles.backdrop} onClose={onClose} closeOnBackdrop={!busy}>
      <div className={styles.modal} role="dialog" aria-labelledby="cat-delete-title">
        <div className={styles.header}>
          <div className={styles.eyebrow}>
            {orphan ? t("lore.categoryDelete.eyebrowEmpty") : t("lore.categoryDelete.eyebrow")}
          </div>
          <div className={styles.title} id="cat-delete-title">
            <span className={styles.dot} style={{ background: categoryColor(categoryId) }} />
            <span className={styles.titleName}>{label}</span>
            {/* orphan 的显示名就是文件夹名，再写一遍 id 是废话——写它的身份。 */}
            {orphan
              ? <span className={styles.orphanTag}>{t("lore.categoryDelete.orphanTag")}</span>
              : <span className={styles.titleId}>{categoryId}</span>}
          </div>
          <div className={styles.count}>
            {n === 0
              ? t("lore.categoryDelete.empty")
              : orphan
                ? <>{t("lore.categoryDelete.orphanLead")} {num(n)} {t("lore.categoryDelete.orphanCount")}</>
                : <>{num(n)} {t("lore.categoryDelete.count")}</>}
          </div>
        </div>

        {n > 0 && (
          <div className={styles.body}>
            {twoExits && <div className={styles.exitsLabel}>{t("lore.categoryDelete.exitsLabel")}</div>}

            <ExitCard
              on={choice === "move"}
              disabled={!canMove}
              onPick={() => setChoice("move")}
              name={<>{t("lore.categoryDelete.moveLabelPre")}{num(n)}{t("lore.categoryDelete.moveLabelPost")}</>}
              note={canMove ? t("lore.categoryDelete.moveNote", { n }) : t("lore.categoryDelete.noTargets")}
            >
              {choice === "move" && canMove && (
                <div className={styles.targets}>
                  <div className={styles.chips}>
                    {targets.map((cat) => (
                      <button
                        type="button"
                        key={cat.id}
                        className={`${styles.target} ${target === cat.id ? styles.targetOn : ""}`}
                        onClick={(e) => { e.stopPropagation(); setTarget(cat.id); }}
                      >
                        <span className={styles.targetDot} style={{ background: categoryColor(cat.id) }} />
                        {categoryLabel(cat, isZh)}
                      </button>
                    ))}
                  </div>
                  {/* 选定目标后把搬家写成路径：文件夹是磁盘上真实存在的那个字符串，所以走 mono。 */}
                  {target && (
                    <div className={styles.pathLine}>
                      {t("lore.categoryDelete.pathLine", { from: categoryId, to: target, n })}
                    </div>
                  )}
                </div>
              )}
            </ExitCard>

            {/* orphan 没有声明可摘，这条出口对它等于「什么都不做」。 */}
            {!orphan && (
              <ExitCard
                on={choice === "keep"}
                onPick={() => setChoice("keep")}
                name={t("lore.categoryDelete.keepLabel")}
                note={
                  <>
                    {t("lore.categoryDelete.keepNotePre", { n })}
                    <span className={styles.mono}>{categoryId}</span>
                    {t("lore.categoryDelete.keepNotePost")}
                  </>
                }
              />
            )}

            {error && <div className={styles.error}>{error}</div>}
          </div>
        )}
        {n === 0 && error && <div className={`${styles.body} ${styles.error}`}>{error}</div>}

        <div className={styles.actions}>
          {/* 「未选择」不是催——它只是说明右边那颗键为什么是灰的。 */}
          {n > 0 && !ready && !busy && (
            <span className={styles.unchosen}>{t("lore.categoryDelete.unchosen")}</span>
          )}
          <span className={styles.grow} />
          <button className={styles.btnGhost} onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button className={styles.btnConfirm} onClick={() => void confirm()} disabled={!ready || busy}>
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

/**
 * 一张出口卡：单选标记 + 名字 + 后果，选中时目标 chips 长在卡里。
 * 是 `div[role=radio]` 而不是 `button`：chips 本身是按钮，按钮不能套按钮。
 */
function ExitCard({
  on,
  disabled = false,
  onPick,
  name,
  note,
  children,
}: {
  on: boolean;
  disabled?: boolean;
  onPick: () => void;
  name: ReactNode;
  note: ReactNode;
  children?: ReactNode;
}) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(); }
  };
  return (
    <div
      role="radio"
      aria-checked={on}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      className={`${styles.choice} ${on ? styles.choiceOn : ""} ${disabled ? styles.choiceDisabled : ""}`}
      onClick={() => { if (!disabled) onPick(); }}
      onKeyDown={onKey}
    >
      <div className={styles.choiceHead}>
        <span className={`${styles.radio} ${on ? styles.radioOn : ""}`} />
        <div className={styles.choiceText}>
          <div className={styles.choiceName}>{name}</div>
          <div className={styles.choiceNote}>{note}</div>
        </div>
      </div>
      {children}
    </div>
  );
}
