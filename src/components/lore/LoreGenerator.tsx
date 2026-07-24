import { useState, useEffect, useRef, KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { X, Bot, Sparkles, RotateCw, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useProjectStore } from "../../stores/projectStore";
import { useAiStore } from "../../stores/aiStore";
import { useLoreStore } from "../../stores/loreStore";
import { LORE_CATEGORIES, slugifyEntityId, uniqueEntityId, readEntityFile, type CategoryId } from "../../lib/lore";
import { scanProjectFiles, imageToDataUrl, type ProjectFile } from "../../lib/fs/images";
import { generateLore } from "../../lib/lore/generator";
import { type AttachedImage, type AttachedText, type AttachedLore, type AttachedItem } from "../../lib/lore/aiTask";
import { MarkdownTextarea } from "../common/MarkdownTextarea";
import { ModalShell } from "../common/ModalShell";
import { AttachmentTextarea } from "./ai/AttachmentTextarea";
import { NewEntryTabs, type NewEntryMode } from "./ai/NewEntryTabs";
import { writeBinaryFile } from "../../lib/fs/fileio";
import { loadApiKey } from "../../lib/keyStore";
import styles from "./LoreGenerator.module.css";

interface Props {
  onClose: () => void;
  /** When set, a mode toggle is shown so the user can switch to manual create. */
  onModeChange?: (mode: NewEntryMode) => void;
}

export function LoreGenerator({ onClose, onModeChange }: Props) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const { projectPath } = useProjectStore();
  const { models, providers, activeModelId, setActiveModel, prompts } = useAiStore();
  const { createNewEntity, scanProject } = useLoreStore();
  const loreIndex = useLoreStore((s) => s.index);

  // ── Input state ──────────────────────────────────────────────────────────
  const [description, setDescription] = useState("");
  const [attached, setAttached] = useState<AttachedItem[]>([]);
  const [category, setCategory] = useState<CategoryId>("characters");
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);

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

  // Candidates for @-mention: every existing entity (this is a brand-new one).
  const allEntities = Object.values(loreIndex).flat();

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
      // Only multimodal models can consume images; sending them to a text model
      // either errors or is silently dropped, so omit them here.
      const supportsImages = model.type === "multimodal";

      // Referenced lore entities + text files both become reference material.
      const loreRefs = await Promise.all(
        attached
          .filter((a): a is AttachedLore => a.kind === "lore")
          .map(async (a) => ({
            name: a.entity.name,
            content: await readEntityFile(a.entity.dirPath, "index.md").catch(() => "(unavailable)"),
          })),
      );
      const fileRefs = attached
        .filter((a): a is AttachedText => a.kind === "text")
        .map((a) => ({ name: a.file.name, content: a.content }));

      const result = await generateLore({
        description,
        images: supportsImages
          ? attached.filter((a): a is AttachedImage => a.kind === "image").map((a) => ({ dataUrl: a.dataUrl }))
          : [],
        textAttachments: [...loreRefs, ...fileRefs],
        baseUrl: provider.baseUrl,
        apiKey,
        standard: provider.apiStandard,
        safetySettings: provider.safetySettings,
        modelId: model.modelId,
        prefix: model.prefix,
        contextSize: model.contextSize,
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
      const baseId = slugifyEntityId(editName);
      const id = await uniqueEntityId(projectPath, editCat, baseId);
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

  const multimodalModels = models.filter((m) => m.type === "multimodal" || m.type === "text");

  // Unsaved once the user has typed a description, attached refs, or generated.
  const dirty = phase !== "input" || description.trim().length > 0 || attached.length > 0;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <ModalShell overlayClassName={styles.overlay} onClose={onClose} isDirty={dirty} closeOnBackdrop={false}>
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

          {onModeChange && (
            <div style={{ marginBottom: "var(--space-3)" }}>
              <NewEntryTabs value="ai" onChange={onModeChange} />
            </div>
          )}

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

            {/* Description + @-mention composer (entities / files / images) */}
            <div className={styles.fieldGroup}>
              <label className={styles.label}>
                {t("lore.generator.descriptionText")} <span className={styles.hint}>· {t("lore.generator.descriptionHint")}</span>
              </label>
              <AttachmentTextarea
                instruction={description}
                onInstructionChange={setDescription}
                attached={attached}
                onAttachedChange={setAttached}
                entities={allEntities}
                projectFiles={projectFiles}
                disabled={phase === "generating"}
                rows={6}
                placeholder={t("lore.generator.descriptionPlaceholder")}
                textareaClassName={styles.textarea}
              />
            </div>
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
                  <MarkdownTextarea className={styles.textarea} rows={10} value={editContent}
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
    </ModalShell>
  );
}
