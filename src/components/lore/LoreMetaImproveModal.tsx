import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { X, Sparkles, RotateCw, AlertTriangle, Bot, Check } from "lucide-react";
import { useAiStore } from "../../stores/aiStore";
import { useProjectStore } from "../../stores/projectStore";
import { useLoreStore } from "../../stores/loreStore";
import {
  readEntityFile, writeEntityFile, assetUrl,
  LORE_CATEGORIES, type CategoryId, type LoreEntity,
} from "../../lib/lore";
import { parseFrontmatter } from "../../lib/markdown";
import { loadApiKey } from "../../lib/keyStore";
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

function serializeFrontmatter(meta: MetaProposal): string {
  const aliasBlock = meta.aliases.length
    ? `aliases:\n${meta.aliases.map((a) => `  - "${a.replace(/"/g, '\\"')}"`).join("\n")}`
    : `aliases: []`;
  const summaryQuoted = `"${meta.summary.replace(/"/g, '\\"')}"`;
  return [
    "---",
    `name: ${meta.name}`,
    aliasBlock,
    `category: ${meta.category}`,
    `summary: ${summaryQuoted}`,
    "---",
    "",
  ].join("\n");
}

function extractJson(raw: string): string {
  let s = raw.trim();
  // Strip ```json fences if present
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();
  // Find the first balanced {...} block, in case the model added prose
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last > first) return s.slice(first, last + 1);
  return s;
}

export function LoreMetaImproveModal({ entity, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const { projectPath } = useProjectStore();
  const { models, providers, activeModelId, setActiveModel } = useAiStore();
  const { scanProject } = useLoreStore();

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

    const apiKey = (await loadApiKey(provider.id)) ?? "";
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    setRawOutput("");
    setPhase("generating");

    try {
      const catIds = LORE_CATEGORIES.map((c) => c.id);
      const systemPrompt = [
        "You are a lore entity metadata curator for a fiction writing app.",
        "Given an entity's current metadata and the body content of its index.md,",
        "produce REFINED metadata fields.",
        "Output ONLY a valid JSON object — no code fences, no explanation — with EXACTLY these keys:",
        '  "name": string (canonical display name)',
        '  "aliases": string[] (alternative names / nicknames / honorifics used in the prose, for RAG keyword matching)',
        `  "category": one of ${JSON.stringify(catIds)}`,
        '  "summary": string (one concise sentence, ≤ 60 chars when possible)',
        "Rules:",
        "- Preserve user intent. If a field is already good, return it unchanged.",
        "- Infer missing aliases from the body (e.g. honorifics, titles, short forms).",
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
        instruction.trim() ? `\nADDITIONAL USER INSTRUCTION:\n${instruction.trim()}` : "",
      ].filter(Boolean).join("\n");

      const { streamCompletion } = await import("../../lib/aiClient");
      let acc = "";
      await streamCompletion({
        baseUrl: provider.baseUrl,
        apiKey,
        standard: provider.apiStandard,
        safetySettings: provider.safetySettings,
        modelId: model.modelId,
        prefix: model.prefix,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText },
        ],
        onChunk: (chunk) => {
          if ("text" in chunk) { acc += chunk.text; setRawOutput(acc); }
        },
        signal: ctrl.signal,
      });

      const jsonStr = extractJson(acc);
      const parsed = JSON.parse(jsonStr) as Partial<MetaProposal>;
      const cat = LORE_CATEGORIES.find((c) => c.id === parsed.category);
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
      const bodyText = body.trimStart();
      const newContent = serializeFrontmatter(meta) + "\n" + bodyText;
      await writeEntityFile(entity.dirPath, "index.md", newContent);
      await scanProject(projectPath);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const addAlias = () => {
    const v = aliasInput.trim();
    if (!v || pAliases.includes(v)) { setAliasInput(""); return; }
    setPAliases([...pAliases, v]);
    setAliasInput("");
  };
  const removeAlias = (i: number) =>
    setPAliases(pAliases.filter((_, x) => x !== i));

  return (
    <div className={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.panel}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            {entity.avatarPath
              ? <img src={assetUrl(entity.avatarPath)} className={styles.headerAvatar} alt={entity.name} />
              : <div className={styles.headerAvatarPlaceholder}><Bot size={16} strokeWidth={1.5} /></div>}
            <div>
              <div className={styles.headerName}>{entity.name}</div>
              <div className={styles.headerSub}>{isZh ? "AI 优化元数据" : "AI improve metadata"}</div>
            </div>
          </div>
          <select
            className={styles.modelSelect}
            value={activeModelId ?? ""}
            onChange={(e) => setActiveModel(e.target.value)}
          >
            <option value="">{t("lore.generator.selectModel", { defaultValue: "选择模型" })}</option>
            {models.map((m) => {
              const pname = providers.find((p) => p.id === m.providerId)?.name ?? "";
              return <option key={m.id} value={m.id}>{pname} / {m.name}</option>;
            })}
          </select>
          <button className={styles.closeBtn} onClick={onClose}><X size={16} /></button>
        </div>

        {/* Body */}
        <div className={styles.body}>
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
            <textarea
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
          {phase === "generating" && rawOutput && (
            <div className={styles.section}>
              <label className={styles.label}>{isZh ? "正在生成…" : "Generating…"}</label>
              <pre className={styles.currentPre}>{rawOutput}</pre>
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
                <select
                  className={extra.gInput}
                  value={pCategory}
                  onChange={(e) => setPCategory(e.target.value as CategoryId)}
                >
                  {LORE_CATEGORIES.map((c) => (
                    <option key={c.id} value={c.id}>
                      {isZh ? c.labelZh : c.labelEn}
                    </option>
                  ))}
                </select>

                <label className={extra.gLabel}>{isZh ? "别名" : "aliases"}</label>
                <div>
                  {pAliases.length > 0 && (
                    <div className={styles.chips} style={{ marginBottom: 6 }}>
                      {pAliases.map((a, i) => (
                        <span key={`${a}-${i}`} className={styles.chip}>
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
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); addAlias(); }
                    }}
                    placeholder={isZh ? "添加别名（回车确认）" : "Add alias (press Enter)"}
                  />
                </div>

                <label className={extra.gLabel}>{isZh ? "概要" : "summary"}</label>
                <textarea
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
          <button className={styles.btnSecondary} onClick={onClose}>
            {isZh ? "取消" : "Cancel"}
          </button>
          <div className={styles.footerRight}>
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
    </div>
  );
}
