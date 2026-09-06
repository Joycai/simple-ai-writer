/**
 * 词典标准化 —— 把「翻译词典」条目的自由格式正文（表格、散文、任意分隔符）
 * 整理成 Sakura 词典格式：一行一条 `原文->译文 #备注`。设计稿 03f 屏 1d–1f。
 *
 * 分工是这个模态的全部设计（docs/feature/translate/01-execution-plan.md §6.6）：
 * **模型只做搬运**——从自由格式里把词对抽出来，一个译名都不许改；**格式由代码
 * 渲染**（`formatDictBody`），所以产物必然可被 `parseDictBody` 读回。这是一次性
 * 的格式抢救，抢救完确定性流水线永远生效——每次翻译时的格式归一从来不在这里，
 * 在 `parseDictBody` 自己身上。这句分工因此写在头部（「搬运 · 不生成」），不在页脚：
 * 它是这个模态和别的 AI 模态的本质区别——别的是生成，这个是搬运。
 *
 * 防改写的核查是启发式的：原文/译文在原正文里逐字找得到才算"已核对"，找不到的
 * 那几行**点出来**（词表预览里带底色 + 「原文里找不到」签，原文态里同一块底色），
 * 不只报一个数。它挡不住所有幻觉，但作者的眼睛只需要落在那几行上。待核**不禁用**
 * 「应用」——待核是让作者看，不是让代码替他判断；禁用的唯一条件是一条都解析不出。
 *
 * 结果态两种视图共用同一段草稿：词表预览（03c 屏 1e 的三栏，也就是应用后条目里会
 * 看到的形制）和真正可编辑的原文 textarea。点预览任意一行切到原文并把光标落在那一行；
 * 改完切回词表，条数和待核数实时重算。
 */

import { useState, useEffect, useRef, useMemo, type ReactNode } from "react";
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
import { categoryColor } from "./catColor";
import shell from "./LoreImproveModal.module.css";
import styles from "./LoreDictNormalizeModal.module.css";

interface Props {
  entity: LoreEntity;
  onClose: () => void;
}

/** 这个格式本身不翻译——它是 Sakura 读的东西，两种界面语言里长得一样。 */
const DICT_FORMAT = "原文->译文 #备注";

type Phase = "input" | "generating" | "result";
type View = "table" | "source";

interface DraftRow extends GlossaryEntry {
  /** 在草稿里的行号（0 起）。 */
  line: number;
  /** 原文 / 译文哪一边在原正文里逐字找不到；null＝两边都找得到。 */
  missing: "src" | "dst" | null;
}

/**
 * 草稿逐行解析，带行号。用的就是 `parseDictBody`（一次一行）——预览要和 03c 阅读模式
 * 看到的那张词表**一模一样**，包括它对备注的截断；另写一套语法只会漂。
 */
function draftRows(draft: string, body: string): DraftRow[] {
  const rows: DraftRow[] = [];
  draft.split("\n").forEach((raw, line) => {
    const e = parseDictBody(raw)[0];
    if (!e) return;
    const missing = !body.includes(e.src) ? "src" : !body.includes(e.dst) ? "dst" : null;
    rows.push({ ...e, line, missing });
  });
  return rows;
}

/**
 * 流式输出里已经完整的词对——生成中「结果 · 边搬边出现」。JSON 还没闭合也照样读得出
 * 前面那些；半截转义的那一条留到下一帧。走 JSON 兜底路径时才有文本可读，工具调用路径
 * 上这里多半是空的，那就只报「进行中…」。
 */
const PAIR_RE =
  /\{\s*"src"\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*"dst"\s*:\s*("(?:[^"\\]|\\.)*")(?:\s*,\s*"note"\s*:\s*("(?:[^"\\]|\\.)*"))?\s*\}/g;
function streamedPairs(raw: string): GlossaryEntry[] {
  const out: GlossaryEntry[] = [];
  for (const m of raw.matchAll(PAIR_RE)) {
    try {
      const src = (JSON.parse(m[1]) as string).trim();
      const dst = (JSON.parse(m[2]) as string).trim();
      const note = m[3] ? (JSON.parse(m[3]) as string).trim() : "";
      if (src && dst) out.push(note ? { src, dst, note } : { src, dst });
    } catch {
      // 半截转义——下一帧再读
    }
  }
  return out;
}

