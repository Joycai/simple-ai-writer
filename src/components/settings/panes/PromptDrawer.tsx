import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { useAiStore } from "../../../stores/aiStore";
import type { Prompt } from "../../../lib/ai/configDb";
import { Select } from "../../common/Select";
import styles from "../settingsCommon.module.css";
import ui from "../settingsUi.module.css";
import hub from "./ProvidersModels.module.css";

/** Not an override target: snippets feed the quick-insert picker on the
 *  自定义/chat input boxes (see SnippetPicker) and are never auto-applied. */
export const SNIPPET_SCENE = "snippet";

const SCENES = ["system", "continue", "polish", "rewrite", "summary", "lore", SNIPPET_SCENE];

interface Props {
  /** An existing prompt to edit, or the seed for a new one (no id). */
  draft: Partial<Prompt>;
  onClose: () => void;
}

export function PromptDrawer({ draft, onClose }: Props) {
  const { t } = useTranslation();
  const { addPrompt, updatePrompt } = useAiStore();
  const editing = !!draft.id;

  const [form, setForm] = useState({
    name: draft.name ?? "",
    scene: draft.scene ?? "continue",
    content: draft.content ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!form.name || !form.content) return;
    setSaving(true);
    setError(null);
    try {
      if (draft.id) {
        await updatePrompt({ id: draft.id, ...form });
      } else {
        await addPrompt(form);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={hub.drawer} role="dialog" aria-label={t("aiConfig.prompts.addTitle")}>
      <div className={hub.drawerHead}>
        <div style={{ minWidth: 0 }}>
          <div className={hub.drawerTitle}>
            {editing ? t("aiConfig.prompts.editTitle") : t("aiConfig.prompts.addTitle")}
          </div>
          <div className={hub.drawerSub}>{t("aiConfig.prompts.drawerSub")}</div>
        </div>
        <span className={hub.footSpacer} />
        <button className={hub.iconBtn} onClick={onClose} title={t("aiConfig.prompts.cancel")}>
          <X size={16} />
        </button>
      </div>

      <div className={hub.drawerBody}>
        {error && <div className={styles.errorNote}>{error}</div>}

        <div className={styles.fieldGroup}>
          <label className={styles.label}>{t("aiConfig.prompts.nameLabel")}</label>
          {/* Kept even though the redesign's row shows the scene badge instead:
              the snippet picker lists prompts by name, so an unnamed one would
              be unpickable there. */}
          <input
            className={styles.input}
            placeholder={t("aiConfig.prompts.namePlaceholder")}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.label}>{t("aiConfig.prompts.sceneLabel")}</label>
          <Select
            value={form.scene}
            onChange={(v) => setForm({ ...form, scene: v })}
            options={SCENES.map((s) => ({
              value: s,
              label: s === SNIPPET_SCENE ? `${t("aiConfig.prompts.sceneSnippet")} (${s})` : `${t(`ai.tasks.${s}`)} (${s})`,
            }))}
            ariaLabel={t("aiConfig.prompts.sceneLabel")}
          />
          <div className={ui.rowDesc}>
            {form.scene === SNIPPET_SCENE
              ? t("aiConfig.prompts.sceneSnippetHint")
              : t("aiConfig.prompts.sceneHint")}
          </div>
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.label}>{t("aiConfig.prompts.contentLabel")}</label>
          <textarea
            className={`${styles.input} ${styles.textarea} ${hub.promptArea}`}
            rows={16}
            placeholder={t("aiConfig.prompts.contentPlaceholder")}
            value={form.content}
            onChange={(e) => setForm({ ...form, content: e.target.value })}
          />
        </div>
      </div>

      <div className={hub.drawerFoot}>
        <span className={hub.escHint}>{t("aiConfig.hub.escToClose")}</span>
        <span className={hub.footSpacer} />
        <button className={styles.btnSecondary} onClick={onClose}>{t("aiConfig.prompts.cancel")}</button>
        <button
          className={styles.btnPrimary}
          onClick={handleSave}
          disabled={!form.name || !form.content || saving}
        >
          {saving
            ? t("aiConfig.prompts.saving")
            : (editing ? t("aiConfig.prompts.save") : t("aiConfig.prompts.add"))}
        </button>
      </div>
    </div>
  );
}
