/**
 * 互动式角色扮演的状态：花名册 + 每个 agent 的活会话 + 并发闸。
 *
 * ## 为什么是一个新 store 而不是改造 agentStore
 *
 * `agentStore` 从字段设计上就是「当前只有一个对话」（`turns` / `chatHistory` /
 * `chatRunning` / `chatAbort` / `chatSessionId` … 全是单值）。把它改成
 * `Map<id, Session>` 会波及 AgentChat、AiDrawer、审批队列、任务工作区——用一次
 * 高风险重构换「代码复用」。这里天然就是 `Record<agentId, …>`，而 agentStore
 * 一行不改。
 *
 * 复用的接缝落在 `runAgent()` 和 `lib/roleplay/context`，**不在
 * `agentStore.sendChat()`**：那 270 行里塞满了写作助手专有的东西（文档焦点、
 * 故事记忆、计划模式、任务清单），扮演一样都不需要。
 *
 * ## 三条落在这个文件里的不变量
 *
 * 1. **transcript 先写、后跑模型。** 作者按下发送的那一刻字就落盘了；模型
 *    调用失败、被中止、应用崩溃，都不该让作者写的那句话消失。
 * 2. **绑定块的对象身份由 meta 持有**（见 lib/roleplay/context），所以刷新
 *    绑定是就地改 content，不是换消息。
 * 3. **旁白的 SceneReader 每次都读盘**，因为 ToolContext 是运行快照，而作者
 *    完全可能在旁白思考的这十几秒里去和别的角色聊了三轮。
 */

import { create } from "zustand";
import i18n from "../i18n";
import { backupFile } from "../lib/agent/backup";
import { appendAgentEventTo, type AgentEvent } from "../lib/agent/events";
import { createStreamThrottle } from "../lib/agent/streamThrottle";
import { summarizeForCompaction } from "../lib/agent/compactRun";
import { presetFor } from "../lib/roleplay/presets";
import { routeTools } from "../lib/agent/routing";
import { repairToolCallPairing, runAgent } from "../lib/agent/runtime";
import { createTaskWorkspace, type TaskWorkspaceHandle } from "../lib/agent/taskWorkspace";
import {
  resolveSubAgentConn, withSessionOverrides, type SubAgentKind,
} from "../lib/agent/subagent";
import { connOptions, resolveConn } from "../lib/ai/conn";
import { costFor } from "../lib/ai/configDb";
import { recordRunOutcome } from "../lib/ai/modelHealth";
import { persistUsage } from "../lib/ai/usage";
import type { MessageContent, StreamMessage } from "../lib/ai/types";
import { measureCharsPerToken } from "../lib/context/budget";
import { messageCeilingFor } from "../lib/agent/toolCost";
import { hashText } from "../lib/context/memory";
import { loadApiKey } from "../lib/keyStore";
import { notify } from "../lib/notify";
import {
  buildBoundContent, buildSystemPrompt, contextSignature, ensureBlocks,
  recordPrimaryCore, refreshBoundBlock, residentCoreDirs,
  refreshMemoryBlock, refreshSystemPrompt,
  type BoundContent, type RoleplaySessionMeta,
} from "../lib/roleplay/context";
import {
  addRecord, dropRecordsFrom, loadMemoryDoc, reviseRecord, saveMemoryDoc, takeSinkable,
  type MemoryDoc,
} from "../lib/roleplay/memory";
import type { AgentMemoryStore } from "../lib/roleplay/memoryTools";
import {
  AREA_BUDGET_TOKENS, MAX_CONCURRENT_RUNS, NO_PERSONA, ROSTER_PREVIEW_CHARS, generateAgentId,
  type AgentKind, type AuthorPersona, type MemoryRecord, type MemoryStatus,
  type RoleplayAgent, type SceneTurn,
} from "../lib/roleplay/model";
import { scriptPreview } from "../lib/roleplay/markup";

import { runSceneRecap, type SceneRecap } from "../lib/roleplay/recap";
import {
  conversationReader, loadStaticContext, prepareContinuedHistory, prepareSeededHistory,
  type RecalledEntity,
} from "../lib/roleplay/run";
import {
  addAreaEntry, createArea, isValidAreaId, listAreas, loadAreaMeta,
  saveAreaMeta, type AreaSummary,
} from "../lib/roleplay/area";
import type { SceneInfo, SceneReader, SceneSlice } from "../lib/roleplay/sceneTools";
import {
  archiveSession, deleteAgentDir, loadPersonaCard, loadRoster, loadSession, loadSummary,
  memoryPath, peekNextArchiveNo, saveRoster, savePersonaCard, saveSession, saveSummary,
  sessionPath, summaryPath, transcriptPath,
} from "../lib/roleplay/store";
import {
  appendTurn, loadTranscript, renderTranscript, truncateTurns,
} from "../lib/roleplay/transcript";
import { fileExists, removeFile, writeFile } from "../lib/fs/fileio";
import { contributingEntities } from "../lib/context/loreSelect";
import { readEntityFile } from "../lib/lore/entity";
import type { AttachedItem } from "../lib/lore/aiTask";
import type { LoreEntity, LoreIndex } from "../lib/lore/model";

interface Job {
  agentId: string;
  /** 上线的内容：作者原文 + `@` 引用内联进来的材料。 */
  wire: MessageContent;
  /** 检索用的纯文本（图片没有词可匹配）。 */
  match: string;
  /**
   * `@` 引用把正文内联进 `wire` 的知识库条目（dirPath）。
   *
   * 引用块和自动检索是两条各自独立的路：不告诉后者「这一份已经在问句里了」，
   * 同一条 index.md 会在同一次请求里出现两遍。
   */
  refDirs: string[];
  /**
   * 这一问已经进过 `history` 了。
   *
   * 重试必须知道这件事：`runJob` 是**就地** push 进 `session.history` 的，所以
   * 原样重跑一遍会让同一句话在上下文里出现两次。置上之后重试直接拿现有历史
   * 开跑——失败的是模型调用，不是这一问的组装。
   */
  committed?: boolean;
}

/** 一个活着的会话。只有被打开过的 agent 才有。 */
export interface LiveSession {
  /** 显示用的对话，**从 transcript 派生**——不从 session.json 来。 */
  turns: SceneTurn[];
  /** 本次运行的执行日志，按轮号。只在内存：它是调试信息，不是作品。 */
  log: Record<number, AgentEvent[]>;
  history: StreamMessage[] | null;
  meta: RoleplaySessionMeta | null;
  /** 流式中的回复正文。 */
  streaming: string;
  /** 本轮的执行日志（还没有轮号可挂）。 */
  liveLog: AgentEvent[];
  usage: { inputTokens: number; outputTokens: number; cost: number } | null;
  /** 失效的绑定（条目/特征已删）。基线哈希在 `RoleplayAgent.contextHash` 上。 */
  stalePaths: string[];
  /** 这个 agent 的记忆，记事本面板的数据源；写入后同步更新。 */
  memory: MemoryRecord[];
  /** 磁盘上的记忆已经变了，但注入块还没刷新（见 refreshMemoryBlock 的四个时刻）。 */
  memoryStale: boolean;
  workspace: TaskWorkspaceHandle | null;
  /**
   * 这一轮是被作者按停的（不是报错）。
   *
   * 和 `error` 分开，因为它们不是同一件事：报错是「出了问题」，按停是「我不想
   * 要这一条了」。但**后果一样**——这一问已经在 transcript 里，却没有回复。所以
   * 两边都通向同一个 `retry`。
   */
  stopped: boolean;
  /**
   * 每一轮想起了记忆区里的哪几条。稿面上那道「想起了…」的痕迹读它。
   *
   * 按轮号存而不是只留最新一条：作者往回翻的时候，第 12 轮为什么那么答，要能在
   * 第 12 轮的位置看见。
   */
  recalled: Record<number, { name: string; dirPath: string }[]>;
  /**
   * 这一场关掉了哪些子代理。**只减不增**——芯片关不出一个没绑模型的子代理来。
   *
   * 存在会话上而不是 agentStore：对话助手和三个并发的扮演 agent 是四段互不相干
   * 的对话，共用一份「本次关掉了什么」就等于互相改设置。
   */
  disabledSubAgents: SubAgentKind[];
  /**
   * 任务工作区的 id，跨重启活下来。
   *
   * 存在会话上而不是 `RoleplayAgent` 上：它跟着**这一场**走，「新开会话」就该
   * 换一个。（`RoleplayAgent.taskId` 曾经存在过，但从来没有人写回去，所以每次
   * 重启都会新建一个再也没人认领的工作区目录。）
   */
  taskId: string | null;
  /**
   * `history` 变过几次。
   *
   * 上下文构成条要靠它才知道该重算：那个数组是**就地** push 的（`runJob` 里
   * 的注入、提问、runAgent 自己的工具轮），引用从头到尾不变，React 看不见。
   */
  contextVersion: number;
  error: string | null;
  /**
   * 上一次跑过的作业，重试用。重试入口只在 `error` 亮着时露出——「重试」在这里
   * 的含义是**这一轮压根没有回复**（网络断了、密钥不对、模型返回错误）。模型
   * 答了、只是答得不合意，不属于这一类：那已经是 transcript 里的一轮。
   */
  lastJob: Job | null;
}

