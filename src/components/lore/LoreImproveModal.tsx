import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  X, Sparkles, RotateCw, ChevronDown, AlertTriangle, FileText, Image, Bot,
} from "lucide-react";
import { useAiStore } from "../../stores/aiStore";
import { useProjectStore } from "../../stores/projectStore";
import { useLoreStore } from "../../stores/loreStore";
import { readEntityFile, writeEntityFile, assetUrl, type LoreEntity } from "../../lib/lore";
import {
  scanProjectFiles, imageToDataUrl, readTextFileContent, type ProjectFile,
} from "../../lib/loreGenerator";
import { loadApiKey } from "../../lib/keyStore";
import styles from "./LoreImproveModal.module.css";

// ── Attachment types ──────────────────────────────────────────────────────────

type AttachedLore  = { kind: "lore";  entity: LoreEntity };
type AttachedImage = { kind: "image"; file: ProjectFile; dataUrl: string };
type AttachedText  = { kind: "text";  file: ProjectFile; content: string };
type AttachedItem  = AttachedLore | AttachedImage | AttachedText;

type PickerItem =
  | { type: "lore"; entity: LoreEntity }
  | { type: "file"; file: ProjectFile };

// ── Lazy image thumbnail for the @ picker ─────────────────────────────────────

function PickerThumb({ file }: { file: ProjectFile }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (file.kind === "image") {
      imageToDataUrl(file.path).then(({ dataUrl }) => setUrl(dataUrl)).catch(() => {});
    }
  }, [file.path, file.kind]);

  if (file.kind === "text" || !url) {
    return (
      <div className={styles.pickerThumbPlaceholder}>
        {file.kind === "image" ? <Image size={12} /> : <FileText size={12} />}
      </div>
    );
  }
  return <img src={url} className={styles.pickerThumb} alt="" />;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  entity: LoreEntity;
  onClose: () => void;
}

