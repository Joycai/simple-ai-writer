import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { X, Sparkles, RotateCw, AlertTriangle, Check } from "lucide-react";
import { useAiStore } from "../../stores/aiStore";
import { useProjectStore } from "../../stores/projectStore";
import { useLoreStore } from "../../stores/loreStore";
import { connOptions } from "../../lib/ai/conn";
import {
  assignableCategories, readEntityFile, saveEntityMetaAndBody,
  type CategoryId, type LoreEntity,
} from "../../lib/lore";
import { categoryLabel, findCategory, loreCategoryIds } from "../../lib/profile";
import { useImageDataUrl } from "./useImageDataUrl";
import { MarkdownTextarea } from "../common/MarkdownTextarea";
import { ModalShell } from "../common/ModalShell";
import { parseFrontmatter } from "../../lib/fs/markdown";
import { loadApiKey } from "../../lib/keyStore";
import { imageForModel } from "../../lib/image/normalize";
import { useImeGuard } from "../../lib/ime";
import { runStructuredTask } from "../../lib/agent/structured";
import type { ToolDefinition } from "../../lib/ai";
import {
  LoreRunSteps, RunStatusLine, ThinkingPanel, estimateRunTokens, useRunClock,
  type RunStep,
} from "./ai/LoreRunProgress";
import { ModelPicker } from "./ai/ModelPicker";
import { Select } from "../common/Select";
import styles from "./LoreImproveModal.module.css";
import extra from "./LoreMetaImproveModal.module.css";
import { baseName } from "../../lib/paths";

interface Props {
  entity: LoreEntity;
  onClose: () => void;
}

interface MetaProposal {
  name: string;
  aliases: string[];
  category: CategoryId;
  summary: string;
}