interface RoleplayState {
  projectPath: string | null;
  loaded: boolean;
  rosterError: string | null;

  order: string[];
  agents: Record<string, RoleplayAgent>;
  authorPersona: AuthorPersona;

  sessions: Record<string, LiveSession>;
  activeAgentId: string | null;

  /** 正在生成的 agentId。上限 MAX_CONCURRENT_RUNS。 */
  running: string[];
  /** 排队中的作业，FIFO。 */
  queue: Job[];
  aborts: Record<string, AbortController>;
  /** 有新回复但作者没看的 agent。 */
  unread: Record<string, boolean>;
  /** 绑定的设定在会话开始后被改过。 */
  stale: Record<string, boolean>;
  /**
   * 项目里所有的记忆区，含条目数和占用情况。绑定选择器读它。
   *
   * 单独一份而不是挂在 agent 上：空闲的区**不属于任何 agent**，那正是继承要用
   * 到的那一批。
   */
  areas: AreaSummary[];

  load: (projectPath: string) => Promise<void>;
  reset: () => void;

  createAgent: (draft: AgentDraft) => Promise<string | null>;
  updateAgent: (id: string, draft: AgentDraft) => Promise<void>;
  removeAgent: (id: string) => Promise<void>;
  /**
   * 转场：把当前这一场封存进 `archive/`，agent 从空白开始。设定、绑定、人设卡
   * 全部保留——「重新开始」不该等于删了重建。
   *
   * 两支（`docs/feature/roleplay/06-scene-and-memory-area.md` §5）：
   * - `fresh` 另起一场，和上一场无关，可选一并清空记忆。
   * - `continue` 接续（客厅 → 卧室）：先让**角色自己**写一份前情，再封存。
   *   细节不留，前情留下。
   */
  newSession: (id: string, opts: NewSessionOptions) => Promise<void>;
  /**
   * 只跑摘要，不封存——给「接续」的预览用。作者看过、改过，再调 `newSession`
   * 把它带进去。返回 null 表示跑不出来（原因已经写进 `session.error`）。
   */
  previewRecap: (id: string, brief: string) => Promise<SceneRecap | null>;
  setAuthorPersona: (persona: AuthorPersona) => Promise<void>;
  /**
   * 只为这一个 agent 覆盖「我此刻是谁」。`null` = 撤销覆盖，跟回全局。
   *
   * 有这一层是因为作者不一定用同一个身份面对所有角色：对甲是「桐谷萤」，对乙
   * 可能是「一个陌生人」。类型上一直有（`RoleplayAgent.authorPersona`，`runJob`
   * 也一直读它），只是没有入口。
   */
  setAgentPersona: (id: string, persona: AuthorPersona | null) => Promise<void>;
  setAgentModel: (id: string, modelId: string | null) => Promise<void>;
  /** 这一场开/关一个子代理。只减不增，见 `LiveSession.disabledSubAgents`。 */
  toggleSubAgent: (id: string, kind: SubAgentKind) => void;

  select: (id: string | null) => Promise<void>;
  /** `quote` = 编辑器里选中的正文，随这一条消息上线（transcript 里仍只存作者敲的字）。 */
  send: (agentId: string, text: string, refs?: AttachedItem[], quote?: string) => Promise<void>;
  stop: (agentId: string) => void;
  /** 重跑上一次失败的作业。只在 `session.error` 亮着时有意义。 */
  retry: (agentId: string) => void;
  /**
   * 回退到某一个作者轮：那一轮及其之后的全部记录被撤销，原文交还给调用方去
   * 重编辑。返回被撤销的那一句，agent 不存在 / 正在跑 / 轮号不对时返回 null。
   */
  rewind: (agentId: string, turnIndex: number) => Promise<string | null>;
  dequeue: (agentId: string) => void;
  promote: (agentId: string) => void;
  refreshBinding: (agentId: string) => Promise<void>;
  /** 把磁盘上的记忆重新灌进注入块（作者手动，或改过记事本之后）。 */
  refreshMemory: (agentId: string) => Promise<void>;
  /** 记事本面板的编辑入口。作者和角色共同维护这一本。 */
  addMemory: (agentId: string, rec: {
    kind: MemoryRecord["kind"]; title: string; body: string; subject: string | null;
    keys?: string[];
  }) => Promise<void>;
  reviseMemory: (
    agentId: string, id: string, patch: { body?: string; status?: MemoryStatus },
  ) => Promise<void>;
  checkBindings: () => Promise<void>;
  /** 重扫记忆区列表。建/绑/解绑之后调。 */
  refreshAreas: () => Promise<void>;
  /**
   * 把一个 agent 绑到某个区上。`"new"` = 新建一个空的，`null` = 解绑。
   *
   * 一个区同时只能挂在一个 agent 上，所以这里会先把它从别人身上摘下来——由这一处
   * 统一维护，比让每个调用方自己记得靠谱。
   */
  bindArea: (agentId: string, target: string | "new" | null) => Promise<void>;
  /** 旁白的只读通道；传给 ToolContext.scenes。 */
  sceneReader: () => SceneReader;
}

export interface NewSessionOptions {
  mode: "fresh" | "continue";
  /** 仅 `fresh`：连记忆一起封存。接续不给这个选项——它明摆着要保留。 */
  clearMemory?: boolean;
  /**
   * 仅 `continue`：已经确认过的前情。
   *
   * 由调用方传进来而不是在这里现跑，是因为作者要先看一眼、能改——一份会成为
   * 角色长期记忆的东西，不该在他没看见的时候就落盘。
   */
  recap?: SceneRecap;
}

export interface AgentDraft {
  kind: AgentKind;
  name: string;
  primaryDirPath: string | null;
  boundPaths: string[];
  modelId: string | null;
  instruction: string;
  /**
   * 绑定的记忆区 id；`null` = 不要，`undefined` = 不动。
   *
   * 「新建一个区」**不走这里**——那是 `bindArea(id, "new")` 的事（它要摘旧的、
   * 抢占新的、写两份 meta）。这个字段曾经在类型上允许 `"new"` 字面量而
   * `createAgent` 原样存储，一个照类型办事的调用方会把字符串 "new" 写进花名册、
   * 随后每一轮 `scanArea("new")` 都在无效 id 上抛异常。现在存之前过
   * `isValidAreaId`。
   */
  areaId?: string | null;
}

function emptySession(): LiveSession {
  return {
    turns: [], log: {}, history: null, meta: null, streaming: "", liveLog: [],
    usage: null, stalePaths: [], memory: [], memoryStale: false,
    workspace: null, stopped: false, recalled: {}, disabledSubAgents: [], taskId: null,
    contextVersion: 0, error: null, lastJob: null,
  };
}

function indexByDir(loreIndex: LoreIndex): Map<string, LoreEntity> {
  const byDir = new Map<string, LoreEntity>();
  for (const entities of Object.values(loreIndex)) {
    for (const e of entities ?? []) byDir.set(e.dirPath, e);
  }
  return byDir;
}

