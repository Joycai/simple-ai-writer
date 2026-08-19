import { useState, useRef, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { X, Sparkles, RotateCw, AlertTriangle } from "lucide-react";
import { useAiStore } from "../../stores/aiStore";
import { useProjectFiles, useProjectStore } from "../../stores/projectStore";
import { useLoreStore } from "../../stores/loreStore";
import { connOptions, resolveConn } from "../../lib/ai/conn";
import {
  readEntityFile, writeEntityFile, saveFacetFile, parseFacetMeta, createFacetFile,
  type LoreEntity, type FacetMeta,
} from "../../lib/lore";

type FacetMode = FacetMeta["mode"];
import { parseFrontmatter } from "../../lib/fs/markdown";
import { categoryLabel, findCategory } from "../../lib/profile";
import {
  collectAttachmentContext, buildUserContent, stripCodeFence,
  type AttachedItem,
} from "../../lib/lore/aiTask";
import { runLoreAgentTask } from "../../lib/agent/run";
import { LORE_IMPROVE_PRESET } from "../../lib/agent/presets";
import { appendAgentEventTo, type AgentEvent } from "../../lib/agent/events";
import { runStructuredTask } from "../../lib/agent/structured";
import type { ToolDefinition } from "../../lib/ai";
import { AgentLog } from "../ai/AgentLog";
import {
  LoreRunSteps, RunStatusLine, ThinkingPanel, estimateRunTokens, useRunClock, useRunTelemetry,
  type RunStep,
} from "./ai/LoreRunProgress";
import { ModelPicker } from "./ai/ModelPicker";
import { useImageDataUrl } from "./useImageDataUrl";
import { MarkdownTextarea } from "../common/MarkdownTextarea";
import { ModalShell } from "../common/ModalShell";
import { AttachmentTextarea } from "./ai/AttachmentTextarea";
import { loadApiKey } from "../../lib/keyStore";
import { Select } from "../common/Select";
import styles from "./LoreImproveModal.module.css";

interface Props {
  entity: LoreEntity;
  onClose: () => void;
}

export function LoreImproveModal({ entity, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const { projectPath } = useProjectStore();
  const { models, providers, activeModelId } = useAiStore();
  // 本次任务使用的模型 — 默认跟随全局设置，改动不写回全局 (设计稿 v4)。
  const [modelId, setModelId] = useState(activeModelId ?? "");
  const { index, scanProject } = useLoreStore();
  const avatarUrl = useImageDataUrl(entity.avatarPath);

  // Write target (设计稿 09 · 写入目标): "__index__" = the entity's index.md,
  // "__new__" = draft a brand-new facet (设计稿 17), else a facet filename.
  const INDEX = "__index__";
  const NEW = "__new__";
  const [target, setTarget] = useState<string>(INDEX);
  const isFacet = target !== INDEX && target !== NEW;
  const isNewFacet = target === NEW;
  const facetMetaRef = useRef<FacetMeta | null>(null);

  const [currentContent, setCurrentContent] = useState("");
  const [instruction, setInstruction] = useState("");
  // Result phase: false = highlighted read-only preview, true = raw textarea.
  const [editRaw, setEditRaw] = useState(false);
  const [attached, setAttached] = useState<AttachedItem[]>([]);
  const projectFiles = useProjectFiles();
  const [phase, setPhase] = useState<"input" | "generating" | "result">("input");
  const [output, setOutput] = useState("");
  const [agentLog, setAgentLog] = useState<AgentEvent[]>([]);
  // 新特征草稿的元字段 (只在 target === NEW 时使用)。
  const [draftTitle, setDraftTitle] = useState("");
  const [draftKeysText, setDraftKeysText] = useState("");
  const [draftMode, setDraftMode] = useState<FacetMode>("auto");
  const [structReasoning, setStructReasoning] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const elapsedSec = useRunClock(phase === "generating");
  const { usageTokens, onEvent: onRunEvent, reset: resetTelemetry } = useRunTelemetry();

  // Load the current target's content: the whole index.md, or a facet's body
  // (frontmatter stripped) with its meta stashed for a later frontmatter-safe
  // save. A new facet has no file yet — the pane starts empty.
  useEffect(() => {
    if (isNewFacet) {
      facetMetaRef.current = null;
      setCurrentContent("");
      return;
    }
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
  }, [entity.dirPath, target, isFacet, isNewFacet]);

  const facetTitle = entity.facets.find((f) => f.file === target)?.title ?? target;
  const otherEntities = Object.values(index).flat().filter((e) => e.id !== entity.id);

  // 状态行左侧的对照标签: `index.md · 对照` / `<facet 文件> · 对照` / `新特征 · 草稿`。
  const targetFileLabel = isNewFacet
    ? t("lore.improve.targetNewShort", { defaultValue: "新特征" })
    : isFacet ? target : "index.md";

  // 新特征起草的语义步骤 (设计稿 17)。
  const newFacetSteps: RunStep[] = [
    {
      label: t("lore.improve.stepCompare", { defaultValue: "读取条目，比对现有特征" }),
      status: "done",
      meta: `${entity.facets.length} ${t("lore.improve.facetsRead", { defaultValue: "特征已读" })}`,
    },
    { label: t("lore.improve.stepDraft", { defaultValue: "起草特征 · 生成触发词与注入方式" }), status: "active" },
    { label: t("lore.improve.stepConfirm", { defaultValue: "交给你确认后写入条目目录" }), status: "pending" },
  ];

  // Added-line detection for the before/after view: a trimmed output line the
  // current content doesn't contain reads as new. Line containment, not a real
  // diff — good enough to tint additions green (设计稿 03 diff 语汇).
  const diff = useMemo(() => {
    const cur = new Set(currentContent.split("\n").map((l) => l.trim()).filter(Boolean));
    const lines = output.split("\n");
    const added = lines.map((l) => l.trim().length > 0 && !cur.has(l.trim()));
    return { lines, added, count: added.filter(Boolean).length };
  }, [output, currentContent]);

  // ── Generate ───────────────────────────────────────────────────────────────
  const handleGenerate = async () => {
    const resolved = resolveConn(models, providers, modelId);
    if (!resolved.ok) { setError(resolved.error); return; }
    const { model, provider } = resolved;

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    setOutput("");
    setAgentLog([]);
    setStructReasoning("");
    resetTelemetry();
    setPhase("generating");

    try {
      const apiKey = (await loadApiKey(provider.id)) ?? "";
      const supportsImages = model.type === "multimodal";
      const { loreRefs, textRefs, images } = await collectAttachmentContext(attached, supportsImages);

      // 新特征 (设计稿 17): one structured pass drafting title + trigger keys +
      // injection mode + body. Structured output can't browse (see structured.ts),
      // so the index body and facet inventory ride in as context instead.
      if (isNewFacet) {
        const idxBody = await readEntityFile(entity.dirPath, "index.md")
          .then((raw) => parseFrontmatter(raw).content)
          .catch(() => "");
        const facetTool: ToolDefinition = {
          type: "function",
          function: {
            name: "draft_lore_facet",
            description:
              "Draft ONE new facet (title, trigger keys, injection mode, markdown body) for the knowledge-base entity. Never duplicates existing facets.",
            parameters: {
              type: "object",
              properties: {
                title: { type: "string", description: "Short facet name" },
                keys: {
                  type: "array",
                  items: { type: "string" },
                  description: "2-6 concise trigger keywords likely to appear in prose when this facet is relevant",
                },
                mode: {
                  type: "string",
                  enum: ["auto", "always", "manual"],
                  description: "auto = inject when entity + a key match (default); always = inject whenever the entity matches; manual = only when pinned",
                },
                body: { type: "string", description: "The facet's markdown body" },
              },
              required: ["title", "keys", "mode", "body"],
            },
          },
        };
        const userText = [
          `ENTITY: ${entity.name}`,
          entity.summary ? `SUMMARY: ${entity.summary}` : "",
          `INDEX BODY:\n${idxBody.trim() || "(empty)"}`,
          entity.facets.length > 0
            ? `EXISTING FACETS (do NOT duplicate):\n${entity.facets
                .map((f) => `- ${f.title}${f.keys.length ? ` (keys: ${f.keys.join(", ")})` : ""}`)
                .join("\n")}`
            : "",
          loreRefs.length > 0 ? "\nREFERENCED LORE ENTRIES:\n" + loreRefs.join("\n\n") : "",
          textRefs.length > 0 ? "\nREFERENCED FILES:\n" + textRefs.join("\n\n") : "",
          `\nUSER INSTRUCTION:\n${instruction.trim() || "Draft the most useful missing facet for this entity."}`,
        ].filter(Boolean).join("\n");

        const toolArgs = await runStructuredTask({
          ...connOptions({ provider, model, apiKey }),
          systemPrompt: [
            "You are drafting ONE new facet for a knowledge-base entity.",
            "A facet is an independently-injectable aspect of the entity (an outfit, a pricing policy, a backstory arc…).",
            "Prefer 'auto' mode unless the material is relevant to almost every mention of the entity.",
            "Write the body in the same language as the entity's own text.",
          ].join("\n"),
          toolInstruction: "Call the draft_lore_facet tool exactly once with the drafted facet.",
          jsonInstruction:
            'Respond with ONLY a JSON object — no markdown fences, no prose — with exactly these keys: {"title": string, "keys": string[], "mode": "auto"|"always"|"manual", "body": string}.',
          outputTool: facetTool,
          userContent: buildUserContent(userText, images),
          signal: ctrl.signal,
          onReasoning: setStructReasoning,
        });
        const parsed = JSON.parse(toolArgs) as {
          title?: string; keys?: string[]; mode?: string; body?: string;
        };
        setDraftTitle(typeof parsed.title === "string" ? parsed.title.trim() : "");
        setDraftKeysText(Array.isArray(parsed.keys)
          ? parsed.keys.filter((k): k is string => typeof k === "string" && k.trim().length > 0).join(", ")
          : "");
        setDraftMode(parsed.mode === "always" || parsed.mode === "manual" ? parsed.mode : "auto");
        setOutput(typeof parsed.body === "string" ? parsed.body : "");
        setPhase("result");
        return;
      }

      const toolHint =
        "You may call list_lore_entities / read_lore_entity first to consult related lore for consistency.";
      const systemPrompt = isFacet
        ? [
            "You are a knowledge-base writing assistant improving ONE facet of a knowledge-base entry.",
            toolHint,
            "Return the COMPLETE updated facet body as rich markdown prose.",
            "Output ONLY the body — no YAML frontmatter, no code fences, no explanation.",
          ].join("\n")
        : [
            "You are a knowledge-base writing assistant improving an existing entry document.",
            toolHint,
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

      await runLoreAgentTask({
        model,
        provider,
        apiKey,
        preset: LORE_IMPROVE_PRESET,
        systemPrompt,
        userContent: buildUserContent(textContent, images),
        projectPath: projectPath ?? "",
        loreIndex: index,
        signal: ctrl.signal,
        onText: setOutput,
        onEvent: (e) => {
          onRunEvent(e); // elapsed/token telemetry for the status line
          setAgentLog((prev) => appendAgentEventTo(prev, e));
        },
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
      if (isNewFacet) {
        const keys = draftKeysText.split(/[,，\n]/).map((k) => k.trim()).filter(Boolean);
        await createFacetFile(entity.dirPath, {
          title: draftTitle.trim() || t("lore.facet.ai.untitled", { defaultValue: "未命名特征" }),
          keys,
          group: null,
          priority: 0,
          mode: draftMode,
        }, body);
        await scanProject(projectPath);
        onClose();
        return;
      }
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
      <div className={`${styles.panel} ${styles.panelWide}`}>

        {/* ── Header: 头像 + 「名 · 改写」 + 斜体元数据 ── */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            {avatarUrl
              ? <img src={avatarUrl} className={styles.headerAvatar} alt={entity.name} />
              : <div className={styles.headerAvatarPlaceholder}>{entity.name.charAt(0)}</div>}
            <div>
              <div className={styles.headerName}>
                {entity.name} · {t("lore.improve.title", { defaultValue: "更新条目" })}
              </div>
              <div className={styles.headerSub}>
                {[
                  (() => { const c = findCategory(entity.category); return c ? categoryLabel(c, isZh) : entity.category; })(),
                  entity.aliases.slice(0, 3).join(" · "),
                  entity.summary,
                ].filter(Boolean).join(" · ")}
              </div>
            </div>
          </div>
          <button className={styles.closeBtn} onClick={onClose}><X size={14} /></button>
        </div>

        {/* ── Body: 左 GOAL 栏 + 右对照区 ── */}
        <div className={styles.improveCols}>

          <div className={styles.goalRail}>
            {/* 写入目标 (设计稿 09): 主词条 / 各特征 / + 生成新特征 */}
            <div>
              <div className={styles.label} style={{ marginBottom: 10 }}>
                {t("lore.improve.targetLabel", { defaultValue: "写入目标" })}
              </div>
              <div className={styles.goalList}>
                <button
                  className={`${styles.targetItem} ${target === INDEX ? styles.targetItemActive : ""}`}
                  disabled={phase === "generating"}
                  onClick={() => { setTarget(INDEX); setOutput(""); setPhase("input"); }}
                >
                  {t("lore.improve.targetIndex", { defaultValue: "主词条 · 概要（index.md）" })}
                </button>
                {entity.facets.map((f) => (
                  <button
                    key={f.file}
                    className={`${styles.targetItem} ${target === f.file ? styles.targetItemActive : ""}`}
                    disabled={phase === "generating"}
                    onClick={() => { setTarget(f.file); setOutput(""); setPhase("input"); }}
                  >
                    ◈ {f.title}
                  </button>
                ))}
                <button
                  className={`${styles.targetItem} ${styles.targetItemNew} ${isNewFacet ? styles.targetItemActive : ""}`}
                  disabled={phase === "generating"}
                  onClick={() => { setTarget(NEW); setOutput(""); setPhase("input"); }}
                >
                  + {t("lore.improve.targetNew", { defaultValue: "生成新特征" })}
                </button>
              </div>
            </div>

            <div className={styles.goalHint}>
              {isNewFacet
                ? t("lore.improve.scopeHintNew", {
                    defaultValue: "起草一条新特征：触发词与注入方式一并生成，入库前可改。",
                  })
                : t("lore.improve.scopeHint", {
                    defaultValue: "只改选中的一个文件；其余特征与配图不动。",
                  })}
            </div>
          </div>

          <div className={styles.improveMain}>
            <div className={styles.improveMainScroll}>

              <div className={styles.diffHead}>
                <span className={styles.diffHeadLabel}>
                  {targetFileLabel} · {isNewFacet
                    ? t("lore.improve.draftHead", { defaultValue: "草稿" })
                    : t("lore.improve.compareHead", { defaultValue: "对照" })}
                </span>
                {phase === "generating" && (
                  <RunStatusLine state="running" elapsedSec={elapsedSec}
                    model={models.find((m) => m.id === modelId)?.name} />
                )}
                {phase === "result" && (
                  <RunStatusLine
                    state="done"
                    elapsedSec={elapsedSec}
                    tokens={usageTokens ?? (isNewFacet ? estimateRunTokens(output, structReasoning) : null)}
                  />
                )}
                <span style={{ flex: 1 }} />
                {phase === "result" && (
                  <button className={styles.diffToggle} onClick={handleGenerate} disabled={!modelId}>
                    ⟳ {t("lore.improve.regenerate")}
                  </button>
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
                  rows={3}
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

              {/* Execution log (tool consultations, rounds) — agent flows only */}
              {agentLog.length > 0 && (phase === "generating" || phase === "result") && (
                <div className={styles.section}>
                  <AgentLog log={agentLog} isRunning={phase === "generating"} />
                </div>
              )}

              {/* 新特征: 步骤列 + 思维链 + 草稿条 (设计稿 17) */}
              {isNewFacet && phase === "generating" && (
                <>
                  <LoreRunSteps steps={newFacetSteps} />
                  <ThinkingPanel text={structReasoning} running />
                </>
              )}
              {isNewFacet && phase === "result" && (
                <>
                  <ThinkingPanel text={structReasoning} running={false} />
                  <div className={styles.draftStrip}>
                    <span className={styles.draftStripMark}>◈</span>
                    <input
                      className={styles.draftTitleInput}
                      value={draftTitle}
                      onChange={(e) => setDraftTitle(e.target.value)}
                      placeholder={t("lore.facet.titlePlaceholder", { defaultValue: "如：战甲形象" })}
                    />
                    <Select
                      className={`${styles.modelSelect} ${styles.draftModeSelect}`}
                      value={draftMode}
                      onChange={(v) => setDraftMode(v as FacetMode)}
                      options={[
                        { value: "auto", label: t("lore.facet.modeAutoShort", { defaultValue: "自动" }) },
                        { value: "always", label: t("lore.facet.modeAlwaysShort", { defaultValue: "常驻" }) },
                        { value: "manual", label: t("lore.facet.modeManualShort", { defaultValue: "手动" }) },
                      ]}
                      ariaLabel={t("lore.facet.fieldMode", { defaultValue: "注入方式" })}
                    />
                  </div>
                  <div className={styles.section}>
                    <label className={styles.label}>
                      {t("lore.facet.fieldKeys", { defaultValue: "触发词" })}
                      <span className={styles.hint}> · {t("lore.improve.keysHint", { defaultValue: "逗号分隔" })}</span>
                    </label>
                    <input
                      className={styles.draftKeysInput}
                      value={draftKeysText}
                      onChange={(e) => setDraftKeysText(e.target.value)}
                    />
                  </div>
                </>
              )}

              {/* 新特征正文 — 没有旧文可对照，单栏编辑 */}
              {isNewFacet ? (
                (phase === "generating" || phase === "result") && (
                  <div className={styles.section}>
                    <label className={styles.label}>{t("lore.facet.fieldBody", { defaultValue: "正文" })}</label>
                    <MarkdownTextarea
                      className={`${styles.textarea} ${styles.outputArea}`}
                      value={output}
                      onChange={(e) => setOutput(e.target.value)}
                      rows={12}
                      readOnly={phase === "generating"}
                      spellCheck={false}
                    />
                  </div>
                )
              ) : (
              <div className={styles.diffGrid}>
                <div className={styles.diffPane}>
                  <div className={styles.paneHead}>
                    <span className={styles.paneLabel}>{isZh ? "现有" : "current"}</span>
                    <span style={{ flex: 1 }} />
                    <span className={styles.paneMeta}>
                      {t("lore.improve.charCount", { count: currentContent.length })}
                    </span>
                  </div>
                  <pre className={styles.diffPre}>{currentContent || "(empty)"}</pre>
                </div>
                <div className={`${styles.diffPane} ${styles.diffPaneAfter}`}>
                  <div className={styles.paneHead}>
                    <span className={`${styles.paneLabel} ${styles.paneLabelAccent}`}>
                      {isZh ? "建议 · draft" : "suggested · draft"}
                    </span>
                    <span style={{ flex: 1 }} />
                    {phase === "result" && diff.count > 0 && (
                      <span className={styles.paneMetaAdd}>+ {diff.count} {isZh ? "行" : "lines"}</span>
                    )}
                    {phase === "result" && (
                      <button className={styles.diffToggle} onClick={() => setEditRaw((v) => !v)}>
                        {editRaw
                          ? (isZh ? "预览" : "Preview")
                          : (isZh ? "编辑" : "Edit")}
                      </button>
                    )}
                  </div>
                  {phase === "result" && !editRaw ? (
                    <pre className={`${styles.diffPre} ${styles.diffPreAfter}`}>
                      {diff.lines.map((l, i) => (
                        <span key={i} className={diff.added[i] ? styles.addedLine : undefined}>
                          {l}
                          {"\n"}
                        </span>
                      ))}
                    </pre>
                  ) : (phase === "generating" || phase === "result") ? (
                    <MarkdownTextarea
                      className={`${styles.textarea} ${styles.outputArea}`}
                      value={output}
                      onChange={(e) => setOutput(e.target.value)}
                      rows={12}
                      readOnly={phase === "generating"}
                      spellCheck={false}
                    />
                  ) : (
                    <pre className={styles.diffPre} style={{ fontStyle: "italic" }}>
                      {isZh ? "生成后在此对照建议稿" : "The suggested draft appears here"}
                    </pre>
                  )}
                </div>
              </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Footer ── */}
        <div className={styles.footer}>
          <div className={styles.footerLeft}>
            <ModelPicker
              models={multimodalModels}
              providers={providers}
              value={modelId}
              onChange={setModelId}
              disabled={phase === "generating"}
            />
            <span className={styles.footerNote}>
              {t("lore.improve.footerNote", { defaultValue: "应用后会覆盖当前内容 · 请先审阅建议稿" })}
            </span>
          </div>
          <div className={styles.footerRight}>
            <button className={styles.btnGhost} onClick={onClose}>{t("lore.improve.cancel")}</button>
            {phase === "input" && (
              <button className={styles.btnPrimary} onClick={handleGenerate} disabled={!modelId}>
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
                <button className={styles.btnSecondary} onClick={handleGenerate} disabled={!modelId}>
                  <RotateCw size={12} /> {t("lore.improve.regenerate")}
                </button>
                <button className={styles.btnPrimary} onClick={handleApply} disabled={saving || !output.trim()}>
                  {saving
                    ? t("lore.improve.applying")
                    : isNewFacet
                      ? t("lore.improve.applyNew", { defaultValue: "新建特征" })
                      : t("lore.improve.applyTo", { file: targetFileLabel, defaultValue: `应用到 ${targetFileLabel}` })}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
