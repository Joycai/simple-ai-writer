import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { useAiStore } from "../../../stores/aiStore";
import { activeProfile, findTask, promptParams } from "../../../lib/profile";
import styles from "../settingsCommon.module.css";

const BUILTIN_PROMPTS_CONFIG = [
  { scene: "system", instructionKey: "ai.instructions.system" },
  { scene: "continue", instructionKey: "ai.instructions.continue" },
  { scene: "polish", instructionKey: "ai.instructions.polish" },
  { scene: "rewrite", instructionKey: "ai.instructions.rewrite" },
  { scene: "summary", instructionKey: "ai.instructions.summary" },
  { scene: "lore", instructionKey: "ai.instructions.lore" },
];

export function PromptsPane() {
  const { t, i18n } = useTranslation();
  const { prompts, addPrompt, removePrompt } = useAiStore();
  const [form, setForm] = useState({ name: "", content: "", scene: "system" });
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolve against the active profile: a scene that is a task id shows the
  // instruction that task actually uses (novel overrides continue/rewrite/
  // summary with its own wording), and "system" shows this profile's system
  // prompt — otherwise the editor would display a text no run ever sends.
  const isZh = i18n.language === "zh-CN";
  const builtinPrompts = BUILTIN_PROMPTS_CONFIG.map((b) => {
    const key = b.scene === "system"
      ? activeProfile().systemPromptKey
      : findTask(b.scene)?.instructionKey ?? b.instructionKey;
    return { ...b, label: t(`ai.tasks.${b.scene}`), content: t(key, promptParams(isZh)) };
  });

  const handleAdd = async () => {
    if (!form.name || !form.content) return;
    setSaving(true);
    setError(null);
    try {
      await addPrompt(form);
      setForm({ name: "", content: "", scene: "system" });
      setShowForm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>{t("aiConfig.prompts.builtinTitle")}</div>
        <div className={styles.itemList}>
          {builtinPrompts.map((b) => {
            const overridden = prompts.some((p) => p.scene === b.scene);
            return (
              <div key={b.scene} className={`${styles.item} ${styles.builtinItem}`}>
                <div className={styles.itemInfo}>
                  <div className={`${styles.itemName} ${overridden ? styles.itemNameDimmed : ""}`}>
                    {b.content}
                    {overridden && <span className={styles.overriddenTag}>{t("aiConfig.prompts.overridden")}</span>}
                  </div>
                </div>
                <span className={styles.badge}>{b.scene}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>{t("aiConfig.prompts.customTitle")}</div>
        {prompts.length === 0 && <div className={styles.emptyNote}>{t("aiConfig.prompts.empty")}</div>}
        <div className={styles.itemList}>
          {prompts.map((p) => (
            <div key={p.id} className={styles.item}>
              <div className={styles.itemInfo}>
                <div className={styles.itemName}>{p.name}</div>
                <div className={styles.itemMetaTruncated}>{p.content}</div>
              </div>
              <span className={styles.badge}>{p.scene}</span>
              <button className={styles.deleteBtn} onClick={() => removePrompt(p.id)}><X size={13} /></button>
            </div>
          ))}
        </div>
      </div>

      {showForm ? (
        <div className={styles.form}>
          <div className={styles.sectionTitle}>{t("aiConfig.prompts.addTitle")}</div>
          {error && <div className={styles.errorNote}>{error}</div>}
          <div className={styles.formRow}>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>{t("aiConfig.prompts.nameLabel")}</label>
              <input className={styles.input} placeholder={t("aiConfig.prompts.namePlaceholder")} value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>{t("aiConfig.prompts.sceneLabel")}</label>
              <select className={styles.select} value={form.scene}
                onChange={(e) => setForm({ ...form, scene: e.target.value })}>
                {/* "snippet" is not an override target: it feeds the quick-insert
                    picker on the 自定义/chat input boxes (see SnippetPicker). */}
                {["system", "continue", "polish", "rewrite", "summary", "lore", "snippet"].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>{t("aiConfig.prompts.contentLabel")}</label>
            <textarea className={`${styles.input} ${styles.textarea}`} rows={4} placeholder={t("ai.panel.customInstruction")}
              value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
          </div>
          <div className={styles.formActions}>
            <button className={styles.btnSecondary} onClick={() => { setShowForm(false); setError(null); }}>{t("aiConfig.prompts.cancel")}</button>
            <button className={styles.btnPrimary} onClick={handleAdd} disabled={!form.name || !form.content || saving}>
              {saving ? t("aiConfig.prompts.saving") : t("aiConfig.prompts.add")}
            </button>
          </div>
        </div>
      ) : (
        <button className={styles.btnPrimary} onClick={() => setShowForm(true)}>+ {t("aiConfig.prompts.add")}</button>
      )}
    </div>
  );
}
