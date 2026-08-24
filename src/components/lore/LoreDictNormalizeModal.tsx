/**
 * 词典标准化 —— 把「翻译词典」条目的自由格式正文（表格、散文、任意分隔符）
 * 整理成 Sakura 词典格式：一行一条 `原文->译文 #备注`。
 *
 * 分工是这个模态的全部设计（docs/feature/translate/01-execution-plan.md §6.6）：
 * **模型只做搬运**——从自由格式里把词对抽出来，一个译名都不许改；**格式由代码
 * 渲染**（`formatDictBody`），所以产物必然可被 `parseDictBody` 读回。这是一次性
 * 的格式抢救，抢救完确定性流水线永远生效——每次翻译时的格式归一从来不在这里，
 * 在 `parseDictBody` 自己身上。
 *
 * 防改写的核查是启发式的：原文/译文在原正文里逐字找得到才算"已核对"，找不到
 * 的计数展示给作者。它挡不住所有幻觉，但把「模型顺手改了译名」从不可见变成
 * 一行黄字。
 */

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { X, Sparkles, RotateCw, AlertTriangle, Check } from "lucide-react";
import { useAiStore } from "../../stores/aiStore";
import { useProjectStore } from "../../stores/projectStore";
import { useLoreStore } from "../../stores/loreStore";
import { connOptions } from "../../lib/ai/conn";
import { readEntityFile, saveEntityMetaAndBody, type LoreEntity } from "../../lib/lore";
import { formatDictBody, parseDictBody, type GlossaryEntry } from "../../lib/translate/glossary";
import { ModalShell } from "../common/ModalShell";
import { parseFrontmatter } from "../../lib/fs/markdown";
import { loadApiKey } from "../../lib/keyStore";
import { runStructuredTask } from "../../lib/agent/structured";
import type { ToolDefinition } from "../../lib/ai";
import {
  LoreRunSteps, RunStatusLine, ThinkingPanel, estimateRunTokens, useRunClock,
  type RunStep,
} from "./ai/LoreRunProgress";
import { ModelPicker } from "./ai/ModelPicker";
import styles from "./LoreImproveModal.module.css";

interface Props {
  entity: LoreEntity;
  onClose: () => void;
}

