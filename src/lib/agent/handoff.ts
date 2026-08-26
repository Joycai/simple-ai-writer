/**
 * 写手交接（writer handoff）—— 一次运行的**收尾阶段**，不是一个工具。
 *
 * 主模型负责收集材料与做决定，最终成文交给作者另外绑定的一个模型。开关一开
 * 就必然发生：写手若是一个工具，模型就得自己决定调不调，那正是本设计要避开的
 * 那个判断。所以它住在 `finishPolicy: "handoff"` 的收尾轮里（runtime.ts），由
 * 运行时强制主模型交出一张**交接单**，然后带着交接单去跑写手。
 *
 * 与 `subagent.ts` 里四个 delegate 的关键区别，也是这个模块存在的理由：
 *
 *   - delegate 是**归纳型**：产出落 note，只回 800 字摘要——原材料绝不进主上下文；
 *   - 写手是**终结型**：产出**就是这一轮给作者的文本**，一字不能改。
 *
 * 由此第一条不变量：**正文字节不经任何模型二次输出。** 让主模型把写手的产出
 * 复述一遍，付两次 output token 是小事，必然被悄悄改写才是大事——而文风正是
 * 启用写手的唯一理由。`registry.ts` 的 `copy_lore_file` 早就把这句话写下来过：
 * 「the content never passes through you … a copy cannot」。`deliverTo` 就是把
 * 那条原则推广到写手身上：主模型只声明落盘意图，字节由运行时搬。
 *
 * 设计与取舍：docs/feature/agent/writer-subagent-plan.md
 */

import i18n from "../../i18n";
import type { StreamMessage, ToolDefinition } from "../ai/types";
import { costFor } from "../ai/configDb";
import { connOptions } from "../ai/conn";
import { persistUsage } from "../ai/usage";
import { fileExists, readFile } from "../fs/fileio";
import { normalizeChapterFileName } from "../context/outline";
import { baseName, dirName, joinPath, resolveWorkspacePath } from "../paths";
import type { AgentEvent } from "./events";
import { occurrenceAt, sliceLines } from "./editApply";
import { WRITER_PRESET } from "./presets";
import type { ToolContext } from "./registry";
import { runAgent } from "./runtime";
import { listTaskNotes } from "./taskWorkspace";

/** The tool the runtime forces on the handoff round. Never in the registry. */
export const HANDOFF_TOOL_NAME = "handoff";

/** 交付形态。写手的成文指令按这个分支——不分支，问一句话也会得到一篇散文。 */
export type HandoffKind = "prose" | "analysis" | "answer";

const HANDOFF_KINDS: readonly HandoffKind[] = ["prose", "analysis", "answer"];

/** 落盘意图。写手不写盘——这里声明的是**运行时**替它做的那一次写入。 */
export interface DeliverTo {
  path: string;
  mode: "create" | "append" | "rewrite" | "replace_lines";
  /** replace_lines 专用，1 起。 */
  range?: { from: number; to: number };
}

/**
 * 交接单：主模型交给写手的工单。
 *
 * **材料给路径而不是正文。** 任务工作区（subagent-lld.md §3）存在的理由恰好就是
 * 这个：让一个全新上下文读到主模型收集的东西。主模型把材料抄进交接单花的是它的
 * output token（贵的那一半），而 note 已经在盘上了。
 *
 * `styleAnchors` 是唯一的例外，且必须是**原文片段**：用形容词描述文风（「冷峻、
 * 克制」）等于让写手去猜，而猜出来的就是通用腔。
 */
export interface HandoffBrief {
  goal: string;
  constraints: string[];
  styleAnchors: string[];
  notes: string[];
  kind: HandoffKind;
  length?: string;
  forbid: string[];
  deliverTo?: DeliverTo;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((s) => s.trim());
}

