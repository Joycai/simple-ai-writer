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
  buildBoundContent, refreshBoundBlock, seedRoleplayHistory,
  type RoleplaySessionMeta,
} from "../lib/roleplay/context";
import {
  MAX_CONCURRENT_RUNS, NO_PERSONA, ROSTER_PREVIEW_CHARS, generateAgentId,
  type AgentKind, type AuthorPersona, type RoleplayAgent, type SceneTurn,
} from "../lib/roleplay/model";
import { scriptPreview } from "../lib/roleplay/markup";
import type { SceneInfo, SceneReader, SceneSlice } from "../lib/roleplay/sceneTools";
import {
  deleteAgentDir, loadPersonaCard, loadRoster, loadSession, loadSummary,
  saveRoster, savePersonaCard, saveSession, saveSummary, transcriptPath,
} from "../lib/roleplay/store";
import { appendTurn, loadTranscript } from "../lib/roleplay/transcript";
import { readEntityFile } from "../lib/lore/entity";
import type { AttachedItem } from "../lib/lore/aiTask";
import type { LoreEntity, LoreIndex } from "../lib/lore/model";

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
  /** 播种时绑定内容的 hash，用来发现「设定已更新」。 */
  boundHash: string | null;
  /** 失效的绑定（条目/特征已删）。 */
  stalePaths: string[];
  workspace: TaskWorkspaceHandle | null;
  error: string | null;
}

interface Job {
  agentId: string;
  /** 上线的内容：作者原文 + `@` 引用内联进来的材料。 */
  wire: MessageContent;
  /** 检索用的纯文本（图片没有词可匹配）。 */
  match: string;
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
  setAuthorPersona: (persona: AuthorPersona) => Promise<void>;
  setAgentModel: (id: string, modelId: string | null) => Promise<void>;

  select: (id: string | null) => Promise<void>;
  send: (agentId: string, text: string, refs?: AttachedItem[]) => Promise<void>;
  stop: (agentId: string) => void;
  dequeue: (agentId: string) => void;
  promote: (agentId: string) => void;
  refreshBinding: (agentId: string) => Promise<void>;
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
    usage: null, boundHash: null, stalePaths: [], workspace: null, error: null,
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
      patchSession(job.agentId, (s) => ({ ...s, error: resolved.error }));
      set((st) => ({ running: st.running.filter((x) => x !== job.agentId) }));
      void pump();
      return;
    }
    const { model, provider } = resolved;

    const controller = new AbortController();
    set((st) => ({ aborts: { ...st.aborts, [job.agentId]: controller } }));
    patchSession(job.agentId, (s) => ({ ...s, streaming: "", liveLog: [], error: null }));

    const loreIndex = useLoreStore.getState().index;
    const { loreBudgetTokens, contextUtilization } = useAppStore.getState();
    const persona = agent.authorPersona ?? get().authorPersona;

    try {
      const apiKey = (await loadApiKey(provider.id)) ?? "";
      let session = get().sessions[job.agentId] ?? emptySession();
      let history = session.history;
      let meta = session.meta;

      if (!history || !meta) {
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
        const seeded = await seedRoleplayHistory({
          agent, persona, personaCard, primaryText, loreIndex,
          firstMessage: job.wire,
          matchText: job.match,
          loreBudgetChars: loreBudgetTokens * charsPerToken,
        });
        history = seeded.messages;
        meta = seeded.meta;
        patchSession(job.agentId, (s) => ({
          ...s,
          history, meta,
          boundHash: hashText(seeded.bound.text),
          stalePaths: seeded.bound.stalePaths,
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
          requestApproval: async (p) => {
            const { useAgentStore } = await import("./agentStore");
            // key 用本 agent 的 controller，绝不能是 CHAT_AUTO_APPROVE_KEY 那样
            // 的字面量——几个 agent 共用一个字面量会让 A 的「本次都批准」
            // 悄悄覆盖到 B。
            return useAgentStore.getState().requestApproval(p, controller, {
              signal: controller.signal,
              autoApproveKey: controller,
            });
          },
          resolveSubAgent: (k) =>
            resolveSubAgentConn(k, models, providers, effectiveSubs, loadApiKey),
        },
        signal: controller.signal,
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
      // 改了绑定就等于设定变了：让顶部的「刷新设定」条出来，由作者决定何时
      // 付那次 prompt 缓存的钱。
      set((st) => ({ stale: { ...st.stale, [id]: true } }));
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
      patchSession(id, (s) => ({
        ...s,
        turns,
        history: stored?.history ?? null,
        meta: (stored?.snapshot.meta as RoleplaySessionMeta | undefined) ?? null,
      }));
      if (stored?.snapshot.meta && stored.boundBlock) {
        patchSession(id, (s) => ({
          ...s,
          meta: { ...(stored.snapshot.meta as RoleplaySessionMeta), boundBlock: stored.boundBlock },
        }));
      }
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
      get().aborts[agentId]?.abort();
      set((st) => ({ queue: st.queue.filter((j) => j.agentId !== agentId) }));
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
      const session = get().sessions[agentId];
      if (!projectPath || !agent || !session?.meta) {
        set((st) => ({ stale: { ...st.stale, [agentId]: false } }));
        return;
      }
      const { useLoreStore } = await import("./loreStore");
      const bound = await refreshBoundBlock(useLoreStore.getState().index, agent, session.meta);
      patchSession(agentId, (s) => ({
        ...s, boundHash: hashText(bound.text), stalePaths: bound.stalePaths,
      }));
      set((st) => ({ stale: { ...st.stale, [agentId]: false } }));
    },

    checkBindings: async () => {
      const { projectPath, sessions } = get();
      if (!projectPath) return;
      const { useLoreStore } = await import("./loreStore");
      const loreIndex = useLoreStore.getState().index;
      const next: Record<string, boolean> = {};
      const stalePaths: Record<string, string[]> = {};
      for (const [id, session] of Object.entries(sessions)) {
        const agent = get().agents[id];
        if (!agent || session.boundHash === null) continue;
        const bound = await buildBoundContent(loreIndex, agent.boundPaths);
        next[id] = hashText(bound.text) !== session.boundHash;
        stalePaths[id] = bound.stalePaths;
      }
      set((st) => ({ stale: { ...st.stale, ...next } }));
      for (const [id, paths] of Object.entries(stalePaths)) {
        patchSession(id, (s) => ({ ...s, stalePaths: paths }));
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
          const last = turns[turns.length - 1];
          out.push({
            agentId: id,
            name: agent.name,
            primary: agent.primaryDirPath?.split(/[/\\]/).pop() ?? "",
            turnCount: turns.length,
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
    }),
  };
});
