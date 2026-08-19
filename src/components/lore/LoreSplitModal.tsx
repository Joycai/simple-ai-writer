/**
 * AI facet splitting — three-phase flow modeled on LoreImproveModal:
 *   input      → current index.md preview + optional author guidance
 *   generating → streaming raw model output
 *   review     → editable core + facet draft cards; nothing touches disk
 *                until Apply, which backs up index.md first
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Scissors, RotateCw, ArrowLeft, AlertTriangle } from "lucide-react";
import { useAiStore } from "../../stores/aiStore";
import { useProjectStore } from "../../stores/projectStore";
import { useLoreStore } from "../../stores/loreStore";
import { connOptions } from "../../lib/ai/conn";
import {
  createFacetFile,
  readEntityFile,
  writeEntityFile,
  type FacetMeta,
  type LoreEntity,
} from "../../lib/lore";
import { splitLore, type SplitResult } from "../../lib/lore/splitter";
import { parseFrontmatter } from "../../lib/fs/markdown";
import { makeDir, writeFile, removeFile } from "../../lib/fs/fileio";
import { loadApiKey } from "../../lib/keyStore";
import { MarkdownTextarea } from "../common/MarkdownTextarea";
import { ModalShell } from "../common/ModalShell";
import { useImeGuard } from "../../lib/ime";
import {
  LoreRunSteps, RunStatusLine, ThinkingPanel, useRunClock, useRunTelemetry,
  type RunStep,
} from "./ai/LoreRunProgress";
import { ModelPicker } from "./ai/ModelPicker";
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
  const ime = useImeGuard();
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
        {...ime.imeProps}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !ime.isComposing(e)) { e.preventDefault(); add(); }
        }}
        onBlur={add}
        placeholder={t("lore.split.addKey", { defaultValue: "+ 关键词" })}
      />
    </div>
  );
}

export function LoreSplitModal({ entity, onClose, onApplied }: Props) {
  const { t } = useTranslation();
  const { projectPath } = useProjectStore();
  const { models, providers, activeModelId } = useAiStore();
  // 本次任务使用的模型 — 默认跟随全局设置，改动不写回全局 (设计稿 v4)。
  const [modelId, setModelId] = useState(activeModelId ?? "");
  const scanProject = useLoreStore((s) => s.scanProject);

  const [phase, setPhase] = useState<"input" | "generating" | "review">("input");
  /**
   * The plan as the model submits it, piece by piece. The split arrives as one
   * tool call per facet now, so there is something real to show while the run
   * is still going — and if the round cap or the author's 停止 ends it early,
   * this is what already landed.
   */
  const [partial, setPartial] = useState<{ core?: string; facets: number }>({ facets: 0 });
  /**
   * The run produced facets but never submitted a core card. The original body
   * stands in so Apply can't erase the entry — but then the facet text is in
   * two places at once, which the author has to be told before they apply it.
   */
  const [coreMissing, setCoreMissing] = useState(false);
  const [indexRaw, setIndexRaw] = useState("");
  const [instruction, setInstruction] = useState("");
  const [core, setCore] = useState("");
  const [drafts, setDrafts] = useState<EditableDraft[]>([]);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const elapsedSec = useRunClock(phase === "generating");
  const { reasoning, usageTokens, onEvent: onRunEvent, reset: resetTelemetry } = useRunTelemetry();

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
    const model = models.find((m) => m.id === modelId);
    const provider = model ? providers.find((p) => p.id === model.providerId) : null;
    if (!model || !provider) { setError(t("ai.errors.noModel")); return; }
    if (!indexBody && entity.facets.length === 0) { setError(t("lore.split.emptyEntry", { defaultValue: "当前条目没有正文，无需拆分" })); return; }

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    resetTelemetry();
    setPartial({ facets: 0 });
    setPhase("generating");

    try {
      const apiKey = (await loadApiKey(provider.id)) ?? "";
      // Fold existing facets back in so the model reorganizes the whole entity,
      // not just the core body. Their files are replaced on Apply.
      const existingFacets = await Promise.all(
        entity.facets.map(async (f) => {
          try {
            const raw = await readEntityFile(entity.dirPath, f.file);
            return { title: f.title, keys: f.keys, body: parseFrontmatter(raw).content };
          } catch {
            return { title: f.title, keys: f.keys, body: "" };
          }
        }),
      );

      const result: SplitResult = await splitLore({
        entityName: entity.name,
        indexBody,
        existingFacets,
        instruction,
        ...connOptions({ provider, model, apiKey }),
        onPartial: (p) => setPartial({ core: p.core, facets: p.facets.length }),
        onEvent: onRunEvent,
        signal: ctrl.signal,
      });
      // Empty core would wipe the entry on Apply — fall back to the original.
      setCoreMissing(!result.core.trim() && result.facets.length > 0);
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

  // 语义步骤 (设计稿 17): 读取 → 拆解分组 → 交给作者确认。
  const splitSteps: RunStep[] = [
    {
      label: t("lore.split.stepRead", { defaultValue: "读取条目正文与特征" }),
      status: "done",
      meta: `${indexBody.length.toLocaleString()} ${t("lore.split.chars", { defaultValue: "字" })}${entity.facets.length > 0 ? ` · ${entity.facets.length} ${t("lore.facet.section", { defaultValue: "特征" })}` : ""}`,
    },
    {
      label: t("lore.split.stepDraft", { defaultValue: "拆解分组 · 起草特征与触发词" }),
      status: "active",
      // One tool call per piece, so this counts real submissions, not a guess.
      meta: [
        partial.core !== undefined
          ? t("lore.split.progressCore", { defaultValue: "概述已提交" })
          : null,
        partial.facets > 0
          ? t("lore.split.progressFacets", {
              count: partial.facets,
              defaultValue: `已提交 ${partial.facets} 个特征`,
            })
          : null,
      ].filter(Boolean).join(" · ") || undefined,
    },
    { label: t("lore.split.stepConfirm", { defaultValue: "交给你确认后写入条目目录" }), status: "pending" },
  ];

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
      // 1. Snapshot the original index.md AND every existing facet — the split
      //    replaces the whole facet set, so the author's text must be recoverable.
      const backupDir = `${projectPath}/.ai-writer/backups`;
      await makeDir(backupDir);
      const stamp = Date.now();
      await writeFile(`${backupDir}/${entity.category}-${entity.id}-index-${stamp}.md`, indexRaw);
      for (const f of entity.facets) {
        try {
          const raw = await readEntityFile(entity.dirPath, f.file);
          await writeFile(`${backupDir}/${entity.category}-${entity.id}-${f.file}-${stamp}.md`, raw);
        } catch { /* best-effort backup */ }
      }

      // 2. Remove the old facet files — the drafts below are the complete new set.
      for (const f of entity.facets) {
        try { await removeFile(`${entity.dirPath}/${f.file}`); } catch { /* already gone */ }
      }

      // 3. Facet files next: if anything fails mid-way the worst case is a
      //    few extra files — index.md is only rewritten once they all exist.
      for (const d of included) {
        await createFacetFile(entity.dirPath, {
          ...d.meta,
          title: d.meta.title.trim() || "未命名特征",
          keys: d.meta.keys.map((k) => k.trim()).filter(Boolean),
        }, d.content);
      }

      // 4. Rewrite index.md, preserving its frontmatter verbatim.
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

  // Block dismissal entirely while generating (matches the disabled close button);
  // otherwise prompt once there's a draft under review or typed guidance.
  const generating = phase === "generating";
  const dirty = phase === "review" || instruction.trim().length > 0;

  return (
    <ModalShell
      overlayClassName={styles.overlay}
      onClose={onClose}
      isDirty={dirty}
      closeOnBackdrop={false}
      closeOnEscape={!generating}
    >
      <div className={styles.panel}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <span className={styles.headerTitle}>
              {t("lore.split.title", { defaultValue: "拆分条目" })} · {entity.name}
            </span>
            <span className={styles.headerEntity}>
              {t("lore.split.statChip", {
                chars: indexBody.length.toLocaleString(),
                facets: entity.facets.length,
                defaultValue: `正文 ${indexBody.length.toLocaleString()} 字 · ${entity.facets.length} 特征`,
              })}
            </span>
            <span className={styles.headerHint}>
              {t("lore.split.reason", { defaultValue: "条目过长会稀释检索命中 · 建议拆分" })}
            </span>
          </div>
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
                {t("lore.split.planLabel", { defaultValue: "整理方案 · AI 建议" })}
                <RunStatusLine state="running" elapsedSec={elapsedSec}
                  model={models.find((m) => m.id === modelId)?.name} />
              </div>
              <LoreRunSteps steps={splitSteps} />
              <ThinkingPanel text={reasoning} running />
            </>
          )}

          {phase === "review" && (
            <>
              <div className={styles.sectionLabel}>
                {t("lore.split.planLabel", { defaultValue: "整理方案 · AI 建议" })}
                <RunStatusLine state="done" elapsedSec={elapsedSec} tokens={usageTokens} />
              </div>
              <ThinkingPanel text={reasoning} running={false} />
              {notes && <div className={styles.notes}>{notes}</div>}
              {coreMissing && (
                <div className={styles.error}>
                  <AlertTriangle size={12} />
                  {t("lore.split.coreMissingWarn", {
                    defaultValue: "AI 没有提交精简后的概述（可能是中途停止）。下面填的是原正文，直接应用会让内容重复一份——请先手动删掉已拆进特征的段落。",
                  })}
                </div>
              )}
              {entity.facets.length > 0 && (
                <div className={styles.error}>
                  <AlertTriangle size={12} />
                  {t("lore.split.replaceWarn", {
                    count: entity.facets.length,
                    defaultValue: `应用后将用下面的特征替换现有的 ${entity.facets.length} 个特征（原文件会先自动备份）`,
                  })}
                </div>
              )}
              <div className={styles.sectionLabel}>
                <span className={styles.swatch} style={{ background: "var(--lore-split-keep)" }} />
                {t("lore.split.coreLabel", { defaultValue: "保留 · 概述（index.md）" })}
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
                {t("lore.split.facetsLabel", { defaultValue: "拆出的特征（按需注入）" })}
                <span className={styles.tokenTag}>{included.length}/{drafts.length}</span>
              </div>
              <div className={styles.draftList}>
                {drafts.map((d, i) => (
                  <div key={i} className={`${styles.draftCard} ${d.include ? "" : styles.draftExcluded}`}>
                    <div className={styles.draftHead}>
                      <span
                        className={styles.swatch}
                        style={{ background: i % 2 === 0 ? "var(--lore-split-a)" : "var(--lore-split-b)" }}
                      />
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
                      <span className={styles.modeBadge}>
                        {t("lore.facet.modeAutoShort", { defaultValue: "自动" })}
                      </span>
                      {d.include && (
                        <span className={styles.draftNewTag}>
                          {t("lore.split.newTag", { defaultValue: "新特征" })}
                        </span>
                      )}
                      <span className={styles.tokenTag}>~{estTk(d.content.length)} tk</span>
                    </div>
                    {d.include && (
                      <>
                        <div className={styles.keysRow}>
                          <span className={styles.keysLabel}>
                            {t("lore.facet.fieldKeys", { defaultValue: "触发词" })}
                          </span>
                          <KeysEditor keys={d.meta.keys} onChange={(keys) => updateDraftMeta(i, { keys })} />
                        </div>
                        {d.meta.keys.length === 0 && (
                          <div className={styles.draftWarn}>
                            <AlertTriangle size={11} />
                            {t("lore.facet.keysEmptyWarn", { defaultValue: "自动模式下没有关键词，此特征永远不会被自动注入" })}
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
          <ModelPicker
            models={models}
            providers={providers}
            value={modelId}
            onChange={setModelId}
            disabled={phase === "generating"}
          />
          {phase === "input" && (
            <>
              <span className={styles.footerSpacer} />
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
            <>
              <span className={styles.footerSpacer} />
              <button className={styles.btn} onClick={handleCancelGenerate}>
                {t("lore.split.cancel", { defaultValue: "停止" })}
              </button>
            </>
          )}
          {phase === "review" && (
            <>
              <span className={styles.footerHint}>
                {t("lore.split.backupHint", { defaultValue: "执行后原条目瘦身为概述 · 全文自动备份一份" })}
              </span>
              <span className={styles.footerSpacer} />
              <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={handleGenerate} disabled={saving}>
                <RotateCw size={12} />
                {t("lore.split.regenerate", { defaultValue: "AI 重新分组" })}
              </button>
              <button className={styles.btn} onClick={() => setPhase("input")} disabled={saving}>
                <ArrowLeft size={12} />
                {t("lore.split.back", { defaultValue: "返回" })}
              </button>
              <button
                className={`${styles.btn} ${styles.btnPrimary}`}
                onClick={handleApply}
                disabled={!canApply}
              >
                {saving
                  ? t("lore.split.applying", { defaultValue: "应用中…" })
                  : t("lore.split.applyCount", {
                      count: included.length,
                      defaultValue: `执行拆分 · ${included.length} 个特征`,
                    })}
              </button>
            </>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
