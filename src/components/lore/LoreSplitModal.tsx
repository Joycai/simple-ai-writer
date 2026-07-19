/**
 * AI facet splitting — three-phase flow modeled on LoreImproveModal:
 *   input      → current index.md preview + optional author guidance
 *   generating → streaming raw model output
 *   review     → editable core + facet draft cards; nothing touches disk
 *                until Apply, which backs up index.md first
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X, Scissors, RotateCw, ArrowLeft, AlertTriangle } from "lucide-react";
import { useAiStore } from "../../stores/aiStore";
import { useProjectStore } from "../../stores/projectStore";
import { useLoreStore } from "../../stores/loreStore";
import {
  createFacetFile,
  readEntityFile,
  writeEntityFile,
  type FacetMeta,
  type LoreEntity,
} from "../../lib/lore";
import { splitLore, type SplitResult } from "../../lib/lore/splitter";
import { makeDir, writeFile } from "../../lib/fs/fileio";
import { loadApiKey } from "../../lib/keyStore";
import { MarkdownTextarea } from "../common/MarkdownTextarea";
import styles from "./LoreSplitModal.module.css";

interface Props {
  entity: LoreEntity;
  onClose: () => void;
  /** Fired after a successful Apply so the parent can re-read index.md. */
  onApplied?: () => void;
}

interface EditableDraft {
  include: boolean;
  meta: FacetMeta;
  content: string;
}

/** Small chip editor for a draft's trigger keys. */
function KeysEditor({ keys, onChange }: { keys: string[]; onChange: (keys: string[]) => void }) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const add = () => {
    const v = input.trim();
    if (v && !keys.includes(v)) onChange([...keys, v]);
    setInput("");
  };
  return (
    <div className={styles.keysEditor}>
      {keys.map((k, i) => (
        <span key={`${k}-${i}`} className={styles.keyChip}>
          {k}
          <button
            className={styles.keyChipRemove}
            onClick={() => onChange(keys.filter((_, x) => x !== i))}
            title={t("lore.facet.removeKey", { defaultValue: "移除" })}
          >
            <X size={9} />
          </button>
        </span>
      ))}
      <input
        className={styles.keyInput}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        onBlur={add}
        placeholder={t("lore.split.addKey", { defaultValue: "+ 关键词" })}
      />
    </div>
  );
}

