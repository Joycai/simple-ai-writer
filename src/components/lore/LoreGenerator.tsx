import { useState, useEffect, useRef, KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { FileText, Image, X, Bot, Sparkles, RotateCw, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useProjectStore } from "../../stores/projectStore";
import { useAiStore } from "../../stores/aiStore";
import { useLoreStore } from "../../stores/loreStore";
import { LORE_CATEGORIES, type CategoryId } from "../../lib/lore";
import {
  scanProjectFiles,
  imageToDataUrl,
  readTextFileContent,
  generateLore,
  type ProjectFile,
} from "../../lib/loreGenerator";
import { writeBinaryFile } from "../../lib/fileio";
import { loadApiKey } from "../../lib/keyStore";
import styles from "./LoreGenerator.module.css";

type AttachedImage = { kind: "image"; file: ProjectFile; dataUrl: string };
type AttachedText  = { kind: "text";  file: ProjectFile; content: string };
type AttachedItem  = AttachedImage | AttachedText;

function PickerThumb({ file }: { file: ProjectFile }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (file.kind === "image") {
      imageToDataUrl(file.path).then(({ dataUrl }) => setUrl(dataUrl)).catch(() => {});
    }
  }, [file.path, file.kind]);
  if (file.kind === "text") {
    return (
      <div className={styles.atPickerThumbPlaceholder}>
        <FileText size={18} strokeWidth={1.5} />
      </div>
    );
  }
  if (!url) return <div className={styles.atPickerThumbPlaceholder}><Image size={18} strokeWidth={1.5} /></div>;
  return <img src={url} alt="" className={styles.atPickerThumb} />;
}

interface Props {
  onClose: () => void;
}