export function LoreDictNormalizeModal({ entity, onClose }: Props) {
  const { t } = useTranslation();
  const { projectPath } = useProjectStore();
  const { models, providers, activeModelId } = useAiStore();
  const [modelId, setModelId] = useState(activeModelId ?? "");
  const { scanProject } = useLoreStore();

  const [body, setBody] = useState("");
  const [phase, setPhase] = useState<"input" | "generating" | "result">("input");
  const [rawOutput, setRawOutput] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** 整理结果，作者可在应用前继续编辑。 */
  const [draft, setDraft] = useState("");
  /** 原文/译文在原正文里逐字找不到的条数——防改写的启发式报警。 */
  const [unverified, setUnverified] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const elapsedSec = useRunClock(phase === "generating");

  useEffect(() => {
    readEntityFile(entity.dirPath, "index.md")
      .then((raw) => setBody(parseFrontmatter(raw).content))
      .catch(() => setBody(""));
  }, [entity.dirPath]);

  const parsedNow = parseDictBody(body).length;
  const parsedDraft = parseDictBody(draft).length;

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

      const dictTool: ToolDefinition = {
        type: "function",
        function: {
          name: "submit_dict_entries",
          description:
            "Submit every translation term pair extracted from the dictionary body, in source order.",
          parameters: {
            type: "object",
            properties: {
              entries: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    src: { type: "string", description: "Japanese source term, copied VERBATIM" },
                    dst: { type: "string", description: "Chinese translation, copied VERBATIM" },
                    note: { type: "string", description: "Optional short note (person / place / skill …)" },
                  },
                  required: ["src", "dst"],
                },
              },
            },
            required: ["entries"],
          },
        },
      };

      const toolArgs = await runStructuredTask({
        ...connOptions({ provider, model, apiKey }),
        systemPrompt: [
          "You are a data-migration assistant. The user gives you the body of a translation-dictionary",
          "note in an arbitrary format (a markdown table, prose, lists, any separator). Extract every",
          "Japanese→Chinese term pair it contains.",
          "Rules:",
          "- COPY both sides VERBATIM. You are moving the author's word list, not making one:",
          "  never invent, translate, merge, or 'improve' a term. A pair you are unsure about is",
          "  still copied as written.",
          "- Keep the source order. Do not deduplicate unless two lines are literally identical.",
          "- Prose or headings that are not term pairs are simply skipped.",
          "- A note is only what the author attached to that pair (e.g. 人名/地名/技能); do not write new notes.",
        ].join("\n"),
        toolInstruction: "Call the submit_dict_entries tool exactly once with every pair.",
        jsonInstruction:
          'Respond with ONLY a JSON object — no markdown fences, no prose: {"entries": [{"src": string, "dst": string, "note"?: string}]}.',
        outputTool: dictTool,
        userContent: `DICTIONARY BODY:\n${body.trim() || "(empty)"}`,
        signal: ctrl.signal,
        onText: setRawOutput,
        onReasoning: setReasoning,
      });

      const parsed = JSON.parse(toolArgs) as { entries?: Array<Partial<GlossaryEntry>> };
      const entries: GlossaryEntry[] = (parsed.entries ?? [])
        .filter((e): e is GlossaryEntry => typeof e?.src === "string" && typeof e?.dst === "string")
        .map((e) => ({
          src: e.src.trim(),
          dst: e.dst.trim(),
          note: typeof e.note === "string" && e.note.trim() ? e.note.trim() : undefined,
        }))
        .filter((e) => e.src && e.dst && e.src !== e.dst);

      setUnverified(entries.filter((e) => !body.includes(e.src) || !body.includes(e.dst)).length);
      setDraft(formatDictBody(entries));
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
    if (!projectPath || !draft.trim() || parsedDraft === 0) return;
    setSaving(true);
    try {
      await saveEntityMetaAndBody(
        projectPath,
        entity,
        {
          name: entity.name,
          aliases: entity.aliases,
          category: entity.category,
          summary: entity.summary,
          dict: entity.dict,
        },
        draft.trim() + "\n",
      );
      await scanProject(projectPath);
      requestClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const steps: RunStep[] = [
    {
      label: t("lore.dict.stepRead"),
      status: "done",
      meta: `${body.length} 字 · ${t("lore.dict.parsedNote", { count: parsedNow })}`,
    },
    { label: t("lore.dict.stepDraft"), status: "active" },
    { label: t("lore.dict.stepConfirm"), status: "pending" },
  ];

  const dirty = phase !== "input";
  const shellCloseRef = useRef<(() => void) | null>(null);
  const requestClose = () => (shellCloseRef.current ?? onClose)();

  return (
    <ModalShell overlayClassName={styles.overlay} onClose={onClose} isDirty={dirty} closeOnBackdrop={false} closeRef={shellCloseRef}>
      <div className={styles.panel}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <div className={styles.headerAvatarPlaceholder}>{entity.name.charAt(0)}</div>
            <div>
              <div className={styles.headerName}>
                {entity.name} · {t("lore.dict.title")}
              </div>
              <div className={styles.headerSub}>{t("lore.dict.subtitle")}</div>
            </div>
          </div>
          <button className={styles.closeBtn} onClick={requestClose}><X size={16} /></button>
        </div>

        <div className={styles.body}>
          <div className={styles.section}>
            <label className={styles.label}>
              {t("lore.dict.currentLabel")}
              <span className={styles.hint}> · {t("lore.dict.parsedNote", { count: parsedNow })}</span>
            </label>
            <pre className={styles.currentPre}>{body.trim() || "(empty)"}</pre>
          </div>

          {phase === "generating" && (
            <div className={styles.section}>
              <div className={styles.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {t("lore.dict.resultLabel")}
                <RunStatusLine state="running" elapsedSec={elapsedSec}
                  model={models.find((m) => m.id === modelId)?.name} />
              </div>
              <LoreRunSteps steps={steps} />
              <ThinkingPanel text={reasoning} running />
            </div>
          )}

          {error && (
            <div className={styles.error}>
              <AlertTriangle size={13} style={{ flexShrink: 0 }} />
              {error}
            </div>
          )}

          {phase === "result" && (
            <div className={styles.section}>
              <label className={styles.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {t("lore.dict.resultLabel")}
                <span className={styles.hint}>{t("lore.dict.resultCount", { count: parsedDraft })}</span>
                <RunStatusLine
                  state="done"
                  elapsedSec={elapsedSec}
                  tokens={estimateRunTokens(rawOutput, reasoning)}
                />
              </label>
              <ThinkingPanel text={reasoning} running={false} />
              {unverified > 0 && (
                <div className={styles.error}>
                  <AlertTriangle size={13} style={{ flexShrink: 0 }} />
                  {t("lore.dict.unverified", { count: unverified })}
                </div>
              )}
              <textarea
                className={styles.textarea}
                rows={14}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
              />
            </div>
          )}
        </div>

        <div className={styles.footer}>
          <div className={styles.footerLeft}>
            <ModelPicker
              models={models}
              providers={providers}
              value={modelId}
              onChange={setModelId}
              disabled={phase === "generating"}
            />
            <span className={styles.footerNote}>{t("lore.dict.footerNote")}</span>
          </div>
          <div className={styles.footerRight}>
            <button className={styles.btnGhost} onClick={requestClose}>
              {t("common.cancel", { defaultValue: "取消" })}
            </button>
            {phase === "input" && (
              <button className={styles.btnPrimary} onClick={handleGenerate} disabled={!modelId}>
                <Sparkles size={13} /> {t("lore.dict.generate")}
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
                <button className={styles.btnSecondary} onClick={handleGenerate} disabled={!modelId}>
                  <RotateCw size={12} /> {t("lore.improve.regenerate", { defaultValue: "重新生成" })}
                </button>
                <button
                  className={styles.btnPrimary}
                  onClick={handleApply}
                  disabled={saving || parsedDraft === 0}
                  title={parsedDraft === 0 ? t("lore.dict.applyNeedsEntries") : undefined}
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
