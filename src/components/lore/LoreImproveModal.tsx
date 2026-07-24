import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { X, Sparkles, RotateCw, ChevronDown, AlertTriangle, Bot } from "lucide-react";
import { useAiStore } from "../../stores/aiStore";
import { useProjectStore } from "../../stores/projectStore";
import { useLoreStore } from "../../stores/loreStore";
import {
  readEntityFile, writeEntityFile, saveFacetFile, parseFacetMeta,
  type LoreEntity, type FacetMeta,
} from "../../lib/lore";
import { parseFrontmatter } from "../../lib/fs/markdown";
import {
  resolveModel, collectAttachmentContext, buildUserContent, stripCodeFence, streamLoreTask,
  type AttachedItem,
} from "../../lib/lore/aiTask";
import { useImageDataUrl } from "./useImageDataUrl";
import { MarkdownTextarea } from "../common/MarkdownTextarea";
import { ModalShell } from "../common/ModalShell";
import { AttachmentTextarea } from "./ai/AttachmentTextarea";
import { scanProjectFiles, type ProjectFile } from "../../lib/fs/images";
import { loadApiKey } from "../../lib/keyStore";
import styles from "./LoreImproveModal.module.css";

interface Props {
  entity: LoreEntity;
  onClose: () => void;
}

