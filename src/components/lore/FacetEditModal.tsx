/**
 * Create / edit / convert-to-facet form (设计稿 03 · 分面: 左列表 + 右编辑器).
 * One modal, three entries:
 *   file === null            → create a new facet file
 *   file is an existing facet → edit it (frontmatter pre-filled)
 *   file is a plain attachment → convert it (defaults + body preserved)
 *
 * The left column lists the entity's facets so the author can hop between
 * them without leaving the modal; switching away from a dirty form asks first.
 * The form is the whole point: authors manage facet frontmatter without
 * ever hand-writing YAML.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Sparkles } from "lucide-react";
import {
  createFacetFile,
  parseFacetMeta,
  readEntityFile,
  saveFacetFile,
  type FacetMeta,
  type LoreEntity,
} from "../../lib/lore";
import { parseFrontmatter } from "../../lib/fs/markdown";
import { categoryLabel, findCategory } from "../../lib/profile";
import { useProjectStore } from "../../stores/projectStore";
import { useLoreStore } from "../../stores/loreStore";
import { MarkdownTextarea } from "../common/MarkdownTextarea";
import { MarkdownPreview } from "../common/MarkdownPreview";
import { ModalShell } from "../common/ModalShell";
import { useImeGuard } from "../../lib/ime";
import { FacetAiAssistantModal } from "./ai/FacetAiAssistantModal";
import { Select } from "../common/Select";
import styles from "./FacetEditModal.module.css";

interface Props {
  entity: LoreEntity;
  /** null → create; existing facet file → edit; plain attachment → convert. */
  file: string | null;
  onClose: () => void;
}

