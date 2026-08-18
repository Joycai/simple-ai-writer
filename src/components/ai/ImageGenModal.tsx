/**
 * Generate a picture, for whatever is being illustrated.
 *
 * Two models, two steps, both visible to the author: a text model drafts the
 * prompt from the subject's own writing (editable before anything is spent),
 * and the image model renders it. Results can then be talked to — each edit is
 * another round in the session store's chain.
 *
 * Everything specific to *what* is being illustrated lives in the
 * `ImageGenTarget` this is handed: where the source material comes from, what
 * existing pictures to stay consistent with, and where a kept image is filed.
 * See lib/image/target.ts.
 */

import { useEffect, useMemo, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { X, Sparkles, Image as ImageIcon, Wand2, UserRound } from "lucide-react";
import { ModalShell } from "../common/ModalShell";
import { imageCostFor } from "../../lib/ai/configDb";
import { resolveImageRoute } from "../../lib/ai/image";
import { imageToDataUrl } from "../../lib/fs/images";
import {
  generateImagePrompt,
  sizeForAspect,
  specToPrompt,
  IMAGE_ASPECTS,
  type ImageAspect,
} from "../../lib/image";
import { resolveConn } from "../../lib/ai/conn";
import { loadApiKey } from "../../lib/keyStore";
import { recordGeneration } from "../../lib/image/session";
import type { ImageGenTarget } from "../../lib/image/target";
import { useAiStore } from "../../stores/aiStore";
import { useImageStore, type RunContext } from "../../stores/imageStore";
import { useProjectStore } from "../../stores/projectStore";
import { useImageThumbnails } from "../lore/useImageDataUrl";
import { useImeGuard } from "../../lib/ime";
import i18n from "../../i18n";
/* Shell + fields both live in this component's own module now — the lore
   modals keep LoreImproveModal.module.css to themselves. The two import names
   survive so the many existing className references stay untouched. */
import { RunStatusLine, useRunClock } from "../lore/ai/LoreRunProgress";
import { ModelPicker } from "../lore/ai/ModelPicker";
import { Select } from "../common/Select";
import styles from "./ImageGenModal.module.css";
import gen from "./ImageGenModal.module.css";

interface Props {
  target: ImageGenTarget;
  onClose: () => void;
}

/** Cap on images per run — the spend ceiling the author can't fat-finger past. */
const MAX_COUNT = 4;

/** Suggestions for the size box when the model declares no sizes of its own. */
const COMMON_SIZES = ["1024x1024", "1024x1536", "1536x1024", "2048x2048"];

export function ImageGenModal({ target, onClose }: Props) {
  const { t } = useTranslation();
  const projectPath = useProjectStore((s) => s.projectPath);
  const { models, providers, activeModelId, imageModelId, setImageModel } = useAiStore();

  const imageModels = useMemo(() => models.filter((m) => m.type === "image"), [models]);
  // Fall back to the first configured image model rather than leaving the
  // select empty: with exactly one image model — the common case — the author
  // should never have to choose it.
  const effectiveImageModelId = imageModelId ?? imageModels[0]?.id ?? "";
  const imageModel = imageModels.find((m) => m.id === effectiveImageModelId) ?? null;
  const imageProvider = imageModel ? providers.find((p) => p.id === imageModel.providerId) ?? null : null;
  /**
   * The chat-completions route carries no n/size/aspect fields (see
   * lib/ai/image.ts). Saying so beats offering controls that quietly do
   * nothing — the count select in particular, where picking 4 used to bill
   * for one picture and explain nothing.
   */
  const chatRoute = !!imageModel && !!imageProvider
    && resolveImageRoute(imageProvider.apiStandard, imageModel.caps?.route) === "chat";

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
  /** One line saying what the picture shows — alt text, and the gallery
   *  description where the target keeps one. */
  const [note, setNote] = useState("");

  const [building, setBuilding] = useState(false);
  const [saving, setSaving] = useState(false);
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
  // 出图计时 (设计稿 18: 生成中 · 9s) — 独立于提示词起草。
  const genElapsed = useRunClock(generating);
  /** The pending edit instruction — the conversational half of the modal. */
  const [editDraft, setEditDraft] = useState("");
  // Thumbnails for the picker grid, not full resolution — see
  // useImageThumbnails. Choosing a candidate saves from its file path, never
  // from this downscaled preview.
  const candidateUrls = useImageThumbnails(currentTurn?.candidates ?? []);

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

  const busy = building || generating || saving;
  /** What this run will actually ask for — the chat route only ever returns one. */
  const effectiveCount = chatRoute ? 1 : count;
  const estimatedCost = imageModel ? imageCostFor(imageModel, effectiveCount) : 0;

  const handleBuildPrompt = async () => {
    const resolved = resolveConn(models, providers, promptModelId);
    if (!resolved.ok) { setError(resolved.error); return; }
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBuilding(true);
    setError(null);
    try {
      const apiKey = (await loadApiKey(resolved.provider.id)) ?? "";
      const spec = await generateImagePrompt({
        subject: target.subject,
        subjectKind: target.subjectKind,
        material: await target.material(),
        instruction: direction,
        references: target.references,
        // Prompts go out in the UI language: every current backend handles
        // Chinese, and an author who wants to hand-tune the text should not
        // have to do it in a language they did not choose.
        promptLanguage: i18n.language.startsWith("zh") ? "zh" : "en",
        language: i18n.language,
        baseUrl: resolved.provider.baseUrl,
        apiKey,
        standard: resolved.provider.apiStandard,
        authMode: resolved.provider.authMode,
        safetySettings: resolved.provider.safetySettings,
        modelId: resolved.model.modelId,
        prefix: resolved.model.prefix,
        contextSize: resolved.model.contextSize,
        maxOutput: resolved.model.maxOutput,
        signal: ctrl.signal,
      });
      setPrompt(spec.prompt);
      setStyle(spec.style);
      setNegative(spec.negative);
      setAspect(spec.aspect);
      // Kept for alt text / the gallery description — the one line that says
      // what the picture is, in the author's language.
      setNote(spec.note);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(e instanceof Error ? e.message : String(e));
    } finally {
      abort.current = null;
      setBuilding(false);
    }
  };

  /** Everything a store run needs from the current form + model selection. */
  const runContext = async (ctrl: AbortController): Promise<RunContext | null> => {
    if (!imageModel || !imageProvider) return null;
    const provider = imageProvider;
    return {
      projectPath: projectPath ?? "",
      model: imageModel,
      provider,
      apiKey: (await loadApiKey(provider.id)) ?? "",
      n: effectiveCount,
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
    } catch (e) {
      // `runContext` awaits the keyring, which can reject before the store is
      // ever reached — without this the button looks dead and the only trace
      // is an unhandled rejection in the console.
      if ((e as Error).name !== "AbortError") setError(e instanceof Error ? e.message : String(e));
    } finally {
      abort.current = null;
    }
  };

  const editIme = useImeGuard();
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
    } catch (e) {
      // Same as handleGenerate: everything before `edit()` can still throw.
      if ((e as Error).name !== "AbortError") setError(e instanceof Error ? e.message : String(e));
    } finally {
      abort.current = null;
    }
  };

  const handleSave = async (alt: boolean) => {
    const sourcePath = currentImagePath();
    if (!sourcePath || !currentTurn) return;
    setSaving(true);
    setError(null);
    try {
      // Read back from scratch rather than holding the bytes in state — see
      // lib/image/session.ts for why candidates live on disk.
      const { dataUrl, bytes, ext } = await imageToDataUrl(sourcePath);
      const input = { bytes, ext, dataUrl, note };
      const savedPath = await (alt ? target.altSave!.run(input) : target.save.run(input));

      // Log how this picture came about, so the chain survives the session.
      const chain = instructionChain(currentTurn.id);
      // Awaited, not fire-and-forget: the record file is a read-modify-write,
      // and two overlapping saves would otherwise lose one of the entries.
      await recordGeneration(projectPath ?? "", {
        path: savedPath,
        prompt: chain.prompt,
        edits: chain.edits,
        model: imageModel?.modelId ?? "",
        size: size.trim() || undefined,
        aspect,
        ...(currentTurn.degraded ? { degraded: true } : {}),
        createdAt: Date.now(),
        costUsd: imageModel ? imageCostFor(imageModel, 1) : 0,
      });

      // Saving does not end the session: the usual next move is to keep
      // editing from the same picture, and dropping the chain here would throw
      // away every earlier round the author might branch back to. The alt
      // action is the exception — an avatar replaces rather than accumulates.
      if (alt && target.altSave?.closeAfter) handleClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    // Closing throws away the whole round — the scratch files AND the money
    // already spent on them — so a stray backdrop click must not do it. Every
    // other editing modal in the app already guards this way; this is the one
    // where an accidental close has a price tag.
    <ModalShell
      overlayClassName={styles.overlay}
      onClose={handleClose}
      isDirty={turns.length > 0 || busy}
      confirmMessage={t("lore.imageGen.discardConfirm")}
      closeOnBackdrop={false}
    >
      {/* 760: footer 要放下「出图模型」选择器 + 关闭 + 最多三枚保存/生成按钮 */}
      <div className={styles.panel} style={{ maxWidth: 760 }}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <div className={styles.headerAvatarPlaceholder}><ImageIcon size={16} strokeWidth={1.5} /></div>
            <div>
              <div className={styles.headerName}>{t("lore.imageGen.title")}</div>
              <div className={styles.headerSub}>{target.subject}</div>
            </div>
          </div>
          {/* 提示词模型留在 header（设计稿 18 未画它，但哪一个在起草提示词
              必须可见）；出图模型挪去 footer 的动作条 (设计稿 v4)。 */}
          <div className={gen.modelPickers}>
            <label className={gen.modelPicker}>
              <span className={gen.modelPickerLabel}>{t("lore.imageGen.promptModelLabel")}</span>
              <Select
                className={styles.modelSelect}
                value={promptModelId}
                onChange={(v) => setPromptModelId(v)}
                disabled={busy || textModels.length === 0}
                options={textModels.map((m) => ({ value: m.id, label: m.name }))}
                ariaLabel={t("lore.imageGen.promptModelLabel")}
              />
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
                {target.references.length > 0 && (
                  <div className={gen.hint}>
                    {t("lore.imageGen.referenceHint", { count: target.references.length })}
                  </div>
                )}
              </div>

              {/* Whatever extra controls this target has — the lore target
                  offers its facets, since that is where the visual specifics
                  live. */}
              {target.extras}

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
                  <Select className={gen.selectInput} value={aspect} disabled={busy}
                    onChange={(v) => setAspect(v as ImageAspect)}
                    options={IMAGE_ASPECTS.map((a) => ({ value: a, label: a }))}
                    ariaLabel={t("lore.imageGen.aspectLabel")} />
                </div>
                <div className={gen.fieldNarrow}>
                  <label className={styles.label}>{t("lore.imageGen.countLabel")}</label>
                  <Select className={gen.selectInput} value={String(effectiveCount)} disabled={busy || chatRoute}
                    onChange={(v) => setCount(parseInt(v, 10))}
                    options={Array.from({ length: MAX_COUNT }, (_, i) => ({
                      value: String(i + 1),
                      label: String(i + 1),
                    }))}
                    ariaLabel={t("lore.imageGen.countLabel")} />
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

              {/* 图库描述 (设计稿 18): 保存时写入的那一行文字，供纯文本模型阅读 */}
              <div className={styles.section}>
                <label className={styles.label}>
                  {t("lore.imageGen.noteLabel", { defaultValue: "图库描述" })}
                  <span className={gen.hintInline}> · {t("lore.imageGen.noteHint", { defaultValue: "保存时作为图片描述写入，供纯文本模型阅读" })}</span>
                </label>
                <input
                  className={gen.input}
                  placeholder={t("lore.imageGen.notePlaceholder", { defaultValue: "一句话说明这张图画的是什么…" })}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  disabled={busy}
                />
              </div>

              {chatRoute && <div className={gen.hint}>{t("lore.imageGen.chatRouteLimits")}</div>}

              {(error || storeError) && <div className={styles.error}>{error ?? storeError}</div>}

              {/* 出图中的占位卡 (设计稿 18): 斜纹底 + 转圈 + 生成中 · Ns */}
              {generating && (
                <div className={gen.genPlaceholder}>
                  <RunStatusLine
                    state="running"
                    label={t("lore.imageGen.generatingShort", { defaultValue: "生成中" })}
                    elapsedSec={genElapsed}
                  />
                </div>
              )}

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

                  <div className={gen.hint}>{t("lore.imageGen.resultsHint")}</div>

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
                      {...editIme.imeProps}
                      onKeyDown={(e) => { if (e.key === "Enter" && !editIme.isComposing(e)) void handleEdit(); }}
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
          <div className={styles.footerLeft}>
            <ModelPicker
              label={t("lore.imageGen.modelLabel")}
              models={imageModels}
              providers={providers}
              value={effectiveImageModelId}
              onChange={(v) => setImageModel(v)}
              disabled={busy || imageModels.length === 0}
            />
            <button className={styles.btnSecondary} onClick={handleClose}>{t("lore.imageGen.close")}</button>
          </div>
          <div className={styles.footerRight}>
            {currentTurn && (
              <>
                {target.altSave && (
                  <button className={styles.btnSecondary} onClick={() => handleSave(true)} disabled={busy}>
                    <UserRound size={13} strokeWidth={1.8} />
                    {target.altSave.label}
                  </button>
                )}
                <button className={styles.btnSecondary} onClick={() => handleSave(false)} disabled={busy}>
                  {saving ? t("lore.imageGen.saving") : target.save.label}
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
