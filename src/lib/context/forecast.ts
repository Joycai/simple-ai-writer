/**
 * 生成面板「上下文分配」条背后的预估：这一次请求会把模型的窗口切成什么样。
 *
 * 镜像 `aiTaskStore.runTask` 真正做的那套规划，减去需要读盘的部分（全书前情的
 * 构建、真正的知识库检索）。它是**预估**不是记录——落地后的实际切分由运行自己
 * 报告（`contextAlloc` + `loreReport`）。模型没声明上下文大小时返回 null：那种
 * 情况下没有计划可画，只有一句静态兜底的说明。
 *
 * ## 为什么它从组件里搬了出来（2026-08-27）
 *
 * 原来这段逻辑就地写在 `AiPanel` 的一个 `useMemo` 里，而那个作用域里同时躺着
 * 两个任务对象：作者点的那个格子（`task`）和**真正会跑的那个**（`runTaskDef`
 * ——Agent 模式会把 `custom` 换成 `agent`）。工具开销那一行取了前者，于是：
 *
 *   32k 窗口 / 50% 占用，Agent 模式开着
 *     面板画：工具 —（段不存在）· 近期 5,200 · 条目 4,000 · 余量 2,800
 *     实际跑：工具 11,796      · 近期   204 · 条目     0 · 余量     0
 *
 * 面板承诺 4,000 tk 的条目，运行注入零。而这类错**不报任何错**——作者只会看见
 * 注入报告是空的，然后去改一份本来没问题的知识库。
 *
 * 所以这里只收**一个**任务对象，并且它叫 {@link ForecastInput.runTask}：每一处
 * 「这个任务是续写吗 / 有没有参考窗口选择器 / 带哪一档工具集」的分支都收进这个
 * 函数里，调用点再也没有可以取错的第二个候选。
 *
 * 界面用哪个任务是另一回事（画哪些控件跟着作者点的那个格子走），这条边界本身
 * 就是这个模块存在的理由——见 `docs/feature/context-meters.md`。
 */

import type { Model } from "../ai/configDb";
import { presetForTools } from "../agent/presets";
import { plannedToolTokens } from "../agent/toolCost";
import type { SubAgentConfig, SubAgentKind } from "../agent/subagent";
import type { TaskDef } from "../profile/model";
import { BOOK_PREV_TAIL_CHARS } from "./bookContext";
import { fixedContextChars, measureCharsPerToken, planContextBudget } from "./budget";

export type ForecastSegmentKey = "tools" | "recent" | "lore" | "memory" | "free";

export interface ContextForecast {
  /**
   * 条上的段，按顺序。
   *
   * **合计不等于输入上限**：固定成本（系统提示 / 任务指令 / 选区 / 大纲 / 附加
   * 知识）今天没有自己的段，它只是把「余量」减小，所以条的总宽是
   * `上限 − 固定成本`。页脚的「预计输入」**含**固定成本，两个数因此差着它。
   */
  segments: { key: ForecastSegmentKey; chars: number }[];
  charsPerToken: number;
  /** 这次请求可以花在输入上的上限（tokens）。 */
  ceilingTokens: number;
  /** 预估真正会花掉多少（tokens），含固定成本与工具 schema。 */
  usedTokens: number;
  /** 为回复留出的额度。 */
  reservedOutputTokens: number;
}

