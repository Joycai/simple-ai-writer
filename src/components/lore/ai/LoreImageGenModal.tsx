/**
 * Generate a picture for one lore entity.
 *
 * Two models, two steps, both visible to the author: a text model drafts the
 * prompt from the entity's own writing (editable before anything is spent), and
 * the image model renders it. A kept result goes into the gallery and is
 * immediately described by the vision path, because a picture that text-only
 * models cannot see is invisible to the rest of the app.
 */

import { useEffect, useMemo, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { X, Sparkles, Image as ImageIcon, Wand2, UserRound } from "lucide-react";
import { ModalShell } from "../../common/ModalShell";
import { generateImage, type GeneratedImage } from "../../../lib/ai/image";
import { imageCostFor } from "../../../lib/ai/configDb";
import { dataUrlToBytes } from "../../../lib/fs/images";
import { readFile } from "../../../lib/fs/fileio";
import { parseFrontmatter } from "../../../lib/fs/markdown";
import {
  generateImagePrompt,
  recordImageUsage,
  sizeForAspect,
  specToPrompt,
  IMAGE_ASPECTS,
  type ImageAspect,
} from "../../../lib/image";
import { addLoreImage, setEntityAvatar, updateLoreImageDesc, type LoreEntity } from "../../../lib/lore";
import { resolveModel } from "../../../lib/lore/aiTask";
import { describeLoreImage } from "../../../lib/lore/vision";
import { categoryLabel, findCategory } from "../../../lib/profile";
import { loadApiKey } from "../../../lib/keyStore";
import { useAiStore } from "../../../stores/aiStore";
import { useProjectStore } from "../../../stores/projectStore";
import i18n from "../../../i18n";
import styles from "../LoreImproveModal.module.css";
import gen from "./LoreImageGenModal.module.css";

interface Props {
  entity: LoreEntity;
  onClose: () => void;
  /** Called after an image landed on disk, so the detail view rescans. */
  onSaved: () => void;
}

/** Cap on images per run — the spend ceiling the author can't fat-finger past. */
const MAX_COUNT = 4;

export function LoreImageGenModal({ entity, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const projectPath = useProjectStore((s) => s.projectPath);
  const { models, providers, activeModelId, imageModelId, setImageModel } = useAiStore();

  const imageModels = useMemo(() => models.filter((m) => m.type === "image"), [models]);
  // Fall back to the first configured image model rather than leaving the
  // select empty: with exactly one image model — the common case — the author
  // should never have to choose it.
  const effectiveImageModelId = imageModelId ?? imageModels[0]?.id ?? "";
  const imageModel = imageModels.find((m) => m.id === effectiveImageModelId) ?? null;

  const [direction, setDirection] = useState("");
  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState("");
  const [negative, setNegative] = useState("");
  const [aspect, setAspect] = useState<ImageAspect>("3:4");
  const [count, setCount] = useState(1);

  const [material, setMaterial] = useState("");
  const [building, setBuilding] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [results, setResults] = useState<GeneratedImage[]>([]);
  const [picked, setPicked] = useState(0);
  const [revised, setRevised] = useState("");
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  // The entity's own text is what makes a drafted prompt specific rather than
  // generic; load it once when the modal opens.
  useEffect(() => {
    let cancelled = false;
    readFile(`${entity.dirPath}/index.md`)
      .then((raw) => { if (!cancelled) setMaterial(parseFrontmatter(raw).content.trim()); })
      .catch(() => { /* a body-less entity still has its summary */ });
    return () => { cancelled = true; };
  }, [entity.dirPath]);

  useEffect(() => () => abort.current?.abort(), []);

  const references = entity.images.map((img) => img.desc).filter((d) => d.trim());

  /**
   * The category's display name — 角色 / 场景 / 产品 — which is what tells the
   * prompt writer whether it is briefing a portrait or a diagram. A category id
   * that no longer exists in the profile simply contributes nothing.
   */
  const subjectKind = (): string | undefined => {
    const cat = findCategory(entity.category);
    return cat ? categoryLabel(cat, i18n.language.startsWith("zh")) : undefined;
  };

  const busy = building || generating || saving;
  const estimatedCost = imageModel ? imageCostFor(imageModel, count) : 0;

  const handleBuildPrompt = async () => {
    const resolved = resolveModel(models, providers, activeModelId);
    if (!resolved) { setError(t("ai.errors.noModel")); return; }
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBuilding(true);
    setError(null);
    try {
      const apiKey = (await loadApiKey(resolved.provider.id)) ?? "";
      const spec = await generateImagePrompt({
        subject: entity.name,
        subjectKind: subjectKind(),
        material: [entity.summary, material].filter(Boolean).join("\n\n"),
        instruction: direction,
        references,
        // Prompts go out in the UI language: every current backend handles
        // Chinese, and an author who wants to hand-tune the text should not
        // have to do it in a language they did not choose.
        promptLanguage: i18n.language.startsWith("zh") ? "zh" : "en",
        language: i18n.language,
        baseUrl: resolved.provider.baseUrl,
        apiKey,
        standard: resolved.provider.apiStandard,
        safetySettings: resolved.provider.safetySettings,
        modelId: resolved.model.modelId,
        prefix: resolved.model.prefix,
        contextSize: resolved.model.contextSize,
        signal: ctrl.signal,
      });
      setPrompt(spec.prompt);
      setStyle(spec.style);
      setNegative(spec.negative);
      setAspect(spec.aspect);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(e instanceof Error ? e.message : String(e));
    } finally {
      abort.current = null;
      setBuilding(false);
    }
  };

  const handleGenerate = async () => {
    if (!imageModel || !prompt.trim()) return;
    const provider = providers.find((p) => p.id === imageModel.providerId);
    if (!provider) { setError(t("ai.errors.noModel")); return; }
    const ctrl = new AbortController();
    abort.current = ctrl;
    setGenerating(true);
    setError(null);
    setRevised("");
    try {
      const apiKey = (await loadApiKey(provider.id)) ?? "";
      const result = await generateImage(
        {
          baseUrl: provider.baseUrl,
          apiKey,
          standard: provider.apiStandard,
          modelId: imageModel.modelId,
          safetySettings: provider.safetySettings,
        },
        {
          prompt: specToPrompt({ prompt, style, negative, aspect, note: "" }),
          n: count,
          size: sizeForAspect(aspect, imageModel.caps?.sizes),
          signal: ctrl.signal,
        },
      );
      setResults(result.images);
      setPicked(0);
      if (result.text) setRevised(result.text);
      await recordImageUsage(projectPath, imageModel, "image-gen", result.images.length, result.usage);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(e instanceof Error ? e.message : String(e));
    } finally {
      abort.current = null;
      setGenerating(false);
    }
  };

  const handleSave = async (asAvatar: boolean) => {
    const chosen = results[picked];
    if (!chosen) return;
    setSaving(true);
    setError(null);
    try {
      const { bytes, ext } = dataUrlToBytes(chosen.dataUrl);
      const stem = `ai-${Date.now()}`;
      const file = await addLoreImage(entity.dirPath, `${stem}.${ext}`, bytes, "");
      if (asAvatar) await setEntityAvatar(entity.dirPath, bytes, ext);
      onSaved();

      // Describe it now rather than leaving that to the author: until this runs
      // the picture is invisible to every text-only model in the app.
      const vision = resolveModel(models, providers, activeModelId);
      if (vision && vision.model.type === "multimodal") {
        setDescribing(true);
        try {
          const apiKey = (await loadApiKey(vision.provider.id)) ?? "";
          const desc = await describeLoreImage({
            dataUrl: chosen.dataUrl,
            entityName: entity.name,
            entitySummary: entity.summary,
            language: i18n.language,
            baseUrl: vision.provider.baseUrl,
            apiKey,
            standard: vision.provider.apiStandard,
            safetySettings: vision.provider.safetySettings,
            modelId: vision.model.modelId,
            prefix: vision.model.prefix,
            contextSize: vision.model.contextSize,
          });
          await updateLoreImageDesc(entity.dirPath, file, desc);
          onSaved();
        } catch {
          // The image is already saved — a failed description is a note, not a
          // failure of the run.
          setError(t("lore.imageGen.describeFailed"));
        } finally {
          setDescribing(false);
        }
      }
      if (!asAvatar) setResults((r) => r.filter((_, i) => i !== picked));
      else onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell overlayClassName={styles.overlay} onClose={onClose}>
      <div className={styles.panel} style={{ maxWidth: 720 }}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <div className={styles.headerAvatarPlaceholder}><ImageIcon size={16} strokeWidth={1.5} /></div>
            <div>
              <div className={styles.headerName}>{t("lore.imageGen.title")}</div>
              <div className={styles.headerSub}>{entity.name}</div>
            </div>
          </div>
          <select
            className={styles.modelSelect}
            value={effectiveImageModelId}
            onChange={(e) => setImageModel(e.target.value)}
            disabled={busy || imageModels.length === 0}
            title={t("lore.imageGen.modelLabel")}
          >
            {imageModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <button className={styles.closeBtn} onClick={onClose}><X size={16} /></button>
        </div>

        <div className={styles.body}>
          {imageModels.length === 0 ? (
            <div className={styles.error}>{t("lore.imageGen.noImageModel")}</div>
          ) : (
            <>
              <div className={styles.section}>
                <label className={styles.label}>{t("lore.imageGen.directionLabel")}</label>
                <textarea
                  className={styles.textarea}
                  rows={2}
                  placeholder={t("lore.imageGen.directionPlaceholder")}
                  value={direction}
                  onChange={(e) => setDirection(e.target.value)}
                  disabled={busy}
                />
                {references.length > 0 && (
                  <div className={gen.hint}>{t("lore.imageGen.referenceHint", { count: references.length })}</div>
                )}
              </div>

              <div className={styles.section}>
                <div className={gen.labelRow}>
                  <label className={styles.label}>{t("lore.imageGen.promptLabel")}</label>
                  <button className={gen.draftBtn} onClick={handleBuildPrompt} disabled={busy}>
                    <Wand2 size={11} strokeWidth={1.8} />
                    {building ? t("lore.imageGen.building") : t("lore.imageGen.buildPrompt")}
                  </button>
                </div>
                <textarea
                  className={styles.textarea}
                  rows={5}
                  placeholder={t("lore.imageGen.promptPlaceholder")}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  disabled={busy}
                />
              </div>

              <div className={gen.fieldRow}>
                <div className={gen.field}>
                  <label className={styles.label}>{t("lore.imageGen.styleLabel")}</label>
                  <input className={gen.input} value={style} onChange={(e) => setStyle(e.target.value)} disabled={busy} />
                </div>
                <div className={gen.field}>
                  <label className={styles.label}>{t("lore.imageGen.negativeLabel")}</label>
                  <input className={gen.input} value={negative} onChange={(e) => setNegative(e.target.value)} disabled={busy} />
                </div>
              </div>

              <div className={gen.fieldRow}>
                <div className={gen.fieldNarrow}>
                  <label className={styles.label}>{t("lore.imageGen.aspectLabel")}</label>
                  <select className={gen.input} value={aspect} disabled={busy}
                    onChange={(e) => setAspect(e.target.value as ImageAspect)}>
                    {IMAGE_ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                </div>
                <div className={gen.fieldNarrow}>
                  <label className={styles.label}>{t("lore.imageGen.countLabel")}</label>
                  <select className={gen.input} value={count} disabled={busy}
                    onChange={(e) => setCount(parseInt(e.target.value, 10))}>
                    {Array.from({ length: MAX_COUNT }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </div>
                {estimatedCost > 0 && (
                  <div className={gen.costHint}>{t("lore.imageGen.costHint", { cost: estimatedCost.toFixed(3) })}</div>
                )}
              </div>

              {error && <div className={styles.error}>{error}</div>}

              {results.length > 0 && (
                <div className={styles.section}>
                  <label className={styles.label}>{t("lore.imageGen.resultsLabel")}</label>
                  <div className={gen.grid}>
                    {results.map((img, i) => (
                      <button
                        key={i}
                        className={`${gen.thumb} ${i === picked ? gen.thumbActive : ""}`}
                        onClick={() => setPicked(i)}
                        disabled={saving}
                      >
                        <img src={img.dataUrl} alt="" />
                      </button>
                    ))}
                  </div>
                  <div className={gen.hint}>
                    {describing ? t("lore.imageGen.describing") : t("lore.imageGen.resultsHint")}
                  </div>
                  {revised && (
                    <div className={gen.revised}>
                      <span className={gen.revisedLabel}>{t("lore.imageGen.revisedNote")}</span>
                      {revised}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className={styles.footer}>
          <button className={styles.btnSecondary} onClick={onClose}>{t("lore.imageGen.close")}</button>
          <div className={styles.footerRight}>
            {results.length > 0 && (
              <>
                <button className={styles.btnSecondary} onClick={() => handleSave(true)} disabled={busy}>
                  <UserRound size={13} strokeWidth={1.8} />
                  {t("lore.imageGen.saveAsAvatar")}
                </button>
                <button className={styles.btnSecondary} onClick={() => handleSave(false)} disabled={busy}>
                  {saving ? t("lore.imageGen.saving") : t("lore.imageGen.saveToGallery")}
                </button>
              </>
            )}
            <button
              className={styles.btnPrimary}
              onClick={handleGenerate}
              disabled={busy || !imageModel || !prompt.trim()}
            >
              <Sparkles size={13} strokeWidth={1.8} />
              {generating ? t("lore.imageGen.generating") : t("lore.imageGen.generate")}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