export function LoreImproveModal({ entity, onClose }: Props) {
  const { t } = useTranslation();
  const { projectPath } = useProjectStore();
  const { models, providers, activeModelId, setActiveModel } = useAiStore();
  const { index, scanProject } = useLoreStore();
  const avatarUrl = useImageDataUrl(entity.avatarPath);

  // Write target: "__index__" = the whole entity index.md, else a facet filename.
  const INDEX = "__index__";
  const [target, setTarget] = useState<string>(INDEX);
  const isFacet = target !== INDEX;
  const facetMetaRef = useRef<FacetMeta | null>(null);

  const [currentContent, setCurrentContent] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [attached, setAttached] = useState<AttachedItem[]>([]);
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [phase, setPhase] = useState<"input" | "generating" | "result">("input");
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (projectPath) {
      scanProjectFiles(projectPath).then(setProjectFiles).catch(() => {});
    }
  }, [projectPath]);

  // Load the current target's content: the whole index.md, or a facet's body
  // (frontmatter stripped) with its meta stashed for a later frontmatter-safe save.
  useEffect(() => {
    const file = isFacet ? target : "index.md";
    readEntityFile(entity.dirPath, file)
      .then((raw) => {
        if (isFacet) {
          facetMetaRef.current = parseFacetMeta(raw, file);
          setCurrentContent(parseFrontmatter(raw).content);
        } else {
          facetMetaRef.current = null;
          setCurrentContent(raw);
        }
      })
      .catch(() => setCurrentContent(""));
  }, [entity.dirPath, target, isFacet]);

  const facetTitle = entity.facets.find((f) => f.file === target)?.title ?? target;
  const otherEntities = Object.values(index).flat().filter((e) => e.id !== entity.id);

  // ── Generate ───────────────────────────────────────────────────────────────
  const handleGenerate = async () => {
    const resolved = resolveModel(models, providers, activeModelId);
    if (!resolved) { setError(t("ai.errors.noModel")); return; }
    const { model, provider } = resolved;

    const apiKey = (await loadApiKey(provider.id)) ?? "";
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    setOutput("");
    setPhase("generating");

    try {
      const supportsImages = model.type === "multimodal";
      const { loreRefs, textRefs, images } = await collectAttachmentContext(attached, supportsImages);

      const systemPrompt = isFacet
        ? [
            "You are a lore writing assistant improving ONE facet of a lore entity.",
            "Return the COMPLETE updated facet body as rich markdown prose.",
            "Output ONLY the body — no YAML frontmatter, no code fences, no explanation.",
          ].join("\n")
        : [
            "You are a lore writing assistant improving an existing lore entity document.",
            "Return the COMPLETE updated index.md file content, starting with a YAML frontmatter block (---) containing: name, aliases (as YAML list), category, and summary.",
            "The body after the frontmatter should be rich markdown prose using ## headers.",
            "Output ONLY the raw file content — no explanation, no code fences, no prefix text.",
          ].join("\n");

      const textContent = [
        isFacet
          ? `CURRENT FACET (${facetTitle}) of entity ${entity.name}:`
          : `CURRENT ENTITY (${entity.name}/index.md):`,
        currentContent || "(empty)",
        loreRefs.length > 0 ? "\nREFERENCED LORE ENTRIES:\n" + loreRefs.join("\n\n") : "",
        textRefs.length > 0 ? "\nREFERENCED FILES:\n" + textRefs.join("\n\n") : "",
        `\nUSER INSTRUCTION:\n${instruction.trim() || "Improve and expand this lore entry with more detail."}`,
      ].filter(Boolean).join("\n");

      await streamLoreTask({
        model,
        provider,
        apiKey,
        systemPrompt,
        userContent: buildUserContent(textContent, images),
        signal: ctrl.signal,
        onText: setOutput,
      });
      setPhase("result");
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError(e instanceof Error ? e.message : String(e));
      }
      setPhase(output ? "result" : "input");
    } finally {
      abortRef.current = null;
    }
  };

  // ── Apply ──────────────────────────────────────────────────────────────────
  const handleApply = async () => {
    if (!projectPath || !output.trim()) return;
    setSaving(true);
    try {
      const body = stripCodeFence(output);
      if (isFacet) {
        // Preserve the facet's frontmatter; only its body is regenerated.
        const meta = facetMetaRef.current ?? (() => {
          const f = entity.facets.find((x) => x.file === target);
          return f ? { title: f.title, keys: f.keys, group: f.group, priority: f.priority, mode: f.mode } : null;
        })();
        if (!meta) { setError(t("lore.improve.facetMetaError", { defaultValue: "无法读取该特征的元数据" })); setSaving(false); return; }
        await saveFacetFile(entity.dirPath, target, meta, body);
      } else {
        await writeEntityFile(entity.dirPath, "index.md", body);
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

  // Unsaved once the user has typed an instruction, attached refs, or generated.
  const dirty = phase !== "input" || instruction.trim().length > 0 || attached.length > 0;

  return (
    <ModalShell overlayClassName={styles.overlay} onClose={onClose} isDirty={dirty} closeOnBackdrop={false}>
      <div className={styles.panel}>

        {/* ── Header ── */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            {avatarUrl
              ? <img src={avatarUrl} className={styles.headerAvatar} alt={entity.name} />
              : <div className={styles.headerAvatarPlaceholder}><Bot size={16} strokeWidth={1.5} /></div>}
            <div>
              <div className={styles.headerName}>{entity.name}</div>
              <div className={styles.headerSub}>{t("lore.improve.subtitle")}</div>
            </div>
          </div>
          <select
            className={styles.modelSelect}
            value={activeModelId ?? ""}
            onChange={(e) => setActiveModel(e.target.value)}
          >
            <option value="">{t("lore.generator.selectModel")}</option>
            {multimodalModels.map((m) => {
              const pname = providers.find((p) => p.id === m.providerId)?.name ?? "";
              return <option key={m.id} value={m.id}>{pname} / {m.name}</option>;
            })}
          </select>
          <button className={styles.closeBtn} onClick={onClose}><X size={16} /></button>
        </div>

        {/* ── Body (scrollable) ── */}
        <div className={styles.body}>

          {/* Write target — only meaningful once the entity has facets */}
          {entity.facets.length > 0 && (
            <div className={styles.section}>
              <label className={styles.label}>{t("lore.improve.targetLabel", { defaultValue: "写入目标" })}</label>
              <select
                className={styles.modelSelect}
                style={{ maxWidth: "none", width: "100%" }}
                value={target}
                disabled={phase === "generating"}
                onChange={(e) => { setTarget(e.target.value); setOutput(""); setPhase("input"); }}
              >
                <option value={INDEX}>{t("lore.improve.targetIndex", { defaultValue: "整体条目（index.md）" })}</option>
                {entity.facets.map((f) => (
                  <option key={f.file} value={f.file}>
                    {t("lore.improve.targetFacetPrefix", { defaultValue: "特征" })}：{f.title}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Current content collapsible */}
          <div className={styles.currentSection}>
            <button className={styles.currentToggle} onClick={() => setShowCurrent((v) => !v)}>
              <ChevronDown size={13} className={`${styles.toggleChevron} ${showCurrent ? styles.toggleChevronOpen : ""}`} />
              <span>{t("lore.improve.currentContent")}</span>
              <span className={styles.currentBytes}>{t("lore.improve.charCount", { count: currentContent.length })}</span>
            </button>
            {showCurrent && (
              <pre className={styles.currentPre}>{currentContent || "(empty)"}</pre>
            )}
          </div>

          {/* Instruction */}
          <div className={styles.section}>
            <label className={styles.label}>
              {t("lore.improve.instructionLabel")}
              <span className={styles.hint}> · {t("lore.improve.atHint")}</span>
            </label>
            <AttachmentTextarea
              instruction={instruction}
              onInstructionChange={setInstruction}
              attached={attached}
              onAttachedChange={setAttached}
              entities={otherEntities}
              projectFiles={projectFiles}
              disabled={phase === "generating"}
              rows={4}
              placeholder={t("lore.improve.instructionPlaceholder")}
              textareaClassName={styles.textarea}
            />
          </div>

          {/* Error */}
          {error && (
            <div className={styles.error}>
              <AlertTriangle size={13} style={{ flexShrink: 0 }} />
              {error}
            </div>
          )}

          {/* Output */}
          {(phase === "generating" || phase === "result") && (
            <div className={styles.section}>
              <label className={styles.label}>
                {phase === "generating" ? t("lore.improve.generating") : t("lore.improve.resultLabel")}
              </label>
              <MarkdownTextarea
                className={`${styles.textarea} ${styles.outputArea}`}
                value={output}
                onChange={(e) => setOutput(e.target.value)}
                rows={16}
                readOnly={phase === "generating"}
                spellCheck={false}
              />
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className={styles.footer}>
          <button className={styles.btnSecondary} onClick={onClose}>{t("lore.improve.cancel")}</button>
          <div className={styles.footerRight}>
            {phase === "input" && (
              <button className={styles.btnPrimary} onClick={handleGenerate} disabled={!activeModelId}>
                <Sparkles size={13} /> {t("lore.improve.generate")}
              </button>
            )}
            {phase === "generating" && (
              <button className={styles.btnAbort}
                onClick={() => { abortRef.current?.abort(); setPhase(output ? "result" : "input"); }}>
                {t("lore.improve.stop")}
              </button>
            )}
            {phase === "result" && (
              <>
                <button className={styles.btnSecondary} onClick={handleGenerate} disabled={!activeModelId}>
                  <RotateCw size={12} /> {t("lore.improve.regenerate")}
                </button>
                <button className={styles.btnPrimary} onClick={handleApply} disabled={saving || !output.trim()}>
                  {saving ? t("lore.improve.applying") : t("lore.improve.apply")}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