function parseDeliverTo(v: unknown): DeliverTo | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const path = typeof o.path === "string" ? o.path.trim() : "";
  const mode = o.mode;
  if (!path) return undefined;
  if (mode !== "create" && mode !== "append" && mode !== "rewrite" && mode !== "replace_lines") {
    return undefined;
  }
  const raw = o.range as Record<string, unknown> | undefined;
  const from = Math.floor(Number(raw?.from));
  const to = Math.floor(Number(raw?.to));
  const range =
    Number.isFinite(from) && Number.isFinite(to) && from >= 1 && to >= from
      ? { from, to }
      : undefined;
  // A replace_lines with no usable range is not a narrower write, it is an
  // unlocatable one. Dropping the whole intent turns it into "just answer",
  // which is recoverable; keeping it would make the runtime guess at a region.
  if (mode === "replace_lines" && !range) return undefined;
  return { path, mode, ...(range ? { range } : {}) };
}

/**
 * Parse the forced call's arguments, leniently.
 *
 * Never throws and never returns null: by the time this runs the author has
 * already been charged for the whole main run, and refusing to hand off over a
 * malformed field would throw that away. A brief with an empty goal is still a
 * brief — `renderBrief` shows the writer what it got.
 */
export function parseHandoffBrief(raw: string): HandoffBrief {
  let o: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object") o = parsed as Record<string, unknown>;
  } catch {
    /* leniently: an unparseable call still hands off, see above */
  }
  const kind = HANDOFF_KINDS.includes(o.kind as HandoffKind) ? (o.kind as HandoffKind) : "prose";
  return {
    goal: typeof o.goal === "string" ? o.goal.trim() : "",
    constraints: asStringArray(o.constraints),
    styleAnchors: asStringArray(o.style_anchors ?? o.styleAnchors),
    notes: asStringArray(o.notes),
    kind,
    length: typeof o.length === "string" && o.length.trim() ? o.length.trim() : undefined,
    forbid: asStringArray(o.forbid),
    deliverTo: parseDeliverTo(o.deliver_to ?? o.deliverTo),
  };
}

/**
 * 降级路径的交接单：主模型没调 `handoff`，只吐了文本。
 *
 * 这条路**必须存在**，而且必须仍然委托。MiniMax 的 `switch` thinking dialect 上
 * forced tool_choice 会被静默降级成 `auto`（lib/ai/openai.ts 的 `toolChoiceFor`、
 * lib/ai/anthropic.ts 的 `toolChoiceBody`，两处注释都论证过那对 `structured.ts`
 * 是安全的——对本设计不是）。降级之后若退回「主模型自己写」，作者开了开关、
 * 看到的却是主模型的输出，而且没有任何报错：开关形同虚设。
 *
 * 所以把主模型这一轮吐出的文本当作工单正文，材料取本次运行写过的全部 note。
 */
export function fallbackBrief(text: string, notes: string[]): HandoffBrief {
  return {
    goal: text.trim(),
    constraints: [],
    styleAnchors: [],
    notes,
    kind: "prose",
    forbid: [],
  };
}

/** 本次运行落过盘的全部 note 路径，供降级路径当材料索引用。 */
export async function collectRunNotes(ctx: ToolContext): Promise<string[]> {
  const taskId = ctx.taskWorkspace?.taskId;
  if (!taskId) return [];
  try {
    return (await listTaskNotes(ctx.projectPath, taskId)).map((n) => n.path);
  } catch {
    return [];
  }
}

