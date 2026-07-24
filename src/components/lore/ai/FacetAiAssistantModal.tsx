/**
 * AI assistant scoped to a SINGLE facet, launched from FacetEditModal.
 *
 * Three tasks, all built on the shared lore AI engine (`lib/lore/aiTask`) and
 * the @-mention composer, so images + referenced lore/files + intent all work:
 *   - append      → expand the facet body with extra material
 *   - restructure → tidy formatting/ordering only, no new facts
 *   - keys        → propose trigger keywords from the body
 *
 * It never touches disk. "Apply" hands a patch (body and/or keys) back to the
 * edit form, which the author reviews and saves through the normal flow — so it
 * works even on an unsaved / brand-new facet.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Sparkles, RotateCw, AlertTriangle, PlusCircle, Wand2, Tags } from "lucide-react";
import { useAiStore } from "../../../stores/aiStore";
import { useProjectStore } from "../../../stores/projectStore";
import { useLoreStore } from "../../../stores/loreStore";
import type { LoreEntity } from "../../../lib/lore";
import {
  resolveModel, collectAttachmentContext, buildUserContent, stripCodeFence, streamLoreTask,
  type AttachedItem,
} from "../../../lib/lore/aiTask";
import { scanProjectFiles, type ProjectFile } from "../../../lib/fs/images";
import { loadApiKey } from "../../../lib/keyStore";
import { MarkdownTextarea } from "../../common/MarkdownTextarea";
import { ModalShell } from "../../common/ModalShell";
import { AttachmentTextarea } from "./AttachmentTextarea";
import styles from "../LoreImproveModal.module.css";
import task from "./FacetAiAssistantModal.module.css";

type TaskKind = "append" | "restructure" | "keys";

interface Props {
  entity: LoreEntity;
  /** Live form values (in-memory, may be unsaved). */
  facetTitle: string;
  facetKeys: string[];
  facetBody: string;
  /** Fill the result back into the edit form. */
  onApply: (patch: { body?: string; keys?: string[] }) => void;
  onClose: () => void;
}

const SYSTEM_PROMPTS: Record<TaskKind, string> = {
  append: [
    "You are a lore assistant expanding ONE facet of a lore entity.",
    "Write ONLY the NEW markdown content to append to the facet body, based on the user's additional material (text and any attached images). Do NOT repeat or restate existing content.",
    "Return ONLY that new markdown — no YAML frontmatter, no code fences, no explanation.",
  ].join("\n"),
  restructure: [
    "You are a lore assistant tidying ONE facet of a lore entity.",
    "Reorganize the ordering and clean up the formatting of the facet body for clarity and consistency. Do NOT add or remove any facts.",
    "Return ONLY the COMPLETE reorganized facet body as markdown — no YAML frontmatter, no code fences, no explanation.",
  ].join("\n"),
  keys: [
    "You are a lore assistant choosing trigger keywords for ONE facet of a lore entity.",
    "Trigger keywords are concise terms likely to appear in story prose when this facet becomes relevant (names, objects, concepts, places).",
    "Return ONLY a comma-separated list of 3–10 keywords — no numbering, no explanation, no other text.",
  ].join("\n"),
};