export const useRoleplayStore = create<RoleplayState>((set, get) => {
  /** 局部更新一个会话，缺席时先建一个空的。 */
  const patchSession = (id: string, patch: (s: LiveSession) => LiveSession) =>
    set((st) => ({
      sessions: { ...st.sessions, [id]: patch(st.sessions[id] ?? emptySession()) },
    }));

  /**
   * transcript 的追加，按 agent 串行化；轮号在链内、追加前一刻才算出。
   *
   * 没有这条链时有一个窄但真实的竞态：发送在生成中是允许的（排队 UI 就是为此
   * 存在的），作者恰好在角色回复落盘的同一瞬按下发送，两条路径各自从**还没
   * patch 的旧 state** 读 `turns.length` 会算出同一个轮号——transcript 里出现
   * 两条 `[N]`，解析时被重排，wire history 和稿面就此错位。
   *
   * 模式同 loreStore 的扫描链：失败不楔死链（存进表里的是 catch 过的），但
   * 错误原样抛给本次调用方。
   */
  const appendChains: Record<string, Promise<unknown>> = {};
  const appendTurnChained = (
    agentId: string,
    make: () => Omit<SceneTurn, "index">,
  ): Promise<SceneTurn> => {
    const prev = appendChains[agentId] ?? Promise.resolve();
    const run = prev.then(async () => {
      const { projectPath } = get();
      if (!projectPath) throw new Error("project closed");
      const turns = get().sessions[agentId]?.turns ?? [];
      const turn: SceneTurn = { ...make(), index: turns.length + 1 };
      await appendTurn(transcriptPath(projectPath, agentId), agentId, turn);
      patchSession(agentId, (s) => ({ ...s, turns: [...s.turns, turn] }));
      return turn;
    });
    appendChains[agentId] = run.catch(() => {});
    return run;
  };

  const persistRoster = async () => {
    const { projectPath, order, agents, authorPersona } = get();
    if (!projectPath) return;
    try {
      await saveRoster(projectPath, {
        authorPersona,
        agents: order.flatMap((id) => agents[id] ?? []),
      });
    } catch (e) {
      console.warn("[roleplay] roster save failed:", e);
    }
  };

  /**
   * 记忆的读改写，全部经过这里。
   *
   * **写前必备份**（`backupFile`，与所有 L1 写工具一致）——这是 L1 唯一的安全阀。
   * 写完不刷新注入块，只标 `memoryStale`：刷新有它自己的四个时刻（见
   * lib/roleplay/context 的 refreshMemoryBlock），在写入的当下刷新会让每记一件
   * 事就作废一次 prompt 缓存前缀，换来零收益。
   */
  const mutateMemory = async (
    agentId: string,
    change: (doc: MemoryDoc) => { doc: MemoryDoc; record: MemoryRecord } | null,
  ): Promise<MemoryRecord | null> => {
    const { projectPath } = get();
    if (!projectPath) return null;
    const path = memoryPath(projectPath, agentId);
    const doc = await loadMemoryDoc(path);
    const result = change(doc);
    if (!result) return null;
    await backupFile(projectPath, path);
    await saveMemoryDoc(path, agentId, result.doc);
    patchSession(agentId, (s) => ({
      ...s, memory: result.doc.records, memoryStale: true,
    }));
    return result.record;
  };

  /**
   * 把「想起了…」记进会话。轮号 = 正在生成的这条回复的轮号：`send` 已经把作者
   * 轮追加过了，所以是 `turns.length + 1`。prepare 期间 turns 不会变——pump 保证
   * 同 agent 不并发跑，而 `send` 的追加发生在入队之前——所以这里算和检索那一刻
   * 算是同一个数。
   */
  const noteRecalled = (agentId: string, recalled: RecalledEntity[]) => {
    if (!recalled.length) return;
    patchSession(agentId, (s) => ({
      ...s,
      recalled: { ...s.recalled, [(s.turns.length || 0) + 1]: recalled },
    }));
  };

  /**
   * 起跑一个作业。
   *
   * 作者轮**已经**在 `send` 里落盘了——这里只负责跑模型和写回复。分开是因为
   * 这两件事的失败后果完全不同：写不进 transcript 是数据丢失，跑不动模型只是
   * 一次重试。
   */
  const runJob = async (job: Job) => {
    const { projectPath } = get();
    const agent = get().agents[job.agentId];
    if (!projectPath || !agent) return;

    const [{ useAiStore }, { useLoreStore }, { useAppStore }] = await Promise.all([
      import("./aiStore"), import("./loreStore"), import("./appStore"),
    ]);
    const { models, providers, activeModelId, subAgents } = useAiStore.getState();
    const resolved = resolveConn(models, providers, agent.modelId ?? activeModelId);
    if (!resolved.ok) {
      patchSession(job.agentId, (s) => ({ ...s, error: resolved.error, lastJob: job }));
      set((st) => ({ running: st.running.filter((x) => x !== job.agentId) }));
      void pump();
      return;
    }
    const { model, provider } = resolved;

    const controller = new AbortController();
    set((st) => ({ aborts: { ...st.aborts, [job.agentId]: controller } }));
    // 先按「还没组装」记下来：万一是压缩或检索这一步炸了，重试要整套重来。
    patchSession(job.agentId, (s) => ({
      ...s, streaming: "", liveLog: [], error: null, stopped: false, lastJob: job,
    }));

    const loreIndex = useLoreStore.getState().index;
    const { loreBudgetTokens, contextUtilization } = useAppStore.getState();
    const persona = agent.authorPersona ?? get().authorPersona;
    // 留给**消息**的上限：工具 schema 那一份已经扣掉了（lib/agent/toolCost）。
    // 压缩和 runtime 的历史裁剪都量这个数——两边各算各的，就是上下文条越过
    // 压缩线却什么都没发生的那种错位。这里算一次，下面用两次。
    const messageCeiling = messageCeilingFor(
      model.contextSize,
      contextUtilization,
      presetFor(agent.kind),
      withSessionOverrides(subAgents, get().sessions[job.agentId]?.disabledSubAgents ?? []),
      models,
    );

    // 同 agentStore.sendChat：流式的输出文本和 reasoning 片段都是
    // latest-wins，缓冲后按节拍落一次 store；别的事件照旧即时写、写前先
    // flush 保序（见 lib/agent/streamThrottle）。声明在 try 外，失败路径
    // 也能把最后一截冲出去。
    let pendingText: string | null = null;
    let pendingReasoning: (AgentEvent & { kind: "reasoning" }) | null = null;
    const stream = createStreamThrottle(() => {
      const text = pendingText;
      const reasoning = pendingReasoning;
      pendingText = null;
      pendingReasoning = null;
      if (text === null && reasoning === null) return;
      patchSession(job.agentId, (s) => ({
        ...s,
        ...(reasoning ? { liveLog: appendAgentEventTo(s.liveLog, reasoning) } : {}),
        ...(text !== null ? { streaming: text } : {}),
      }));
    });

    try {
      const apiKey = (await loadApiKey(provider.id)) ?? "";
      let session = get().sessions[job.agentId] ?? emptySession();
      let history = session.history;
      let meta = session.meta;

      if (job.committed && history && meta) {
        // 重试：这一问、这一轮的注入、这一次的压缩都已经在 history 里了。
        // 再走一遍下面任何一支都会把它们叠第二份。
        repairToolCallPairing(history);
      } else if (!history || !meta) {
        // 历史准备的排序住在 lib（prepareSeededHistory），这里只剩状态：基线、
        // 会话字段、执行日志、「想起了…」。
        const charsPerToken = measureCharsPerToken(job.match);
        const seeded = await prepareSeededHistory({
          projectPath, agent, persona, loreIndex,
          loreScope: useLoreStore.getState().scope,
          wire: job.wire,
          matchText: job.match,
          refDirs: job.refDirs,
          loreBudgetChars: loreBudgetTokens * charsPerToken,
          areaBudgetChars: AREA_BUDGET_TOKENS * charsPerToken,
          currentTurns: get().sessions[job.agentId]?.turns ?? [],
        });
        history = seeded.history;
        meta = seeded.meta;
        // 基线进花名册而不是进内存的会话：没打开过的 agent 也要能亮起
        // 「设定已更新」，而那正是刚打开应用时最需要它的时刻。
        set((st) => ({
          agents: {
            ...st.agents,
            [agent.id]: { ...st.agents[agent.id], contextHash: seeded.contextHash },
          },
          stale: { ...st.stale, [agent.id]: false },
        }));
        void persistRoster();
        patchSession(job.agentId, (s) => ({
          ...s,
          history, meta,
          stalePaths: seeded.bound.stalePaths,
          memory: seeded.memoryRecords,
          memoryStale: false,
          liveLog: appendAgentEventTo(s.liveLog, {
            kind: "context-seeded",
            documentName: null,
            recentChars: 0,
            memoryChars: 0,
            // 只数真的贡献了文字的：主角每轮都在候选里（pin），正文常驻、这一轮
            // 又没有新特征时它什么都不贡献——算进去等于报一个不存在的注入。
            loreEntities: seeded.report ? contributingEntities(seeded.report).length : 0,
            loreChars: seeded.report?.usedChars ?? 0,
            at: Date.now(),
          }),
        }));
        noteRecalled(job.agentId, seeded.recalled);
      } else {
        // 排序（修对 → 压缩 → 刷新记忆块 → 词条注入 → 区检索 → 提问）住在
        // lib（prepareContinuedHistory），这里只剩状态：历史/事件/记事本/
        // 「想起了…」，和摘要的 fire-and-forget 落盘。
        const charsPerToken = measureCharsPerToken(job.match);
        const cont = await prepareContinuedHistory({
          projectPath, agent, loreIndex,
          loreScope: useLoreStore.getState().scope,
          history, meta,
          wire: job.wire,
          matchText: job.match,
          refDirs: job.refDirs,
          loreBudgetChars: loreBudgetTokens * charsPerToken,
          areaBudgetChars: AREA_BUDGET_TOKENS * charsPerToken,
          ceilingTokens: messageCeiling,
          summarize: (input) =>
            summarizeForCompaction(connOptions({ provider, model, apiKey }), input, controller.signal),
        });
        history = cont.history;
        patchSession(job.agentId, (s) => ({
          ...s,
          history,
          liveLog: cont.compactedEvent
            ? appendAgentEventTo(s.liveLog, cont.compactedEvent)
            : s.liveLog,
          ...(cont.memoryRecords ? { memory: cont.memoryRecords, memoryStale: false } : {}),
        }));
        if (cont.summaryToSave) void saveSummary(projectPath, job.agentId, cont.summaryToSave);
        noteRecalled(job.agentId, cont.recalled);
      }

      // 到这里这一问已经在 history 里了。往后任何一步失败，重试都必须走上面
      // 那条「拿现有历史开跑」的分支。
      const committed: Job = { ...job, committed: true };
      patchSession(job.agentId, (s) => ({ ...s, lastJob: committed }));

      // 子代理需要一个 workspace 才拿得到 delegate；没有它，作者一开 vision
      // 子代理，routeTools 就会把 read_image 摘掉而不给替代品——看图能力凭空
      // 消失。见 docs/feature/roleplay/02-design.md §8。
      let workspace = get().sessions[job.agentId]?.workspace ?? null;
      if (!workspace) {
        workspace = createTaskWorkspace(
          projectPath, model.id, get().sessions[job.agentId]?.taskId ?? undefined,
        );
        patchSession(job.agentId, (s) => ({ ...s, workspace, taskId: workspace!.taskId }));
      }

      const preset = presetFor(agent.kind);
      const effectiveSubs = withSessionOverrides(
      subAgents, get().sessions[job.agentId]?.disabledSubAgents ?? [],
    );
      const routed = routeTools(preset, effectiveSubs, workspace, models);

      const result = await runAgent({
        ...connOptions({ provider, model, apiKey }),
        inputCeilingTokens: messageCeiling,
        preset: { ...preset, tools: routed.tools, serverTools: routed.serverTools },
        messages: history,
        toolContext: {
          projectPath,
          loreIndex,
          loreScope: useLoreStore.getState().scope,
          multimodal: model.type === "multimodal",
          taskWorkspace: workspace,
          signal: controller.signal,
          // 只有旁白拿得到这个通道，所以扮演 agent 的 scene 工具即使被硬塞
          // 进 preset 也只会得到一句「你不是旁白」。双保险，不是冗余。
          scenes: agent.kind === "narrator" ? get().sceneReader() : undefined,
          // 自己这一场的记录。没有 id 参数，所以装上它不会让角色多看见任何
          // 别人的东西。和 sceneReader 一样每次读盘（见 conversationReader）。
          conversation: conversationReader(projectPath, agent.id),
          // 每次调用都读盘：同一次运行里 remember 之后紧接着的 recall 必须
          // 看得见刚记下的东西（ToolContext 是运行快照，见 registry 的注释）。
          agentMemory: {
            list: async () =>
              (await loadMemoryDoc(memoryPath(projectPath, agent.id))).records,
            add: async (rec) => {
              // 正在生成的那一轮的轮号：作者轮在 send() 里已经追加过了，所以
              // 角色轮是它的下一个。对话区据此把「记下了：…」挂在这条回复下面。
              const turn = (get().sessions[agent.id]?.turns.length ?? 0) + 1;
              const record = await mutateMemory(agent.id, (doc) =>
                addRecord(doc, { ...rec, turn }, Math.floor(Date.now() / 1000)));
              if (!record) throw new Error("memory unavailable");
              return record;
            },
            revise: async (recId, patch) =>
              mutateMemory(agent.id, (doc) =>
                reviseRecord(doc, recId, patch, Math.floor(Date.now() / 1000))),
          } satisfies AgentMemoryStore,
          requestApproval: async (p) => {
            const { useAgentStore } = await import("./agentStore");
            // key 用本 agent 的 controller，绝不能是 CHAT_AUTO_APPROVE_KEY 那样
            // 的字面量——几个 agent 共用一个字面量会让 A 的「本次都批准」
            // 悄悄覆盖到 B。
            return useAgentStore.getState().requestApproval(p, controller, {
              signal: controller.signal,
              autoApproveKey: controller,
              // 卡片归本 agent 的对话区渲染，不归对话助手——三个并发的 agent
              // 各看各的（lib/agent/approvalRouting）。
              surface: agent.id,
            });
          },
          resolveSubAgent: (k) =>
            resolveSubAgentConn(k, models, providers, effectiveSubs, loadApiKey),
        },
        signal: controller.signal,
        // 只有旁白接这两个回调。
        //
        // 扮演 agent 的 `maxRounds: 5` 是刻意的小：它的期望响应是一句台词，
        // 撞到上限说明模型在做错的事，force-text 收尾正是想要的降级——弹一张
        // 「要不要再给四轮」的卡片，只会训练作者为一个本就不该需要轮数的模式
        // 一再放行，顺带把一场戏切断。
        //
        // 旁白不同：它 `maxRounds: 20`，读几场戏再改写成正文完全可能撞上，而
        // 撞上就直接收尾等于半途而废。存盘暂停不给（`canPause: false`）——扮演
        // 这边没有恢复已暂停任务的入口，给了就是一个存进去再也拿不出来的按钮。
        ...(agent.kind === "narrator" ? {
          onRoundLimit: async (roundsUsed: number) => {
            const { useAgentStore } = await import("./agentStore");
            return useAgentStore.getState().requestRoundExtension(
              roundsUsed, preset.maxRounds, controller, false, agent.id,
            );
          },
          onTruncationLimit: async (recoveries: number) => {
            const { useAgentStore } = await import("./agentStore");
            return useAgentStore.getState()
              .requestTruncationDecision(recoveries, controller, agent.id);
          },
        } : {}),
        onEvent: (event) => {
          if (event.kind === "reasoning") {
            if (
              pendingReasoning &&
              (pendingReasoning.parentStep !== event.parentStep ||
                pendingReasoning.round !== event.round)
            ) {
              stream.flush();
            }
            pendingReasoning = event;
            stream.schedule();
            return;
          }
          stream.flush();
          patchSession(job.agentId, (s) => ({ ...s, liveLog: appendAgentEventTo(s.liveLog, event) }));
        },
        onOutputText: (text) => {
          pendingText = text;
          stream.schedule();
        },
      });
      // 下一行就要读 streaming 收全文——缓冲里最后一截必须先落下去。
      stream.flush();

      const reply = get().sessions[job.agentId]?.streaming.trim() ?? "";
      if (reply) {
        const turn = await appendTurnChained(job.agentId, () => ({
          speaker: "agent",
          speakerName: agent.name,
          at: Math.floor(Date.now() / 1000),
          text: reply,
        }));
        patchSession(job.agentId, (s) => ({
          ...s,
          log: { ...s.log, [turn.index]: s.liveLog },
          streaming: "",
          liveLog: [],
        }));
        set((st) => ({
          agents: {
            ...st.agents,
            [agent.id]: { ...st.agents[agent.id], turnCount: turn.index, updatedAt: Math.floor(Date.now() / 1000) },
          },
        }));
        void persistRoster();
      }

      const cost = costFor(model, result.inputTokens, result.outputTokens, result.cachedTokens);
      patchSession(job.agentId, (s) => ({
        ...s,
        usage: {
          inputTokens: (s.usage?.inputTokens ?? 0) + result.inputTokens,
          outputTokens: (s.usage?.outputTokens ?? 0) + result.outputTokens,
          cost: (s.usage?.cost ?? 0) + cost,
        },
      }));
      recordRunOutcome(model.id, null);
      void persistUsage(
        projectPath, model.id, result.inputTokens, result.outputTokens, cost,
        agent.kind === "narrator" ? "roleplay:narrator" : "roleplay:character",
        result.cachedTokens,
      );
      if (get().activeAgentId !== job.agentId) {
        set((st) => ({ unread: { ...st.unread, [job.agentId]: true } }));
        notify("done", i18n.t("notify.doneTitle"), i18n.t("roleplay.notify.replied", {
          name: agent.name, defaultValue: `${agent.name} 回复了` ,
        }));
      }
    } catch (e) {
      // 失败前已经流出来的内容仍然是作者该看到的。
      stream.flush();
      if ((e as Error).name === "AbortError") {
        // 按停之后这一问仍然孤零零地留在 transcript 里。给它一个重试的落点，
        // 否则作者只能把那句话再打一遍。
        patchSession(job.agentId, (s) => ({ ...s, stopped: true }));
      } else {
        const msg = String(e);
        patchSession(job.agentId, (s) => ({
          ...s,
          error: msg,
          liveLog: appendAgentEventTo(s.liveLog, { kind: "run-error", message: msg, at: Date.now() }),
        }));
        recordRunOutcome(model.id, msg);
      }
    } finally {
      const { useAgentStore } = await import("./agentStore");
      useAgentStore.getState().rejectAll("roleplay run ended", controller);

      patchSession(job.agentId, (x) => ({ ...x, contextVersion: x.contextVersion + 1 }));

      const s = get().sessions[job.agentId];
      if (s?.history && s.meta) {
        void saveSession(projectPath, job.agentId, {
          history: s.history,
          snapshot: { turns: [], history: s.history, meta: s.meta, usage: null, taskId: s.workspace?.taskId ?? null },
          boundBlock: s.meta.boundBlock,
          memoryBlock: s.meta.memoryBlock,
        });
      }
      set((st) => {
        const aborts = { ...st.aborts };
        delete aborts[job.agentId];
        return { running: st.running.filter((x) => x !== job.agentId), aborts };
      });
      void pump();
    }
  };

  /** 信号量：有名额就拉起队首里第一个自己没在跑的作业。 */
  const pump = async () => {
    for (;;) {
      const { running, queue } = get();
      if (running.length >= MAX_CONCURRENT_RUNS) return;
      const idx = queue.findIndex((j) => !running.includes(j.agentId));
      if (idx < 0) return;
      const job = queue[idx];
      set((st) => ({
        queue: st.queue.filter((_, i) => i !== idx),
        running: [...st.running, job.agentId],
      }));
      void runJob(job);
    }
  };

  return {
    projectPath: null,
    loaded: false,
    rosterError: null,
    order: [],
    agents: {},
    authorPersona: NO_PERSONA,
    sessions: {},
    activeAgentId: null,
    running: [],
    queue: [],
    aborts: {},
    unread: {},
    stale: {},
    areas: [],

    load: async (projectPath) => {
      // **同一个项目已经装好了就直接返回。**
      //
      // 这个方法挂在 RoleplayPanel 的 mount effect 上，而抽屉一关整棵子树就卸载
      // （AiDrawer 是条件渲染 + AnimatePresence）。原来每次挂载都无条件重跑，
      // 于是关一次面板就把 sessions / running / queue / aborts 全清空——正在生成
      // 的那一轮并没有真的停下，只是界面不再认识它，`stop` 也够不到它的
      // controller 了。对话助手没有这个毛病，因为 agentStore 不在挂载时重置。
      if (get().projectPath === projectPath && get().loaded) return;

      // 换项目才是真的要清干净：先掐断在跑的，否则那些 controller 会连同
      // `aborts` 一起被丢掉，留下几个谁也停不了的运行往旧项目里写。
      if (get().projectPath !== projectPath) {
        for (const c of Object.values(get().aborts)) c.abort();
        set({ sessions: {}, running: [], queue: [], aborts: {}, activeAgentId: null, unread: {}, stale: {} });
      }
      set({ projectPath, loaded: false, rosterError: null });
      try {
        const { roster, rebuilt } = await loadRoster(projectPath);
        set({
          order: roster.agents.map((a) => a.id),
          agents: Object.fromEntries(roster.agents.map((a) => [a.id, a])),
          authorPersona: roster.authorPersona,
          loaded: true,
          rosterError: rebuilt
            ? i18n.t("roleplay.errors.rosterRebuilt", {
                defaultValue: "花名册损坏，已按目录重建——绑定和模型设置需要重新填。",
              })
            : null,
        });
        await get().refreshAreas();
      } catch (e) {
        // 这条会直接显示给作者，所以先说人话再附上原因——一串裸 TypeError
        // 只会让人以为应用坏了，而实际上多半只是目录读不出来。
        set({
          loaded: true,
          rosterError: i18n.t("roleplay.errors.loadFailed", {
            error: String(e),
            defaultValue: `读不到扮演目录（.ai-writer/roleplay/）：${String(e)}`,
          }),
        });
      }
    },

    // 项目关掉了。跑着的先掐断——丢掉 aborts 表等于把它们变成谁也停不了的运行。
    reset: () => {
      for (const c of Object.values(get().aborts)) c.abort();
      set({
        projectPath: null, loaded: false, rosterError: null, order: [], agents: {},
        authorPersona: NO_PERSONA, sessions: {}, activeAgentId: null,
        running: [], queue: [], aborts: {}, unread: {}, stale: {},
      });
    },

    createAgent: async (draft) => {
      const { projectPath } = get();
      if (!projectPath) return null;
      const now = Math.floor(Date.now() / 1000);
      const id = generateAgentId(Date.now(), Math.random());
      const agent: RoleplayAgent = {
        id,
        kind: draft.kind,
        name: draft.name.trim() || i18n.t("roleplay.kind.narrator", { defaultValue: "旁白" }),
        primaryDirPath: draft.kind === "narrator" ? null : draft.primaryDirPath,
        boundPaths: draft.boundPaths,
        modelId: draft.modelId,
        areaId: draft.areaId && isValidAreaId(draft.areaId) ? draft.areaId : null,
        authorPersona: null,
        createdAt: now,
        updatedAt: now,
        turnCount: 0,
        contextHash: null,
      };
      set((st) => ({ order: [...st.order, id], agents: { ...st.agents, [id]: agent } }));
      await savePersonaCard(projectPath, agent, draft.instruction);
      await persistRoster();
      await get().select(id);
      return id;
    },

    updateAgent: async (id, draft) => {
      const { projectPath, agents } = get();
      const prev = agents[id];
      if (!projectPath || !prev) return;
      const next: RoleplayAgent = {
        ...prev,
        name: draft.name.trim() || prev.name,
        primaryDirPath: prev.kind === "narrator" ? null : draft.primaryDirPath,
        boundPaths: draft.boundPaths,
        modelId: draft.modelId,
        updatedAt: Math.floor(Date.now() / 1000),
      };
      set((st) => ({ agents: { ...st.agents, [id]: next } }));
      await savePersonaCard(projectPath, next, draft.instruction);
      await persistRoster();
      // 改了绑定也是一种「设定变了」。不直接置 true，而是重新比对一遍——把
      // 「过期与否」的判断留在唯一的一处，否则改回原样之后那条提示会赖着不走。
      void get().checkBindings();
    },

    previewRecap: async (id, brief) => {
      const { projectPath } = get();
      const agent = get().agents[id];
      if (!projectPath || !agent) return null;
      const turns = get().sessions[id]?.turns ?? [];
      if (!turns.length) return null;

      const [{ useAiStore }, { useLoreStore }] = await Promise.all([
        import("./aiStore"), import("./loreStore"),
      ]);
      const { models, providers, activeModelId } = useAiStore.getState();
      const resolved = resolveConn(models, providers, agent.modelId ?? activeModelId);
      if (!resolved.ok) {
        patchSession(id, (s) => ({ ...s, error: resolved.error }));
        return null;
      }
      const { model, provider } = resolved;

      try {
        const apiKey = (await loadApiKey(provider.id)) ?? "";
        let primaryText = "";
        if (agent.primaryDirPath) {
          try { primaryText = await readEntityFile(agent.primaryDirPath, "index.md"); } catch { /* 条目没了也照写 */ }
        }
        const recap = await runSceneRecap({
          ...connOptions({ provider, model, apiKey }),
          // 角色自己的那一份 system prompt：它是**以这个角色的身份**在回忆，
          // 不是一个通用摘要器在压缩文本。见 lib/roleplay/recap 的第 1 条。
          systemPrompt: buildSystemPrompt({
            agent,
            persona: agent.authorPersona ?? get().authorPersona,
            personaCard: await loadPersonaCard(projectPath, id),
            primaryText,
            loreIndex: useLoreStore.getState().index,
          }),
          turns,
          brief,
          memory: get().sessions[id]?.memory ?? [],
        });
        patchSession(id, (s) => ({ ...s, error: null }));
        return recap;
      } catch (e) {
        patchSession(id, (s) => ({ ...s, error: String(e) }));
        return null;
      }
    },

    newSession: async (id, opts) => {
      const { projectPath } = get();
      const agent = get().agents[id];
      if (!projectPath || !agent) return;
      // 跑着的时候不许开新场：正在写的那一轮会追加到一个已经被移走的文件上。
      if (get().running.includes(id) || get().queue.some((j) => j.agentId === id)) return;

      const continuing = opts.mode === "continue" && !!opts.recap;
      const now = Math.floor(Date.now() / 1000);

      try {
        // **先写记忆，再封存。** 反过来的话，摘要落盘失败时上一场已经不在当前
        // transcript 里了，作者眼前一片空白却什么也没留下（06 §5.4）。
        //
        // 场次编号和封存编号必须出自同一个算法（最大值 + 1，不是文件个数）：
        // 作者手删过一场归档后，按个数算的编号会和 `archiveSession` 实际用的
        // 错开，记忆区条目的「来自第 N 场」就指错了场。
        const sceneNo = await peekNextArchiveNo(projectPath, id);
        const path = memoryPath(projectPath, id);
        const doc = await loadMemoryDoc(path);
        let next = doc;

        // **降级只发生在转场这一刻**（06 §3.1）。规则按性质，不按预算——分拣
        // 本身在 `takeSinkable` 里：欠着的约定和待办、关系留在常驻层；其余**移出**
        // 常驻层、沉进记忆区，各成一条，各带自己的关键字——合并成一段散文会把
        // 它们变成一份摘要，而那正是记忆当初要防的东西。
        if (agent.areaId) {
          const { doc: remaining, sinking } = takeSinkable(doc);
          for (const rec of sinking) {
            const keys = rec.keys.length
              ? rec.keys
              // 没有关键字的旧记录（`remember` 那时还不收它）至少让标题和主语
              // 能命中——否则它沉下去就等于消失。
              : [rec.title, ...(rec.subject ? [rec.subject] : [])].filter(Boolean);
            await addAreaEntry(projectPath, agent.areaId, {
              title: rec.title,
              body: [rec.body, rec.status !== "open" ? `（${rec.status === "done" ? "已兑现" : "已作废"}）` : ""]
                .filter(Boolean).join("\n\n"),
              keys,
              scene: sceneNo,
            }, now);
          }
          // 全部写进区里才移出常驻层：中途失败最多把已沉的重复一次，绝不丢。
          if (sinking.length) next = remaining;
          const meta = await loadAreaMeta(projectPath, agent.areaId);
          await saveAreaMeta(projectPath, { ...meta, lastScene: sceneNo, boundTo: id });
        } else {
          // 没有记忆区时退回 PR 1 的行为：上一条前情作废但正文保留，只留最新的
          // 一条常驻。信息不丢，只是找不回来。
          for (const old of doc.records.filter((r) => r.kind === "scene" && r.status === "open")) {
            const revised = reviseRecord(next, old.id, { status: "void" }, now);
            if (revised) next = revised.doc;
          }
        }

        if (continuing) {
          const added = addRecord(next, {
            kind: "scene",
            title: opts.recap!.title,
            body: opts.recap!.body,
            keys: opts.recap!.keys,
            // 前情不属于任何一轮——它讲的是整整一场。
            turn: 0,
            subject: null,
          }, now);
          next = added.doc;
        }

        if (next !== doc) {
          await backupFile(projectPath, path);
          await saveMemoryDoc(path, id, next);
        }

        await archiveSession(projectPath, id, { clearMemory: opts.clearMemory === true });

        // 封存把旧的 summary.md 一起搬走了，所以新的一场的摘要要在这之后写。
        // 它服务的是旁白的 read_scene_summary，以及下一次压缩的 prevSummary。
        if (continuing) {
          await saveSummary(projectPath, id, `${opts.recap!.title}\n\n${opts.recap!.body}`);
        }
      } catch (e) {
        patchSession(id, (s) => ({ ...s, error: String(e) }));
        return;
      }

      // 会话整个归零。`contextHash` 一并清掉——它是「设定已更新」的基线，而这一
      // 场还没播种过，没有基线可比；留着旧的会让提示按上一场的状态亮。
      const doc = await loadMemoryDoc(memoryPath(projectPath, id));
      set((st) => ({
        // `emptySession()` 的 `taskId: null` 正是想要的：新的一场配新的工作区。
        sessions: { ...st.sessions, [id]: { ...emptySession(), memory: doc.records } },
        unread: { ...st.unread, [id]: false },
        stale: { ...st.stale, [id]: false },
        agents: {
          ...st.agents,
          [id]: { ...agent, turnCount: 0, contextHash: null, updatedAt: now },
        },
      }));
      await persistRoster();
    },

    removeAgent: async (id) => {
      const { projectPath } = get();
      get().stop(id);
      set((st) => {
        const agents = { ...st.agents };
        delete agents[id];
        const sessions = { ...st.sessions };
        delete sessions[id];
        return {
          order: st.order.filter((x) => x !== id),
          agents,
          sessions,
          queue: st.queue.filter((j) => j.agentId !== id),
          activeAgentId: st.activeAgentId === id ? null : st.activeAgentId,
        };
      });
      await persistRoster();
      if (projectPath) {
        // 目录移进 backups 而不是真删——里面有 transcript，那是作者写的字。
        try {
          await deleteAgentDir(projectPath, id, Date.now());
        } catch (e) {
          console.warn("[roleplay] agent dir not archived:", e);
        }
      }
    },

    setAuthorPersona: async (persona) => {
      set({ authorPersona: persona });
      await persistRoster();
      // 换身份和改设定是同一件事：它改的是 system 层，而活着的会话读不到。
      // **不自动重写** system——那会作废每个 agent 的 prompt 缓存前缀。亮起
      // 提示条，让作者自己决定哪一场戏值得为此重来一次前缀。
      void get().checkBindings();
    },

    toggleSubAgent: (id, kind) => patchSession(id, (s) => ({
      ...s,
      disabledSubAgents: s.disabledSubAgents.includes(kind)
        ? s.disabledSubAgents.filter((k) => k !== kind)
        : [...s.disabledSubAgents, kind],
    })),

    setAgentPersona: async (id, persona) => {
      const prev = get().agents[id];
      if (!prev) return;
      set((st) => ({ agents: { ...st.agents, [id]: { ...prev, authorPersona: persona } } }));
      await persistRoster();
      void get().checkBindings();
    },

    setAgentModel: async (id, modelId) => {
      const prev = get().agents[id];
      if (!prev) return;
      set((st) => ({ agents: { ...st.agents, [id]: { ...prev, modelId } } }));
      await persistRoster();
    },

    select: async (id) => {
      set((st) => ({
        activeAgentId: id,
        unread: id ? { ...st.unread, [id]: false } : st.unread,
      }));
      const { projectPath } = get();
      if (!id || !projectPath || get().sessions[id]) return;

      // 打开一个 agent：对话从 transcript 来，wire history 从 session.json 来。
      // 后者读不出就留空——下一次发送会重新播种，作者一个字都不会少。
      const { turns } = await loadTranscript(transcriptPath(projectPath, id));
      const stored = await loadSession(projectPath, id);
      const doc = await loadMemoryDoc(memoryPath(projectPath, id));
      // meta 从 blob 反序列化回来只有 ChatSessionMeta 的字段；两个块的对象身份
      // 由 SerializedSession 单独存下标、在这里重连。**两个都要重连**——漏掉
      // memoryBlock 曾经让四个刷新时刻在重启后全部静默失效（恢复正是其中之一）。
      let history: StreamMessage[] | null = null;
      let meta: RoleplaySessionMeta | null = null;
      if (stored) {
        history = stored.history;
        meta = { ...stored.snapshot.meta, boundBlock: stored.boundBlock, memoryBlock: stored.memoryBlock };
        // 旧版本播种的历史可能缺块（那时空内容不建块、序列化也不存 memoryBlock
        // 的身份）——先补齐，刷新才有落点。
        ensureBlocks(history, meta);
        // 恢复是四个刷新时刻之一：应用关着的时候作者可能手改过 memory.md。
        refreshMemoryBlock(meta, doc.records);
      }
      patchSession(id, (s) => ({
        ...s,
        turns,
        history,
        meta,
        // 认领上一次的工作区，而不是新开一个——否则每次重启都在
        // `.ai-writer/tasks/` 里留下一个再也没人看的目录。
        taskId: stored?.snapshot.taskId ?? null,
        memory: doc.records,
        memoryStale: false,
      }));
      void get().checkBindings();
    },

    send: async (agentId, text, refs = [], quote) => {
      const { projectPath } = get();
      const agent = get().agents[agentId];
      const body = text.trim();
      if (!projectPath || !agent || !body) return;

      const persona = agent.authorPersona ?? get().authorPersona;
      const personaName = persona.mode === "lore" && persona.dirPath
        ? (await import("./loreStore").then((m) =>
            indexByDir(m.useLoreStore.getState().index).get(persona.dirPath!)?.name ?? ""))
        : "";

      // 先落盘，再排队。模型跑不动只是一次重试，写不进去是数据丢失。
      // 轮号由追加链在落盘前一刻算出——见 appendTurnChained。
      try {
        await appendTurnChained(agentId, () => ({
          speaker: "author",
          speakerName: personaName,
          at: Math.floor(Date.now() / 1000),
          text: body,
        }));
      } catch (e) {
        patchSession(agentId, (s) => ({ ...s, error: String(e) }));
        return;
      }
      patchSession(agentId, (s) => ({ ...s, error: null, stopped: false }));

      // `@` 引用是**内联**的，不是提名的：作者打了 @西厢 就已经决定助手该看着
      // 它说话，把那变成模型可以跳过的建议是在赌一件已经定了的事（见
      // lib/agent/chatRefs 的开头）。transcript 里存的仍是作者敲的那句话。
      const { buildChatMessage } = await import("../lib/agent/chatRefs");
      // 图片能不能上线，取决于**这个 agent 绑的模型**，不是全局那个——两级
      // 解析和 runJob 里那一句必须是同一句话（§2.14）。识图子代理开着时另外
      // 告诉模型「图在这个路径上，可以 delegate」，那和把 base64 塞给一个读不
      // 了图的模型是两件事（docs/feature/agent/subagent-lld.md §6.1）。
      const { useAiStore } = await import("./aiStore");
      const { models, activeModelId, subAgents } = useAiStore.getState();
      const model = models.find((m) => m.id === (agent.modelId ?? activeModelId));
      const subs = withSessionOverrides(
        subAgents, get().sessions[agentId]?.disabledSubAgents ?? [],
      );
      const { visionSubAgentModel } = await import("../lib/agent/subagent");
      // 正文已经常驻在上下文里的条目**不再内联第二份**：绑定块（或 system 层）
      // 一份、【引用资料】一份，是同一段文字在同一次请求里出现两遍，而且会一直
      // 留到那一轮被折叠。作者敲的 `@名字` 仍在正文里，模型照样知道他在说谁——
      // 那段设定本来就在它眼前。芯片也保留：作者说过要带上，界面不该偷偷抹掉。
      const resident = residentCoreDirs(
        agent, get().sessions[agentId]?.meta ?? null,
        (await import("./loreStore")).useLoreStore.getState().index,
      );
      const inlined = refs.filter((r) => !(r.kind === "lore" && resident.has(r.entity.dirPath)));
      const composed = await buildChatMessage(body, quote, inlined, {
        allowImages: model?.type === "multimodal",
        visionDelegate: visionSubAgentModel(models, subs) !== null,
      });
      set((st) => ({
        queue: [...st.queue, {
          agentId,
          wire: composed.content,
          match: composed.text,
          // 只记**真的内联了**的那些：常驻的早已在账本里，重复记一笔只会把
          // carrier 换成这条问句，等它折叠掉，绑定块里还在的正文就被当成没了。
          refDirs: inlined.flatMap((r) => (r.kind === "lore" ? [r.entity.dirPath] : [])),
        }],
      }));
      void pump();
    },

    stop: (agentId) => {
      const controller = get().aborts[agentId];
      controller?.abort();
      // 中止信号解不开一张正阻塞着的卡片：`onRoundLimit` 等的是一个 Promise，
      // 而 abort 不会让它 reject。所以这里要像 stopChat 一样主动排空本次运行
      // 的队列，否则「停止」按下去之后这个 agent 会永远卡在那张卡片上。
      if (controller) {
        void import("./agentStore").then((m) =>
          m.useAgentStore.getState().rejectAll("aborted by user", controller),
        );
      }
      set((st) => ({ queue: st.queue.filter((j) => j.agentId !== agentId) }));
    },

    /**
     * 重跑上一次失败的作业。
     *
     * 作者轮**不重发**——它在 `send` 里就落盘了，重试是接着那一问再跑一次模型，
     * 不是再说一遍话。committed 的作业连组装都跳过，直接用现有 history。
     */
    retry: (agentId) => {
      const job = get().sessions[agentId]?.lastJob;
      if (!job) return;
      const { running, queue } = get();
      if (running.includes(agentId) || queue.some((j) => j.agentId === agentId)) return;
      patchSession(agentId, (s) => ({ ...s, error: null, stopped: false }));
      set((st) => ({ queue: [...st.queue, job] }));
      void pump();
    },

    /**
     * 回退到某一个作者轮。
     *
     * 撤销的东西分四份，各有各的理由：
     *
     * 1. **transcript** —— 截到这一轮之前，先 `backupFile`。这是唯一一处重写这个
     *    文件的地方，理由写在 `truncateTurns` 的注释里：只追加那条纪律防的是悄悄
     *    丢字，而回退是作者指名道姓要撤销哪一轮。
     * 2. **wire history 整个丢掉**（连同 `session.json`）。不做外科手术式的回卷——
     *    `meta` 里挂着轮起点、注入账本、摘要，一条条往回拆很难拆对，而下一次发送
     *    本来就会从截断后的 transcript 重新播种（§2.10 的回放）。这个功能几乎是
     *    那次修复的免费副产品。
     * 3. **记忆**里 `turn >= turnIndex` 的记录删掉。留着的话角色会言之凿凿地提起
     *    一件从没发生过的事，比丢掉它更糟。见 `dropRecordsFrom`。
     * 4. **summary.md 清掉**（先备份）。滚动摘要是散文，没法按轮号截断，而它很
     *    可能已经把被撤销的那几轮写了进去——一份悄悄断言了不存在的事的摘要，正是
     *    这个功能要消除的东西。代价是长对话的远期上下文，换回来的是不会撒谎。
     */
    rewind: async (agentId, turnIndex) => {
      const { projectPath } = get();
      const agent = get().agents[agentId];
      if (!projectPath || !agent) return null;
      if (get().running.includes(agentId) || get().queue.some((j) => j.agentId === agentId)) return null;

      const turns = get().sessions[agentId]?.turns ?? [];
      const target = turns.find((t) => t.index === turnIndex);
      if (!target || target.speaker !== "author") return null;

      const kept = truncateTurns(turns, turnIndex);
      try {
        const tPath = transcriptPath(projectPath, agentId);
        await backupFile(projectPath, tPath);
        await writeFile(tPath, renderTranscript(agentId, kept));

        const mPath = memoryPath(projectPath, agentId);
        const doc = await loadMemoryDoc(mPath);
        const { doc: nextDoc, dropped } = dropRecordsFrom(doc, turnIndex);
        if (dropped.length) {
          await backupFile(projectPath, mPath);
          await saveMemoryDoc(mPath, agentId, nextDoc);
        }

        const sPath = summaryPath(projectPath, agentId);
        if (await fileExists(sPath)) {
          await backupFile(projectPath, sPath);
          await removeFile(sPath);
        }
        // session.json 是缓存，不备份——一段接不回任何 transcript 的 wire
        // history 备份下来也没人读得懂。
        const jPath = sessionPath(projectPath, agentId);
        if (await fileExists(jPath)) await removeFile(jPath);

        patchSession(agentId, (s) => ({
          ...s,
          turns: kept,
          log: Object.fromEntries(Object.entries(s.log).filter(([k]) => Number(k) < turnIndex)),
          // recalled 也按轮号截：留着的话，被撤销轮号上的「想起了…」痕迹会错挂
          // 到重写后同轮号的新对话上。
          recalled: Object.fromEntries(
            Object.entries(s.recalled).filter(([k]) => Number(k) < turnIndex),
          ),
          history: null,
          meta: null,
          streaming: "",
          liveLog: [],
          error: null,
          lastJob: null,
          memory: nextDoc.records,
          memoryStale: false,
        }));
        set((st) => ({
          agents: {
            ...st.agents,
            [agentId]: { ...agent, turnCount: kept.length, contextHash: null },
          },
        }));
        void persistRoster();
        return target.text;
      } catch (e) {
        patchSession(agentId, (s) => ({ ...s, error: String(e) }));
        return null;
      }
    },

    dequeue: (agentId) => set((st) => ({
      queue: st.queue.filter((j) => j.agentId !== agentId),
    })),

    promote: (agentId) => {
      set((st) => {
        const mine = st.queue.filter((j) => j.agentId === agentId);
        if (!mine.length) return st;
        return { queue: [...mine, ...st.queue.filter((j) => j.agentId !== agentId)] };
      });
      void pump();
    },

    refreshBinding: async (agentId) => {
      const { projectPath } = get();
      const agent = get().agents[agentId];
      if (!projectPath || !agent) return;

      const { useLoreStore } = await import("./loreStore");
      const loreIndex = useLoreStore.getState().index;
      const session = get().sessions[agentId];
      const persona = agent.authorPersona ?? get().authorPersona;
      const { primaryText, personaCard } = await loadStaticContext(projectPath, agent);

      // 有活的历史就就地重写绑定块（对象身份不变，meta 继续指着它）；没有的
      // 话什么都不用改写——下一次发送会重新播种，那时用的自然是新内容。两条
      // 路都要把基线更新到「现在」，否则 checkBindings 下一轮又把它标成过期。
      //
      // 先补块再刷新：旧版本播种的会话可能根本没有绑定块，而「刷新了基线、清了
      // 提示、块却没写进去」正是这个按钮最不能犯的错——作者会有理由相信已经生效。
      let bound: BoundContent;
      if (session?.meta && session.history) {
        ensureBlocks(session.history, session.meta);
        bound = await refreshBoundBlock(loreIndex, agent, session.meta);
      } else {
        bound = await buildBoundContent(loreIndex, agent.boundPaths);
      }

      // 绑定块之外，system 层也要一起刷：主角条目、扮演指令、作者此刻的身份
      // 全住在那里，而它们只在播种时被读过一次。少了这一句，作者改完人设点
      // 「刷新设定」，看到提示条消失，模型却什么都没变——比不刷新更糟，因为
      // 现在他有理由相信已经生效了。
      if (session?.history) {
        refreshSystemPrompt(session.history, {
          agent, persona, personaCard, primaryText, loreIndex,
        });
        // system 层刚被重写，里面那份主角正文也就换成了新的——账本要按新的
        // 指纹重记一笔。不重记的话，条目的指纹已经变了、账目还是旧的，检索会
        // 把刚刚写进 system 的同一份正文再注入一遍。
        if (session.meta) {
          recordPrimaryCore(
            session.meta, loreIndex, agent.primaryDirPath, primaryText, session.history[0],
          );
        }
      }

      set((st) => ({
        agents: {
          ...st.agents,
          [agentId]: {
            ...st.agents[agentId],
            contextHash: hashText(contextSignature({
              agent, persona, personaCard, primaryText, loreIndex, boundText: bound.text,
            })),
          },
        },
        stale: { ...st.stale, [agentId]: false },
      }));
      patchSession(agentId, (s) => ({ ...s, stalePaths: bound.stalePaths }));
      void persistRoster();
    },

    refreshMemory: async (agentId) => {
      const { projectPath } = get();
      if (!projectPath) return;
      const doc = await loadMemoryDoc(memoryPath(projectPath, agentId));
      const session = get().sessions[agentId];
      // 没有活的历史就不用刷——下一次发送会重新播种，那时读的就是磁盘上的新内容。
      // 有历史先补块（旧版本播种的会话可能缺），刷新才有落点。
      if (session?.meta && session.history) {
        ensureBlocks(session.history, session.meta);
        refreshMemoryBlock(session.meta, doc.records);
      }
      patchSession(agentId, (s) => ({ ...s, memory: doc.records, memoryStale: false }));
    },

    addMemory: async (agentId, rec) => {
      // 作者手加的记录 `turn: 0`（＝不详），于是它不会在对话区冒出一句
      // 「记下了：…」——那句话的意思是「角色刚刚记住了」，而这条是作者自己写的，
      // 他不需要被告知。它只活在记事本里。
      await mutateMemory(agentId, (doc) =>
        addRecord(doc, { ...rec, turn: 0 }, Math.floor(Date.now() / 1000)));
    },

    reviseMemory: async (agentId, id, patch) => {
      await mutateMemory(agentId, (doc) =>
        reviseRecord(doc, id, patch, Math.floor(Date.now() / 1000)));
    },

    refreshAreas: async () => {
      const { projectPath } = get();
      if (!projectPath) { set({ areas: [] }); return; }
      try {
        set({ areas: await listAreas(projectPath) });
      } catch (e) {
        console.warn("[roleplay] areas not listed:", e);
      }
    },

    bindArea: async (agentId, target) => {
      const { projectPath } = get();
      const agent = get().agents[agentId];
      if (!projectPath || !agent) return;

      let nextId: string | null = null;
      if (target === "new") {
        const made = await createArea(
          projectPath,
          i18n.t("roleplay.area.defaultName", {
            name: agent.name, defaultValue: `${agent.name}的旧事`,
          }),
          Math.floor(Date.now() / 1000),
          Math.random(),
        );
        nextId = made.id;
      } else {
        nextId = target;
      }

      // 旧的先摘干净。一个区同时只能挂一个 agent（06 §4.1），而「摘下来」这件事
      // 由这一处统一做，比让每个调用方自己记得靠谱。
      if (agent.areaId && agent.areaId !== nextId) {
        const old = await loadAreaMeta(projectPath, agent.areaId);
        await saveAreaMeta(projectPath, { ...old, boundTo: null, formerName: agent.name });
      }
      if (nextId) {
        const meta = await loadAreaMeta(projectPath, nextId);
        // 抢占：这个区如果还挂在别人身上，那个人先失去它。UI 会挡住这种情况，
        // 但花名册是可以手改的。
        const holder = get().order.find((x) => x !== agentId && get().agents[x]?.areaId === nextId);
        if (holder) {
          set((st) => ({ agents: { ...st.agents, [holder]: { ...st.agents[holder], areaId: null } } }));
        }
        await saveAreaMeta(projectPath, { ...meta, boundTo: agentId });
      }

      set((st) => ({ agents: { ...st.agents, [agentId]: { ...st.agents[agentId], areaId: nextId } } }));
      await persistRoster();
      await get().refreshAreas();
    },

    /**
     * 重新比对每个 agent 的绑定内容。
     *
     * 遍历**整个花名册**，不只是打开过的会话：基线 (`agent.contextHash`) 现在存在
     * 花名册里，所以刚打开应用、一个会话都没打开时，攒了十个角色的项目也能立刻
     * 看出哪几个的设定变过——那正是最需要这条提示的时刻。
     *
     * 没有基线的 agent（还没开过口）被跳过：它没有任何已经烘进上下文的旧内容，
     * 下一次发送就是新的，标成「已更新」是在报一件没发生的事。
     *
     * 每次比对要读绑定条目的正文——知识库索引里只有元数据，特征正文不在其中。
     * 没有为此加一层「先比元数据签名、不同再读文件」的快路：绑定通常是个位数
     * 条目、agent 通常是个位数个，而这个函数只在知识库重扫之后跑一次；先加缓存
     * 层，等于为一个还没量到的问题增加一处会和真相不同步的状态。
     */
    checkBindings: async () => {
      const { projectPath, order } = get();
      if (!projectPath) return;
      const { useLoreStore } = await import("./loreStore");
      const loreIndex = useLoreStore.getState().index;

      const next: Record<string, boolean> = {};
      const stalePaths: Record<string, string[]> = {};
      // 并发而不是逐个 await：每个 agent 现在要读绑定条目 + 主角条目 + 人设卡，
      // 攒了十几个角色的项目串起来就是几十次往返，而它们之间毫无依赖。
      const globalPersona = get().authorPersona;
      const rows = await Promise.all(order.map(async (id) => {
        const agent = get().agents[id];
        if (!agent || agent.contextHash === null) return null;
        const [bound, statics] = await Promise.all([
          buildBoundContent(loreIndex, agent.boundPaths),
          loadStaticContext(projectPath, agent),
        ]);
        const sig = contextSignature({
          agent,
          persona: agent.authorPersona ?? globalPersona,
          personaCard: statics.personaCard,
          primaryText: statics.primaryText,
          loreIndex,
          boundText: bound.text,
        });
        return { id, stale: hashText(sig) !== agent.contextHash, stalePaths: bound.stalePaths };
      }));
      for (const row of rows) {
        if (!row) continue;
        next[row.id] = row.stale;
        stalePaths[row.id] = row.stalePaths;
      }
      set((st) => ({ stale: { ...st.stale, ...next } }));
      for (const [id, paths] of Object.entries(stalePaths)) {
        if (get().sessions[id]) patchSession(id, (s) => ({ ...s, stalePaths: paths }));
      }
    },

    sceneReader: (): SceneReader => ({
      list: async (): Promise<SceneInfo[]> => {
        const { projectPath, order, agents } = get();
        if (!projectPath) return [];
        const out: SceneInfo[] = [];
        for (const id of order) {
          const agent = agents[id];
          if (!agent || agent.kind !== "character") continue;
          const { turns } = await loadTranscript(transcriptPath(projectPath, id));
          const summary = await loadSummary(projectPath, id);
          const memory = await loadMemoryDoc(memoryPath(projectPath, id));
          const last = turns[turns.length - 1];
          out.push({
            agentId: id,
            name: agent.name,
            primary: agent.primaryDirPath?.split(/[/\\]/).pop() ?? "",
            turnCount: turns.length,
            openMemory: memory.records.filter((r) => r.status === "open").length,
            lastAt: last?.at ?? 0,
            gist: summary.split(/\r?\n/)[0] ?? (last ? scriptPreview(last.text, ROSTER_PREVIEW_CHARS) : ""),
          });
        }
        return out;
      },
      read: async (agentId): Promise<SceneSlice> => {
        const { projectPath } = get();
        if (!projectPath) return { turns: [], total: 0, renumbered: false };
        const { turns, renumbered } = await loadTranscript(transcriptPath(projectPath, agentId));
        return { turns, total: turns.length, renumbered };
      },
      summary: async (agentId) => {
        const { projectPath } = get();
        return projectPath ? loadSummary(projectPath, agentId) : "";
      },
      memory: async (agentId, includeClosed) => {
        const { projectPath } = get();
        if (!projectPath) return [];
        const doc = await loadMemoryDoc(memoryPath(projectPath, agentId));
        return includeClosed ? doc.records : doc.records.filter((r) => r.status === "open");
      },
    }),
  };
});