export function LoreMetaImproveModal({ entity, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const { projectPath } = useProjectStore();
  const { models, providers, activeModelId } = useAiStore();
  // 本次任务使用的模型 — 默认跟随全局设置，改动不写回全局 (设计稿 v4)。
  const [modelId, setModelId] = useState(activeModelId ?? "");
  const { scanProject } = useLoreStore();
  const avatarUrl = useImageDataUrl(entity.avatarPath);

  const [body, setBody] = useState("");
  const [phase, setPhase] = useState<"input" | "generating" | "result">("input");
  const [rawOutput, setRawOutput] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [instruction, setInstruction] = useState("");

  // Editable proposal fields (initialized from current entity, replaced after generate)
  const [pName, setPName] = useState(entity.name);
  const [pAliases, setPAliases] = useState<string[]>(entity.aliases);
  const [pCategory, setPCategory] = useState<CategoryId>(entity.category);
  const [pSummary, setPSummary] = useState(entity.summary);
  const [aliasInput, setAliasInput] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const elapsedSec = useRunClock(phase === "generating");

  useEffect(() => {
    readEntityFile(entity.dirPath, "index.md")
      .then((raw) => {
        const { content } = parseFrontmatter(raw);
        setBody(content);
      })
      .catch(() => setBody(""));
  }, [entity.dirPath]);

  const handleGenerate = async () => {
    const model = models.find((m) => m.id === modelId);
    const provider = model ? providers.find((p) => p.id === model.providerId) : null;
    if (!model || !provider) {
      setError(t("ai.errors.noModel", { defaultValue: "请先在设置中选择模型" }));
      return;
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    setRawOutput("");
    setReasoning("");
    setPhase("generating");

    try {
      const apiKey = (await loadApiKey(provider.id)) ?? "";
      const catIds = loreCategoryIds();

      // Multimodal models additionally receive the entity's avatar + gallery
      // images as binary payloads. Text-only models still get the textual
      // gallery descriptions embedded in the prompt below.
      const supportsImages = model.type === "multimodal";
      const galleryLines: string[] = [];
      if (entity.avatarPath) {
        const fname = baseName(entity.avatarPath) || "avatar";
        galleryLines.push(`- ${fname}: (avatar)`);
      }
      for (const img of entity.images) {
        galleryLines.push(`- ${img.file}: ${img.desc || "(no description)"}`);
      }

      const imageDataUrls: string[] = [];
      if (supportsImages) {
        const paths = [
          ...(entity.avatarPath ? [entity.avatarPath] : []),
          ...entity.images.map((i) => i.absPath),
        ];
        for (const p of paths) {
          try {
            const { dataUrl } = await imageForModel(p);
            imageDataUrls.push(dataUrl);
          } catch { /* skip unreadable image */ }
        }
      }

      const systemBase = [
        "You are a metadata curator for a writing workspace's knowledge base.",
        "Given an entity's current metadata, the body content of its index.md, and",
        "optionally its images, produce REFINED metadata fields — WITHOUT changing the body.",
        "Rules:",
        "- Preserve user intent. If a field is already good, return it unchanged.",
        "- Infer missing aliases from the body and images (e.g. honorifics, titles, short forms).",
        "- The category should match the entity's nature; only change it if clearly wrong.",
        "- Respond in the same language as the body (Chinese body → Chinese summary).",
      ].join("\n");
      const userText = [
        "CURRENT METADATA:",
        `  name: ${entity.name}`,
        `  aliases: ${JSON.stringify(entity.aliases)}`,
        `  category: ${entity.category}`,
        `  summary: ${entity.summary || "(empty)"}`,
        "",
        "BODY (index.md content after frontmatter):",
        body.trim() || "(empty)",
        galleryLines.length ? `\nIMAGES:\n${galleryLines.join("\n")}` : "",
        instruction.trim() ? `\nADDITIONAL USER INSTRUCTION:\n${instruction.trim()}` : "",
      ].filter(Boolean).join("\n");

      const userContent = imageDataUrls.length
        ? [
            { type: "text" as const, text: userText },
            ...imageDataUrls.map((url) => ({
              type: "image_url" as const,
              image_url: { url },
            })),
          ]
        : userText;

      const metadataTool: ToolDefinition = {
        type: "function",
        function: {
          name: "update_lore_metadata",
          description:
            "Persist refined metadata (name, aliases, category, summary) for the lore entity. Does not touch the entity body.",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "Canonical display name" },
              aliases: {
                type: "array",
                items: { type: "string" },
                description: "Alternative names / nicknames / honorifics for RAG keyword matching",
              },
              category: { type: "string", enum: catIds, description: "Entity category" },
              summary: { type: "string", description: "One concise sentence, ≤ 60 chars when possible" },
            },
            required: ["name", "aliases", "category", "summary"],
          },
        },
      };

      // Unified structured-output path: forced tool_choice with JSON fallback
      // for models that reject it — see lib/agent/structured.ts.
      const toolArgs = await runStructuredTask({
        ...connOptions({ provider, model, apiKey }),
        systemPrompt: systemBase,
        toolInstruction: "Call the update_lore_metadata tool exactly once with the refined fields.",
        jsonInstruction: `Respond with ONLY a JSON object — no markdown fences, no prose — with exactly these keys: {"name": string, "aliases": string[], "category": one of [${catIds.join(", ")}], "summary": string}.`,
        outputTool: metadataTool,
        userContent,
        signal: ctrl.signal,
        onText: setRawOutput,
        onReasoning: setReasoning,
      });

      const parsed = JSON.parse(toolArgs) as Partial<MetaProposal>;
      const cat = typeof parsed.category === "string" ? findCategory(parsed.category) : null;
      setPName(typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : entity.name);
      setPAliases(Array.isArray(parsed.aliases)
        ? parsed.aliases.filter((a): a is string => typeof a === "string" && a.trim().length > 0).map((a) => a.trim())
        : entity.aliases);
      setPCategory(cat ? cat.id : entity.category);
      setPSummary(typeof parsed.summary === "string" ? parsed.summary : entity.summary);
      setPhase("result");
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg.includes("JSON") ? `模型未返回合法 JSON：${msg}` : msg);
      }
      setPhase(rawOutput ? "result" : "input");
    } finally {
      abortRef.current = null;
    }
  };

  const handleApply = async () => {
    if (!projectPath || !pName.trim()) return;
    setSaving(true);
    try {
      const meta: MetaProposal = {
        name: pName.trim(),
        aliases: pAliases.map((a) => a.trim()).filter(Boolean),
        category: pCategory,
        summary: pSummary.trim(),
      };
      // dict 原样带过去：AI 的元数据建议不该顺手抹掉词典标记。
      await saveEntityMetaAndBody(projectPath, entity, { ...meta, dict: entity.dict }, body);
      await scanProject(projectPath);
      requestClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const aliasIme = useImeGuard();
  const addAlias = () => {
    const v = aliasInput.trim();
    if (!v || pAliases.includes(v)) { setAliasInput(""); return; }
    setPAliases([...pAliases, v]);
    setAliasInput("");
  };
  const removeAlias = (i: number) =>
    setPAliases(pAliases.filter((_, x) => x !== i));

  const activeModel = models.find((m) => m.id === modelId);
  const imageCount = (entity.avatarPath ? 1 : 0) + entity.images.length;
  const willSendImages = activeModel?.type === "multimodal" && imageCount > 0;

  // 语义步骤 (设计稿 17): 读取 → 生成建议 → 交给作者确认。
  const metaSteps: RunStep[] = [
    {
      label: t("lore.meta.stepRead", { defaultValue: "读取主词条与配图" }),
      status: "done",
      meta: `${body.length}${isZh ? " 字" : " ch"}${willSendImages ? ` · ${imageCount}${isZh ? " 图" : " img"}` : ""}`,
    },
    { label: t("lore.meta.stepDraft", { defaultValue: "生成建议 · 名称 / 别名 / 分类 / 概要" }), status: "active" },
    { label: t("lore.meta.stepConfirm", { defaultValue: "交给你确认后写入 index.md" }), status: "pending" },
  ];

  // Unsaved once the user has typed an instruction or a proposal was generated.
  const dirty = phase !== "input" || instruction.trim().length > 0;

  const shellCloseRef = useRef<(() => void) | null>(null);
  const requestClose = () => (shellCloseRef.current ?? onClose)();

  return (
    <ModalShell overlayClassName={styles.overlay} onClose={onClose} isDirty={dirty} closeOnBackdrop={false} closeRef={shellCloseRef}>
      <div className={styles.panel}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            {avatarUrl
              ? <img src={avatarUrl} className={styles.headerAvatar} alt={entity.name} />
              : <div className={styles.headerAvatarPlaceholder}>{entity.name.charAt(0)}</div>}
            <div>
              <div className={styles.headerName}>
                {entity.name} · {t("lore.meta.title", { defaultValue: "主词条补全" })}
              </div>
              <div className={styles.headerSub}>
                {t("lore.meta.subtitle", { defaultValue: "缺失的概要与别名会显著降低命中率" })}
              </div>
              {(!entity.summary || entity.aliases.length === 0) && (
                <div className={extra.badges}>
                  {!entity.summary && (
                    <span className={extra.badge}>{t("lore.meta.missingSummary", { defaultValue: "缺概要" })}</span>
                  )}
                  {entity.aliases.length === 0 && (
                    <span className={extra.badge}>{t("lore.meta.missingAliases", { defaultValue: "缺别名" })}</span>
                  )}
                </div>
              )}
            </div>
          </div>
          <button className={styles.closeBtn} onClick={requestClose}><X size={16} /></button>
        </div>

        {/* Body */}
        <div className={styles.body}>
          {willSendImages && (
            <div className={styles.section} style={{ opacity: 0.75, fontSize: 12 }}>
              {t("lore.meta.sendImages", {
                count: imageCount,
                defaultValue: `将随条目一并发送 ${imageCount} 张图片（头像 + 图库）供多模态模型参考。`,
              })}
            </div>
          )}
          {/* Current snapshot */}
          <div className={styles.section}>
            <label className={styles.label}>{t("lore.meta.currentLabel", { defaultValue: "当前主词条" })}</label>
            <pre className={styles.currentPre}>
{`---
name: ${entity.name}
aliases: ${JSON.stringify(entity.aliases)}
category: ${entity.category}
summary: ${entity.summary}
---`}
            </pre>
          </div>

          {/* Instruction (optional) */}
          <div className={styles.section}>
            <label className={styles.label}>
              {t("lore.meta.instructionLabel", { defaultValue: "额外指令" })}
              <span className={styles.hint}> · {t("lore.facet.optional", { defaultValue: "可选" })}</span>
            </label>
            <MarkdownTextarea
              format={false}
              className={styles.textarea}
              rows={2}
              placeholder={t("lore.meta.instructionPlaceholder", {
                defaultValue: "例如：补充别名、把概要缩短到一句话…",
              })}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              disabled={phase === "generating"}
            />
          </div>

          {/* 运行进度: 状态行 + 步骤列 + 思维链 (设计稿 17) */}
          {phase === "generating" && (
            <div className={styles.section}>
              <div className={styles.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {t("lore.meta.suggestionLabel", { defaultValue: "AI 建议" })}
                <RunStatusLine state="running" elapsedSec={elapsedSec}
                  model={models.find((m) => m.id === modelId)?.name} />
              </div>
              <LoreRunSteps steps={metaSteps} />
              <ThinkingPanel text={reasoning} running />
            </div>
          )}

          {/* Error */}
          {error && (
            <div className={styles.error}>
              <AlertTriangle size={13} style={{ flexShrink: 0 }} />
              {error}
            </div>
          )}

          {/* Editable proposal */}
          {phase === "result" && (
            <div className={styles.section}>
              <label className={styles.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {t("lore.meta.suggestionEditable", { defaultValue: "AI 建议（应用前可编辑）" })}
                <RunStatusLine
                  state="done"
                  elapsedSec={elapsedSec}
                  tokens={estimateRunTokens(rawOutput, reasoning)}
                />
              </label>
              <ThinkingPanel text={reasoning} running={false} />
              <div className={extra.grid}>
                <label className={extra.gLabel}>{t("lore.detail.fieldName", { defaultValue: "名称" })}</label>
                <input
                  className={extra.gInput}
                  value={pName}
                  onChange={(e) => setPName(e.target.value)}
                />

                <label className={extra.gLabel}>{t("lore.detail.fieldCategory", { defaultValue: "分类" })}</label>
                <Select
                  className={extra.gSelect}
                  value={pCategory}
                  onChange={(v) => setPCategory(v as CategoryId)}
                  // Same asymmetry as the detail pane's picker: an orphan is
                  // offered only when the entry already sits in it.
                  options={assignableCategories(entity.category).map((c) => ({
                    value: c.id,
                    label: categoryLabel(c, isZh),
                  }))}
                />

                <label className={extra.gLabel}>{t("lore.detail.fieldAliases", { defaultValue: "别名" })}</label>
                <div>
                  {pAliases.length > 0 && (
                    <div className={styles.chips} style={{ marginBottom: 6 }}>
                      {pAliases.map((a, i) => (
                        <span
                          key={`${a}-${i}`}
                          className={`${styles.chip} ${entity.aliases.includes(a) ? "" : extra.chipNew}`}
                        >
                          {a}
                          <button className={styles.chipRemove} onClick={() => removeAlias(i)}>
                            <X size={10} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <input
                    className={extra.gInput}
                    value={aliasInput}
                    onChange={(e) => setAliasInput(e.target.value)}
                    {...aliasIme.imeProps}
                    onKeyDown={(e) => {
                      if (aliasIme.isComposing(e)) return;
                      if (e.key === "Enter") { e.preventDefault(); addAlias(); }
                    }}
                    placeholder={t("lore.detail.aliasPlaceholder", { defaultValue: "添加别名（回车确认）" })}
                  />
                </div>

                <label className={extra.gLabel}>
                  {t("lore.detail.fieldSummary", { defaultValue: "概要" })}
                  {pSummary.trim() && (
                    <span className={extra.charNote}>
                      {t("lore.facet.chars", { chars: pSummary.trim().length, defaultValue: `${pSummary.trim().length} 字` })}
                    </span>
                  )}
                </label>
                <MarkdownTextarea
                  className={`${extra.gInput} ${extra.gTextarea} ${pSummary.trim() && pSummary.trim() !== entity.summary ? extra.gChanged : ""}`}
                  value={pSummary}
                  onChange={(e) => setPSummary(e.target.value)}
                  rows={2}
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          <div className={styles.footerLeft}>
            <ModelPicker
              models={models}
              providers={providers}
              value={modelId}
              onChange={setModelId}
              disabled={phase === "generating"}
            />
            <span className={styles.footerNote}>
              {t("lore.meta.footerNote", {
                defaultValue: "「应用」只写入主词条四个字段：名称 · 别名 · 分类 · 概要，不改特征正文",
              })}
            </span>
          </div>
          <div className={styles.footerRight}>
            <button className={styles.btnGhost} onClick={requestClose}>
              {t("common.cancel", { defaultValue: "取消" })}
            </button>
            {phase === "input" && (
              <button
                className={styles.btnPrimary}
                onClick={handleGenerate}
                disabled={!modelId}
              >
                <Sparkles size={13} /> {t("lore.meta.generate", { defaultValue: "生成建议" })}
              </button>
            )}
            {phase === "generating" && (
              <button
                className={styles.btnAbort}
                onClick={() => { abortRef.current?.abort(); setPhase(rawOutput ? "result" : "input"); }}
              >
                {t("lore.improve.stop", { defaultValue: "停止" })}
              </button>
            )}
            {phase === "result" && (
              <>
                <button
                  className={styles.btnSecondary}
                  onClick={handleGenerate}
                  disabled={!modelId}
                >
                  <RotateCw size={12} /> {t("lore.improve.regenerate", { defaultValue: "重新生成" })}
                </button>
                <button
                  className={styles.btnPrimary}
                  onClick={handleApply}
                  disabled={saving || !pName.trim()}
                >
                  <Check size={13} /> {saving
                    ? t("lore.improve.applying", { defaultValue: "应用中…" })
                    : t("lore.meta.apply", { defaultValue: "应用" })}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