/** Split a comma / newline / Chinese-comma separated list into unique keywords. */
function parseKeywords(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of stripCodeFence(raw).split(/[,，\n]/)) {
    const v = part.trim();
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

export function FacetAiAssistantModal({
  entity, facetTitle, facetKeys, facetBody, onApply, onClose,
}: Props) {
  const { t } = useTranslation();
  const { projectPath } = useProjectStore();
  const { models, providers, activeModelId, setActiveModel } = useAiStore();
  const index = useLoreStore((s) => s.index);

  const [kind, setKind] = useState<TaskKind>("append");
  const [instruction, setInstruction] = useState("");
  const [attached, setAttached] = useState<AttachedItem[]>([]);
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [phase, setPhase] = useState<"input" | "generating" | "result">("input");
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (projectPath) scanProjectFiles(projectPath).then(setProjectFiles).catch(() => {});
  }, [projectPath]);

  const otherEntities = Object.values(index).flat().filter((e) => e.id !== entity.id);
  const outputKind: "body" | "keys" = kind === "keys" ? "keys" : "body";

  const TASK_META: { kind: TaskKind; name: string; desc: string; icon: React.ReactNode }[] = [
    { kind: "append",      icon: <PlusCircle size={13} />, name: t("lore.facet.ai.appendName", { defaultValue: "追加内容" }),   desc: t("lore.facet.ai.appendDesc", { defaultValue: "结合额外资料/图片补充这个特征" }) },
    { kind: "restructure", icon: <Wand2 size={13} />,      name: t("lore.facet.ai.tidyName", { defaultValue: "整理结构" }),     desc: t("lore.facet.ai.tidyDesc", { defaultValue: "只调整格式与顺序，不改事实" }) },
    { kind: "keys",        icon: <Tags size={13} />,       name: t("lore.facet.ai.keysName", { defaultValue: "更新触发词" }),   desc: t("lore.facet.ai.keysDesc", { defaultValue: "根据正文重新建议触发关键词" }) },
  ];

  const selectTask = (next: TaskKind) => {
    if (next === kind) return;
    setKind(next);
    setOutput("");
    setError(null);
    setPhase("input");
  };

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

      const defaultInstruction = kind === "append"
        ? "Expand this facet with more concrete detail."
        : kind === "restructure"
          ? "Tidy the structure and formatting."
          : "Suggest trigger keywords for this facet.";

      const textContent = [
        `ENTITY: ${entity.name}`,
        entity.summary ? `ENTITY SUMMARY: ${entity.summary}` : "",
        `FACET: ${facetTitle.trim() || "(untitled)"}`,
        `CURRENT TRIGGER KEYWORDS: ${facetKeys.length ? facetKeys.join(", ") : "(none)"}`,
        `CURRENT FACET BODY:\n${facetBody.trim() || "(empty)"}`,
        loreRefs.length > 0 ? "\nREFERENCED LORE ENTRIES:\n" + loreRefs.join("\n\n") : "",
        textRefs.length > 0 ? "\nREFERENCED FILES:\n" + textRefs.join("\n\n") : "",
        `\nUSER INSTRUCTION:\n${instruction.trim() || defaultInstruction}`,
      ].filter(Boolean).join("\n");

      await streamLoreTask({
        model,
        provider,
        apiKey,
        systemPrompt: SYSTEM_PROMPTS[kind],
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

  const handleApply = () => {
    if (!output.trim()) return;
    if (kind === "keys") {
      onApply({ keys: parseKeywords(output) });
    } else if (kind === "append") {
      // Preserve existing body verbatim; the model returned only the addition.
      const addition = stripCodeFence(output);
      const base = facetBody.replace(/\s+$/, "");
      onApply({ body: base ? `${base}\n\n${addition}` : addition });
    } else {
      onApply({ body: stripCodeFence(output) });
    }
    onClose();
  };

  const multimodalModels = models.filter((m) => m.type === "multimodal" || m.type === "text");

  const dirty = phase !== "input" || instruction.trim().length > 0 || attached.length > 0;

  return (
    <ModalShell overlayClassName={styles.overlay} onClose={onClose} isDirty={dirty} closeOnBackdrop={false}>
      <div className={styles.panel}>

        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <div className={styles.headerAvatarPlaceholder}><Sparkles size={16} strokeWidth={1.5} /></div>
            <div>
              <div className={styles.headerName}>{t("lore.facet.ai.title", { defaultValue: "AI 助手" })}</div>
              <div className={styles.headerSub}>{facetTitle.trim() || t("lore.facet.ai.untitled", { defaultValue: "未命名特征" })}</div>
            </div>
          </div>
          <select
            className={styles.modelSelect}
            value={activeModelId ?? ""}
            onChange={(e) => setActiveModel(e.target.value)}
          >
            <option value="">{t("lore.generator.selectModel", { defaultValue: "选择模型" })}</option>
            {multimodalModels.map((m) => {
              const pname = providers.find((p) => p.id === m.providerId)?.name ?? "";
              return <option key={m.id} value={m.id}>{pname} / {m.name}</option>;
            })}
          </select>
          <button className={styles.closeBtn} onClick={onClose}><X size={16} /></button>
        </div>

        {/* Body */}
        <div className={styles.body}>
          {/* Task selector */}
          <div className={task.tasks}>
            {TASK_META.map((tm) => (
              <button
                key={tm.kind}
                className={`${task.taskBtn} ${kind === tm.kind ? task.taskBtnActive : ""}`}
                onClick={() => selectTask(tm.kind)}
              >
                <span className={task.taskName}>{tm.icon}{tm.name}</span>
                <span className={task.taskDesc}>{tm.desc}</span>
              </button>
            ))}
          </div>

          {/* Intent + attachments */}
          <div className={styles.section}>
            <label className={styles.label}>
              {t("lore.facet.ai.intentLabel", { defaultValue: "补充说明 / 意图" })}
              <span className={styles.hint}> · {t("lore.improve.atHint", { defaultValue: "输入 @ 引用图片或其他条目" })}</span>
            </label>
            <AttachmentTextarea
              instruction={instruction}
              onInstructionChange={setInstruction}
              attached={attached}
              onAttachedChange={setAttached}
              entities={otherEntities}
              projectFiles={projectFiles}
              disabled={phase === "generating"}
              rows={3}
              placeholder={t("lore.facet.ai.intentPlaceholder", { defaultValue: "例如：根据附图补充服装细节；把材质和颜色分开写…" })}
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
                {phase === "generating"
                  ? t("lore.improve.generating", { defaultValue: "生成中…" })
                  : kind === "keys"
                    ? t("lore.facet.ai.keysResultLabel", { defaultValue: "建议关键词（逗号分隔，可编辑）" })
                    : kind === "append"
                      ? t("lore.facet.ai.appendResultLabel", { defaultValue: "将追加到正文的内容（可编辑）" })
                      : t("lore.facet.ai.bodyResultLabel", { defaultValue: "结果（应用前可编辑）" })}
              </label>
              <MarkdownTextarea
                className={`${styles.textarea} ${styles.outputArea}`}
                value={output}
                onChange={(e) => setOutput(e.target.value)}
                rows={outputKind === "keys" ? 3 : 14}
                readOnly={phase === "generating"}
                spellCheck={false}
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          <button className={styles.btnSecondary} onClick={onClose}>
            {t("common.cancel", { defaultValue: "取消" })}
          </button>
          <div className={styles.footerRight}>
            {phase === "input" && (
              <button className={styles.btnPrimary} onClick={handleGenerate} disabled={!activeModelId}>
                <Sparkles size={13} /> {t("lore.facet.ai.generate", { defaultValue: "生成" })}
              </button>
            )}
            {phase === "generating" && (
              <button className={styles.btnAbort}
                onClick={() => { abortRef.current?.abort(); setPhase(output ? "result" : "input"); }}>
                {t("lore.improve.stop", { defaultValue: "停止" })}
              </button>
            )}
            {phase === "result" && (
              <>
                <button className={styles.btnSecondary} onClick={handleGenerate} disabled={!activeModelId}>
                  <RotateCw size={12} /> {t("lore.improve.regenerate", { defaultValue: "重新生成" })}
                </button>
                <button className={styles.btnPrimary} onClick={handleApply} disabled={!output.trim()}>
                  {kind === "keys"
                    ? t("lore.facet.ai.applyKeys", { defaultValue: "应用关键词" })
                    : kind === "append"
                      ? t("lore.facet.ai.applyAppend", { defaultValue: "追加到正文" })
                      : t("lore.facet.ai.applyBody", { defaultValue: "应用到正文" })}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