export function handoffToolDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: HANDOFF_TOOL_NAME,
      description:
        "Hand the finished thinking to the writer, who produces the text the author will actually read. " +
        "You do NOT write the deliverable yourself — this call IS your answer for this turn. " +
        "Reference material by path (notes, documents, lore entries): the writer reads them itself, so do not " +
        "paste their contents here. Style anchors are the one exception and must be VERBATIM excerpts, " +
        "never adjectives.",
      parameters: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description:
              "What must be delivered this turn, in one or two sentences. The writer cannot see this conversation.",
          },
          kind: {
            type: "string",
            enum: ["prose", "analysis", "answer"],
            description:
              "prose — manuscript text; analysis — a considered assessment; answer — a direct reply to a question. " +
              "Pick what the author actually asked for; a yes/no question is an 'answer', not an essay.",
          },
          constraints: {
            type: "array",
            items: { type: "string" },
            description:
              "Things the writer must not contradict: settings facts, plot points, the author's explicit requests.",
          },
          style_anchors: {
            type: "array",
            items: { type: "string" },
            description:
              "VERBATIM excerpts from the manuscript or lore that show the voice to match. Never adjectives.",
          },
          notes: {
            type: "array",
            items: { type: "string" },
            description:
              "Paths the writer should read: task notes, documents, lore entries. Paths only — never their contents.",
          },
          length: { type: "string", description: "Rough target length, e.g. '800-1200 字'." },
          forbid: {
            type: "array",
            items: { type: "string" },
            description: "Things to avoid: clichés, spoilers, a tone the author rejected.",
          },
          deliver_to: {
            type: "object",
            description:
              "Where the text should land on disk, when it should. Omit for a reply that stays in the conversation. " +
              "The author still approves the write on a card, and you never re-type the text: the app moves the bytes.",
            properties: {
              path: { type: "string", description: "Project-relative file path." },
              mode: {
                type: "string",
                enum: ["create", "append", "rewrite", "replace_lines"],
                description:
                  "create — a new file; append — add to the end of an existing one; rewrite — replace the whole file; " +
                  "replace_lines — replace the line range given in 'range' (read_file's trailer reports the numbers).",
              },
              range: {
                type: "object",
                properties: {
                  from: { type: "integer" },
                  to: { type: "integer" },
                },
                description: "1-indexed inclusive line range; required for replace_lines.",
              },
            },
            required: ["path", "mode"],
          },
        },
        required: ["goal", "kind"],
      },
    },
  };
}

function section(label: string, lines: string[]): string {
  return lines.length ? `\n\n【${label}】\n${lines.map((l) => `- ${l}`).join("\n")}` : "";
}

/** 交接单渲染成写手看到的那条 user 消息。 */
export function renderBrief(brief: HandoffBrief): string {
  const t = (k: string) => i18n.t(`ai.instructions.handoffBrief.${k}`);
  let out = `${t("goal")}\n${brief.goal || t("goalMissing")}`;
  out += section(t("constraints"), brief.constraints);
  // 原文片段用引用块而不是列表项：它们本身可能是多行的，列表会把换行吃掉，
  // 而换行正是"这段文字长什么样"的一部分。
  if (brief.styleAnchors.length) {
    out += `\n\n【${t("styleAnchors")}】\n${brief.styleAnchors
      .map((s) => s.split("\n").map((l) => `> ${l}`).join("\n"))
      .join("\n>\n")}`;
  }
  out += section(t("notes"), brief.notes);
  out += section(t("forbid"), brief.forbid);
  if (brief.length) out += `\n\n【${t("length")}】\n${brief.length}`;
  return out;
}

/**
 * 写手的 system 层 = 成文指令 + **调用方的 system 层**。
 *
 * 继承那一段不是客气：chat 的写作提示词里带着 `profileSystemPrompt()` 与能力包的
 * 措辞，写手拿不到就不知道这个项目管它叫「文档」还是「章节」，出来的正文用词跟
 * 项目对不上。继承的是调用方**指定**的那一段，不是 `history[0]` 整条——后者还
 * 挂着 agent briefing、工作流清单、docx 预设，那些是工具循环的机器，喂给一个
 * 没有这些工具的写手只会让它谈论自己没有的能力。
 */
export function writerSystemPrompt(brief: HandoffBrief, inherited?: string): string {
  const base = i18n.t("ai.instructions.writer.base");
  const byKind = i18n.t(`ai.instructions.writer.${brief.kind}`);
  const persona = inherited?.trim()
    ? `\n\n## ${i18n.t("ai.instructions.writer.inheritedHeading")}\n${inherited.trim()}`
    : "";
  return `${base}\n\n${byKind}${persona}`;
}

export interface WriterHandoffArgs {
  brief: HandoffBrief;
  /** True when the brief came from {@link fallbackBrief} — see its comment. */
  degraded: boolean;
  /** The parent run's tool context; the writer gets a read-only slice of it. */
  ctx: ToolContext;
  /** System-layer text the writer inherits — see {@link writerSystemPrompt}. */
  inheritedSystem?: string;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  /** The writer's text so far, in full — piped straight into the parent's output. */
  onText: (text: string) => void;
  /** Log-tree parent for the nested run's events. */
  stepId: string;
}