export function LoreGenerator({ onClose }: Props) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const { projectPath } = useProjectStore();
  const { models, providers, activeModelId, setActiveModel, prompts } = useAiStore();
  const { createNewEntity, scanProject } = useLoreStore();

  // ── Input state ──────────────────────────────────────────────────────────
  const [description, setDescription] = useState("");
  const [attached, setAttached] = useState<AttachedItem[]>([]);
  const [category, setCategory] = useState<CategoryId>("characters");

  // ── @ picker state ───────────────────────────────────────────────────────
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [atIndex, setAtIndex] = useState(0);
  const [atQuery, setAtQuery] = useState("");
  const [pickerStyle, setPickerStyle] = useState<React.CSSProperties>({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaWrapRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  // ── Generation state ─────────────────────────────────────────────────────
  const [phase, setPhase] = useState<"input" | "generating" | "result">("input");
  const [genStatus, setGenStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── Editable result fields ───────────────────────────────────────────────
  const [editName, setEditName] = useState("");
  const [editCat, setEditCat] = useState<CategoryId>("characters");
  const [editTags, setEditTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [editSummary, setEditSummary] = useState("");
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);

  // Status messages for generation
  const statusMessages = [
    t("lore.generator.status1"),
    t("lore.generator.status2"),
    t("lore.generator.status3"),
    t("lore.generator.status4"),
  ];

  useEffect(() => {
    if (projectPath) {
      scanProjectFiles(projectPath).then(setProjectFiles).catch(() => {});
    }
  }, [projectPath]);

  // Recompute picker position whenever it opens
  useEffect(() => {
    if (showPicker && textareaWrapRef.current) {
      const r = textareaWrapRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom - 8;
      const pickerH = Math.min(280, window.innerHeight * 0.4);
      if (spaceBelow >= pickerH) {
        setPickerStyle({ top: r.bottom + 4, left: r.left, width: r.width });
      } else {
        setPickerStyle({ bottom: window.innerHeight - r.top + 4, left: r.left, width: r.width });
      }
    }
  }, [showPicker]);

  // Close picker on outside click — but NOT when clicking inside the picker portal
  useEffect(() => {
    if (!showPicker) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (textareaWrapRef.current?.contains(t) || pickerRef.current?.contains(t)) return;
      setShowPicker(false);
    };
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, [showPicker]);

  // ── @ detection ──────────────────────────────────────────────────────────
  const handleDescChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    const pos = e.target.selectionStart ?? val.length;
    setDescription(val);
    const before = val.slice(0, pos);
    const match = before.match(/@(\w*)$/);
    if (match) {
      setAtIndex(pos - match[0].length);
      setAtQuery(match[1]);
      setShowPicker(true);
    } else {
      setShowPicker(false);
    }
  };

  const handlePickFile = async (file: ProjectFile) => {
    if (attached.find((a) => a.file.path === file.path)) {
      setShowPicker(false);
      return;
    }
    try {
      if (file.kind === "image") {
        const { dataUrl } = await imageToDataUrl(file.path);
        setAttached((prev) => [...prev, { kind: "image", file, dataUrl }]);
      } else {
        const content = await readTextFileContent(file.path);
setAttached((prev) => [...prev, { kind: "text", file, content }]);
      }
      const before = description.slice(0, atIndex);
      const after = description.slice(atIndex + 1 + atQuery.length);
      setDescription(`${before}@[${file.name}]${after}`);
    } catch { /* unreadable — skip */ }
    setShowPicker(false);
    textareaRef.current?.focus();
  };

  const removeAttached = (path: string) =>
    setAttached((prev) => prev.filter((a) => a.file.path !== path));

  // ── Tag input helpers ────────────────────────────────────────────────────
  const commitTag = () => {
    const t = tagInput.trim();
    if (t && !editTags.includes(t)) setEditTags((prev) => [...prev, t]);
    setTagInput("");
  };

  const handleTagKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commitTag(); }
    if (e.key === "Backspace" && !tagInput) setEditTags((prev) => prev.slice(0, -1));
  };

  // ── Generate ─────────────────────────────────────────────────────────────
  const handleGenerate = async () => {
    const model = models.find((m) => m.id === activeModelId);
    const provider = model ? providers.find((p) => p.id === model.providerId) : null;
    if (!model || !provider) { setError(t("ai.errors.noModel")); return; }

    const apiKey = await loadApiKey(provider.id) ?? "";
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    setGenStatus(statusMessages[0]);
    setPhase("generating");

    // Cycle status messages so UI feels alive
    let si = 0;
    const tick = setInterval(() => { si = (si + 1) % statusMessages.length; setGenStatus(statusMessages[si]); }, 1800);

    try {
      const loreScenePrompt = prompts.find((p) => p.scene === "lore");
      const result = await generateLore({
        description,
        images: attached.filter((a): a is AttachedImage => a.kind === "image").map((a) => ({ dataUrl: a.dataUrl })),
        textAttachments: attached.filter((a): a is AttachedText => a.kind === "text").map((a) => ({ name: a.file.name, content: a.content })),
        baseUrl: provider.baseUrl,
        apiKey,
        standard: provider.apiStandard,
        safetySettings: provider.safetySettings,
        modelId: model.modelId,
        onProgress: () => {}, // we show spinner, not raw text
        signal: ctrl.signal,
        systemPrompt: loreScenePrompt?.content,
      });
      setEditName(result.name);
      setEditCat(result.category);
      setEditTags(result.aliases);
      setEditSummary(result.summary);
      setEditContent(result.content);
      setPhase("result");
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError(e instanceof Error ? e.message : String(e));
      }
      setPhase("input");
    } finally {
      clearInterval(tick);
      abortRef.current = null;
    }
  };

  // ── Save ─────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!projectPath) return;
    setSaving(true);
    try {
      const id = editName.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_-]/g, "") || "entity";
      await createNewEntity(projectPath, editCat, id, editName);
      const { writeEntityFile } = await import("../../lib/lore");
      const aliasLines = editTags.map((a) => `  - "${a}"`).join("\n");
      const full = [
        "---",
        `name: ${editName}`,
        `aliases:`,
        aliasLines,
        `category: ${editCat}`,
        `summary: "${editSummary.replace(/"/g, '\\"')}"`,
        "---",
        "",
        editContent,
      ].join("\n");
      const dirPath = `${projectPath}/.ai-writer/lore/${editCat}/${id}`;
      await writeEntityFile(dirPath, "index.md", full);
      const firstImage = attached.find((a): a is AttachedImage => a.kind === "image");
      if (firstImage) {
        const { bytes, ext } = await imageToDataUrl(firstImage.file.path);
        await writeBinaryFile(`${dirPath}/avatar.${ext}`, bytes);
      }
      await scanProject(projectPath);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const filteredFiles = projectFiles.filter(
    (f) => !atQuery || f.name.toLowerCase().includes(atQuery.toLowerCase()),
  );
  const multimodalModels = models.filter((m) => m.type === "multimodal" || m.type === "text");

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
    <div className={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.panel}>

        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <div className={styles.headerIcon}><Bot size={20} strokeWidth={1.5} /></div>
            <div className={styles.headerText}>
              <div className={styles.title}>{t("lore.generator.title")}</div>
              <div className={styles.subtitle}>{t("lore.generator.subtitle")}</div>
            </div>
          </div>
          <button className={styles.closeBtn} onClick={onClose}><X size={16} /></button>
        </div>

        {/* Scrollable body */}
        <div className={styles.body}>

          {/* ── Input card ── */}
          <div className={styles.card}>
            <div className={styles.cardTitle}>
              <span>{t("lore.generator.step1")}</span>
            </div>

            {/* Category + Model */}
            <div className={styles.row}>
              <div className={styles.fieldGroup}>
                <label className={styles.label}>{t("lore.generator.categoryLabel")}</label>
                <select className={styles.select} value={category}
                  onChange={(e) => setCategory(e.target.value as CategoryId)}>
                  {LORE_CATEGORIES.map((c) => (
                    <option key={c.id} value={c.id}>{isZh ? c.labelZh : c.labelEn}</option>
                  ))}
                </select>
              </div>
              <div className={styles.fieldGroup}>
                <label className={styles.label}>{t("lore.generator.modelLabel")}</label>
                <select className={styles.select} value={activeModelId ?? ""}
                  onChange={(e) => setActiveModel(e.target.value)}>
                  <option value="">{t("lore.generator.selectModel")}</option>
                  {multimodalModels.map((m) => {
                    const pname = providers.find((p) => p.id === m.providerId)?.name ?? "";
                    return <option key={m.id} value={m.id}>{pname} / {m.name}</option>;
                  })}
                </select>
              </div>
            </div>

            {/* Description textarea */}
            <div className={styles.fieldGroup}>
              <label className={styles.label}>
                {t("lore.generator.descriptionText")} <span className={styles.hint}>· {t("lore.generator.descriptionHint")}</span>
              </label>
              <div ref={textareaWrapRef}>
                <textarea
                  ref={textareaRef}
                  className={styles.textarea}
                  rows={6}
                  placeholder={t("lore.generator.descriptionPlaceholder")}
                  value={description}
                  onChange={handleDescChange}
                  onKeyDown={(e) => { if (e.key === "Escape") setShowPicker(false); }}
                  disabled={phase === "generating"}
                />
              </div>
            </div>

            {/* Attached files */}
            {attached.length > 0 && (
              <div className={styles.attachedSection}>
                <div className={styles.attachedLabel}>{t("lore.generator.attachedFiles")} ({attached.length})</div>
                <div className={styles.attachedGrid}>
                  {attached.map((a) => (
                    <div key={a.file.path} className={styles.attachedChip}>
                      {a.kind === "image"
                        ? <img src={a.dataUrl} alt={a.file.name} className={styles.chipThumb} />
                        : <span className={styles.chipThumb} style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <FileText size={16} strokeWidth={1.5} />
                          </span>
                      }
                      <span className={styles.chipLabel}>{a.file.name}</span>
                      <button className={styles.chipRemove}
                        onClick={() => removeAttached(a.file.path)}><X size={11} /></button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Error */}
          {error && <div className={styles.error}><AlertTriangle size={13} style={{ flexShrink: 0 }} /> {error}</div>}

          {/* ── Generating state ── */}
          {phase === "generating" && (
            <div className={styles.card}>
              <div className={styles.generating}>
                <div className={styles.spinner} />
                <div className={styles.generatingText}>
                  {genStatus}<span className={styles.generatingDots} />
                </div>
              </div>
            </div>
          )}

          {/* ── Result card ── */}
          {phase === "result" && (
            <>
              <div className={styles.divider}>{t("lore.generator.completed")}</div>

              <div className={styles.card}>
                <div className={styles.resultHeader}>
                  <div className={styles.cardTitle}>
                    <span className={styles.cardTitleAccent}>{t("lore.generator.step2")}</span>
                  </div>
                  <span className={styles.resultBadge}><CheckCircle2 size={13} /> {t("lore.generator.success")}</span>
                </div>

                {/* Name + Category */}
                <div className={styles.row}>
                  <div className={styles.fieldGroup}>
                    <label className={styles.label}>{t("lore.generator.nameLabel")}</label>
                    <input className={styles.input} value={editName}
                      onChange={(e) => setEditName(e.target.value)} placeholder={t("lore.generator.namePlaceholder")} />
                  </div>
                  <div className={styles.fieldGroup}>
                    <label className={styles.label}>{t("lore.generator.categoryLabel2")}</label>
                    <select className={styles.select} value={editCat}
                      onChange={(e) => setEditCat(e.target.value as CategoryId)}>
                      {LORE_CATEGORIES.map((c) => (
                        <option key={c.id} value={c.id}>{isZh ? c.labelZh : c.labelEn}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Aliases as tags */}
                <div className={styles.fieldGroup}>
                  <label className={styles.label}>
                    {t("lore.generator.aliasLabel")} <span className={styles.hint}>· {t("lore.generator.aliasHint")}</span>
                  </label>
                  <div className={styles.tagsWrap} onClick={() => document.getElementById("tag-input")?.focus()}>
                    {editTags.map((t) => (
                      <span key={t} className={styles.tag}>
                        {t}
                        <button className={styles.tagRemove}
                          onClick={(e) => { e.stopPropagation(); setEditTags((prev) => prev.filter((x) => x !== t)); }}>
                          <X size={10} />
                        </button>
                      </span>
                    ))}
                    <input
                      id="tag-input"
                      className={styles.tagInput}
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      onKeyDown={handleTagKey}
                      onBlur={commitTag}
                      placeholder={editTags.length === 0 ? t("lore.generator.aliasPlaceholder") : ""}
                    />
                  </div>
                </div>

                {/* Summary */}
                <div className={styles.fieldGroup}>
                  <label className={styles.label}>{t("lore.generator.summaryLabel")} <span className={styles.hint}>· {t("lore.generator.summaryHint")}</span></label>
                  <input className={styles.input} value={editSummary}
                    onChange={(e) => setEditSummary(e.target.value)}
                    placeholder={t("lore.generator.summaryPlaceholder")} />
                </div>

                {/* Content */}
                <div className={styles.fieldGroup}>
                  <label className={styles.label}>{t("lore.generator.contentLabel")} <span className={styles.hint}>· {t("lore.generator.contentHint")}</span></label>
                  <textarea className={styles.textarea} rows={10} value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    style={{ resize: "vertical" }} />
                </div>
              </div>
            </>
          )}
        </div>

        {/* ── Sticky footer ── */}
        <div className={styles.footer}>
          {phase === "input" && (
            <>
              <button className={styles.btnSecondary} onClick={onClose}>{t("lore.generator.cancel")}</button>
              <button className={styles.btnPrimary} onClick={handleGenerate}
                disabled={!activeModelId || !description.trim()}
                style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Sparkles size={14} /> {t("lore.generator.submitBtn")}
              </button>
            </>
          )}
          {phase === "generating" && (
            <button className={styles.btnAbort}
              onClick={() => { abortRef.current?.abort(); setPhase("input"); }}>
              {t("lore.generator.stopBtn")}
            </button>
          )}
          {phase === "result" && (
            <>
              <button className={styles.btnSecondary} onClick={onClose}>{t("lore.generator.cancel")}</button>
              <button className={styles.btnSecondary} onClick={handleGenerate}
                disabled={!activeModelId || !description.trim()}
                style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <RotateCw size={13} /> {t("lore.generator.regenerateBtn")}
              </button>
              <button className={styles.btnPrimary} onClick={handleSave}
                disabled={!editName.trim() || saving}>
                {saving ? t("lore.generator.submitBtnSaving") : t("lore.generator.saveTolore")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>

      {/* @ picker via portal — escapes overflow context */}
      {showPicker && createPortal(
        <div ref={pickerRef} className={styles.atPicker} style={{ position: "fixed", zIndex: 500, ...pickerStyle }}>
          <div className={styles.atPickerHeader}>
            <span className={styles.atPickerLabel}>{t("lore.generator.selectReferenceImage")}</span>
            <kbd className={styles.atPickerEsc}>{t("lore.generator.closeEsc")}</kbd>
          </div>
          <div className={styles.atPickerList}>
            {filteredFiles.length === 0
              ? <div className={styles.atPickerEmpty}>{t("lore.generator.noFiles")}</div>
              : filteredFiles.slice(0, 12).map((file) => (
                <button
                  key={file.path}
                  className={styles.atPickerItem}
                  onMouseDown={(e) => { e.preventDefault(); void handlePickFile(file); }}
                >
                  <PickerThumb file={file} />
                  <div className={styles.atPickerInfo}>
                    <div className={styles.atPickerName}>{file.name}</div>
                    <div className={styles.atPickerPath}>
                      {file.path.replace(projectPath ?? "", "").slice(1)}
                    </div>
                  </div>
                </button>
              ))
            }
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