export function LoreSplitModal({ entity, onClose, onApplied }: Props) {
  const { t } = useTranslation();
  const { projectPath } = useProjectStore();
  const { models, providers, activeModelId, setActiveModel } = useAiStore();
  const scanProject = useLoreStore((s) => s.scanProject);

  const [phase, setPhase] = useState<"input" | "generating" | "review">("input");
  const [indexRaw, setIndexRaw] = useState("");
  const [instruction, setInstruction] = useState("");
  const [rawOutput, setRawOutput] = useState("");
  const [core, setCore] = useState("");
  const [drafts, setDrafts] = useState<EditableDraft[]>([]);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Normalize CRLF up front: the frontmatter regex below assumes \n, and a
    // Windows-edited file would otherwise lose its frontmatter on Apply.
    readEntityFile(entity.dirPath, "index.md")
      .then((raw) => setIndexRaw(raw.replace(/\r\n/g, "\n")))
      .catch(() => setIndexRaw(""));
  }, [entity.dirPath]);

  // Abort a running generation when the modal unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  const indexBody = useMemo(
    () => indexRaw.replace(/^---\n[\s\S]*?\n---\n?/, "").trim(),
    [indexRaw],
  );

  const estTk = (chars: number) => Math.ceil(chars / 3);

  const handleGenerate = async () => {
    const model = models.find((m) => m.id === activeModelId);
    const provider = model ? providers.find((p) => p.id === model.providerId) : null;
    if (!model || !provider) { setError(t("ai.errors.noModel")); return; }
    if (!indexBody) { setError(t("lore.split.emptyEntry", { defaultValue: "当前条目没有正文，无需拆分" })); return; }

    const apiKey = (await loadApiKey(provider.id)) ?? "";
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    setRawOutput("");
    setPhase("generating");

    try {
      const result: SplitResult = await splitLore({
        entityName: entity.name,
        indexBody,
        instruction,
        baseUrl: provider.baseUrl,
        apiKey,
        standard: provider.apiStandard,
        safetySettings: provider.safetySettings,
        modelId: model.modelId,
        prefix: model.prefix,
        contextSize: model.contextSize,
        onProgress: (text) => setRawOutput((prev) => prev + text),
        signal: ctrl.signal,
      });
      // Empty core would wipe the entry on Apply — fall back to the original.
      setCore(result.core || indexBody);
      setDrafts(result.facets.map((f) => ({ include: true, meta: f.meta, content: f.content })));
      setNotes(result.notes);
      setPhase("review");
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError(e instanceof Error ? e.message : String(e));
      }
      setPhase("input");
    } finally {
      abortRef.current = null;
    }
  };

  const handleCancelGenerate = () => {
    abortRef.current?.abort();
  };

  const updateDraft = (i: number, patch: Partial<EditableDraft>) =>
    setDrafts((prev) => prev.map((d, x) => (x === i ? { ...d, ...patch } : d)));
  const updateDraftMeta = (i: number, patch: Partial<FacetMeta>) =>
    setDrafts((prev) => prev.map((d, x) => (x === i ? { ...d, meta: { ...d.meta, ...patch } } : d)));

  const included = drafts.filter((d) => d.include);
  const canApply = !saving && core.trim().length > 0 && included.length > 0;

  const handleApply = async () => {
    if (!canApply || !projectPath) return;
    setSaving(true);
    setError(null);
    try {
      // 1. Snapshot the original index.md — the author's text is irreplaceable.
      const backupDir = `${projectPath}/.ai-writer/backups`;
      await makeDir(backupDir);
      await writeFile(`${backupDir}/${entity.category}-${entity.id}-index-${Date.now()}.md`, indexRaw);

      // 2. Facet files first: if anything fails mid-way the worst case is a
      //    few extra files — index.md is only rewritten once they all exist.
      for (const d of included) {
        await createFacetFile(entity.dirPath, {
          ...d.meta,
          title: d.meta.title.trim() || "未命名侧面",
          keys: d.meta.keys.map((k) => k.trim()).filter(Boolean),
        }, d.content);
      }

      // 3. Rewrite index.md, preserving its frontmatter verbatim.
      const fm = indexRaw.match(/^---\n[\s\S]*?\n---\n?/)?.[0] ?? "";
      await writeEntityFile(entity.dirPath, "index.md", fm + core.trim() + "\n");

      await scanProject(projectPath);
      onApplied?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return createPortal(
    <div className={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget && phase !== "generating") onClose(); }}>
      <div className={styles.panel}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <Scissors size={15} strokeWidth={1.8} />
            <span className={styles.headerTitle}>
              {t("lore.split.title", { defaultValue: "拆分侧面" })}
            </span>
            <span className={styles.headerEntity}>{entity.name}</span>
          </div>
          <select
            className={styles.modelSelect}
            value={activeModelId ?? ""}
            onChange={(e) => setActiveModel(e.target.value)}
            disabled={phase === "generating"}
          >
            <option value="">{t("lore.generator.selectModel")}</option>
            {models.map((m) => {
              const pname = providers.find((p) => p.id === m.providerId)?.name ?? "";
              return <option key={m.id} value={m.id}>{pname} / {m.name}</option>;
            })}
          </select>
          <button className={styles.closeBtn} onClick={onClose} disabled={phase === "generating"}>
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className={styles.body}>
          {phase === "input" && (
            <>
              <div className={styles.sectionLabel}>
                {t("lore.split.current", { defaultValue: "当前条目" })}
                <span className={styles.tokenTag}>~{estTk(indexBody.length)} tk</span>
              </div>
              <pre className={styles.currentPreview}>{indexBody || t("lore.split.emptyEntry", { defaultValue: "当前条目没有正文，无需拆分" })}</pre>
              <div className={styles.sectionLabel}>
                {t("lore.split.instructionLabel", { defaultValue: "拆解指令（可选）" })}
              </div>
              <MarkdownTextarea
                format={false}
                className={styles.instructionInput}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                rows={3}
                placeholder={t("lore.split.instructionPlaceholder", { defaultValue: "如：服装和形态单独拆成互斥组；背景故事合成一条…" })}
              />
              {error && <div className={styles.error}><AlertTriangle size={12} /> {error}</div>}
            </>
          )}

          {phase === "generating" && (
            <>
              <div className={styles.sectionLabel}>
                {t("lore.split.generating", { defaultValue: "正在拆解…" })}
              </div>
              <pre className={styles.streamOutput}>{rawOutput || "…"}</pre>
            </>
          )}

          {phase === "review" && (
            <>
              {notes && <div className={styles.notes}>{notes}</div>}
              <div className={styles.sectionLabel}>
                {t("lore.split.coreLabel", { defaultValue: "核心卡（保留在 index.md）" })}
                <span className={styles.tokenTag}>
                  ~{estTk(core.length)} tk
                  <span className={styles.tokenBefore}>／{t("lore.split.before", { defaultValue: "原" })} {estTk(indexBody.length)} tk</span>
                </span>
              </div>
              <MarkdownTextarea
                className={styles.coreTextarea}
                value={core}
                onChange={(e) => setCore(e.target.value)}
                spellCheck={false}
              />

              <div className={styles.sectionLabel}>
                {t("lore.split.facetsLabel", { defaultValue: "拆出的侧面（按需注入）" })}
                <span className={styles.tokenTag}>{included.length}/{drafts.length}</span>
              </div>
              <div className={styles.draftList}>
                {drafts.map((d, i) => (
                  <div key={i} className={`${styles.draftCard} ${d.include ? "" : styles.draftExcluded}`}>
                    <div className={styles.draftHead}>
                      <label className={styles.draftInclude}>
                        <input
                          type="checkbox"
                          checked={d.include}
                          onChange={(e) => updateDraft(i, { include: e.target.checked })}
                        />
                      </label>
                      <input
                        className={styles.draftTitle}
                        value={d.meta.title}
                        onChange={(e) => updateDraftMeta(i, { title: e.target.value })}
                        disabled={!d.include}
                      />
                      <input
                        className={styles.draftGroup}
                        value={d.meta.group ?? ""}
                        onChange={(e) => updateDraftMeta(i, { group: e.target.value.trim() || null })}
                        placeholder={t("lore.split.groupPlaceholder", { defaultValue: "互斥组" })}
                        disabled={!d.include}
                        title={t("lore.facet.fieldGroup", { defaultValue: "互斥组" })}
                      />
                      <input
                        className={styles.draftPriority}
                        type="number"
                        value={d.meta.priority}
                        onChange={(e) => updateDraftMeta(i, { priority: Number(e.target.value) || 0 })}
                        disabled={!d.include}
                        title={t("lore.facet.fieldPriority", { defaultValue: "优先级" })}
                      />
                      <span className={styles.tokenTag}>~{estTk(d.content.length)} tk</span>
                    </div>
                    {d.include && (
                      <>
                        <KeysEditor keys={d.meta.keys} onChange={(keys) => updateDraftMeta(i, { keys })} />
                        {d.meta.keys.length === 0 && (
                          <div className={styles.draftWarn}>
                            <AlertTriangle size={11} />
                            {t("lore.facet.keysEmptyWarn", { defaultValue: "自动模式下没有关键词，此侧面永远不会被自动注入" })}
                          </div>
                        )}
                        <MarkdownTextarea
                          format={false}
                          className={styles.draftContent}
                          value={d.content}
                          onChange={(e) => updateDraft(i, { content: e.target.value })}
                          rows={4}
                          spellCheck={false}
                        />
                      </>
                    )}
                  </div>
                ))}
              </div>
              {error && <div className={styles.error}><AlertTriangle size={12} /> {error}</div>}
            </>
          )}
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          {phase === "input" && (
            <>
              <button className={styles.btn} onClick={onClose}>
                {t("common.cancel", { defaultValue: "取消" })}
              </button>
              <button
                className={`${styles.btn} ${styles.btnPrimary}`}
                onClick={handleGenerate}
                disabled={!indexBody}
              >
                <Scissors size={12} />
                {t("lore.split.start", { defaultValue: "开始拆解" })}
              </button>
            </>
          )}
          {phase === "generating" && (
            <button className={styles.btn} onClick={handleCancelGenerate}>
              {t("lore.split.cancel", { defaultValue: "停止" })}
            </button>
          )}
          {phase === "review" && (
            <>
              <button className={styles.btn} onClick={() => setPhase("input")} disabled={saving}>
                <ArrowLeft size={12} />
                {t("lore.split.back", { defaultValue: "返回" })}
              </button>
              <button className={styles.btn} onClick={handleGenerate} disabled={saving}>
                <RotateCw size={12} />
                {t("lore.split.regenerate", { defaultValue: "重新拆解" })}
              </button>
              <span className={styles.footerSpacer} />
              <span className={styles.footerHint}>
                {t("lore.split.backupHint", { defaultValue: "应用前会自动备份原条目" })}
              </span>
              <button
                className={`${styles.btn} ${styles.btnPrimary}`}
                onClick={handleApply}
                disabled={!canApply}
              >
                {saving
                  ? t("lore.split.applying", { defaultValue: "应用中…" })
                  : t("lore.split.apply", { defaultValue: "应用拆分" })}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
