import { useState, useRef, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { X, Sparkles, RotateCw, AlertTriangle } from "lucide-react";
import { useAiStore } from "../../stores/aiStore";
import { useProjectStore } from "../../stores/projectStore";
import { useLoreStore } from "../../stores/loreStore";
import { resolveConn } from "../../lib/ai/conn";
import {
  readEntityFile, writeEntityFile, saveFacetFile, parseFacetMeta,
  type LoreEntity, type FacetMeta,
} from "../../lib/lore";
import { parseFrontmatter } from "../../lib/fs/markdown";
import { categoryLabel, findCategory } from "../../lib/profile";
import {
  collectAttachmentContext, buildUserContent, stripCodeFence,
  type AttachedItem,
} from "../../lib/lore/aiTask";
import { runLoreAgentTask } from "../../lib/agent/run";
import { LORE_IMPROVE_PRESET } from "../../lib/agent/presets";
import { appendAgentEventTo, type AgentEvent } from "../../lib/agent/events";
import { AgentLog } from "../ai/AgentLog";
import { useImageDataUrl } from "./useImageDataUrl";
import { MarkdownTextarea } from "../common/MarkdownTextarea";
import { ModalShell } from "../common/ModalShell";
import { AttachmentTextarea } from "./ai/AttachmentTextarea";
import { scanProjectFiles, type ProjectFile } from "../../lib/fs/images";
import { loadApiKey } from "../../lib/keyStore";
import { Select } from "../common/Select";
import styles from "./LoreImproveModal.module.css";

interface Props {
  entity: LoreEntity;
  onClose: () => void;
}

/** 改写目标预设 (设计稿 03 GOAL 单选) — 每项只是把一条现成指令填进指令框，
    作者仍可自由改写；不携带任何检索/上下文行为。 */
const GOALS = [
  { id: "detail", zh: "补全细节", en: "Fill in details",
    insZh: "补全这条设定的细节：扩展背景、外观与具体描写，保持既有事实不变。",
    insEn: "Fill in the details of this entry: expand background, appearance and concrete description without changing established facts." },
  { id: "voice", zh: "统一口吻", en: "Unify the voice",
    insZh: "统一全文口吻与叙述风格，修正前后不一致的措辞。",
    insEn: "Unify the narrative voice across the entry and fix inconsistent wording." },
  { id: "tighten", zh: "紧凑改写", en: "Tighten prose",
    insZh: "在不丢失信息的前提下压缩行文，使内容更紧凑。",
    insEn: "Compress the prose without losing information." },
  { id: "conflict", zh: "增加冲突点", en: "Add tension",
    insZh: "为这条设定增加可用于叙事的冲突点或张力。",
    insEn: "Add narrative tension or points of conflict to this entry." },
  { id: "sample", zh: "添加口吻样本", en: "Add voice samples",
    insZh: "为该条目补充口吻样本（引语），体现说话习惯。",
    insEn: "Add voice samples (quotes) that capture how this character speaks." },
] as const;

export function LoreImproveModal({ entity, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
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
  const [instruction, setInstruction] = useState("");
  const [goal, setGoal] = useState<string | null>(null);
  // Result phase: false = highlighted read-only preview, true = raw textarea.
  const [editRaw, setEditRaw] = useState(false);
  const [attached, setAttached] = useState<AttachedItem[]>([]);
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [phase, setPhase] = useState<"input" | "generating" | "result">("input");
  const [output, setOutput] = useState("");
  const [agentLog, setAgentLog] = useState<AgentEvent[]>([]);
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
    const resolved = resolveConn(models, providers, activeModelId);
    if (!resolved.ok) { setError(resolved.error); return; }
    const { model, provider } = resolved;

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    setOutput("");
    setAgentLog([]);
    setPhase("generating");

    try {
      const apiKey = (await loadApiKey(provider.id)) ?? "";
      const supportsImages = model.type === "multimodal";
      const { loreRefs, textRefs, images } = await collectAttachmentContext(attached, supportsImages);

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
        onEvent: (e) => setAgentLog((prev) => appendAgentEventTo(prev, e)),
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
      <div className={`${styles.panel} ${styles.panelWide}`}>

        {/* ── Header: 头像 + 「名 · 改写」 + 斜体元数据 ── */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            {avatarUrl
              ? <img src={avatarUrl} className={styles.headerAvatar} alt={entity.name} />
              : <div className={styles.headerAvatarPlaceholder}>{entity.name.charAt(0)}</div>}
            <div>
              <div className={styles.headerName}>
                {entity.name} · {isZh ? "改写" : "Improve"}
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
          <Select
            className={styles.modelSelect}
            value={activeModelId ?? ""}
            onChange={(v) => setActiveModel(v)}
            options={[
              { value: "", label: t("lore.generator.selectModel") },
              ...multimodalModels.map((m) => ({
                value: m.id,
                label: `${providers.find((p) => p.id === m.providerId)?.name ?? ""} / ${m.name}`,
              })),
            ]}
            ariaLabel={t("lore.generator.selectModel")}
          />
          <button className={styles.closeBtn} onClick={onClose}><X size={14} /></button>
        </div>

        {/* ── Body: 左 GOAL 栏 + 右对照区 ── */}
        <div className={styles.improveCols}>

          <div className={styles.goalRail}>
            <div>
              <div className={styles.label} style={{ marginBottom: 10 }}>
                {isZh ? "goal · 改写目标" : "goal"}
              </div>
              <div className={styles.goalList}>
                {GOALS.map((g) => (
                  <button
                    key={g.id}
                    className={`${styles.goalItem} ${goal === g.id ? styles.goalItemActive : ""}`}
                    disabled={phase === "generating"}
                    onClick={() => {
                      setGoal(g.id);
                      setInstruction(isZh ? g.insZh : g.insEn);
                    }}
                  >
                    <span className={styles.goalDot} />
                    {isZh ? g.zh : g.en}
                  </button>
                ))}
              </div>
            </div>

            {/* Write target — only meaningful once the entity has facets */}
            {entity.facets.length > 0 && (
              <div>
                <div className={styles.label} style={{ marginBottom: 10 }}>
                  {isZh ? "target · 写入目标" : "target"}
                </div>
                <Select
                  className={`${styles.modelSelect} ${styles.targetSelect}`}
                  value={target}
                  disabled={phase === "generating"}
                  onChange={(v) => { setTarget(v); setOutput(""); setPhase("input"); }}
                  options={[
                    { value: INDEX, label: t("lore.improve.targetIndex", { defaultValue: "整体条目（index.md）" }) },
                    ...entity.facets.map((f) => ({
                      value: f.file,
                      label: `${t("lore.improve.targetFacetPrefix", { defaultValue: "特征" })}：${f.title}`,
                    })),
                  ]}
                />
              </div>
            )}

            <div className={styles.goalHint}>
              {t("lore.improve.suggestOnlyHint", {
                defaultValue: "AI 仅会建议；应用前可在右侧继续编辑结果。",
              })}
            </div>
          </div>

          <div className={styles.improveMain}>
            <div className={styles.improveMainScroll}>

              <div className={styles.diffHead}>
                <span className={styles.diffHeadLabel}>
                  {isZh ? "before / after · 对照" : "before / after"}
                </span>
                {phase === "generating" && (
                  <span className={styles.diffStatus}>{t("lore.improve.generating")}…</span>
                )}
                {phase === "result" && (
                  <span className={styles.diffStatus}>
                    <span className={styles.diffStatusDot} />
                    {t("lore.generator.completed")}
                  </span>
                )}
                <span style={{ flex: 1 }} />
                {phase === "result" && (
                  <button className={styles.diffToggle} onClick={handleGenerate} disabled={!activeModelId}>
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

              {/* Execution log (tool consultations, rounds) */}
              {agentLog.length > 0 && (phase === "generating" || phase === "result") && (
                <div className={styles.section}>
                  <AgentLog log={agentLog} isRunning={phase === "generating"} />
                </div>
              )}

              {/* Before / after panes */}
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
            </div>
          </div>
        </div>

        {/* ── Footer ── */}
        <div className={styles.footer}>
          <span className={styles.footerNote}>
            {t("lore.improve.footerNote", { defaultValue: "应用后会覆盖当前内容 · 请先审阅建议稿" })}
          </span>
          <div className={styles.footerRight}>
            <button className={styles.btnGhost} onClick={onClose}>{t("lore.improve.cancel")}</button>
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
