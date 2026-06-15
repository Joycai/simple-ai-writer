import { useState, useEffect, useRef, KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "../../stores/projectStore";
import { useAiStore } from "../../stores/aiStore";
import { useLoreStore } from "../../stores/loreStore";
import { LORE_CATEGORIES, type CategoryId } from "../../lib/lore";
import {
  scanProjectImages,
  imageToDataUrl,
  generateLore,
  type ProjectImage,
} from "../../lib/loreGenerator";
import { loadApiKey } from "../../lib/keyStore";
import styles from "./LoreGenerator.module.css";

// Tiny image thumbnail for @ picker — loads lazily to avoid blocking
function PickerThumb({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    imageToDataUrl(path).then(({ dataUrl }) => setUrl(dataUrl)).catch(() => {});
  }, [path]);
  if (!url) return <div className={styles.atPickerThumbPlaceholder}>🖼</div>;
  return <img src={url} alt="" className={styles.atPickerThumb} />;
}

interface Props {
  onClose: () => void;
}

export function LoreGenerator({ onClose }: Props) {
  const { t } = useTranslation();
  const { projectPath } = useProjectStore();
  const { models, providers, activeModelId, setActiveModel, prompts } = useAiStore();
  const { createNewEntity, scanProject } = useLoreStore();

  // ── Input state ──────────────────────────────────────────────────────────
  const [description, setDescription] = useState("");
  const [attached, setAttached] = useState<{ image: ProjectImage; dataUrl: string }[]>([]);
  const [category, setCategory] = useState<CategoryId>("characters");

  // ── @ picker state ───────────────────────────────────────────────────────
  const [projectImages, setProjectImages] = useState<ProjectImage[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [atIndex, setAtIndex] = useState(0);
  const [atQuery, setAtQuery] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
      scanProjectImages(projectPath).then(setProjectImages).catch(() => {});
    }
  }, [projectPath]);

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

  const handlePickImage = async (img: ProjectImage) => {
    if (attached.find((a) => a.image.path === img.path)) {
      setShowPicker(false);
      return;
    }
    try {
      const { dataUrl } = await imageToDataUrl(img.path);
      setAttached((prev) => [...prev, { image: img, dataUrl }]);
      const before = description.slice(0, atIndex);
      const after = description.slice(atIndex + 1 + atQuery.length);
      setDescription(`${before}@[${img.name}]${after}`);
    } catch { /* unreadable — skip */ }
    setShowPicker(false);
    textareaRef.current?.focus();
  };

  const removeAttached = (path: string) =>
    setAttached((prev) => prev.filter((a) => a.image.path !== path));

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
        images: attached.map((a) => ({ dataUrl: a.dataUrl })),
        baseUrl: provider.baseUrl,
        apiKey,
        standard: provider.apiStandard,
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
      if (attached.length > 0) {
        const { bytes, ext } = await imageToDataUrl(attached[0].image.path);
        const { writeFile } = await import("@tauri-apps/plugin-fs");
        await writeFile(`${dirPath}/avatar.${ext}`, bytes);
      }
      await scanProject(projectPath);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const filteredImages = projectImages.filter(
    (img) => !atQuery || img.name.toLowerCase().includes(atQuery.toLowerCase()),
  );
  const multimodalModels = models.filter((m) => m.type === "multimodal" || m.type === "text");

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.panel}>

        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <div className={styles.headerIcon}>🤖</div>
            <div className={styles.headerText}>
              <div className={styles.title}>{t("lore.generator.title")}</div>
              <div className={styles.subtitle}>{t("lore.generator.subtitle")}</div>
            </div>
          </div>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
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
                    <option key={c.id} value={c.id}>{c.icon} {c.labelZh}</option>
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
              <div className={styles.textareaWrap}>
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

                {/* @ picker dropdown */}
                {showPicker && (
                  <div className={styles.atPicker}>
                    <div className={styles.atPickerHeader}>
                      <span className={styles.atPickerLabel}>{t("lore.generator.selectReferenceImage")}</span>
                      <kbd className={styles.atPickerEsc}>{t("lore.generator.closeEsc")}</kbd>
                    </div>
                    <div className={styles.atPickerList}>
                      {filteredImages.length === 0
                        ? <div className={styles.atPickerEmpty}>{t("lore.generator.noImages")}</div>
                        : filteredImages.slice(0, 12).map((img) => (
                          <button key={img.path} className={styles.atPickerItem}
                            onClick={() => handlePickImage(img)}>
                            <PickerThumb path={img.path} />
                            <div className={styles.atPickerInfo}>
                              <div className={styles.atPickerName}>{img.name}</div>
                              <div className={styles.atPickerPath}>
                                {img.path.replace(projectPath ?? "", "").slice(1)}
                              </div>
                            </div>
                          </button>
                        ))
                      }
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Attached images */}
            {attached.length > 0 && (
              <div className={styles.attachedSection}>
                <div className={styles.attachedLabel}>{t("lore.generator.referenceImages")} ({attached.length})</div>
                <div className={styles.attachedGrid}>
                  {attached.map((a) => (
                    <div key={a.image.path} className={styles.attachedChip}>
                      <img src={a.dataUrl} alt={a.image.name} className={styles.chipThumb} />
                      <span className={styles.chipLabel}>{a.image.name}</span>
                      <button className={styles.chipRemove}
                        onClick={() => removeAttached(a.image.path)}>✕</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Error */}
          {error && <div className={styles.error}>⚠ {error}</div>}

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
                  <span className={styles.resultBadge}>{t("lore.generator.success")}</span>
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
                        <option key={c.id} value={c.id}>{c.icon} {c.labelZh}</option>
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
                          ✕
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
                disabled={!activeModelId || !description.trim()}>
                ✨ {t("lore.generator.submitBtn")}
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
                disabled={!activeModelId || !description.trim()}>
                {t("lore.generator.regenerateBtn")}
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
  );
}
