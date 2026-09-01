/**
 * 集合管理（设计稿 03 屏 29）：新建 / 重命名 / 拖动排序 / 删除。
 *
 * 删除那一步是这一屏的重点，因为它是唯一看起来会毁东西的操作。它不会：删掉的只是
 * 「属于某集合」这层归属，条目、特征、配图、磁盘上的文件全都不动。所以确认框不写
 * 「此操作不可撤销」这类通用恐吓，而是**把删完之后的样子算出来给作者看**——多少条
 * 会落进未归集、多少条还留在别的集合里、取材范围会不会跟着退回全部。
 *
 * 重命名要改写所有成员条目的 frontmatter（集合的 id 就是它的名字，见
 * lib/lore/collections），所以它是个异步操作，期间禁用整个列表。
 */
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { GripVertical } from "lucide-react";
import {
  collectionBreakdown,
  collectionViews,
  entityCollections,
  sameCollection,
  scopeHas,
  type LoreIndex,
  type LoreScope,
} from "../../../lib/lore";
import { categoryLabel, findCategory } from "../../../lib/profile";
import { useImeGuard } from "../../../lib/ime";
import { ModalShell } from "../../common/ModalShell";
import styles from "./manage.module.css";

export function CollectionsManageModal({
  index,
  declared,
  scope,
  onClose,
  onReorder,
  onCreate,
  onRename,
  onDelete,
}: {
  index: LoreIndex;
  declared: string[];
  scope: LoreScope;
  onClose: () => void;
  onReorder: (next: string[]) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  onRename: (from: string, to: string) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dragFrom = useRef<string | null>(null);
  const ime = useImeGuard();

  const views = useMemo(() => collectionViews(index, declared), [index, declared]);
  const rows = useMemo(
    () =>
      views.map((v) => ({
        ...v,
        breakdown: collectionBreakdown(index, v.name)
          .map(({ category, count }) => {
            const cat = findCategory(category);
            return `${cat ? categoryLabel(cat, isZh) : category} ${count}`;
          })
          .join(" "),
      })),
    [views, index, isZh],
  );

  /** 删掉这个集合之后，有多少条会真的变成「未归集」。 */
  const deleteImpact = (name: string) => {
    let members = 0;
    let orphan = 0;
    for (const entities of Object.values(index)) {
      for (const e of entities ?? []) {
        const cols = entityCollections(e);
        if (!cols.some((c) => sameCollection(c, name))) continue;
        members++;
        if (cols.length === 1) orphan++;
      }
    }
    return { members, orphan, kept: members - orphan };
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const create = () => {
    const name = draft.trim();
    if (!name) return;
    if (views.some((v) => sameCollection(v.name, name))) {
      setError(t("lore.collections.manage.duplicate"));
      return;
    }
    void run(async () => { await onCreate(name); setDraft(""); });
  };

  const commitRename = () => {
    const from = renaming;
    const to = renameDraft.trim();
    setRenaming(null);
    if (!from || !to || sameCollection(from, to)) return;
    void run(() => onRename(from, to));
  };

  const drop = (target: string) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    if (!from || from === target) return;
    const names = views.map((v) => v.name);
    const next = names.filter((n) => n !== from);
    next.splice(next.indexOf(target), 0, from);
    void run(() => onReorder(next));
  };

  const impact = confirming ? deleteImpact(confirming) : null;

  return (
    <ModalShell overlayClassName={styles.backdrop} onClose={onClose} isDirty={draft.trim().length > 0}>
      <div className={styles.panel}>
        <div className={styles.head}>
          <span className={styles.title}>{t("lore.collections.manage.title")}</span>
          <span className={styles.subtitle}>
            {t("lore.collections.manage.subtitle", { n: views.length })}
          </span>
          <span style={{ flex: 1 }} />
          <span className={styles.headEn}>Collections</span>
        </div>

        <div className={styles.list}>
          {rows.map((row) => (
            <div
              key={row.name}
              className={`${styles.row} ${renaming === row.name ? styles.rowEditing : ""}`}
              draggable={!busy && renaming === null}
              onDragStart={() => { dragFrom.current = row.name; }}
              onDragOver={(ev) => ev.preventDefault()}
              onDrop={() => drop(row.name)}
            >
              <GripVertical size={13} className={styles.grip} strokeWidth={1.6} />
              {renaming === row.name ? (
                <>
                  <input
                    className={styles.renameInput}
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (ime.isComposing(e)) return;
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") { e.stopPropagation(); setRenaming(null); }
                    }}
                    {...ime.imeProps}
                  />
                  <span className={styles.renameHint}>{t("lore.collections.manage.renaming")}</span>
                </>
              ) : (
                <>
                  <div className={styles.rowMain}>
                    <span className={styles.rowName}>{row.name}</span>
                    <span className={styles.rowMeta}>
                      {t("lore.collections.entries", { n: row.count })}
                      {row.breakdown ? ` · ${row.breakdown}` : ""}
                    </span>
                  </div>
                  <button
                    type="button"
                    className={styles.rowAction}
                    disabled={busy}
                    onClick={() => { setRenaming(row.name); setRenameDraft(row.name); }}
                  >
                    {t("lore.collections.manage.rename")}
                  </button>
                  <button
                    type="button"
                    className={`${styles.rowAction} ${styles.rowDanger}`}
                    disabled={busy}
                    onClick={() => setConfirming(row.name)}
                  >
                    {t("lore.collections.manage.delete")}
                  </button>
                </>
              )}
            </div>
          ))}
        </div>

        <div className={styles.createRow}>
          <input
            className={styles.createInput}
            value={draft}
            disabled={busy}
            placeholder={t("lore.collections.assign.newPlaceholder")}
            onChange={(e) => { setDraft(e.target.value); setError(null); }}
            onKeyDown={(e) => {
              if (ime.isComposing(e)) return;
              if (e.key === "Enter") create();
            }}
            {...ime.imeProps}
          />
          <button type="button" className={styles.createBtn} onClick={create} disabled={busy || !draft.trim()}>
            {t("lore.collections.manage.create")}
          </button>
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.foot}>
          {t("lore.collections.manage.emptyOk")}
          <span className={styles.footEn}> {t("lore.collections.manage.emptyOkEn")}</span>
        </div>
      </div>

      {confirming && impact && (
        <div className={styles.confirmLayer}>
          <div className={styles.confirmPanel}>
            <div className={styles.confirmTitle}>
              {t("lore.collections.manage.deleteTitle", { name: confirming })}
            </div>
            <div className={styles.confirmBody}>
              <div className={styles.confirmRow}>
                <span className={styles.confirmDot} />
                <span className={styles.confirmText}>
                  {t("lore.collections.manage.deleteBody", { n: impact.members, name: confirming })}
                </span>
              </div>
              <div className={styles.confirmEn}>{t("lore.collections.manage.deleteBodyEn")}</div>
              <div className={styles.confirmAfter}>
                <span className={styles.confirmAfterTitle}>
                  {t("lore.collections.manage.deleteAfter")}
                </span>
                <span className={styles.confirmAfterBody}>
                  {t("lore.collections.manage.deleteAfterBody", {
                    orphan: impact.orphan,
                    kept: impact.kept,
                  })}
                </span>
                {scopeHas(scope, confirming) && (
                  <span className={styles.confirmAfterBody}>
                    {t("lore.collections.manage.deleteAfterScope")}
                  </span>
                )}
              </div>
            </div>
            <div className={styles.confirmFoot}>
              <span style={{ flex: 1 }} />
              <button type="button" className={styles.confirmCancel} onClick={() => setConfirming(null)}>
                {t("common.cancel", { defaultValue: isZh ? "取消" : "Cancel" })}
              </button>
              <button
                type="button"
                className={styles.confirmDelete}
                disabled={busy}
                onClick={() => {
                  const name = confirming;
                  setConfirming(null);
                  void run(() => onDelete(name));
                }}
              >
                {t("lore.collections.manage.deleteConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </ModalShell>
  );
}