export interface ForecastInput {
  /**
   * **真正会跑的那个任务**——不是作者点的那个格子。
   *
   * Agent 模式下这两者是不同的对象（`custom` → `agent`），而它们的工具档、是否
   * 续写、有没有参考窗口选择器全都不一样。取错了不会报错，只会让整条预估描述一
   * 个没人会发的请求（见文件头）。
   */
  runTask: TaskDef;
  contextSize: number;
  maxOutputTokens: number | undefined;
  utilization: number;
  loreBudgetTokens: number;
  /** 算工具 schema 用——路由要知道哪些子代理在场。 */
  subAgents: Record<SubAgentKind, SubAgentConfig>;
  models: Model[];
  systemPromptChars: number;
  instructionChars: number;
  /** 选区原始长度；续写任务不带选区，由本函数按 `runTask` 归零。 */
  selectionChars: number;
  /** 大纲原始长度；只有续写任务会带，同上。 */
  outlineChars: number;
  /** 附加知识原始长度；只有续写任务会带，同上。 */
  knowledgeChars: number;
  /** 用来实测这份稿子的字/token 比。 */
  documentText: string;
  /** 锚点之前有多少正文——参考窗口最多只能长到这么大。 */
  anchorOffset: number;
  /** 作者在「参考上文」里选的字数；任务没有那个选择器时本函数忽略它。 */
  contextChars: number;
  /** 作者选的续写长度；非续写任务本函数忽略它。 */
  continueLength: number | undefined;
  memoryChars: number;
}

export function planForecast(input: ForecastInput): ContextForecast | null {
  const {
    runTask, contextSize, maxOutputTokens, utilization, loreBudgetTokens, subAgents,
    models, systemPromptChars, instructionChars, documentText, anchorOffset, memoryChars,
  } = input;
  if (contextSize <= 0) return null;

  // 这三条分支全部只认 `runTask`。调用点不再各自判断一遍——那正是工具开销取错的
  // 成因（文件头）。
  const isContinue = !!runTask.continuation;
  const supportsExtras = !!runTask.referenceWindow;
  const toolSchemaTokens = plannedToolTokens(
    presetForTools(runTask.tools), subAgents, models,
  );

  const charsPerToken = measureCharsPerToken(documentText);
  const fixedChars = fixedContextChars({
    systemPromptChars,
    taskInstructionChars: instructionChars,
    selectionChars: isContinue ? 0 : input.selectionChars,
    outlineChars: isContinue ? input.outlineChars : 0,
    knowledgeChars: isContinue ? input.knowledgeChars : 0,
    prevChapterTailChars: isContinue ? BOOK_PREV_TAIL_CHARS : 0,
  });
  const plan = planContextBudget({
    contextSize,
    maxOutputTokens,
    utilization,
    loreBudgetTokens,
    toolSchemaTokens,
    fixedChars,
    // 没有选择器的任务（续写/自定义）不传，参考窗口就成为一个可规划的层。
    recentWindowChars: supportsExtras ? input.contextChars : undefined,
    availableRecentChars: Math.max(0, anchorOffset),
    hasMemory: memoryChars > 0,
    includeBookContext: isContinue,
    replyChars: isContinue ? input.continueLength : undefined,
    charsPerToken,
  });

  // Clip each layer to what actually exists — a budget the manuscript can't
  // fill is headroom, not usage, and showing it as usage would make the bar
  // lie about how much room is left for lore.
  const recent = Math.min(plan.recentWindowChars, Math.max(0, anchorOffset));
  const lore = plan.loreChars;
  const memory = Math.min(plan.memoryChars, memoryChars) + plan.bookPriorChars;

  // The plannable layers are measured against the **message** ceiling; the
  // tool schemas sit outside it, so the toolset reads as space taken from the
  // layers rather than as a ceiling that quietly shrank.
  const ceilingChars = Math.floor(plan.messageCeilingTokens * charsPerToken);
  const free = Math.max(0, ceilingChars - fixedChars - recent - lore - memory);
  const toTokens = (chars: number) => Math.round(chars / charsPerToken);
  // Converted for geometry only, and it round-trips exactly: the tooltip
  // divides by the same ratio to print the token count back.
  const toolChars = plan.toolSchemaTokens * charsPerToken;

  return {
    segments: [
      { key: "tools", chars: toolChars },
      { key: "recent", chars: recent },
      { key: "lore", chars: lore },
      { key: "memory", chars: memory },
      { key: "free", chars: free },
    ],
    charsPerToken,
    ceilingTokens: plan.inputCeilingTokens,
    usedTokens: toTokens(fixedChars + recent + lore + memory) + plan.toolSchemaTokens,
    reservedOutputTokens: plan.reservedOutputTokens,
  };
}