export function FacetEditModal({ entity, file, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const { projectPath } = useProjectStore();
  const scanProject = useLoreStore((s) => s.scanProject);

  // Which file the editor is showing. Starts on the prop, but the left list
  // can switch it (or reset it to null = create) without reopening the modal.
  const [activeFile, setActiveFile] = useState<string | null>(file);

  const [title, setTitle] = useState("");
  const [keys, setKeys] = useState<string[]>([]);
  const [keyInput, setKeyInput] = useState("");
  const [group, setGroup] = useState("");
  const [priority, setPriority] = useState(0);
  const [mode, setMode] = useState<FacetMeta["mode"]>("auto");
  const [body, setBody] = useState("");
  const [bodyView, setBodyView] = useState<"editor" | "preview">("editor");
  const [loaded, setLoaded] = useState(file === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAi, setShowAi] = useState(false);

  // Group suggestions: every group already used on this entity.
  const knownGroups = useMemo(
    () => [...new Set((entity.facets ?? []).map((f) => f.group).filter(Boolean))] as string[],
    [entity.facets],
  );

  // (Re)load whenever the active file changes; also handles the initial mount.
  const initialSnapshot = useRef<string | null>(null);
  useEffect(() => {
    setTitle("");
    setKeys([]);
    setKeyInput("");
    setGroup("");
    setPriority(0);
    setMode("auto");
    setBody("");
    setError(null);
    initialSnapshot.current = null;
    if (!activeFile) { setLoaded(true); return; }
    setLoaded(false);
    readEntityFile(entity.dirPath, activeFile)
      .then((raw) => {
        const meta = parseFacetMeta(raw, activeFile);
        if (meta) {
          setTitle(meta.title);
          setKeys(meta.keys);
          setGroup(meta.group ?? "");
          setPriority(meta.priority);
          setMode(meta.mode);
        } else {
          // Convert flow: seed the title from the filename.
          setTitle(activeFile.replace(/\.md$/, ""));
        }
        setBody(parseFrontmatter(raw).content);
      })
      .catch(() => setError(t("lore.facet.loadError", { defaultValue: "读取文件失败" })))
      .finally(() => setLoaded(true));
  }, [entity.dirPath, activeFile, t]);

  const keyIme = useImeGuard();
  const addKey = () => {
    const v = keyInput.trim();
    if (v && !keys.includes(v)) setKeys([...keys, v]);
    setKeyInput("");
  };

  // Dirty tracking: snapshot the form once it's loaded, then compare. A close
  // gesture only prompts when the current form differs from that baseline.
  const snapshot = JSON.stringify({ title, keys, group, priority, mode, body });
  useEffect(() => {
    if (loaded && initialSnapshot.current === null) initialSnapshot.current = snapshot;
  }, [loaded, snapshot]);
  const dirty = loaded && initialSnapshot.current !== null && initialSnapshot.current !== snapshot;

  const switchTo = (next: string | null) => {
    if (next === activeFile) return;
    if (dirty && !window.confirm(t("lore.facet.switchDiscard", { defaultValue: "当前分面有未保存的修改，切换将丢弃，继续？" }))) return;
    setActiveFile(next);
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
      if (activeFile) {
        await saveFacetFile(entity.dirPath, activeFile, meta, body);
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

  const cat = findCategory(entity.category);

  return (
    <>
    <ModalShell overlayClassName={styles.overlay} onClose={onClose} isDirty={dirty} closeOnBackdrop={false}>
      <div className={styles.panel}>
        <div className={styles.header}>
          <span className={styles.headerTitle}>
            {entity.name} · {t("lore.facet.section", { defaultValue: "分面" })}
          </span>
          <span className={styles.headerBadge}>
            {cat ? categoryLabel(cat, false) : entity.category}
          </span>
          <span className={styles.spacer} />
          <span className={styles.headerNote}>
            {t("lore.facet.headerNote", { defaultValue: "分面独立检索，命中哪个注入哪个 — 不再整条塞入" })}
          </span>
          <button className={styles.newFacetBtn} onClick={() => switchTo(null)}>
            + {t("lore.facet.new", { defaultValue: "新分面" })}
          </button>
          <button className={styles.closeBtn} onClick={onClose} title={t("common.close", { defaultValue: "关闭" })}>
            <X size={14} />
          </button>
        </div>

        <div className={styles.cols}>
          {/* Left: facet list */}
          <div className={styles.list}>
            {entity.facets.length === 0 && activeFile === null && (
              <div className={styles.listEmpty}>
                {t("lore.facet.listEmpty", { defaultValue: "还没有分面 — 右侧填写第一条" })}
              </div>
            )}
            {entity.facets.map((f) => (
              <button
                key={f.file}
                className={`${styles.listRow} ${activeFile === f.file ? styles.listRowActive : ""}`}
                onClick={() => switchTo(f.file)}
              >
                <span className={styles.listTitle}>{f.title}</span>
                {f.mode === "auto" && f.keys.length === 0 && (
                  <span className={styles.listBadge}>
                    {t("lore.facet.needsWork", { defaultValue: "待完善" })}
                  </span>
                )}
                <span className={styles.spacer} />
                <span className={styles.listMeta}>
                  {f.charCount} {isZh ? "字" : "ch"}
                </span>
              </button>
            ))}
            {activeFile === null && (
              <div className={`${styles.listRow} ${styles.listRowActive}`}>
                <span className={styles.listTitle}>
                  + {t("lore.facet.createTitle", { defaultValue: "新建分面" })}
                </span>
              </div>
            )}

            <div className={styles.behaviorCard}>
              <div className={styles.behaviorHead}>
                {t("lore.facet.behaviorHead", { defaultValue: "检索行为" })}
              </div>
              <div className={styles.behaviorText}>
                {t("lore.facet.behaviorText", {
                  defaultValue: "提示词命中某个分面的关键词时只注入该分面，省下其余字数预算。",
                })}
              </div>
            </div>
          </div>

          {/* Right: editor */}
          <div className={styles.editor}>
            <div className={styles.editorScroll}>
              <div className={styles.fieldRow}>
                <div className={styles.fieldGrow}>
                  <label className={styles.label}>
                    {t("lore.facet.fieldTitle", { defaultValue: "分面名称" })}
                  </label>
                  <input
                    className={styles.input}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={t("lore.facet.titlePlaceholder", { defaultValue: "如：战甲形象" })}
                    autoFocus={activeFile === null}
                  />
                </div>
                <div className={styles.fieldNarrow}>
                  <label className={styles.label}>
                    {t("lore.facet.fieldMode", { defaultValue: "激活方式" })}
                  </label>
                  <Select
                    className={styles.modeSelect}
                    value={mode}
                    onChange={(v) => setMode(v as FacetMeta["mode"])}
                    options={[
                      { value: "auto", label: t("lore.facet.modeAutoShort", { defaultValue: "自动" }) },
                      { value: "always", label: t("lore.facet.modeAlwaysShort", { defaultValue: "总是" }) },
                      { value: "manual", label: t("lore.facet.modeManualShort", { defaultValue: "仅手动" }) },
                    ]}
                  />
                </div>
              </div>

              <div className={styles.bodyBlock}>
                <div className={styles.bodyHead}>
                  <label className={styles.label}>
                    {t("lore.facet.fieldBody", { defaultValue: "正文" })}
                  </label>
                  <div className={styles.viewToggle}>
                    {(["editor", "preview"] as const).map((v) => (
                      <button
                        key={v}
                        className={`${styles.viewBtn} ${bodyView === v ? styles.viewBtnActive : ""}`}
                        onClick={() => setBodyView(v)}
                      >
                        {t(`editor.viewMode.${v}`)}
                      </button>
                    ))}
                  </div>
                </div>
                {bodyView === "editor" ? (
                  <MarkdownTextarea
                    className={styles.bodyTextarea}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    spellCheck={false}
                    placeholder={t("lore.facet.bodyPlaceholder", { defaultValue: "这一分面的具体设定内容…" })}
                  />
                ) : body.trim() ? (
                  // basePath: facet files live in the entity folder, so relative
                  // image links resolve against it.
                  <MarkdownPreview source={body} basePath={entity.dirPath} className={styles.bodyPreview} />
                ) : (
                  <div className={`${styles.bodyPreview} ${styles.bodyPreviewEmpty}`}>
                    {t("lore.facet.previewEmpty", { defaultValue: "暂无内容" })}
                  </div>
                )}
              </div>

              <div>
                <label className={styles.label}>
                  {t("lore.facet.fieldKeys", { defaultValue: "检索关键词" })}
                </label>
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
                  <input
                    className={styles.chipAddInput}
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    {...keyIme.imeProps}
                    onKeyDown={(e) => {
                      if (keyIme.isComposing(e)) return;
                      if (e.key === "Enter") { e.preventDefault(); addKey(); }
                    }}
                    onBlur={addKey}
                    placeholder={t("lore.facet.addKeyShort", { defaultValue: "+ 添加" })}
                  />
                </div>
                {mode === "auto" && keys.length === 0 && (
                  <div className={styles.hintWarn}>
                    {t("lore.facet.keysEmptyWarn", { defaultValue: "自动模式下没有关键词，此特征永远不会被自动注入" })}
                  </div>
                )}
              </div>

              <div className={styles.fieldRow}>
                <div className={styles.fieldGrow}>
                  <label className={styles.label}>
                    {t("lore.facet.fieldGroup", { defaultValue: "互斥组" })}
                  </label>
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
                <div className={styles.fieldNarrow}>
                  <label className={styles.label}>
                    {t("lore.facet.fieldPriority", { defaultValue: "优先级" })}
                  </label>
                  <input
                    className={styles.input}
                    type="number"
                    value={priority}
                    onChange={(e) => setPriority(Number(e.target.value))}
                  />
                </div>
              </div>

              {error && <div className={styles.error}>{error}</div>}
            </div>
          </div>
        </div>

        <div className={styles.footer}>
          <button
            className={styles.aiLink}
            onClick={() => setShowAi(true)}
            disabled={!loaded}
            title={t("lore.facet.ai.open", { defaultValue: "AI 助手" })}
          >
            <Sparkles size={11} strokeWidth={2} />
            {t("lore.facet.ai.linkLabel", { defaultValue: "AI 助手 · 就这个分面提问或改写" })}
          </button>
          <span className={styles.spacer} />
          <button className={styles.btn} onClick={onClose} disabled={busy}>
            {t("common.cancel", { defaultValue: "取消" })}
          </button>
          <button className={styles.btnPrimary} onClick={handleSave} disabled={!canSave}>
            {busy
              ? t("lore.facet.saving", { defaultValue: "保存中…" })
              : t("lore.facet.save", { defaultValue: "保存" })}
          </button>
        </div>
      </div>
    </ModalShell>

    {showAi && (
      <FacetAiAssistantModal
        entity={entity}
        facetTitle={title}
        facetKeys={keys}
        facetBody={body}
        onApply={(patch) => {
          if (patch.body !== undefined) setBody(patch.body);
          if (patch.keys) setKeys(patch.keys);
        }}
        onClose={() => setShowAi(false)}
      />
    )}
    </>
  );
}
