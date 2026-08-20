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
import { compactChatHistory, summarizeForCompaction } from "../lib/agent/compactRun";
import { excludeDirsFor, noteTurnStart } from "../lib/agent/compact";
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
import { inputCeilingFor, measureCharsPerToken } from "../lib/context/budget";
import { hashText } from "../lib/context/memory";
import { assembleTurnInjection } from "../lib/context/rag";
import { loadApiKey } from "../lib/keyStore";
import { notify } from "../lib/notify";
import {
  buildBoundContent, refreshBoundBlock, refreshMemoryBlock, seedRoleplayHistory,
  type RoleplaySessionMeta,
} from "../lib/roleplay/context";
import {
  addRecord, loadMemoryDoc, reviseRecord, saveMemoryDoc, type MemoryDoc,
} from "../lib/roleplay/memory";
import type { AgentMemoryStore } from "../lib/roleplay/memoryTools";
import {
  MAX_CONCURRENT_RUNS, NO_PERSONA, ROSTER_PREVIEW_CHARS, generateAgentId,
  type AgentKind, type AuthorPersona, type MemoryRecord, type MemoryStatus,
  type RoleplayAgent, type SceneTurn,
} from "../lib/roleplay/model";
import { scriptPreview } from "../lib/roleplay/markup";
import type { SceneInfo, SceneReader, SceneSlice } from "../lib/roleplay/sceneTools";
import {
  archiveSession, deleteAgentDir, loadPersonaCard, loadRoster, loadSession, loadSummary,
  memoryPath, saveRoster, savePersonaCard, saveSession, saveSummary, transcriptPath,
} from "../lib/roleplay/store";
import { appendTurn, loadTranscript } from "../lib/roleplay/transcript";
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
  /** 失效的绑定（条目/特征已删）。基线哈希在 `RoleplayAgent.boundHash` 上。 */
  stalePaths: string[];
  /** 这个 agent 的记忆，记事本面板的数据源；写入后同步更新。 */
  memory: MemoryRecord[];
  /** 磁盘上的记忆已经变了，但注入块还没刷新（见 refreshMemoryBlock 的四个时刻）。 */
  memoryStale: boolean;
  workspace: TaskWorkspaceHandle | null;
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

  load: (projectPath: string) => Promise<void>;
  reset: () => void;

  createAgent: (draft: AgentDraft) => Promise<string | null>;
  updateAgent: (id: string, draft: AgentDraft) => Promise<void>;
  removeAgent: (id: string) => Promise<void>;
  /**
   * 新开一场：把当前 transcript / summary 封存进 `archive/`，agent 从空白开始。
   * 设定、绑定、人设卡全部保留——「重新开始」不该等于删了重建。
   */
  newSession: (id: string, opts: { clearMemory: boolean }) => Promise<void>;
  setAuthorPersona: (persona: AuthorPersona) => Promise<void>;
  setAgentModel: (id: string, modelId: string | null) => Promise<void>;

  select: (id: string | null) => Promise<void>;
  send: (agentId: string, text: string, refs?: AttachedItem[]) => Promise<void>;
  stop: (agentId: string) => void;
  /** 重跑上一次失败的作业。只在 `session.error` 亮着时有意义。 */
  retry: (agentId: string) => void;
  dequeue: (agentId: string) => void;
  promote: (agentId: string) => void;
  refreshBinding: (agentId: string) => Promise<void>;
  /** 把磁盘上的记忆重新灌进注入块（作者手动，或改过记事本之后）。 */
  refreshMemory: (agentId: string) => Promise<void>;
  /** 记事本面板的编辑入口。作者和角色共同维护这一本。 */
  addMemory: (agentId: string, rec: {
    kind: MemoryRecord["kind"]; title: string; body: string; subject: string | null;
  }) => Promise<void>;
  reviseMemory: (
    agentId: string, id: string, patch: { body?: string; status?: MemoryStatus },
  ) => Promise<void>;
  checkBindings: () => Promise<void>;
  /** 旁白的只读通道；传给 ToolContext.scenes。 */
  sceneReader: () => SceneReader;
}

export interface AgentDraft {
  kind: AgentKind;
  name: string;
  primaryDirPath: string | null;
  boundPaths: string[];
  modelId: string | null;
  instruction: string;
}

