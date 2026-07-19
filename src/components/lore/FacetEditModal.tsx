/**
 * Create / edit / convert-to-facet form. One modal, three entries:
 *   file === null            → create a new facet file
 *   file is an existing facet → edit it (frontmatter pre-filled)
 *   file is a plain attachment → convert it (defaults + body preserved)
 *
 * The form is the whole point: authors manage facet frontmatter without
 * ever hand-writing YAML.
 */

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X, Layers } from "lucide-react";
import {
  createFacetFile,
  parseFacetMeta,
  readEntityFile,
  saveFacetFile,
  type FacetMeta,
  type LoreEntity,
} from "../../lib/lore";
import { parseFrontmatter } from "../../lib/fs/markdown";
import { useProjectStore } from "../../stores/projectStore";
import { useLoreStore } from "../../stores/loreStore";
import { MarkdownTextarea } from "../common/MarkdownTextarea";
import styles from "./FacetEditModal.module.css";

interface Props {
  entity: LoreEntity;
  /** null → create; existing facet file → edit; plain attachment → convert. */
  file: string | null;
  onClose: () => void;
}

export function FacetEditModal({ entity, file, onClose }: Props) {
  const { t } = useTranslation();
  const { projectPath } = useProjectStore();
  const scanProject = useLoreStore((s) => s.scanProject);

  const [title, setTitle] = useState("");
  const [keys, setKeys] = useState<string[]>([]);
  const [keyInput, setKeyInput] = useState("");
  const [group, setGroup] = useState("");
  const [priority, setPriority] = useState(0);
  const [mode, setMode] = useState<FacetMeta["mode"]>("auto");
  const [body, setBody] = useState("");
  const [loaded, setLoaded] = useState(file === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Group suggestions: every group already used on this entity.
  const knownGroups = useMemo(
    () => [...new Set((entity.facets ?? []).map((f) => f.group).filter(Boolean))] as string[],
    [entity.facets],
  );

  useEffect(() => {
    if (!file) return;
    readEntityFile(entity.dirPath, file)
      .then((raw) => {
        const meta = parseFacetMeta(raw, file);
        if (meta) {
          setTitle(meta.title);
          setKeys(meta.keys);
          setGroup(meta.group ?? "");
          setPriority(meta.priority);
          setMode(meta.mode);
        } else {
          // Convert flow: seed the title from the filename.
          setTitle(file.replace(/\.md$/, ""));
        }
        setBody(parseFrontmatter(raw).content);
      })
      .catch(() => setError(t("lore.facet.loadError", { defaultValue: "读取文件失败" })))
      .finally(() => setLoaded(true));
  }, [entity.dirPath, file, t]);

  const addKey = () => {
    const v = keyInput.trim();
    if (v && !keys.includes(v)) setKeys([...keys, v]);
    setKeyInput("");
  };

  const canSave = loaded && !busy && title.trim().length > 0;

  const handleSave = async () => {
    if (!canSave || !projectPath) return;
    setBusy(true);
    setError(null);
    try {
      const meta: FacetMeta = {
        title: title.trim(),
        keys: keys.map((k) => k.trim()).filter(Boolean),
        group: group.trim() || null,
        priority: Number.isFinite(priority) ? priority : 0,
        mode,
      };
      if (file) {
        await saveFacetFile(entity.dirPath, file, meta, body);
      } else {
        await createFacetFile(entity.dirPath, meta, body);
      }
      await scanProject(projectPath);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const heading = file === null
    ? t("lore.facet.createTitle", { defaultValue: "新建特征" })
    : t("lore.facet.editTitle", { defaultValue: "编辑特征" });

  return createPortal(
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <Layers size={15} strokeWidth={1.8} />
            <span className={styles.headerTitle}>{heading}</span>
            <span className={styles.headerEntity}>{entity.name}{file ? ` · ${file}` : ""}</span>
          </div>
          <button className={styles.closeBtn} onClick={onClose} title={t("common.close", { defaultValue: "关闭" })}>
            <X size={16} />
          </button>
        </div>

        <div className={styles.formBody}>
          <div className={styles.grid}>
            <label className={styles.label}>
              {t("lore.facet.fieldTitle", { defaultValue: "名称" })}
            </label>
            <input
              className={styles.input}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("lore.facet.titlePlaceholder", { defaultValue: "如：战甲形象" })}
              autoFocus={file === null}
            />

            <label className={styles.label}>
              {t("lore.facet.fieldKeys", { defaultValue: "触发关键词" })}
            </label>
            <div>
              {keys.length > 0 && (
                <div className={styles.chips}>
                  {keys.map((k, i) => (
                    <span key={`${k}-${i}`} className={styles.chipTag}>
                      {k}
                      <button
                        className={styles.chipRemove}
                        onClick={() => setKeys(keys.filter((_, x) => x !== i))}
                        title={t("lore.facet.removeKey", { defaultValue: "移除" })}
                      >
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <input
                className={styles.input}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); addKey(); }
                }}
                onBlur={addKey}
                placeholder={t("lore.facet.keysPlaceholder", { defaultValue: "添加关键词（回车确认）— 正文出现任一关键词即激活" })}
              />
              {mode === "auto" && keys.length === 0 && (
                <div className={styles.hintWarn}>
                  {t("lore.facet.keysEmptyWarn", { defaultValue: "自动模式下没有关键词，此特征永远不会被自动注入" })}
                </div>
              )}
            </div>

            <label className={styles.label}>
              {t("lore.facet.fieldMode", { defaultValue: "激活方式" })}
            </label>
            <select className={styles.input} value={mode} onChange={(e) => setMode(e.target.value as FacetMeta["mode"])}>
              <option value="auto">{t("lore.facet.modeAuto", { defaultValue: "自动 — 实体命中且关键词命中时注入" })}</option>
              <option value="always">{t("lore.facet.modeAlways", { defaultValue: "总是 — 实体命中即注入" })}</option>
              <option value="manual">{t("lore.facet.modeManual", { defaultValue: "仅手动 — 只在被固定（pin）时注入" })}</option>
            </select>

            <label className={styles.label}>
              {t("lore.facet.fieldGroup", { defaultValue: "互斥组" })}
            </label>
            <div>
              <input
                className={styles.input}
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                list="facet-group-suggestions"
                placeholder={t("lore.facet.groupPlaceholder", { defaultValue: "可留空；同组同时命中只注入优先级最高的一个（如 outfit）" })}
              />
              <datalist id="facet-group-suggestions">
                {knownGroups.map((g) => <option key={g} value={g} />)}
              </datalist>
            </div>

            <label className={styles.label}>
              {t("lore.facet.fieldPriority", { defaultValue: "优先级" })}
            </label>
            <input
              className={`${styles.input} ${styles.inputNarrow}`}
              type="number"
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
            />
          </div>

          <div className={styles.bodyBlock}>
            <label className={styles.label}>
              {t("lore.facet.fieldBody", { defaultValue: "内容 · Markdown" })}
            </label>
            <MarkdownTextarea
              className={styles.bodyTextarea}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              spellCheck={false}
              placeholder={t("lore.facet.bodyPlaceholder", { defaultValue: "这一特征的具体设定内容…" })}
            />
          </div>

          {error && <div className={styles.error}>{error}</div>}
        </div>

        <div className={styles.footer}>
          <button className={styles.btn} onClick={onClose} disabled={busy}>
            {t("common.cancel", { defaultValue: "取消" })}
          </button>
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleSave} disabled={!canSave}>
            {busy
              ? t("lore.facet.saving", { defaultValue: "保存中…" })
              : t("lore.facet.save", { defaultValue: "保存" })}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
