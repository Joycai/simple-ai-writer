import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { categoryLabel, MAX_SLOTS, newFacetSlotId, resolveWorkspace, slotLabel, suggestCategoryId, type FacetSlot } from "../../lib/profile";
import { useProjectStore, useTerms } from "../../stores/projectStore";
import { useLoreStore } from "../../stores/loreStore";
import { ModalShell } from "../common/ModalShell";
import styles from "./CategorySlotsModal.module.css";

const emptySlot = (): FacetSlot => ({ id: newFacetSlotId(), labelZh: "", labelEn: "" });

/** The same project schema editor serves category creation and every slot entry point. */
export function CategorySlotsModal({ categoryId, addSlot = false, onClose, onSaved }: {
  categoryId?: string;
  addSlot?: boolean;
  onClose: () => void;
  onSaved?: (categoryId: string, slotId?: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const terms = useTerms();
  const workspace = useProjectStore((s) => s.workspace);
  const customCategories = useProjectStore((s) => s.customCategories);
  const extensions = useProjectStore((s) => s.categoryExtensions);
  const projectPath = useProjectStore((s) => s.projectPath);
  const index = useLoreStore((s) => s.index);
  const category = workspace.categories.find((c) => c.id === categoryId);
  const own = customCategories.find((c) => c.id === categoryId);
  const inherited = categoryId ? resolveWorkspace(workspace.enabled).categories.find((c) => c.id === categoryId)?.slots ?? [] : [];
  const [label, setLabel] = useState("");
  const [slots, setSlots] = useState<FacetSlot[]>(() => {
    const initial = own?.slots ?? (categoryId ? extensions[categoryId.toLowerCase()]?.slots : undefined) ?? [];
    return addSlot && initial.length < MAX_SLOTS ? [...initial, emptySlot()] : [...initial];
  });
  const initial = useRef(JSON.stringify(slots));
  const originalIds = useRef(new Set((own?.slots ?? (categoryId ? extensions[categoryId.toLowerCase()]?.slots : undefined) ?? []).map((s) => s.id)));
  const openingProject = useRef(projectPath);
  const openingSchema = useRef(JSON.stringify({ category, own, extension: categoryId ? extensions[categoryId.toLowerCase()] : undefined }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const closeRef = useRef<(() => void) | null>(null);
  const dirty = label.trim().length > 0 || JSON.stringify(slots) !== initial.current || addSlot;
  const close = () => {
    if (!busy && (!dirty || window.confirm(t("common.unsavedConfirm")))) closeRef.current?.();
  };
  const update = (id: string, next: FacetSlot) => setSlots((list) => list.map((s) => s.id === id ? next : s));
  const move = (at: number, by: number) => setSlots((list) => {
    const next = [...list];
    [next[at], next[at + by]] = [next[at + by], next[at]];
    return next;
  });
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const store = useProjectStore.getState();
      if (!openingProject.current || store.projectPath !== openingProject.current) throw new Error(t("lore.slotEditor.projectChanged"));
      if (categoryId && openingSchema.current !== JSON.stringify({
        category: store.workspace.categories.find((c) => c.id === categoryId),
        own: store.customCategories.find((c) => c.id === categoryId),
        extension: store.categoryExtensions[categoryId.toLowerCase()],
      })) throw new Error(t("lore.slotEditor.schemaChanged"));
      let id = categoryId;
      if (id) await store.setCategorySlots(id, slots);
      else {
        id = suggestCategoryId(label, [...store.workspace.categories.map((c) => c.id), ...Object.keys(store.categoryExtensions)]);
        await store.setCustomCategories([...store.customCategories, {
          id, labelZh: label.trim(), labelEn: label.trim(), ...(slots.length ? { slots } : {}),
        }]);
      }
      onSaved?.(id, slots.find((s) => !originalIds.current.has(s.id))?.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const valid = (categoryId ? !!category : !!label.trim()) && slots.every((s) => s.labelZh.trim() && s.labelEn.trim());
  return (
    <ModalShell overlayClassName={styles.overlay} onClose={onClose} isDirty={dirty} closeOnBackdrop={false} closeOnEscape={!busy} closeRef={closeRef}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="category-slots-title">
        <header className={styles.header}>
          <h2 id="category-slots-title">{t(categoryId ? "lore.slotEditor.title" : "lore.newCategory.title")}</h2>
          <p>{category ? categoryLabel(category, isZh) : t("lore.slotEditor.optional")}</p>
          <p>{t("lore.slotEditor.shared", { entry: terms.entry })}</p>
        </header>
        <div className={styles.body}>
          <fieldset disabled={busy} className={styles.fields}>
            {!categoryId && <label>{t("lore.slotEditor.categoryName")}<input autoFocus maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} /></label>}
            {inherited.length > 0 && <section><h3>{t("lore.slotEditor.builtin")}</h3><div className={styles.inherited}>{inherited.map((s) => <span key={s.id}>{slotLabel(s, isZh)}</span>)}</div></section>}
            <h3>{t("lore.slotEditor.custom")}</h3>
            {slots.map((slot, at) => {
              const uses = Object.values(index).flat().filter((e) => e.category.toLowerCase() === categoryId?.toLowerCase()).reduce((n, e) => n + e.facets.filter((f) => f.slot?.toLowerCase() === slot.id.toLowerCase()).length, 0);
              return <section key={slot.id} className={styles.slot}>
                <SlotFields slot={slot} onChange={(next) => update(slot.id, next)} />
                <div className={styles.actions}>
                  <button type="button" disabled={at === 0} onClick={() => move(at, -1)}>{t("lore.slotEditor.up")}</button>
                  <button type="button" disabled={at === slots.length - 1} onClick={() => move(at, 1)}>{t("lore.slotEditor.down")}</button>
                  <button type="button" onClick={() => setRemoving(slot.id)}>{t("lore.slotEditor.remove")}</button>
                </div>
                {removing === slot.id && <div role="alert" className={styles.note}>
                  <p>{t("lore.slotEditor.removeNote", { count: uses })}</p>
                  <button type="button" onClick={() => { setSlots((list) => list.filter((s) => s.id !== slot.id)); setRemoving(null); }}>{t("lore.slotEditor.confirmRemove")}</button>
                  <button type="button" onClick={() => setRemoving(null)}>{t("common.cancel")}</button>
                </div>}
              </section>;
            })}
            <button type="button" disabled={slots.length >= MAX_SLOTS} onClick={() => setSlots((list) => [...list, emptySlot()])}>{t("lore.slotEditor.add")}</button>
            <p className={styles.note}>{t("lore.slotEditor.limit", { count: MAX_SLOTS })}</p>
          </fieldset>
          {error && <p role="alert" className={styles.error}>{error}</p>}
        </div>
        <footer className={styles.footer}>
          <button type="button" onClick={close} disabled={busy}>{t("common.cancel")}</button>
          <button type="button" className={styles.primary} onClick={() => void save()} disabled={!valid || busy || removing !== null}>{t(busy ? "lore.slotEditor.saving" : "common.save")}</button>
        </footer>
      </div>
    </ModalShell>
  );
}

function SlotFields({ slot, onChange }: { slot: FacetSlot; onChange: (next: FacetSlot) => void }) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const defaults = slot.defaults ?? {};
  const setDefault = (patch: Partial<NonNullable<FacetSlot["defaults"]>>) => onChange({ ...slot, defaults: { ...defaults, ...patch } });
  return <div className={styles.fields}>
    <label>{t("lore.slotEditor.name")}<input autoFocus={!slot.labelZh} maxLength={40} value={slotLabel(slot, isZh)} onChange={(e) => onChange({ ...slot, labelZh: e.target.value, labelEn: e.target.value })} /></label>
    <label>{t("lore.slotEditor.description")}<textarea maxLength={120} value={(isZh ? slot.hintZh : slot.hintEn) ?? ""} onChange={(e) => onChange({ ...slot, hintZh: e.target.value, hintEn: e.target.value })} /></label>
    <label className={styles.checkbox}><input type="checkbox" checked={slot.expected ?? false} onChange={(e) => onChange({ ...slot, expected: e.target.checked })} />{t("lore.slotEditor.expected")}</label>
    <details><summary>{t("lore.slotEditor.defaults")}</summary>
      <p className={styles.note}>{t("lore.slotEditor.defaultsNote")}</p>
      <div className={styles.fields}>
        <label>{t("lore.slotEditor.mode")}<select value={defaults.mode ?? ""} onChange={(e) => setDefault({ mode: (e.target.value || undefined) as typeof defaults.mode })}>
          <option value="">{t("lore.slotEditor.unset")}</option>
          {["auto", "always", "manual"].map((mode) => <option key={mode} value={mode}>{t(`lore.slotEditor.${mode}`)}</option>)}
        </select></label>
        <label>{t("lore.slotEditor.priority")}<input type="number" value={defaults.priority ?? ""} onChange={(e) => setDefault({ priority: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
        <label>{t("lore.slotEditor.group")}<input maxLength={40} value={defaults.group ?? ""} onChange={(e) => setDefault({ group: e.target.value || undefined })} /></label>
        <label>{t("lore.slotEditor.keys")}<input value={(defaults.keys ?? []).join(",")} onChange={(e) => setDefault({ keys: e.target.value.split(/[,，]/) })} /></label>
      </div>
    </details>
  </div>;
}