function emptySession(): LiveSession {
  return {
    turns: [], log: {}, history: null, meta: null, streaming: "", liveLog: [],
    usage: null, stalePaths: [], memory: [], memoryStale: false,
    workspace: null, error: null, lastJob: null,
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
      ...s, streaming: "", liveLog: [], error: null, lastJob: job,
    }));

    const loreIndex = useLoreStore.getState().index;
    const { loreBudgetTokens, contextUtilization } = useAppStore.getState();
    const persona = agent.authorPersona ?? get().authorPersona;

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
        // 主角条目正文进 system 层——它是「你是谁」，是唯一整轮存活的那一层。
        let primaryText = "";
        if (agent.primaryDirPath) {
          try {
            primaryText = await readEntityFile(agent.primaryDirPath, "index.md");
          } catch {
            primaryText = "";
          }
        }
        const personaCard = await loadPersonaCard(projectPath, agent.id);
        const charsPerToken = measureCharsPerToken(job.match);
        const memoryDoc = await loadMemoryDoc(memoryPath(projectPath, agent.id));
        // `session.json` 丢了（或从没写过）而 transcript 里已经有对话——把它回放
        // 回去。不回放的话作者看着满屏的记录，角色却说它不知道之前发生过什么：
        // **稿面完好、模型失忆**。transcript 是资产，session.json 只是缓存。
        //
        // 末尾那一轮是 `send` 刚刚落盘的这一问，由 `firstMessage` 承担，回放要去掉。
        const all = get().sessions[job.agentId]?.turns ?? [];
        const priorTurns = all.length && all[all.length - 1].speaker === "author"
          ? all.slice(0, -1)
          : all;
        const seeded = await seedRoleplayHistory({
          agent, persona, personaCard, primaryText, loreIndex,
          firstMessage: job.wire,
          matchText: job.match,
          loreBudgetChars: loreBudgetTokens * charsPerToken,
          memory: memoryDoc.records,
          priorTurns,
          priorSummary: priorTurns.length
            ? await loadSummary(projectPath, agent.id)
            : "",
        });
        history = seeded.messages;
        meta = seeded.meta;
        // 基线进花名册而不是进内存的会话：没打开过的 agent 也要能亮起
        // 「设定已更新」，而那正是刚打开应用时最需要它的时刻。
        set((st) => ({
          agents: {
            ...st.agents,
            [agent.id]: { ...st.agents[agent.id], boundHash: hashText(seeded.bound.text) },
          },
          stale: { ...st.stale, [agent.id]: false },
        }));
        void persistRoster();
        patchSession(job.agentId, (s) => ({
          ...s,
          history, meta,
          stalePaths: seeded.bound.stalePaths,
          memory: memoryDoc.records,
          memoryStale: false,
          liveLog: appendAgentEventTo(s.liveLog, {
            kind: "context-seeded",
            documentName: null,
            recentChars: 0,
            memoryChars: 0,
            loreEntities: seeded.report?.entities.length ?? 0,
            loreChars: seeded.report?.usedChars ?? 0,
            at: Date.now(),
          }),
        }));
      } else {
        repairToolCallPairing(history);

        const compacted = await compactChatHistory({
          history,
          meta,
          ceilingTokens: inputCeilingFor(model.contextSize, contextUtilization),
          summarize: (input) =>
            summarizeForCompaction(connOptions({ provider, model, apiKey }), input, controller.signal),
        });
        if (compacted) {
          history = compacted.history;
          patchSession(job.agentId, (s) => ({
            ...s, history, liveLog: appendAgentEventTo(s.liveLog, compacted.event),
          }));
          // 折叠出来的摘要落盘：旁白的 read_scene_summary 读的就是它，而这
          // 是它唯一被写出来的时刻——压缩本来就在生成这段文字，再要一次是白花钱。
          if (meta.summaryText) {
            void saveSummary(projectPath, job.agentId, meta.summaryText);
          }
          // 压缩刚刚把 `remember` 的那些工具结果折叠掉了——这正是记忆注入块
          // 必须重新灌一遍的时刻，也是它唯一免费的时刻（历史本来就重建了，
          // 缓存本来就作废了）。见 refreshMemoryBlock 的注释。
          const fresh = await loadMemoryDoc(memoryPath(projectPath, job.agentId));
          refreshMemoryBlock(meta, fresh.records);
          patchSession(job.agentId, (s) => ({
            ...s, memory: fresh.records, memoryStale: false,
          }));
        }

        // 逐轮注入：绑定之外的新词条。账本保证已经在上下文里的不再重发。
        const inj = await assembleTurnInjection({
          loreIndex,
          matchTarget: job.match,
          excludeDirs: excludeDirsFor(meta, loreIndex),
          loreBudgetChars: loreBudgetTokens * measureCharsPerToken(job.match),
          doc: null,
        });
        if (inj.text) {
          const carrier: StreamMessage = { role: "user", content: inj.text };
          history.push(carrier);
          const byDir = indexByDir(loreIndex);
          const { recordInjections } = await import("../lib/agent/compact");
          recordInjections(
            meta, inj.matchedEntities.flatMap((e) => byDir.get(e.dirPath) ?? []), carrier,
          );
        }

        const question: StreamMessage = { role: "user", content: job.wire };
        noteTurnStart(meta, question);
        history.push(question);
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
        workspace = createTaskWorkspace(projectPath, model.id, agent.taskId ?? undefined);
        patchSession(job.agentId, (s) => ({ ...s, workspace }));
      }

      const preset = presetFor(agent.kind);
      const effectiveSubs = withSessionOverrides(subAgents, [] as SubAgentKind[]);
      const routed = routeTools(preset, effectiveSubs, workspace, models);

      const result = await runAgent({
        ...connOptions({ provider, model, apiKey }),
        inputCeilingTokens: inputCeilingFor(model.contextSize, contextUtilization),
        preset: { ...preset, tools: routed.tools, serverTools: routed.serverTools },
        messages: history,
        toolContext: {
          projectPath,
          loreIndex,
          multimodal: model.type === "multimodal",
          taskWorkspace: workspace,
          signal: controller.signal,
          // 只有旁白拿得到这个通道，所以扮演 agent 的 scene 工具即使被硬塞
          // 进 preset 也只会得到一句「你不是旁白」。双保险，不是冗余。
          scenes: agent.kind === "narrator" ? get().sceneReader() : undefined,
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
        // 扮演 agent 的 `maxRounds: 4` 是刻意的小：它的期望响应是一句台词，
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
        onEvent: (event) =>
          patchSession(job.agentId, (s) => ({ ...s, liveLog: appendAgentEventTo(s.liveLog, event) })),
        onOutputText: (text) => patchSession(job.agentId, (s) => ({ ...s, streaming: text })),
      });

      const reply = get().sessions[job.agentId]?.streaming.trim() ?? "";
      if (reply) {
        const turns = get().sessions[job.agentId]?.turns ?? [];
        const turn: SceneTurn = {
          index: turns.length + 1,
          speaker: "agent",
          speakerName: agent.name,
          at: Math.floor(Date.now() / 1000),
          text: reply,
        };
        await appendTurn(transcriptPath(projectPath, agent.id), agent.id, turn);
        patchSession(job.agentId, (s) => ({
          ...s,
          turns: [...s.turns, turn],
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
      if ((e as Error).name !== "AbortError") {
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

      const s = get().sessions[job.agentId];
      if (s?.history && s.meta) {
        void saveSession(projectPath, job.agentId, {
          history: s.history,
          snapshot: { turns: [], history: s.history, meta: s.meta, usage: null, taskId: s.workspace?.taskId ?? null },
          boundBlock: s.meta.boundBlock,
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

    load: async (projectPath) => {
      set({ projectPath, loaded: false, rosterError: null, sessions: {}, running: [], queue: [], aborts: {} });
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

    reset: () => set({
      projectPath: null, loaded: false, rosterError: null, order: [], agents: {},
      authorPersona: NO_PERSONA, sessions: {}, activeAgentId: null,
      running: [], queue: [], aborts: {}, unread: {}, stale: {},
    }),

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
        authorPersona: null,
        taskId: null,
        createdAt: now,
        updatedAt: now,
        turnCount: 0,
        boundHash: null,
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

    newSession: async (id, opts) => {
      const { projectPath } = get();
      const agent = get().agents[id];
      if (!projectPath || !agent) return;
      // 跑着的时候不许开新场：正在写的那一轮会追加到一个已经被移走的文件上。
      if (get().running.includes(id) || get().queue.some((j) => j.agentId === id)) return;

      try {
        await archiveSession(projectPath, id, opts);
      } catch (e) {
        patchSession(id, (s) => ({ ...s, error: String(e) }));
        return;
      }

      // 会话整个归零。`boundHash` 一并清掉——它是「设定已更新」的基线，而这一
      // 场还没播种过，没有基线可比；留着旧的会让提示按上一场的状态亮。
      const memory = opts.clearMemory ? [] : get().sessions[id]?.memory ?? [];
      set((st) => ({
        sessions: { ...st.sessions, [id]: { ...emptySession(), memory } },
        unread: { ...st.unread, [id]: false },
        stale: { ...st.stale, [id]: false },
        agents: {
          ...st.agents,
          [id]: { ...agent, turnCount: 0, boundHash: null, updatedAt: Math.floor(Date.now() / 1000) },
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
      patchSession(id, (s) => ({
        ...s,
        turns,
        history: stored?.history ?? null,
        meta: (stored?.snapshot.meta as RoleplaySessionMeta | undefined) ?? null,
        memory: doc.records,
        memoryStale: false,
      }));
      if (stored?.snapshot.meta && stored.boundBlock) {
        patchSession(id, (s) => ({
          ...s,
          meta: { ...(stored.snapshot.meta as RoleplaySessionMeta), boundBlock: stored.boundBlock },
        }));
      }
      // 恢复是四个刷新时刻之一：应用关着的时候作者可能手改过 memory.md。
      const restored = get().sessions[id]?.meta;
      if (restored) refreshMemoryBlock(restored, doc.records);
      void get().checkBindings();
    },

    send: async (agentId, text, refs = []) => {
      const { projectPath } = get();
      const agent = get().agents[agentId];
      const body = text.trim();
      if (!projectPath || !agent || !body) return;

      const persona = agent.authorPersona ?? get().authorPersona;
      const personaName = persona.mode === "lore" && persona.dirPath
        ? (await import("./loreStore").then((m) =>
            indexByDir(m.useLoreStore.getState().index).get(persona.dirPath!)?.name ?? ""))
        : "";

      const turns = get().sessions[agentId]?.turns ?? [];
      const turn: SceneTurn = {
        index: turns.length + 1,
        speaker: "author",
        speakerName: personaName,
        at: Math.floor(Date.now() / 1000),
        text: body,
      };
      // 先落盘，再排队。模型跑不动只是一次重试，写不进去是数据丢失。
      try {
        await appendTurn(transcriptPath(projectPath, agentId), agentId, turn);
      } catch (e) {
        patchSession(agentId, (s) => ({ ...s, error: String(e) }));
        return;
      }
      patchSession(agentId, (s) => ({ ...s, turns: [...s.turns, turn], error: null }));

      // `@` 引用是**内联**的，不是提名的：作者打了 @西厢 就已经决定助手该看着
      // 它说话，把那变成模型可以跳过的建议是在赌一件已经定了的事（见
      // lib/agent/chatRefs 的开头）。transcript 里存的仍是作者敲的那句话。
      const { buildChatMessage } = await import("../lib/agent/chatRefs");
      const composed = await buildChatMessage(body, undefined, refs, {
        allowImages: false,
        visionDelegate: false,
      });
      set((st) => ({
        queue: [...st.queue, { agentId, wire: composed.content, match: composed.text }],
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
      patchSession(agentId, (s) => ({ ...s, error: null }));
      set((st) => ({ queue: [...st.queue, job] }));
      void pump();
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

      // 有活的历史就就地重写绑定块（对象身份不变，meta 继续指着它）；没有的
      // 话什么都不用改写——下一次发送会重新播种，那时用的自然是新内容。两条
      // 路都要把基线更新到「现在」，否则 checkBindings 下一轮又把它标成过期。
      const bound = session?.meta
        ? await refreshBoundBlock(loreIndex, agent, session.meta)
        : await buildBoundContent(loreIndex, agent.boundPaths);

      set((st) => ({
        agents: {
          ...st.agents,
          [agentId]: { ...st.agents[agentId], boundHash: hashText(bound.text) },
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
      const meta = get().sessions[agentId]?.meta;
      // 没有活的历史就不用刷——下一次发送会重新播种，那时读的就是磁盘上的新内容。
      if (meta) refreshMemoryBlock(meta, doc.records);
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

    /**
     * 重新比对每个 agent 的绑定内容。
     *
     * 遍历**整个花名册**，不只是打开过的会话：基线 (`agent.boundHash`) 现在存在
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
      for (const id of order) {
        const agent = get().agents[id];
        if (!agent || agent.boundHash === null) continue;
        const bound = await buildBoundContent(loreIndex, agent.boundPaths);
        next[id] = hashText(bound.text) !== agent.boundHash;
        stalePaths[id] = bound.stalePaths;
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
