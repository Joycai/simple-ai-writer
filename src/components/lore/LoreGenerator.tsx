import { useState, useRef, KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { X, Sparkles, RotateCw, AlertTriangle } from "lucide-react";
import { useProjectFiles, useProjectStore, useTerms } from "../../stores/projectStore";
import { useAiStore } from "../../stores/aiStore";
import { useLoreStore } from "../../stores/loreStore";
import { connOptions } from "../../lib/ai/conn";
import { slugifyEntityId, uniqueEntityId, readEntityFile, type CategoryId } from "../../lib/lore";
import { categoryLabel, defaultCategoryId, loreCategories } from "../../lib/profile";
import { readImageBytes } from "../../lib/fs/images";
import { generateLore } from "../../lib/lore/generator";
import { type AttachedImage, type AttachedText, type AttachedLore, type AttachedItem } from "../../lib/lore/aiTask";
import { MarkdownTextarea } from "../common/MarkdownTextarea";
import { ModalShell } from "../common/ModalShell";
import { AttachmentTextarea } from "./ai/AttachmentTextarea";
import {
  LoreRunSteps, RunStatusLine, ThinkingPanel, useRunClock, useRunTelemetry,
  type RunStep,
} from "./ai/LoreRunProgress";
import { ModelPicker } from "./ai/ModelPicker";
import { NewEntryTabs, type NewEntryMode } from "./ai/NewEntryTabs";
import { writeBinaryFile } from "../../lib/fs/fileio";
import { loadApiKey } from "../../lib/keyStore";
import { useImeGuard } from "../../lib/ime";
import { Select } from "../common/Select";
import styles from "./LoreGenerator.module.css";

interface Props {
  onClose: () => void;
  /** When set, a mode toggle is shown so the user can switch to manual create. */
  onModeChange?: (mode: NewEntryMode) => void;
  /**
   * Description to open with — the manuscript passage behind 提取为设定.
   * A starting point, not a commitment: it lands in the ordinary input the
   * author was going to type into, and they can trim or annotate it first.
   */
  initialDescription?: string;
}

export function LoreGenerator({ onClose, onModeChange, initialDescription }: Props) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const { projectPath } = useProjectStore();
  const terms = useTerms();
  const { models, providers, activeModelId, prompts } = useAiStore();
  // 本次任务使用的模型 — 默认跟随全局设置，改动不写回全局 (设计稿 v4)。
  const [modelId, setModelId] = useState(activeModelId ?? "");
  const { createNewEntity, scanProject } = useLoreStore();
  const loreIndex = useLoreStore((s) => s.index);

  // ── Input state ──────────────────────────────────────────────────────────
  const [description, setDescription] = useState(initialDescription ?? "");
  const [attached, setAttached] = useState<AttachedItem[]>([]);
  // 分类范围 (设计稿 08): which categories the extraction may file into.
  // All enabled by default; at least one must stay on.
  const [selCats, setSelCats] = useState<CategoryId[]>(() => loreCategories().map((c) => c.id));
  const projectFiles = useProjectFiles();

  // ── Generation state ─────────────────────────────────────────────────────
  const [phase, setPhase] = useState<"input" | "generating" | "result">("input");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const elapsedSec = useRunClock(phase === "generating");
  const { reasoning, usageTokens, onEvent: onRunEvent, reset: resetTelemetry } = useRunTelemetry();

  // ── Editable result fields ───────────────────────────────────────────────
  const [editName, setEditName] = useState("");
  const [editCat, setEditCat] = useState<CategoryId>(defaultCategoryId);
  const [editTags, setEditTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [editSummary, setEditSummary] = useState("");
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);

  // Candidates for @-mention: every existing entity (this is a brand-new one).
  const allEntities = Object.values(loreIndex).flat();

  const toggleCat = (id: CategoryId) => {
    setSelCats((prev) => prev.includes(id)
      ? (prev.length > 1 ? prev.filter((c) => c !== id) : prev) // keep at least one
      : [...prev, id]);
  };

  // 语义步骤 (设计稿 17): 读取 → 提取 → 交给作者确认。
  const refCount = attached.length;
  const genSteps: RunStep[] = [
    {
      label: t("lore.generator.stepRead", { defaultValue: "读取描述与引用资料" }),
      status: "done",
      meta: `${description.trim().length}${isZh ? " 字" : " ch"}${refCount > 0 ? ` · ${refCount}${isZh ? " 引用" : " refs"}` : ""}`,
    },
    { label: t("lore.generator.stepExtract", { defaultValue: "提取条目 · 生成主词条与概要" }), status: "active" },
    { label: t("lore.generator.stepConfirm", { defaultValue: "交给你确认后入库" }), status: "pending" },
  ];

  // ── Tag input helpers ────────────────────────────────────────────────────
  const commitTag = () => {
    const t = tagInput.trim();
    if (t && !editTags.includes(t)) setEditTags((prev) => [...prev, t]);
    setTagInput("");
  };

  const tagIme = useImeGuard();
  const handleTagKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // Mid-composition the IME owns both keys: Enter commits the pinyin and ，is
    // just a character being typed.
    if (tagIme.isComposing(e)) return;
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commitTag(); }
    if (e.key === "Backspace" && !tagInput) setEditTags((prev) => prev.slice(0, -1));
  };

  // ── Generate ─────────────────────────────────────────────────────────────
  const handleGenerate = async () => {
    const model = models.find((m) => m.id === modelId);
    const provider = model ? providers.find((p) => p.id === model.providerId) : null;
    if (!model || !provider) { setError(t("ai.errors.noModel")); return; }

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    resetTelemetry();
    setPhase("generating");

    try {
      const apiKey = await loadApiKey(provider.id) ?? "";
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
        ...connOptions({ provider, model, apiKey }),
        onProgress: () => {}, // raw JSON stays hidden — the progress card speaks instead
        onEvent: onRunEvent,  // reasoning stream + token totals (设计稿 17)
        signal: ctrl.signal,
        systemPrompt: loreScenePrompt?.content,
        allowedCategories: selCats,
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
        // The bytes go straight to disk as the entity's avatar, so this is
        // the plain reader — not `imageForModel`, which may re-encode.
        const { bytes, ext } = await readImageBytes(firstImage.file.path);
        await writeBinaryFile(`${dirPath}/avatar.${ext}`, bytes);
      }
      await scanProject(projectPath);
      requestClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const multimodalModels = models.filter((m) => m.type === "multimodal" || m.type === "text");

  // Unsaved once the user has typed a description, attached refs, or generated.
  const dirty = phase !== "input" || description.trim().length > 0 || attached.length > 0;

  const shellCloseRef = useRef<(() => void) | null>(null);
  const requestClose = () => (shellCloseRef.current ?? onClose)();

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <ModalShell overlayClassName={styles.overlay} onClose={onClose} isDirty={dirty} closeOnBackdrop={false} closeRef={shellCloseRef}>
      <div className={styles.panel}>

        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerRow}>
            <Sparkles size={17} strokeWidth={1.6} color="var(--color-sienna)" />
            <span className={styles.headerEyebrow}>
              {isZh ? "extract · 提取" : "extract"}
            </span>
            <span className={styles.spacer} />
            <button className={styles.closeBtn} onClick={requestClose}><X size={14} /></button>
          </div>
          <h2 className={styles.title}>{t("lore.generator.title", { entry: terms.entry })}</h2>
          <p className={styles.subtitle}>{t("lore.generator.subtitle")}</p>
        </div>

        {/* Two-column body */}
        <div className={styles.cols}>

          {/* Left: options */}
          <div className={styles.side}>
            <div>
              <div className={styles.sectionLabel}>{isZh ? "scope · 分类范围" : "scope"}</div>
              <div className={styles.catChips}>
                {loreCategories().map((c) => (
                  <button
                    key={c.id}
                    className={`${styles.catChip} ${selCats.includes(c.id) ? styles.catChipOn : ""}`}
                    disabled={phase === "generating"}
                    onClick={() => toggleCat(c.id)}
                  >
                    {categoryLabel(c, isZh)}
                  </button>
                ))}
              </div>
            </div>
            <span className={styles.spacer} />
            <div className={styles.hintCard}>
              <div className={styles.hintHead}>hint</div>
              {t("lore.generator.hintReview", {
                defaultValue: "已有 {{n}} 条，生成结果先经你审核，入库前可修改。",
                n: allEntities.length,
              })}
            </div>
          </div>

          {/* Right: description + result */}
          <div className={styles.main}>
            {onModeChange && (
              <NewEntryTabs value="ai" onChange={onModeChange} />
            )}

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

          {/* Error */}
          {error && <div className={styles.error}><AlertTriangle size={13} style={{ flexShrink: 0 }} /> {error}</div>}

          {/* ── Generating: 步骤列 + 思维链 (设计稿 17) ── */}
          {phase === "generating" && (
            <>
              <div className={styles.statusRow}>
                <span className={styles.statusLabel}>
                  {t("lore.generator.resultHead", { defaultValue: "提取结果" })}
                </span>
                <RunStatusLine state="running" elapsedSec={elapsedSec}
                  model={models.find((m) => m.id === modelId)?.name} />
              </div>
              <LoreRunSteps steps={genSteps} />
              <ThinkingPanel text={reasoning} running />
            </>
          )}

          {/* ── Result card (候选卡「新条目」态) ── */}
          {phase === "result" && (
            <>
              <div className={styles.statusRow}>
                <span className={styles.statusLabel}>
                  {t("lore.generator.resultHead", { defaultValue: "提取结果" })}
                </span>
                <RunStatusLine state="done" elapsedSec={elapsedSec} tokens={usageTokens} />
              </div>
              <ThinkingPanel text={reasoning} running={false} />

              <div className={styles.resultCard}>
                <div className={styles.resultHeader}>
                  <span className={styles.resultNew}>{isZh ? "新" : "new"}</span>
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
                    <Select className={styles.select} value={editCat}
                      onChange={(v) => setEditCat(v as CategoryId)}
                      options={loreCategories().map((c) => ({ value: c.id, label: categoryLabel(c, isZh) }))} />
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
                      {...tagIme.imeProps}
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
        </div>

        {/* ── Footer strip ── */}
        <div className={styles.footer}>
          <ModelPicker
            models={multimodalModels}
            providers={providers}
            value={modelId}
            onChange={setModelId}
            disabled={phase === "generating"}
          />
          <span className={styles.footerNote}>
            {t("lore.generator.footerNote", { defaultValue: "生成结果先经你审核，入库前可修改" })}
          </span>
          <span className={styles.spacer} />
          {phase === "input" && (
            <>
              <button className={styles.btnGhost} onClick={requestClose}>{t("lore.generator.cancel")}</button>
              <button className={styles.btnPrimary} onClick={handleGenerate}
                disabled={!modelId || !description.trim()}>
                <Sparkles size={13} /> {t("lore.generator.submitBtn", { entry: terms.entry })}
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
              <button className={styles.btnGhost} onClick={requestClose}>{t("lore.generator.cancel")}</button>
              <button className={styles.btnSecondary} onClick={handleGenerate}
                disabled={!modelId || !description.trim()}>
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