export function LoreImproveModal({ entity, onClose }: Props) {
  const { t } = useTranslation();
  const { projectPath } = useProjectStore();
  const { models, providers, activeModelId, setActiveModel } = useAiStore();
  const { index, scanProject } = useLoreStore();

  const [currentContent, setCurrentContent] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [attached, setAttached] = useState<AttachedItem[]>([]);
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [phase, setPhase] = useState<"input" | "generating" | "result">("input");
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // @ picker
  const [showPicker, setShowPicker] = useState(false);
  const [atQuery, setAtQuery] = useState("");
  const [atIndex, setAtIndex] = useState(0);
  const [pickerStyle, setPickerStyle] = useState<React.CSSProperties>({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaWrapRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    readEntityFile(entity.dirPath, "index.md")
      .then(setCurrentContent)
      .catch(() => setCurrentContent(""));
    if (projectPath) {
      scanProjectFiles(projectPath).then(setProjectFiles).catch(() => {});
    }
  }, [entity.dirPath, projectPath]);

  // Recompute picker position whenever it opens
  useEffect(() => {
    if (showPicker && textareaWrapRef.current) {
      const r = textareaWrapRef.current.getBoundingClientRect();
      // Try to open below; if not enough room, open above
      const spaceBelow = window.innerHeight - r.bottom - 8;
      const pickerH = Math.min(240, window.innerHeight * 0.4);
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

  const otherEntities = Object.values(index).flat().filter((e) => e.id !== entity.id);

  const pickerItems: PickerItem[] = [
    ...otherEntities
      .filter((e) => !atQuery || e.name.toLowerCase().includes(atQuery))
      .map((e): PickerItem => ({ type: "lore", entity: e })),
    ...projectFiles
      .filter((f) => !atQuery || f.name.toLowerCase().includes(atQuery))
      .map((f): PickerItem => ({ type: "file", file: f })),
  ].slice(0, 10);

  const itemKey = (item: PickerItem) =>
    item.type === "lore" ? `lore:${item.entity.id}` : `file:${item.file.path}`;

  const attachedKeys = new Set(
    attached.map((a) => (a.kind === "lore" ? `lore:${a.entity.id}` : `file:${a.file.path}`)),
  );

  // ── @ detection ────────────────────────────────────────────────────────────
  const handleInstructionChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInstruction(val);
    const pos = e.target.selectionStart ?? val.length;
    const before = val.slice(0, pos);
    const match = before.match(/@(\w*)$/);
    if (match) {
      setAtIndex(pos - match[0].length);
      setAtQuery(match[1].toLowerCase());
      setShowPicker(true);
    } else {
      setShowPicker(false);
    }
  };

  const insertAtLabel = (label: string) => {
    const before = instruction.slice(0, atIndex);
    const after = instruction.slice(atIndex + 1 + atQuery.length);
    setInstruction(`${before}@[${label}]${after}`);
    setShowPicker(false);
    textareaRef.current?.focus();
  };

  const handlePickItem = async (item: PickerItem) => {
    if (attachedKeys.has(itemKey(item))) { setShowPicker(false); return; }
    if (item.type === "lore") {
      setAttached((prev) => [...prev, { kind: "lore", entity: item.entity }]);
      insertAtLabel(item.entity.name);
    } else {
      try {
        if (item.file.kind === "image") {
          const { dataUrl } = await imageToDataUrl(item.file.path);
          setAttached((prev) => [...prev, { kind: "image", file: item.file, dataUrl }]);
        } else {
          const content = await readTextFileContent(item.file.path);
          setAttached((prev) => [...prev, { kind: "text", file: item.file, content }]);
        }
        insertAtLabel(item.file.name);
      } catch { /* skip unreadable */ }
    }
  };

  const removeAttached = (key: string) =>
    setAttached((prev) =>
      prev.filter((a) => (a.kind === "lore" ? `lore:${a.entity.id}` : `file:${a.file.path}`) !== key),
    );

  // ── Generate ───────────────────────────────────────────────────────────────
  const handleGenerate = async () => {
    const model = models.find((m) => m.id === activeModelId);
    const provider = model ? providers.find((p) => p.id === model.providerId) : null;
    if (!model || !provider) { setError(t("ai.errors.noModel")); return; }

    const apiKey = (await loadApiKey(provider.id)) ?? "";
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    setOutput("");
    setPhase("generating");

    try {
      const loreRefs = await Promise.all(
        attached
          .filter((a): a is AttachedLore => a.kind === "lore")
          .map(async (a) => {
            try {
              const c = await readEntityFile(a.entity.dirPath, "index.md");
              return `## ${a.entity.name}\n${c}`;
            } catch { return `## ${a.entity.name}\n(unavailable)`; }
          }),
      );

      const textRefs = attached
        .filter((a): a is AttachedText => a.kind === "text")
        .map((a) => `--- ${a.file.name} ---\n${a.content}`);

      // Only multimodal models can consume images; sending them to a text model
      // either errors or is silently dropped, so omit them here.
      const supportsImages = model.type === "multimodal";
      const imageAttachments = supportsImages
        ? attached.filter((a): a is AttachedImage => a.kind === "image")
        : [];

      const systemPrompt = [
        "You are a lore writing assistant improving an existing lore entity document.",
        "Return the COMPLETE updated index.md file content, starting with a YAML frontmatter block (---) containing: name, aliases (as YAML list), category, and summary.",
        "The body after the frontmatter should be rich markdown prose using ## headers.",
        "Output ONLY the raw file content — no explanation, no code fences, no prefix text.",
      ].join("\n");

      const textContent = [
        `CURRENT ENTITY (${entity.name}/index.md):`,
        currentContent || "(empty)",
        loreRefs.length > 0 ? "\nREFERENCED LORE ENTRIES:\n" + loreRefs.join("\n\n") : "",
        textRefs.length > 0 ? "\nREFERENCED FILES:\n" + textRefs.join("\n\n") : "",
        `\nUSER INSTRUCTION:\n${instruction.trim() || "Improve and expand this lore entry with more detail."}`,
      ].filter(Boolean).join("\n");

      // Text/md attachments are already embedded in textContent above.
      // Only use a multipart array when there are actual image attachments;
      // otherwise pass a plain string so Gemini doesn't see a spurious parts array.
      type TextPart = { type: "text"; text: string };
      type ImagePart = { type: "image_url"; image_url: { url: string } };
      const userContent: string | Array<TextPart | ImagePart> =
        imageAttachments.length > 0
          ? [
              { type: "text", text: textContent },
              ...imageAttachments.map((a) => ({
                type: "image_url" as const,
                image_url: { url: a.dataUrl },
              })),
            ]
          : textContent;

      const { streamCompletion } = await import("../../lib/aiClient");
      let accumulated = "";
      await streamCompletion({
        baseUrl: provider.baseUrl,
        apiKey,
        standard: provider.apiStandard,
        safetySettings: provider.safetySettings,
        modelId: model.modelId,
        prefix: model.prefix,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        onChunk: (chunk) => {
          if ("text" in chunk) { accumulated += chunk.text; setOutput(accumulated); }
        },
        signal: ctrl.signal,
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
      let content = output.trim();
      const fence = content.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/);
      if (fence) content = fence[1];
      await writeEntityFile(entity.dirPath, "index.md", content);
      await scanProject(projectPath);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const multimodalModels = models.filter((m) => m.type === "multimodal" || m.type === "text");

  return (
    <div className={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.panel}>

        {/* ── Header ── */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            {entity.avatarPath
              ? <img src={assetUrl(entity.avatarPath)} className={styles.headerAvatar} alt={entity.name} />
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
            <div ref={textareaWrapRef}>
              <textarea
                ref={textareaRef}
                className={styles.textarea}
                rows={4}
                placeholder={t("lore.improve.instructionPlaceholder")}
                value={instruction}
                onChange={handleInstructionChange}
                onKeyDown={(e) => { if (e.key === "Escape") setShowPicker(false); }}
                disabled={phase === "generating"}
              />
            </div>

            {/* Attached chips (always in flow, never overlap) */}
            {attached.length > 0 && (
              <div className={styles.chips}>
                {attached.map((a) => {
                  const key = a.kind === "lore" ? `lore:${a.entity.id}` : `file:${a.file.path}`;
                  const label = a.kind === "lore" ? a.entity.name : a.file.name;
                  return (
                    <span key={key} className={`${styles.chip} ${a.kind === "image" ? styles.chipImage : ""}`}>
                      {a.kind === "image" && <Image size={10} />}
                      @{label}
                      <button className={styles.chipRemove} onClick={() => removeAttached(key)}>
                        <X size={10} />
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
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
              <textarea
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

      {/* @ picker rendered via portal — escapes overflow context entirely */}
      {showPicker && pickerItems.length > 0 && createPortal(
        <div ref={pickerRef} className={styles.picker} style={{ position: "fixed", zIndex: 500, ...pickerStyle }}>
          {pickerItems.map((item) => {
            const key = itemKey(item);
            const used = attachedKeys.has(key);
            return (
              <button
                key={key}
                className={`${styles.pickerItem} ${used ? styles.pickerItemUsed : ""}`}
                onMouseDown={(e) => { e.preventDefault(); void handlePickItem(item); }}
              >
                {item.type === "lore"
                  ? item.entity.avatarPath
                    ? <img src={assetUrl(item.entity.avatarPath)} className={styles.pickerThumb} alt="" />
                    : <div className={styles.pickerThumbPlaceholder}><FileText size={12} /></div>
                  : <PickerThumb file={item.file} />}
                <span className={styles.pickerName}>
                  {item.type === "lore" ? item.entity.name : item.file.name}
                </span>
                <span className={styles.pickerBadge}>
                  {item.type === "lore" ? item.entity.category : item.file.kind}
                </span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
