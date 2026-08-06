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
import { imageCostFor } from "../../../lib/ai/configDb";
import { imageToDataUrl } from "../../../lib/fs/images";
import { readFile } from "../../../lib/fs/fileio";
import { parseFrontmatter } from "../../../lib/fs/markdown";
import {
  generateImagePrompt,
  sizeForAspect,
  specToPrompt,
  IMAGE_ASPECTS,
  type ImageAspect,
} from "../../../lib/image";
import { addLoreImage, readEntityFile, setEntityAvatar, updateLoreImageDesc, type LoreEntity } from "../../../lib/lore";
import { resolveModel } from "../../../lib/lore/aiTask";
import { describeLoreImage } from "../../../lib/lore/vision";
import { categoryLabel, findCategory } from "../../../lib/profile";
import { loadApiKey } from "../../../lib/keyStore";
import { recordGeneration } from "../../../lib/image/session";
import { useAiStore } from "../../../stores/aiStore";
import { useImageStore, type RunContext } from "../../../stores/imageStore";
import { useProjectStore } from "../../../stores/projectStore";
import { useImageDataUrls } from "../useImageDataUrl";
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

/** Suggestions for the size box when the model declares no sizes of its own. */
const COMMON_SIZES = ["1024x1024", "1024x1536", "1536x1024", "2048x2048"];

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

  // Which model drafts the prompt. Separate from the image model and from the
  // app-wide active model: the author may want a strong writer here without
  // changing what the rest of the app uses, so this stays local to the run.
  const textModels = useMemo(
    () => models.filter((m) => m.type === "text" || m.type === "multimodal"),
    [models],
  );
  const [promptModelId, setPromptModelId] = useState(
    () => activeModelId ?? textModels[0]?.id ?? "",
  );

  const [direction, setDirection] = useState("");
  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState("");
  const [negative, setNegative] = useState("");
  const [aspect, setAspect] = useState<ImageAspect>("3:4");
  const [count, setCount] = useState(1);
  /**
   * Explicit pixel size. Empty means "let the model's declared sizes decide",
   * which is also the only correct request for endpoints that reject the
   * parameter (xAI) or take a ratio instead (Gemini).
   */
  const [size, setSize] = useState("");
  /** Facet files to feed the prompt writer, keyed by filename. */
  const [pickedFacets, setPickedFacets] = useState<Set<string>>(new Set());

  const [material, setMaterial] = useState("");
  const [building, setBuilding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  // The edit chain lives in its own store: it outlives individual renders,
  // survives branching back to an earlier round, and is what PR4's agent tools
  // will drive instead of this component.
  const {
    turns, running, begin, generate, edit, end, goTo, choose,
    currentTurn: getCurrentTurn, currentImagePath, instructionChain,
  } = useImageStore();
  const storeError = useImageStore((s) => s.error);
  const currentTurn = getCurrentTurn();
  const generating = running;
  /** The pending edit instruction — the conversational half of the modal. */
  const [editDraft, setEditDraft] = useState("");
  const candidateUrls = useImageDataUrls(currentTurn?.candidates ?? []);

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

  // One session per open modal. Starting it here also sweeps scratch files a
  // previous run left behind, so a crash mid-session cleans itself up on the
  // next open rather than accumulating.
  useEffect(() => {
    void begin(projectPath ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Close, dropping the session's scratch files. */
  const handleClose = () => {
    abort.current?.abort();
    void end(projectPath ?? "");
    onClose();
  };

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

  /**
   * The chosen facets' bodies, appended to the entity's own text. Facets are
   * where the visual detail actually lives — an outfit, a form, a scar — so a
   * prompt drafted from index.md alone describes a generic version of the
   * subject. Read at build time rather than up front: the author picks a
   * couple out of what can be dozens.
   */
  const collectFacetText = async (): Promise<string> => {
    const chosen = entity.facets.filter((f) => pickedFacets.has(f.file));
    const parts = await Promise.all(
      chosen.map(async (f) => {
        try {
          const raw = await readEntityFile(entity.dirPath, f.file);
          return `## ${f.title}\n${parseFrontmatter(raw).content.trim()}`;
        } catch {
          return "";
        }
      }),
    );
    return parts.filter(Boolean).join("\n\n");
  };

  const handleBuildPrompt = async () => {
    const resolved = resolveModel(models, providers, promptModelId);
    if (!resolved) { setError(t("ai.errors.noModel")); return; }
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBuilding(true);
    setError(null);
    try {
      const apiKey = (await loadApiKey(resolved.provider.id)) ?? "";
      const facetText = await collectFacetText();
      const spec = await generateImagePrompt({
        subject: entity.name,
        subjectKind: subjectKind(),
        material: [entity.summary, material, facetText].filter(Boolean).join("\n\n"),
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

  /** Everything a store run needs from the current form + model selection. */
  const runContext = async (ctrl: AbortController): Promise<RunContext | null> => {
    if (!imageModel) return null;
    const provider = providers.find((p) => p.id === imageModel.providerId);
    if (!provider) return null;
    return {
      projectPath: projectPath ?? "",
      model: imageModel,
      provider,
      apiKey: (await loadApiKey(provider.id)) ?? "",
      n: count,
      // A size typed here wins; otherwise fall back to whatever the model
      // declared as supported, and to nothing at all if it declared none.
      size: size.trim() || sizeForAspect(aspect, imageModel.caps?.sizes),
      aspect,
      signal: ctrl.signal,
    };
  };

  const handleGenerate = async () => {
    if (!imageModel || !prompt.trim()) return;
    const ctrl = new AbortController();
    abort.current = ctrl;
    setError(null);
    try {
      const ctx = await runContext(ctrl);
      if (!ctx) { setError(t("ai.errors.noModel")); return; }
      await generate(ctx, specToPrompt({ prompt, style, negative, aspect, note: "" }));
    } finally {
      abort.current = null;
    }
  };

  /** Send one edit instruction against the candidate currently on screen. */
  const handleEdit = async () => {
    if (!imageModel || !editDraft.trim() || !currentTurn) return;
    const ctrl = new AbortController();
    abort.current = ctrl;
    const instruction = editDraft.trim();
    setError(null);
    try {
      const ctx = await runContext(ctrl);
      if (!ctx) { setError(t("ai.errors.noModel")); return; }
      setEditDraft("");
      await edit(ctx, instruction);
    } finally {
      abort.current = null;
    }
  };

  const handleSave = async (asAvatar: boolean) => {
    const sourcePath = currentImagePath();
    if (!sourcePath || !currentTurn) return;
    setSaving(true);
    setError(null);
    try {
      // Read back from scratch rather than holding the bytes in state — see
      // lib/image/session.ts for why candidates live on disk.
      const { dataUrl, bytes, ext } = await imageToDataUrl(sourcePath);
      const stem = `ai-${Date.now()}`;
      const file = await addLoreImage(entity.dirPath, `${stem}.${ext}`, bytes, "");
      if (asAvatar) await setEntityAvatar(entity.dirPath, bytes, ext);
      onSaved();

      // Log how this picture came about, so the chain survives the session.
      const chain = instructionChain(currentTurn.id);
      void recordGeneration(projectPath ?? "", {
        path: `${entity.dirPath}/${file}`,
        prompt: chain.prompt,
        edits: chain.edits,
        model: imageModel?.modelId ?? "",
        size: size.trim() || undefined,
        aspect,
        ...(currentTurn.degraded ? { degraded: true } : {}),
        createdAt: Date.now(),
        costUsd: imageModel ? imageCostFor(imageModel, 1) : 0,
      });

      // Describe it now rather than leaving that to the author: until this runs
      // the picture is invisible to every text-only model in the app.
      const vision = resolveModel(models, providers, promptModelId);
      if (vision && vision.model.type === "multimodal") {
        setDescribing(true);
        try {
          const apiKey = (await loadApiKey(vision.provider.id)) ?? "";
          const desc = await describeLoreImage({
            dataUrl,
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
      // Saving does not end the session: the usual next move is to keep
      // editing from the same picture, and dropping the chain here would throw
      // away every earlier round the author might branch back to.
      if (asAvatar) handleClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell overlayClassName={styles.overlay} onClose={handleClose}>
      <div className={styles.panel} style={{ maxWidth: 720 }}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <div className={styles.headerAvatarPlaceholder}><ImageIcon size={16} strokeWidth={1.5} /></div>
            <div>
              <div className={styles.headerName}>{t("lore.imageGen.title")}</div>
              <div className={styles.headerSub}>{entity.name}</div>
            </div>
          </div>
          {/* Both models this run uses, each labelled: which one drafts the
              prompt is not guessable from a bare dropdown, and it was
              previously invisible — silently the app-wide active model. */}
          <div className={gen.modelPickers}>
            <label className={gen.modelPicker}>
              <span className={gen.modelPickerLabel}>{t("lore.imageGen.promptModelLabel")}</span>
              <select
                className={styles.modelSelect}
                value={promptModelId}
                onChange={(e) => setPromptModelId(e.target.value)}
                disabled={busy || textModels.length === 0}
              >
                {textModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </label>
            <label className={gen.modelPicker}>
              <span className={gen.modelPickerLabel}>{t("lore.imageGen.modelLabel")}</span>
              <select
                className={styles.modelSelect}
                value={effectiveImageModelId}
                onChange={(e) => setImageModel(e.target.value)}
                disabled={busy || imageModels.length === 0}
              >
                {imageModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </label>
          </div>
          <button className={styles.closeBtn} onClick={handleClose}><X size={16} /></button>
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

              {/* Facets carry the visual specifics — an outfit, a form, a
                  transformation — that index.md deliberately leaves out. */}
              {entity.facets.length > 0 && (
                <div className={styles.section}>
                  <label className={styles.label}>{t("lore.imageGen.facetsLabel")}</label>
                  <div className={gen.facets}>
                    {entity.facets.map((f) => {
                      const on = pickedFacets.has(f.file);
                      return (
                        <button
                          key={f.file}
                          className={`${gen.facetChip} ${on ? gen.facetChipOn : ""}`}
                          onClick={() => setPickedFacets((prev) => {
                            const next = new Set(prev);
                            if (on) next.delete(f.file); else next.add(f.file);
                            return next;
                          })}
                          disabled={busy}
                          title={f.group ? `${f.title} · ${f.group}` : f.title}
                        >
                          {f.title}
                        </button>
                      );
                    })}
                  </div>
                  <div className={gen.hint}>{t("lore.imageGen.facetsHint")}</div>
                </div>
              )}

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
                <div className={gen.field}>
                  <label className={styles.label}>{t("lore.imageGen.sizeLabel")}</label>
                  <input
                    className={gen.input}
                    list="image-size-options"
                    placeholder={t("lore.imageGen.sizePlaceholder")}
                    value={size}
                    onChange={(e) => setSize(e.target.value)}
                    disabled={busy}
                  />
                  {/* A datalist, not a select: the accepted sizes differ per
                      model and per relay, so the common ones are suggestions
                      rather than the only options. */}
                  <datalist id="image-size-options">
                    {(imageModel?.caps?.sizes ?? COMMON_SIZES).map((s) => <option key={s} value={s} />)}
                  </datalist>
                </div>
                {estimatedCost > 0 && (
                  <div className={gen.costHint}>{t("lore.imageGen.costHint", { cost: estimatedCost.toFixed(3) })}</div>
                )}
              </div>

              {(error || storeError) && <div className={styles.error}>{error ?? storeError}</div>}

              {currentTurn && (
                <div className={styles.section}>
                  <label className={styles.label}>{t("lore.imageGen.resultsLabel")}</label>
                  <div className={gen.grid}>
                    {currentTurn.candidates.map((path, i) => (
                      <button
                        key={path}
                        className={`${gen.thumb} ${i === currentTurn.chosen ? gen.thumbActive : ""}`}
                        onClick={() => choose(currentTurn.id, i)}
                        disabled={saving || generating}
                      >
                        {candidateUrls[path] && <img src={candidateUrls[path]} alt="" />}
                      </button>
                    ))}
                  </div>

                  {/* A regeneration standing in for an edit does not resemble
                      its parent — say so, or it reads as the model ignoring
                      the instruction. */}
                  {currentTurn.degraded && (
                    <div className={gen.degraded}>{t("lore.imageGen.degradedNote")}</div>
                  )}

                  <div className={gen.hint}>
                    {describing ? t("lore.imageGen.describing") : t("lore.imageGen.resultsHint")}
                  </div>

                  {currentTurn.text && (
                    <div className={gen.revised}>
                      <span className={gen.revisedLabel}>{t("lore.imageGen.revisedNote")}</span>
                      {currentTurn.text}
                    </div>
                  )}

                  {/* The conversational half: keep talking to the picture. */}
                  <div className={gen.editRow}>
                    <input
                      className={gen.input}
                      placeholder={t("lore.imageGen.editPlaceholder")}
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void handleEdit(); }}
                      disabled={busy}
                    />
                    <button
                      className={styles.btnSecondary}
                      onClick={handleEdit}
                      disabled={busy || !editDraft.trim()}
                    >
                      <Wand2 size={13} strokeWidth={1.8} />
                      {generating ? t("lore.imageGen.editing") : t("lore.imageGen.editBtn")}
                    </button>
                  </div>
                  {imageModel?.caps?.edit === false && (
                    <div className={gen.hint}>{t("lore.imageGen.noEditSupport")}</div>
                  )}

                  {/* Round history. Clicking an earlier round is how an author
                      abandons a branch and tries a different direction from a
                      picture they preferred. */}
                  {turns.length > 1 && (
                    <div className={gen.turns}>
                      {turns.map((turn, i) => (
                        <button
                          key={turn.id}
                          className={`${gen.turnChip} ${turn.id === currentTurn.id ? gen.turnChipOn : ""}`}
                          onClick={() => goTo(turn.id)}
                          disabled={generating}
                          title={turn.instruction}
                        >
                          {i === 0
                            ? t("lore.imageGen.turnRoot")
                            : `${i}. ${turn.instruction.slice(0, 14)}${turn.instruction.length > 14 ? "…" : ""}`}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className={styles.footer}>
          <button className={styles.btnSecondary} onClick={handleClose}>{t("lore.imageGen.close")}</button>
          <div className={styles.footerRight}>
            {currentTurn && (
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
              {generating
                ? t("lore.imageGen.generating")
                : currentTurn ? t("lore.imageGen.regenerate") : t("lore.imageGen.generate")}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