export interface WriterHandoffResult {
  text: string;
  /** Set when the handoff could not run; the caller reports it to the author. */
  error?: string;
  /**
   * What the **writer's** model spent — already persisted here as a
   * `subagent:writer` row and already on the nested `run-done`.
   *
   * Reported, never added to the parent run's totals. Those are priced with the
   * *main* model's rate by the caller and written as one `chat` row, so folding
   * these in bills the same tokens twice at two different prices, and Settings
   * → 用量 sums every row. `executeDelegate` keeps its sub-run out for exactly
   * this reason; the writer is no different.
   */
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Present when the brief carried `deliverTo` and the write was attempted. */
  delivered?: { path: string; approved: boolean; detail?: string };
}

/**
 * Run the writer and (optionally) land its output on disk.
 *
 * Accounting is the sub-run's own, exactly like `executeDelegate`: a
 * `run-done` event under `stepId` so the author sees the cost of the step they
 * are watching, plus a `token_usage` row tagged `subagent:writer`.
 */
export async function runWriterHandoff(args: WriterHandoffArgs): Promise<WriterHandoffResult> {
  const { brief, degraded, ctx, signal, onEvent, onText, stepId } = args;
  const empty = { text: "", inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  const startedAt = Date.now();

  /**
   * Both bracket events are emitted here rather than by the caller, because the
   * open one carries the writer's model name and only this function has
   * resolved it by then — and the author needs that name while the text is
   * still streaming, not after.
   */
  const open = (model?: string) =>
    onEvent({
      kind: "handoff",
      step: stepId,
      brief,
      ...(degraded ? { degraded: true as const } : {}),
      ...(model ? { model } : {}),
      at: Date.now(),
    });
  const close = (
    extra: { chars: number } & Partial<{
      error: string;
      inputTokens: number;
      outputTokens: number;
      cost: number;
      delivered: { path: string; approved: boolean };
    }>,
  ) =>
    onEvent({
      kind: "handoff-done",
      step: stepId,
      elapsedMs: Date.now() - startedAt,
      ...extra,
      at: Date.now(),
    });

  if (!ctx.resolveSubAgent) {
    const error = i18n.t("ai.errors.writerUnavailable");
    open();
    close({ chars: 0, error });
    return { ...empty, error };
  }
  const conn = await ctx.resolveSubAgent("writer");
  if ("error" in conn) {
    open();
    close({ chars: 0, error: conn.error });
    return { ...empty, error: conn.error };
  }
  open(conn.model.name);

  const messages: StreamMessage[] = [
    { role: "system", content: writerSystemPrompt(brief, args.inheritedSystem) },
    { role: "user", content: renderBrief(brief) },
  ];

  let text = "";
  let result;
  try {
    result = await runAgent({
      ...connOptions(conn),
      preset: WRITER_PRESET,
      messages,
      toolContext: {
        projectPath: ctx.projectPath,
        loreIndex: ctx.loreIndex,
        multimodal: conn.model.type === "multimodal",
        // The parent's handle, passed as-is. Safe because WRITER_PRESET carries
        // no tool that writes into the workspace — the constraint is the
        // toolset, not the handle, the same way the roleplay scene tools are
        // kept from a character by simply not being in its preset.
        taskWorkspace: ctx.taskWorkspace,
        signal,
      },
      signal,
      onEvent: (e) => onEvent({ ...e, parentStep: stepId }),
      onOutputText: (full) => {
        text = full;
        onText(full);
      },
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    const error = (e as Error).message;
    close({ chars: text.length, error });
    return { ...empty, text, error };
  }

  onEvent({
    kind: "run-done",
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    at: Date.now(),
    parentStep: stepId,
  });
  const cost = costFor(conn.model, result.inputTokens, result.outputTokens, result.cachedTokens);
  await persistUsage(
    ctx.projectPath,
    conn.model.id,
    result.inputTokens,
    result.outputTokens,
    cost,
    "subagent:writer",
    result.cachedTokens,
  );

  const usage = {
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cachedTokens: result.cachedTokens,
  };

  const accounted = {
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cost,
  };

  if (!text.trim()) {
    const error = i18n.t("ai.errors.writerEmpty");
    close({ chars: 0, error, ...accounted });
    return { ...usage, text, error };
  }

  const delivered = brief.deliverTo
    ? await deliverWriterOutput(brief.deliverTo, text, ctx)
    : undefined;

  close({
    chars: text.length,
    ...accounted,
    ...(delivered ? { delivered: { path: delivered.path, approved: delivered.approved } } : {}),
  });
  return { ...usage, text, ...(delivered ? { delivered } : {}) };
}

/**
 * 引用式写入：把写手的产出落到作者指定的位置。
 *
 * 这里是 §5.4 那条不变量真正成立的地方——`content` 从来没有经过任何模型的输出，
 * 它是写手的流直接进的提案。所以不需要新的 Proposal 类型：区别不在数据结构上，
 * 在于**谁打的这些字**。
 */
async function deliverWriterOutput(
  deliverTo: DeliverTo,
  text: string,
  ctx: ToolContext,
): Promise<{ path: string; approved: boolean; detail?: string }> {
  const fail = (detail: string) => ({ path: deliverTo.path, approved: false, detail });

  if (!ctx.requestApproval) return fail(i18n.t("ai.errors.writerNoApproval"));
  const resolved = resolveWorkspacePath(ctx.projectPath, deliverTo.path);
  if (!resolved) return fail(i18n.t("ai.errors.writerPathOutside", { path: deliverTo.path }));

  // `createEntry` runs the name through `normalizeChapterFileName`, so an
  // extensionless "第五章" lands at "第五章.md". Applying it here as well is what
  // keeps the card, the collision check below and the file that actually
  // appears from being three different paths — the same thing `create_chapter`
  // does before it proposes (lib/agent/writeTools).
  const path =
    deliverTo.mode === "create"
      ? joinPath(dirName(resolved), normalizeChapterFileName(baseName(resolved)))
      : resolved;

  const id = `writer-${Date.now()}`;
  // See ProposalBase.fromWriter — this function is the only place it is true.
  const fromWriterFlag = { fromWriter: true as const };
  try {
    if (deliverTo.mode === "create") {
      // Checked *before* the card, not left to the apply: `createEntry` throws
      // on a collision, so without this the author reads the writer's text,
      // approves a create, and gets an error where the file should be. The
      // text is already in the conversation either way — reporting the clash
      // here costs nothing and asks nothing.
      if (await fileExists(path)) {
        return fail(i18n.t("ai.errors.writerExists", { path: deliverTo.path }));
      }
      const decision = await ctx.requestApproval({ kind: "create", id, path, content: text, ...fromWriterFlag });
      return { path, approved: decision.approved, ...(decision.approved ? {} : { detail: decision.reason }) };
    }

    const original = await readFile(path);

    if (deliverTo.mode === "append") {
      const decision = await ctx.requestApproval({
        kind: "append", id, path, content: text, originalChars: original.length, ...fromWriterFlag,
      });
      return { path, approved: decision.approved, ...(decision.approved ? {} : { detail: decision.reason }) };
    }
    if (deliverTo.mode === "rewrite") {
      const decision = await ctx.requestApproval({
        kind: "rewrite", id, path, content: text, originalChars: original.length, ...fromWriterFlag,
      });
      return { path, approved: decision.approved, ...(decision.approved ? {} : { detail: decision.reason }) };
    }

    const { from, to } = deliverTo.range!;
    const slice = sliceLines(original, from, to);
    if (!slice || slice.text === "") {
      return fail(i18n.t("ai.errors.writerRangeGone", { from, to }));
    }
    // Same welding guard as rewrite_lines: the slice carries its last line's
    // terminator, so a replacement without one runs the next line onto this text.
    let replace = text;
    if (slice.text.endsWith("\n") && replace !== "" && !replace.endsWith("\n")) replace += "\n";
    const { occurrences, index } = occurrenceAt(original, slice.text, slice.start);
    const decision = await ctx.requestApproval({
      kind: "edit",
      id,
      path,
      find: slice.text,
      replace,
      occurrences,
      target: occurrences === 1 ? undefined : index,
      range: { from, to: slice.to },
      ...fromWriterFlag,
    });
    return { path, approved: decision.approved, ...(decision.approved ? {} : { detail: decision.reason }) };
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    return fail(String(e));
  }
}
