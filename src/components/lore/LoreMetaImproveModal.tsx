import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { X, Sparkles, RotateCw, AlertTriangle, Check } from "lucide-react";
import { useAiStore } from "../../stores/aiStore";
import { useProjectStore } from "../../stores/projectStore";
import { useLoreStore } from "../../stores/loreStore";
import { connOptions } from "../../lib/ai/conn";
import {
  readEntityFile, saveEntityMetaAndBody,
  type CategoryId, type LoreEntity,
} from "../../lib/lore";
import { categoryLabel, findCategory, loreCategories, loreCategoryIds } from "../../lib/profile";
import { useImageDataUrl } from "./useImageDataUrl";
import { MarkdownTextarea } from "../common/MarkdownTextarea";
import { ModalShell } from "../common/ModalShell";
import { parseFrontmatter } from "../../lib/fs/markdown";
import { loadApiKey } from "../../lib/keyStore";
import { imageToDataUrl } from "../../lib/fs/images";
import { useImeGuard } from "../../lib/ime";
import { runStructuredTask } from "../../lib/agent/structured";
import type { ToolDefinition } from "../../lib/ai";
import { Select } from "../common/Select";
import styles from "./LoreImproveModal.module.css";
import extra from "./LoreMetaImproveModal.module.css";

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
  const { models, providers, activeModelId, setActiveModel } = useAiStore();
  const { scanProject } = useLoreStore();
  const avatarUrl = useImageDataUrl(entity.avatarPath);

  const [body, setBody] = useState("");
  const [phase, setPhase] = useState<"input" | "generating" | "result">("input");
  const [rawOutput, setRawOutput] = useState("");
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

  useEffect(() => {
    readEntityFile(entity.dirPath, "index.md")
      .then((raw) => {
        const { content } = parseFrontmatter(raw);
        setBody(content);
      })
      .catch(() => setBody(""));
  }, [entity.dirPath]);

  const handleGenerate = async () => {
    const model = models.find((m) => m.id === activeModelId);
    const provider = model ? providers.find((p) => p.id === model.providerId) : null;
    if (!model || !provider) {
      setError(t("ai.errors.noModel", { defaultValue: "请先在设置中选择模型" }));
      return;
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    setRawOutput("");
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
        const fname = entity.avatarPath.split(/[\\/]/).pop() ?? "avatar";
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
            const { dataUrl } = await imageToDataUrl(p);
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
      await saveEntityMetaAndBody(projectPath, entity, meta, body);
      await scanProject(projectPath);
      onClose();
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

  const activeModel = models.find((m) => m.id === activeModelId);
  const imageCount = (entity.avatarPath ? 1 : 0) + entity.images.length;
  const willSendImages = activeModel?.type === "multimodal" && imageCount > 0;

  // Unsaved once the user has typed an instruction or a proposal was generated.
  const dirty = phase !== "input" || instruction.trim().length > 0;

  return (
    <ModalShell overlayClassName={styles.overlay} onClose={onClose} isDirty={dirty} closeOnBackdrop={false}>
      <div className={styles.panel}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            {avatarUrl
              ? <img src={avatarUrl} className={styles.headerAvatar} alt={entity.name} />
              : <div className={styles.headerAvatarPlaceholder}>{entity.name.charAt(0)}</div>}
            <div>
              <div className={styles.headerName}>
                {entity.name} · {isZh ? "元信息完善" : "Metadata"}
              </div>
              <div className={styles.headerSub}>
                {isZh ? "缺失的摘要与别名会显著降低检索命中" : "Missing summary or aliases hurt retrieval"}
              </div>
              {(!entity.summary || entity.aliases.length === 0) && (
                <div className={extra.badges}>
                  {!entity.summary && (
                    <span className={extra.badge}>{isZh ? "缺摘要" : "no summary"}</span>
                  )}
                  {entity.aliases.length === 0 && (
                    <span className={extra.badge}>{isZh ? "缺别名" : "no aliases"}</span>
                  )}
                </div>
              )}
            </div>
          </div>
          <Select
            className={styles.modelSelect}
            value={activeModelId ?? ""}
            onChange={(v) => setActiveModel(v)}
            options={[
              { value: "", label: t("lore.generator.selectModel", { defaultValue: "选择模型" }) },
              ...models.map((m) => ({
                value: m.id,
                label: `${providers.find((p) => p.id === m.providerId)?.name ?? ""} / ${m.name}`,
              })),
            ]}
            ariaLabel={t("lore.generator.selectModel", { defaultValue: "选择模型" })}
          />
          <button className={styles.closeBtn} onClick={onClose}><X size={16} /></button>
        </div>

        {/* Body */}
        <div className={styles.body}>
          {willSendImages && (
            <div className={styles.section} style={{ opacity: 0.75, fontSize: 12 }}>
              {isZh
                ? `将随词条设定一并发送 ${imageCount} 张图片（头像 + 图库）供多模态模型参考。`
                : `Sending ${imageCount} image(s) (avatar + gallery) to the multimodal model.`}
            </div>
          )}
          {/* Current snapshot */}
          <div className={styles.section}>
            <label className={styles.label}>{isZh ? "当前元数据" : "Current metadata"}</label>
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
              {isZh ? "额外指令" : "Extra instruction"}
              <span className={styles.hint}> · {isZh ? "可选" : "optional"}</span>
            </label>
            <MarkdownTextarea
              format={false}
              className={styles.textarea}
              rows={2}
              placeholder={isZh
                ? "例如：补充别名、把概要缩短到一句话…"
                : "e.g. add aliases inferred from the body, tighten the summary…"}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              disabled={phase === "generating"}
            />
          </div>

          {/* Streaming raw output */}
          {phase === "generating" && (
            <div className={styles.section}>
              <div className={extra.genRow}>
                <span className={extra.genDots}>
                  <span className={extra.genDot} />
                  <span className={extra.genDot} />
                  <span className={extra.genDot} />
                </span>
                <span className={extra.genLabel}>{isZh ? "生成中" : "generating"}</span>
              </div>
              {rawOutput && <pre className={styles.currentPre}>{rawOutput}</pre>}
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
              <label className={styles.label}>
                {isZh ? "AI 建议（应用前可编辑）" : "AI suggestion (editable before apply)"}
              </label>
              <div className={extra.grid}>
                <label className={extra.gLabel}>{isZh ? "名称" : "name"}</label>
                <input
                  className={extra.gInput}
                  value={pName}
                  onChange={(e) => setPName(e.target.value)}
                />

                <label className={extra.gLabel}>{isZh ? "分类" : "category"}</label>
                <Select
                  className={extra.gSelect}
                  value={pCategory}
                  onChange={(v) => setPCategory(v as CategoryId)}
                  options={loreCategories().map((c) => ({
                    value: c.id,
                    label: categoryLabel(c, isZh),
                  }))}
                />

                <label className={extra.gLabel}>{isZh ? "别名" : "aliases"}</label>
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
                    placeholder={isZh ? "添加别名（回车确认）" : "Add alias (press Enter)"}
                  />
                </div>

                <label className={extra.gLabel}>
                  {isZh ? "概要" : "summary"}
                  {pSummary.trim() && (
                    <span className={extra.charNote}>{pSummary.trim().length} {isZh ? "字" : "ch"}</span>
                  )}
                </label>
                <MarkdownTextarea
                  className={`${extra.gInput} ${extra.gTextarea}`}
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
          <span className={styles.footerNote}>
            {isZh ? "「应用」只更新元信息，不改动正文" : "Apply only updates metadata — the body is untouched"}
          </span>
          <div className={styles.footerRight}>
            <button className={styles.btnGhost} onClick={onClose}>
              {isZh ? "取消" : "Cancel"}
            </button>
            {phase === "input" && (
              <button
                className={styles.btnPrimary}
                onClick={handleGenerate}
                disabled={!activeModelId}
              >
                <Sparkles size={13} /> {isZh ? "生成建议" : "Generate"}
              </button>
            )}
            {phase === "generating" && (
              <button
                className={styles.btnAbort}
                onClick={() => { abortRef.current?.abort(); setPhase(rawOutput ? "result" : "input"); }}
              >
                {isZh ? "停止" : "Stop"}
              </button>
            )}
            {phase === "result" && (
              <>
                <button
                  className={styles.btnSecondary}
                  onClick={handleGenerate}
                  disabled={!activeModelId}
                >
                  <RotateCw size={12} /> {isZh ? "重新生成" : "Regenerate"}
                </button>
                <button
                  className={styles.btnPrimary}
                  onClick={handleApply}
                  disabled={saving || !pName.trim()}
                >
                  <Check size={13} /> {saving ? (isZh ? "应用中…" : "Applying…") : (isZh ? "应用" : "Apply")}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