/** 「第 12、38 条」——连续的一段写成「15–37」，不然四十条待核会写成一堵墙。 */
function rowList(indices: number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < indices.length) {
    let j = i;
    while (j + 1 < indices.length && indices[j + 1] === indices[j] + 1) j++;
    parts.push(j > i + 1 ? `${indices[i]}–${indices[j]}` : indices.slice(i, j + 1).join("、"));
    i = j + 1;
  }
  return parts.join("、");
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export function LoreDictNormalizeModal({ entity, onClose }: Props) {
  const { t } = useTranslation();
  const { projectPath } = useProjectStore();
  const { models, providers, activeModelId } = useAiStore();
  const [modelId, setModelId] = useState(activeModelId ?? "");
  const { scanProject } = useLoreStore();

  const [body, setBody] = useState("");
  const [phase, setPhase] = useState<Phase>("input");
  const [rawOutput, setRawOutput] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** 整理结果，作者可在应用前继续编辑。两种视图共用这一份。 */
  const [draft, setDraft] = useState("");
  const [view, setView] = useState<View>("table");
  const [onlyFlagged, setOnlyFlagged] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = useRef<HTMLPreElement | null>(null);
  const liveRef = useRef<HTMLPreElement | null>(null);
  /** 切到原文态后要把光标落在哪一行（0 起）。 */
  const pendingLineRef = useRef<number | null>(null);
  const elapsedSec = useRunClock(phase === "generating");

  useEffect(() => {
    readEntityFile(entity.dirPath, "index.md")
      .then((raw) => setBody(parseFrontmatter(raw).content))
      .catch(() => setBody(""));
  }, [entity.dirPath]);

  const parsedNow = parseDictBody(body).length;
  const rows = useMemo(() => draftRows(draft, body), [draft, body]);
  const parsedDraft = rows.length;
  const flagged = useMemo(() => rows.filter((r) => r.missing !== null), [rows]);
  const flaggedLines = useMemo(() => new Set(flagged.map((r) => r.line)), [flagged]);
  const streamed = useMemo(() => (phase === "generating" ? streamedPairs(rawOutput) : []), [phase, rawOutput]);

  // 边搬边出现的那一块跟着流走。
  useEffect(() => {
    if (liveRef.current) liveRef.current.scrollTop = liveRef.current.scrollHeight;
  }, [streamed.length]);

  // 从词表点过来的：原文态挂好之后把光标落到那一行，并把它滚到视野里。
  useEffect(() => {
    if (view !== "source" || pendingLineRef.current === null) return;
    const line = pendingLineRef.current;
    pendingLineRef.current = null;
    const ta = areaRef.current;
    if (!ta) return;
    const lines = draft.split("\n");
    let start = 0;
    for (let i = 0; i < line && i < lines.length; i++) start += lines[i].length + 1;
    const end = start + (lines[line]?.length ?? 0);
    ta.focus();
    ta.setSelectionRange(start, end);
    // 22px 行高 × 行号，留三行余量——和 .srcArea 的 line-height 是同一个数。
    ta.scrollTop = Math.max(0, (line - 3) * 22);
    if (mirrorRef.current) mirrorRef.current.scrollTop = ta.scrollTop;
  }, [view, draft]);

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
    setOnlyFlagged(false);
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

      setDraft(formatDictBody(entries));
      setView("table");
      setPhase("result");
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg.includes("JSON") ? `模型未返回合法 JSON：${msg}` : msg);
      }
      setPhase(draft ? "result" : "input");
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
    {
      label: t("lore.dict.stepDraft"),
      status: "active",
      meta: streamed.length > 0 ? t("lore.dict.liveCount", { n: streamed.length }) : t("lore.dict.working"),
    },
    { label: t("lore.dict.stepConfirm"), status: "pending" },
  ];

  const dirty = phase !== "input";
  const shellCloseRef = useRef<(() => void) | null>(null);
  const requestClose = () => (shellCloseRef.current ?? onClose)();
  const modelName = models.find((m) => m.id === modelId)?.name;

  const jumpToLine = (line: number) => {
    pendingLineRef.current = line;
    setView("source");
  };

  const code = <span className={styles.code}>{DICT_FORMAT}</span>;
  const sub: ReactNode =
    phase === "input" ? <>{t("lore.dict.subtitlePre")}{code}</>
    : phase === "generating" ? <>{t("lore.dict.subGenerating")}{code}</>
    : t("lore.dict.subResult");

  // 词表预览的行：全部，或只看待核的那几行（略过的段写成「… 第 15–37 条」）。
  const tableRows: Array<{ kind: "row"; row: DraftRow; idx: number } | { kind: "gap"; from: number; to: number }> = [];
  if (onlyFlagged) {
    let cursor = 1;
    rows.forEach((row, i) => {
      if (row.missing === null) return;
      const idx = i + 1;
      if (idx > cursor) tableRows.push({ kind: "gap", from: cursor, to: idx - 1 });
      tableRows.push({ kind: "row", row, idx });
      cursor = idx + 1;
    });
    if (cursor <= rows.length) tableRows.push({ kind: "gap", from: cursor, to: rows.length });
  } else {
    rows.forEach((row, i) => tableRows.push({ kind: "row", row, idx: i + 1 }));
  }

  return (
    <ModalShell overlayClassName={shell.overlay} onClose={onClose} isDirty={dirty} closeOnBackdrop={false} closeRef={shellCloseRef}>
      <div className={shell.panel} style={{ maxWidth: 880 }}>
        <div className={styles.header}>
          <div className={styles.headRow}>
            <span className={styles.avatar} style={{ background: categoryColor(entity.category) }}>
              {entity.name.charAt(0)}
            </span>
            <div className={styles.headText}>
              <div className={styles.headName}>{entity.name} · {t("lore.dict.title")}</div>
              <div className={styles.headSub}>{sub}</div>
            </div>
            <span className={styles.tag}>{t("lore.dict.tag")}</span>
            <span className={styles.grow} />
            {phase === "result" && (
              <span className={styles.doneChip}>
                <span className={styles.doneDot} />
                {t("lore.dict.done", { s: elapsedSec })}
              </span>
            )}
            <button className={shell.closeBtn} onClick={requestClose} disabled={phase === "generating"} aria-label={t("common.close", { defaultValue: "关闭" })}>
              <X size={14} />
            </button>
          </div>
          {/* 分工写在头部，不是页脚：一枚 mono 眉签 + 一句话，靠 2px 赭石竖线站住。不是横幅。 */}
          {phase === "input" && (
            <div className={styles.eyebrowBlock}>
              <span className={styles.eyebrow}>{t("lore.dict.moveEyebrow")}</span>
              <span className={styles.eyebrowText}>{t("lore.dict.moveEyebrowText")}</span>
            </div>
          )}
        </div>

        <div className={shell.body}>
          {phase === "input" && (
            <div className={shell.section}>
              <div className={styles.sectionHead}>
                <span className={styles.sectionLabel}>
                  {t("lore.dict.currentLabel")} · {t("lore.dict.parsedPre")}
                  <span className={styles.numAccent}>{parsedNow}</span>
                  {t("lore.dict.parsedPost")}
                </span>
                <span className={styles.grow} />
                <span className={styles.meta}>{t("lore.dict.bodyMeta", { chars: body.length })}</span>
              </div>
              <pre className={styles.bodyPre}>{body.trim() || "(empty)"}</pre>
              <div className={styles.caption}>{t("lore.dict.bodyCaption")}{code}。</div>
            </div>
          )}

          {phase === "generating" && (
            <>
              <div className={shell.section}>
                <RunStatusLine
                  state="running"
                  elapsedSec={elapsedSec}
                  tokens={estimateRunTokens(rawOutput, reasoning)}
                  model={modelName}
                  onStop={() => { abortRef.current?.abort(); setPhase(draft ? "result" : "input"); }}
                />
                <LoreRunSteps steps={steps} />
                <ThinkingPanel text={reasoning} running />
              </div>
              {streamed.length > 0 && (
                <div className={shell.section}>
                  <div className={styles.sectionLabel}>{t("lore.dict.liveLabel")}</div>
                  <pre ref={liveRef} className={styles.livePre}>{formatDictBody(streamed)}</pre>
                </div>
              )}
            </>
          )}

          {error && (
            <div className={shell.error}>
              <AlertTriangle size={13} style={{ flexShrink: 0 }} />
              {error}
            </div>
          )}

          {phase === "result" && (
            <div className={shell.section}>
              <div className={styles.sectionHead}>
                <span className={styles.sectionLabel}>
                  {t("lore.dict.resultLabel")} · {t("lore.dict.resultCountPre")}
                  <span className={styles.num}>{parsedDraft}</span>
                  {t("lore.dict.resultCountPost")}
                </span>
                <span className={styles.grow} />
                <span className={styles.seg} role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={view === "table"}
                    className={`${styles.segBtn} ${view === "table" ? styles.segOn : ""}`}
                    onClick={() => setView("table")}
                  >
                    {t("lore.dict.viewTable")}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={view === "source"}
                    className={`${styles.segBtn} ${view === "source" ? styles.segOn : ""}`}
                    onClick={() => setView("source")}
                  >
                    {t("lore.dict.viewSource")}
                  </button>
                </span>
              </div>

              <ThinkingPanel text={reasoning} running={false} />

              {flagged.length > 0 && (
                <div className={styles.check}>
                  <span className={styles.checkEyebrow}>{t("lore.dict.checkEyebrow")}</span>
                  <div className={styles.checkBody}>
                    <div className={styles.checkText}>
                      <span className={styles.num}>{flagged.length}</span> {t("lore.dict.unverified")}
                    </div>
                    <div className={styles.checkRows}>
                      {t("lore.dict.flaggedRows", { list: rowList(flagged.map((r) => rows.indexOf(r) + 1)) })}
                    </div>
                  </div>
                  {view === "table" && (
                    <button type="button" className={styles.checkFilter} onClick={() => setOnlyFlagged((v) => !v)}>
                      {onlyFlagged
                        ? t("lore.dict.showAll", { count: parsedDraft })
                        : t("lore.dict.onlyFlagged", { count: flagged.length })}
                    </button>
                  )}
                </div>
              )}

              {view === "table" ? (
                <div className={styles.tbl}>
                  <div className={styles.tHead}>
                    <span />
                    <span>{t("lore.dict.colSrc")}</span>
                    <span>{t("lore.dict.colDst")}</span>
                    <span className={styles.tNoteCol}>{t("lore.dict.colNote")}</span>
                  </div>
                  {tableRows.length === 0 && (
                    <div className={styles.tEmpty}>{t("lore.dict.applyNeedsEntries")}</div>
                  )}
                  {tableRows.map((r) =>
                    r.kind === "gap" ? (
                      <div key={`gap-${r.from}`} className={styles.tGap}>
                        {t("lore.dict.gapRows", { from: r.from, to: r.to })}
                      </div>
                    ) : (
                      <button
                        type="button"
                        key={r.row.line}
                        className={`${styles.tRow} ${r.row.missing ? styles.tRowOn : ""}`}
                        onClick={() => jumpToLine(r.row.line)}
                        title={t("lore.dict.rowHint")}
                      >
                        <span className={styles.tIdx}>{pad2(r.idx)}</span>
                        <span className={styles.tSrc}>{r.row.src}</span>
                        <span className={styles.tDst}>{r.row.dst}</span>
                        <span className={styles.tNoteCol}>
                          {r.row.note && <span className={styles.tNote}>{r.row.note}</span>}
                          {r.row.missing && (
                            <span className={styles.tTag}>
                              {r.row.missing === "src" ? t("lore.dict.missingSrc") : t("lore.dict.missingDst")}
                            </span>
                          )}
                        </span>
                      </button>
                    ),
                  )}
                </div>
              ) : (
                <div className={styles.srcWrap}>
                  <pre ref={mirrorRef} className={styles.srcMirror} aria-hidden>
                    {draft.split("\n").map((l, i) => (
                      <span key={i} className={flaggedLines.has(i) ? styles.srcLineOn : styles.srcLine}>
                        {l || " "}
                      </span>
                    ))}
                  </pre>
                  <textarea
                    ref={areaRef}
                    className={styles.srcArea}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onScroll={(e) => {
                      if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
                    }}
                    spellCheck={false}
                    aria-label={t("lore.dict.viewSource")}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <div className={shell.footer}>
          <div className={shell.footerLeft}>
            <ModelPicker
              models={models}
              providers={providers}
              value={modelId}
              onChange={setModelId}
              disabled={phase === "generating"}
            />
            <span className={shell.footerNote}>{t("lore.dict.footerNote")}</span>
          </div>
          <div className={shell.footerRight}>
            {phase === "input" && (
              <>
                <button className={shell.btnGhost} onClick={requestClose}>
                  {t("common.cancel", { defaultValue: "取消" })}
                </button>
                <button className={shell.btnPrimary} onClick={handleGenerate} disabled={!modelId}>
                  <Sparkles size={13} /> {t("lore.dict.generate")}
                </button>
              </>
            )}
            {/* 生成中页脚只留「停止」。 */}
            {phase === "generating" && (
              <button
                className={shell.btnAbort}
                onClick={() => { abortRef.current?.abort(); setPhase(draft ? "result" : "input"); }}
              >
                {t("lore.improve.stop", { defaultValue: "停止" })}
              </button>
            )}
            {phase === "result" && (
              <>
                <button className={shell.btnSecondary} onClick={handleGenerate} disabled={!modelId}>
                  <RotateCw size={12} /> {t("lore.improve.regenerate", { defaultValue: "重新生成" })}
                </button>
                <button
                  className={shell.btnPrimary}
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
