/**
 * The prompt editor drawer — one drawer for both kinds of prompt, because the
 * fields are the same shape and a second drawer would only be a second thing to
 * keep in step.
 *
 * A **snippet** gets a name, a group, a body, and a live preview of the row it
 * will become in the picker. A **built-in override** gets the name and body but
 * no group — a group is a shelf in the snippet library, and an override does
 * not live there.
 *
 * The scene is not a dropdown any more. It arrives from where the drawer was
 * opened: the snippet list makes snippets, the override region makes overrides.
 * Asking the author to classify a prompt in a seven-value picker was the thing
 * that made snippets undiscoverable in the first place.
 *
 * 设计稿 `10 提示词库` 1i.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { useAiStore } from "../../../stores/aiStore";
import { SNIPPET_SCENE, type Prompt } from "../../../lib/ai/configDb";
import { countPlaceholders, previewLine, splitPlaceholders } from "../../../lib/ai/snippets";
import { Select } from "../../common/Select";
import styles from "../settingsCommon.module.css";
import ui from "../settingsUi.module.css";
import hub from "./ProvidersModels.module.css";
import pane from "./Prompts.module.css";

/** Re-exported for the surfaces that still import it from here. */
export { SNIPPET_SCENE };

/** Sentinel for "no group" — an empty string cannot be a Select value. */
const NO_GROUP = "__none__";

interface Props {
  /** An existing prompt to edit, or the seed for a new one (no id). */
  draft: Partial<Prompt>;
  /** Existing group names, offered in the dropdown. */
  groups?: string[];
  onClose: () => void;
}

export function PromptDrawer({ draft, groups = [], onClose }: Props) {
  const { t } = useTranslation();
  const { addPrompt, updatePrompt, removePrompt } = useAiStore();
  const editing = !!draft.id;
  const isSnippet = (draft.scene ?? SNIPPET_SCENE) === SNIPPET_SCENE;

  const [form, setForm] = useState({
    name: draft.name ?? "",
    content: draft.content ?? "",
    group: draft.group?.trim() ? draft.group.trim() : NO_GROUP,
  });
  const [newGroup, setNewGroup] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!form.name || !form.content) return;
    setSaving(true);
    setError(null);
    try {
      const next = {
        name: form.name,
        content: form.content,
        scene: draft.scene ?? SNIPPET_SCENE,
        group: isSnippet && form.group !== NO_GROUP ? form.group.trim() : "",
        useCount: draft.useCount ?? 0,
        lastUsedAt: draft.lastUsedAt ?? 0,
      };
      if (draft.id) await updatePrompt({ id: draft.id, ...next });
      else await addPrompt(next);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const placeholders = countPlaceholders(form.content);

  return (
    <div className={hub.drawer} role="dialog" aria-label={t("aiConfig.prompts.addTitle")}>
      <div className={hub.drawerHead}>
        <div style={{ minWidth: 0 }}>
          <div className={hub.drawerTitle}>
            {editing
              ? isSnippet
                ? t("aiConfig.prompts.editSnippet", { defaultValue: "编辑片段" })
                : t("aiConfig.prompts.editTitle")
              : isSnippet
                ? t("aiConfig.prompts.addSnippet", { defaultValue: "新建片段" })
                : t("aiConfig.prompts.addTitle")}
          </div>
          <div className={hub.drawerSub}>
            {!isSnippet
              ? t("aiConfig.prompts.drawerSub")
              : editing
                ? t("aiConfig.prompts.snippetMeta", { n: draft.useCount ?? 0 })
                : t("aiConfig.prompts.drawerSubSnippet")}
          </div>
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
          <input
            className={styles.input}
            placeholder={t("aiConfig.prompts.namePlaceholder")}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>

        {isSnippet && (
          <div className={styles.fieldGroup}>
            <label className={styles.label}>{t("aiConfig.prompts.groupLabel", { defaultValue: "分组" })}</label>
            {newGroup ? (
              <input
                className={styles.input}
                autoFocus
                placeholder={t("aiConfig.prompts.newGroupPlaceholder", { defaultValue: "新分组的名字" })}
                value={form.group === NO_GROUP ? "" : form.group}
                onChange={(e) => setForm({ ...form, group: e.target.value || NO_GROUP })}
                onBlur={() => { if (form.group === NO_GROUP) setNewGroup(false); }}
              />
            ) : (
              <Select
                value={form.group}
                onChange={(v) => {
                  if (v === "__new__") { setNewGroup(true); setForm({ ...form, group: NO_GROUP }); }
                  else setForm({ ...form, group: v });
                }}
                ariaLabel={t("aiConfig.prompts.groupLabel", { defaultValue: "分组" })}
                options={[
                  { value: NO_GROUP, label: t("ai.snippets.ungrouped", { defaultValue: "未分组" }) },
                  ...groups.map((g) => ({ value: g, label: g })),
                  { value: "__new__", label: t("aiConfig.prompts.newGroup", { defaultValue: "新建分组…" }) },
                ]}
              />
            )}
            <div className={ui.rowDesc}>
              {t("aiConfig.prompts.groupHint", {
                defaultValue: "清空即回到「未分组」。一个片段只属于一个分组。",
              })}
            </div>
          </div>
        )}

        <div className={styles.fieldGroup}>
          <label className={styles.label}>{t("aiConfig.prompts.contentLabel")}</label>
          <textarea
            className={`${styles.input} ${styles.textarea} ${hub.promptArea}`}
            rows={isSnippet ? 10 : 16}
            placeholder={t(isSnippet
              ? "aiConfig.prompts.contentPlaceholderSnippet"
              : "aiConfig.prompts.contentPlaceholder")}
            value={form.content}
            onChange={(e) => setForm({ ...form, content: e.target.value })}
          />
          {isSnippet && (
            <div className={ui.rowDesc}>
              {/* `{{…}}` is passed *in* rather than written into the translation:
                  a literal double brace in a value is i18next interpolation
                  syntax and would be swallowed. */}
              {t("aiConfig.prompts.placeholderHint", { ph: "{{…}}" })}
              {placeholders > 0 && (
                <> · {t("aiConfig.prompts.placeholderCount", { defaultValue: "本条有 {{n}} 处", n: placeholders })}</>
              )}
            </div>
          )}
        </div>

        {/* What it will look like where it is actually used. A snippet is judged
            by its row in the picker, not by its body in a textarea. */}
        {isSnippet && form.content.trim() && (
          <div className={styles.fieldGroup}>
            <label className={styles.label}>
              {t("aiConfig.prompts.previewLabel", { defaultValue: "在选择器里长什么样" })}
            </label>
            <div className={pane.list}>
              <div className={pane.row}>
                <span className={pane.name}>{form.name || t("aiConfig.prompts.namePlaceholder")}</span>
                <span className={pane.preview}>
                  {splitPlaceholders(previewLine(form.content)).map((p, i) =>
                    p.placeholder
                      ? <span key={i} className={pane.ph}>{p.text}</span>
                      : <span key={i}>{p.text}</span>,
                  )}
                </span>
              </div>
            </div>
            <div className={ui.rowDesc}>
              {t("aiConfig.prompts.insertNote", {
                defaultValue: "插入 = 追加到输入框末尾并换行",
              })}
              {form.group !== NO_GROUP && ` · ${form.group}`}
            </div>
          </div>
        )}
      </div>

      <div className={hub.drawerFoot}>
        {editing && (
          <button
            className={styles.btnSecondary}
            onClick={() => { void removePrompt(draft.id!); onClose(); }}
          >
            {t("aiConfig.prompts.delete")}
          </button>
        )}
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
