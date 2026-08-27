/**
 * 一次扮演运行的**历史准备**——`runJob` 里出过全部三个高严重度 bug 的那一段，
 * 抽到 lib 里让编排本身可测。设计：docs/feature/roleplay/09-runjob-refactor-lld.md。
 *
 * 分界沿用仓库既有的一条：**lib 做 IO，store 做状态**。这里的函数可以读盘、
 * 跑压缩摘要，但不 import 任何 zustand store——需要向 store 报告的事，以返回值
 * 说出来（`SeedOutcome` / `ContinueOutcome` / `RecalledEntity[]`），由 store 去
 * patch。不引入 ports/DI（LLD §8 方案 A）：context.test 用 fileio mock + 真实
 * compact 的路线已经证明，测真排序比测「假 ports 被怎么调」值钱。
 */

import i18n from "../../i18n";
import {
  coreDoneFor, excludeDirsFor, injectedFacetsFor, noteTurnStart, recordInjections,
  recordInjectionsFromReport,
} from "../agent/compact";
import { compactChatHistory, type SummarizeInput } from "../agent/compactRun";
import type { AgentEvent } from "../agent/events";
import { repairToolCallPairing } from "../agent/runtime";
import type { MessageContent, StreamMessage } from "../ai/types";
import { hashText } from "../context/memory";
import { selectLore, type LoreActivationReport } from "../context/loreSelect";
import { assembleTurnInjection } from "../context/rag";
import { readEntityFile } from "../lore/entity";
import type { LoreIndex } from "../lore/model";
import { areaEntities, scanArea } from "./area";
import {
  blockSizes, buildBoundContent, contextSignature, recordInlinedRefs, refreshMemoryBlock,
  seedRoleplayHistory, type BoundContent, type RoleplaySessionMeta,
} from "./context";
import type { ConversationReader } from "./conversationTools";
import { loadMemoryDoc } from "./memory";
import type { AuthorPersona, MemoryRecord, RoleplayAgent, SceneTurn } from "./model";
import {
  listArchives, loadPersonaCard, loadSummary, memoryPath, transcriptPath,
} from "./store";
import { currentSceneNo } from "./scene";
import {
  primaryPiece, residentPieces, type PreflightEstimate, type ResidentPiece,
} from "./trace";
import { loadTranscript } from "./transcript";

// ─── 静态上下文 ──────────────────────────────────────────────────────────────

export interface StaticContext {
  primaryText: string;
  personaCard: string;
}

/**
 * system 层那两样住在磁盘上的输入：主角条目正文 + 人设卡里的扮演指令。
 *
 * 单独成一个函数，是因为播种、`refreshBinding` 和 `checkBindings` 必须读到
 * **同一组**输入——基线和实际内容各读各的，就是一次永远对不上的比较。
 */
export async function loadStaticContext(
  projectPath: string,
  agent: RoleplayAgent,
): Promise<StaticContext> {
  let primaryText = "";
  if (agent.primaryDirPath) {
    // 条目被删了也照跑：角色还在，只是没有那份人设了。
    try { primaryText = await readEntityFile(agent.primaryDirPath, "index.md"); } catch { /* 同上 */ }
  }
  return { primaryText, personaCard: await loadPersonaCard(projectPath, agent.id) };
}

/**
 * 一个 agent 的**静态**上下文全貌：下一次发送会带上什么，以及「设定变没变」的
 * 那个签名。
 *
 * 两件事一次读完，是因为它们读的是同一组文件（绑定条目正文 + 主角条目 + 人设卡
 * + 记忆），而这个函数会被 `checkBindings` 对每个 agent 各跑一次。分成两个函数
 * 就是把每次知识库重扫的磁盘往返翻倍，去换一个没人需要的分离。
 *
 * **签名的适用范围比预估窄**：没有基线的 agent（还没开过口）不参与「设定已更新」
 * 的比对——它没有任何已经烘进上下文的旧内容，标成「已更新」是在报一件没发生的
 * 事（05 §2.6）。但它**恰恰是最需要预估的那一个**：上下文构成条这时只画得出工具
 * schema。所以调用方拿走 `signature` 时要自己判断，拿走 `preflight` 时不必。
 */
export async function inspectAgent(opts: {
  projectPath: string;
  agent: RoleplayAgent;
  persona: AuthorPersona;
  loreIndex: LoreIndex;
}): Promise<{ signature: string; preflight: PreflightEstimate }> {
  const { projectPath, agent, persona, loreIndex } = opts;
  const [bound, statics, memoryDoc] = await Promise.all([
    buildBoundContent(loreIndex, agent.boundPaths),
    loadStaticContext(projectPath, agent),
    loadMemoryDoc(memoryPath(projectPath, agent.id)),
  ]);
  const system = {
    agent, persona, personaCard: statics.personaCard,
    primaryText: statics.primaryText, loreIndex,
  };
  return {
    signature: contextSignature({ ...system, boundText: bound.text }),
    preflight: {
      ...blockSizes({ system, boundText: bound.text, memory: memoryDoc.records }),
      resident: residentPieces(
        primaryPiece(loreIndex, agent.primaryDirPath, statics.primaryText),
        bound.pieces,
      ),
      stalePaths: bound.stalePaths,
    },
  };
}

// ─── 角色回看自己这一场的通道 ────────────────────────────────────────────────

/**
 * `ToolContext.conversation` 的工厂。每次调用都读盘，不缓存：作者的这一问在
 * `send` 里就落盘了，而 ToolContext 是运行开始时的快照——缓存会让角色说刚
 * 发生的事没发生。作用域是结构性的：没有 agent id 参数，只够得到自己。
 */
export function conversationReader(
  projectPath: string,
  agentId: string,
): ConversationReader {
  return {
    scenes: async () => {
      // 目录每次重读：作者可能刚在别处转了一场。**作废的在这里就被滤掉**，
      // 所以工具层根本拿不到它们的场号。
      const list = await listArchives(projectPath, agentId);
      return {
        current: currentSceneNo(list.map((a) => a.no)),
        past: list.filter((a) => !a.discarded).map((a) => a.no),
      };
    },
    read: async (scene) => {
      const hit = (await listArchives(projectPath, agentId))
        .find((a) => a.no === scene && !a.discarded);
      const { turns, renumbered } = await loadTranscript(
        hit ? hit.path : transcriptPath(projectPath, agentId),
      );
      return { turns, renumbered };
    },
  };
}

// ─── 回放轮的选择 ────────────────────────────────────────────────────────────

/**
 * 从显示层的当前对话里挑出要回放的过往轮次：去掉末尾那条**刚落盘的作者问**
 * ——它由播种的 `firstMessage` 承担，回放再带一遍就是同一句话出现两次。
 * 末尾不是作者轮（比如上一轮的回复刚写完）就整段原样回放。
 */
export function selectPriorTurns(turns: readonly SceneTurn[]): readonly SceneTurn[] {
  return turns.length && turns[turns.length - 1].speaker === "author"
    ? turns.slice(0, -1)
    : turns;
}

// ─── 记忆区检索 ──────────────────────────────────────────────────────────────



/**
 * 记忆区：第二路检索，**独立成块**，插在 `history[insertIndex]`。
 *
 * 分块不是排版偏好：【知识库】是世界的事实，【记忆】是这个角色**以为**的事，
 * 两者可以互相矛盾（06 §4.2）。合成一块，角色会开始把自己的猜测当成公认
 * 事实说出口。
 *
 * 预算也分开——一场戏聊到深处时最不该发生的事，是角色的记忆把它自己的
 * 人设挤出去。
 *
 * 播种和续跑两条路**都**要走这里：这段检索曾经只活在续跑分支里，于是新开
 * 会话（也包括每次重启后的重播种）的第一问永远想不起任何旧事——而转场后的
 * 第一句恰恰是最需要「想起旧事」的时刻。
 *
 * 返回**整份检索报告**，不只是想起的条目名。稿面上那道「想起了…」痕迹只要
 * 名字，而取材条要回答的是「为什么是这几条」——命中的层、激活它的关键字、
 * 命中了却没进去的和原因，全在报告里，丢掉就再也算不回来。`null` = 什么都
 * 没想起（区为空、没命中、或读不出来）。读不出来不该毁掉这一轮：角色少想起
 * 几件事，比这一句话发不出去好。
 */
export async function injectAreaRecall(opts: {
  projectPath: string;
  areaId: string | null;
  matchText: string;
  /** 就地 splice。 */
  history: StreamMessage[];
  /** 就地记账；prelude 情形就地标轮起点。 */
  meta: RoleplaySessionMeta;
  insertIndex: number;
  budgetChars: number;
}): Promise<LoreActivationReport | null> {
  const { projectPath, areaId, matchText, history, meta, insertIndex, budgetChars } = opts;
  if (!areaId) return null;
  try {
    const areaIndex = await scanArea(projectPath, areaId);
    const picked = await selectLore(
      matchText, areaIndex, [], budgetChars,
      // 账本共用一份；记忆区条目住在 `.ai-writer/roleplay/areas/` 下，dirPath
      // 天然不会和项目条目撞车。
      { excludeDirs: excludeDirsFor(meta, areaIndex) },
    );
    if (!picked.text) return null;
    const label = i18n.t("roleplay.section.recall", { defaultValue: "记忆" });
    const lead = i18n.t("roleplay.section.recallLead", {
      defaultValue: "以下是你想起来的旧事。这是**你记得的**，未必和别人说的一致。",
    });
    const carrier: StreamMessage = {
      role: "user",
      content: `【${label}】\n${lead}\n${picked.text}`,
    };
    history.splice(insertIndex, 0, carrier);
    // 折叠语义：载体必须落在可折叠的一侧。续跑时它挂在上一轮的尾部；播种且
    // 没有回放轮时它前面没有任何轮起点，会落进 prelude——永不折叠、账本条目
    // 永不过期。此时把它自己标成轮起点（segmentHistory 按 Set 判断，不看
    // turnStarts 的数组顺序），它就成了一个日后可被正常折叠的单消息轮。
    const starts = new Set(meta.turnStarts);
    if (!history.slice(0, insertIndex).some((m) => starts.has(m))) {
      noteTurnStart(meta, carrier);
    }
    const byDir = new Map(areaEntities(areaIndex).map((e) => [e.dirPath, e]));
    recordInjections(
      meta,
      picked.report.entities.flatMap((r) => byDir.get(r.dirPath) ?? []),
      carrier,
    );
    return picked.report;
  } catch (e) {
    console.warn("[roleplay] memory area not read:", e);
    return null;
  }
}

// ─── 播种分支 ────────────────────────────────────────────────────────────────

export interface SeedOutcome {
  history: StreamMessage[];
  meta: RoleplaySessionMeta;
  /** `stalePaths` 给 UI 标灰失效的绑定。 */
  bound: BoundContent;
  /** context-seeded 事件里的数字。 */
  report: LoreActivationReport | null;
  /** 记事本面板的初始数据。 */
  memoryRecords: MemoryRecord[];
  /** 「设定已更新」的新基线，store 写进花名册。 */
  contextHash: string;
  /** 本轮记忆区检索报告；`null` = 什么都没想起。 */
  recall: LoreActivationReport | null;
  /**
   * 常驻层的实况：system 里的主角那一份 + 绑定块里逐项的真实形状。
   *
   * 在这里装配而不是把 `primaryText` 抛给 store 自己拼：主角正文住在 system
   * 层这件事是**这个函数**刚刚做的决定，让调用方再推导一遍，就是把一条不变量
   * 复制成两份。
   */
  resident: ResidentPiece[];
}

/**
 * runJob 的播种分支：没有活历史（新会话，或 `session.json` 读不出来）时，
 * 从 transcript + 设定重建一段完整的历史。
 *
 * 排序 = 原店内代码逐条搬过来：静态上下文 → 记忆 → 回放轮 → 播种 → 基线哈希
 * → 区检索（插在提问前一位）。**基线必须由 `contextSignature` 在这里算**——
 * 和 `checkBindings` 是同一个函数、同一组输入，各读各的就是一次永远对不上的
 * 比较（`RoleplayAgent.contextHash` 的注释）。
 *
 * `session.json` 丢了而 transcript 里已经有对话——把它回放回去。不回放的话
 * 作者看着满屏的记录，角色却说它不知道之前发生过什么：**稿面完好、模型失忆**。
 * transcript 是资产，session.json 只是缓存。
 */
export async function prepareSeededHistory(opts: {
  projectPath: string;
  agent: RoleplayAgent;
  persona: AuthorPersona;
  loreIndex: LoreIndex;
  /** 取材范围（见 lib/lore/collections）；绑定条目不受它限制。 */
  loreScope?: string | null;
  wire: MessageContent;
  matchText: string;
  /** `@` 引用已经把正文内联进 `wire` 的条目（dirPath），不再由检索送第二份。 */
  refDirs?: readonly string[];
  loreBudgetChars: number;
  areaBudgetChars: number;
  /** 显示层的当前对话（store 传入），用来算回放轮。 */
  currentTurns: readonly SceneTurn[];
}): Promise<SeedOutcome> {
  const { projectPath, agent, persona, loreIndex } = opts;
  // 主角条目正文进 system 层——它是「你是谁」，是唯一整轮存活的那一层。
  const { primaryText, personaCard } = await loadStaticContext(projectPath, agent);
  const memoryDoc = await loadMemoryDoc(memoryPath(projectPath, agent.id));
  const priorTurns = selectPriorTurns(opts.currentTurns);
  const seeded = await seedRoleplayHistory({
    agent, persona, personaCard, primaryText, loreIndex,
    firstMessage: opts.wire,
    matchText: opts.matchText,
    refDirs: opts.refDirs,
    loreBudgetChars: opts.loreBudgetChars,
    memory: memoryDoc.records,
    priorTurns,
    priorSummary: priorTurns.length ? await loadSummary(projectPath, agent.id) : "",
  });
  const contextHash = hashText(contextSignature({
    agent, persona, personaCard, primaryText, loreIndex,
    boundText: seeded.bound.text,
  }));
  // 播种出来的历史以这一问收尾——旧事插在它前面。
  const recall = await injectAreaRecall({
    projectPath,
    areaId: agent.areaId,
    matchText: opts.matchText,
    history: seeded.messages,
    meta: seeded.meta,
    insertIndex: seeded.messages.length - 1,
    budgetChars: opts.areaBudgetChars,
  });
  return {
    history: seeded.messages,
    meta: seeded.meta,
    bound: seeded.bound,
    report: seeded.report,
    memoryRecords: memoryDoc.records,
    contextHash,
    recall,
    resident: residentPieces(
      primaryPiece(loreIndex, agent.primaryDirPath, primaryText),
      seeded.bound.pieces,
    ),
  };
}

// ─── 续跑分支 ────────────────────────────────────────────────────────────────

export interface ContinueOutcome {
  /** 压缩可能重建数组；没压缩时就是传入的那一个。store 无条件换上。 */
  history: StreamMessage[];
  compactedEvent: AgentEvent | null;
  /**
   * 压缩产出的滚动摘要；store 负责 fire-and-forget 落盘——挪进这里同步 await
   * 会改变失败语义（摘要写不进盘今天不毁这一轮）。
   */
  summaryToSave: string | null;
  /** 压缩后从盘上重读的记忆；null = 没压缩，记事本不用动。 */
  memoryRecords: MemoryRecord[] | null;
  /**
   * 本轮的知识库检索报告。
   *
   * 在这个字段存在之前，`assembleTurnInjection` 的报告**在这个函数内部就被
   * 丢掉了**——记完账就没人再看它一眼。于是第 2 轮往后的取材事实永远算不
   * 回来：播种轮好歹还有 `SeedOutcome.report`，续跑轮什么都没有。
   */
  loreReport: LoreActivationReport | null;
  recall: LoreActivationReport | null;
}

/**
 * runJob 的续跑分支：有活历史时，把这一问接进去。
 *
 * 排序是这个函数存在的理由，逐条钉在测试里（run.test.ts）：
 *
 *   修对 → 压缩 →（压缩了才）刷新记忆块 → 条目注入 → 区检索 → 提问。
 *
 * 「压缩之后刷新记忆块」不是省钱的优化，**它精确地就是正确性边界**——压缩刚把
 * `remember` 的工具结果折叠掉，此刻不重灌，角色欠着的约定就从上下文里消失了
 * （refreshMemoryBlock 的注释）。**提问永远是最后一条**，且是本轮的 turnStart。
 *
 * `history` / `meta` 都是就地改：meta 的块身份必须跨越整个准备存活
 * （saveSession 的下标序列化依赖它）。
 */
export async function prepareContinuedHistory(opts: {
  projectPath: string;
  agent: RoleplayAgent;
  loreIndex: LoreIndex;
  /** 取材范围（见 lib/lore/collections）；绑定条目不受它限制。 */
  loreScope?: string | null;
  history: StreamMessage[];
  meta: RoleplaySessionMeta;
  wire: MessageContent;
  matchText: string;
  /** `@` 引用已经把正文内联进 `wire` 的条目（dirPath），不再由检索送第二份。 */
  refDirs?: readonly string[];
  loreBudgetChars: number;
  areaBudgetChars: number;
  ceilingTokens: number;
  /** 连接绑定的摘要器，store 用 connOptions 闭包好传进来——lib 不碰密钥。 */
  summarize: (input: SummarizeInput) => Promise<string>;
}): Promise<ContinueOutcome> {
  const { projectPath, agent, loreIndex, meta } = opts;
  let history = opts.history;
  repairToolCallPairing(history);

  let compactedEvent: AgentEvent | null = null;
  let summaryToSave: string | null = null;
  let memoryRecords: MemoryRecord[] | null = null;

  const compacted = await compactChatHistory({
    history, meta,
    ceilingTokens: opts.ceilingTokens,
    summarize: opts.summarize,
  });
  if (compacted) {
    history = compacted.history;
    compactedEvent = compacted.event;
    // 折叠出来的摘要要落盘：旁白的 read_scene_summary 读的就是它，而这是它唯一
    // 被写出来的时刻——压缩本来就在生成这段文字，再要一次是白花钱。
    summaryToSave = meta.summaryText;
    // 压缩刚刚把 `remember` 的那些工具结果折叠掉了——这正是记忆注入块必须重新
    // 灌一遍的时刻，也是它唯一免费的时刻（历史本来就重建了，缓存本来就作废了）。
    const fresh = await loadMemoryDoc(memoryPath(projectPath, agent.id));
    refreshMemoryBlock(meta, fresh.records);
    memoryRecords = fresh.records;
  }

  // 逐轮注入：还没进过上下文的那些层。账本按层记，所以「绑了一段特征」不再等于
  // 「整条失联」——条目其余的特征照常按 keys 补进来。
  //
  // 主角条目当 pin：作者对着角色说话，一整场戏都未必写出它的名字，而自动匹配要先
  // 命中条目名才轮得到特征（`coreDone` 挡着它的正文不重发）。
  const coreDone = coreDoneFor(meta, loreIndex);
  for (const dir of opts.refDirs ?? []) coreDone.add(dir);
  const inj = await assembleTurnInjection({
    loreIndex,
    matchTarget: opts.matchText,
    pinPaths: agent.primaryDirPath ? [agent.primaryDirPath] : [],
    coreDone,
    excludeFacets: injectedFacetsFor(meta, loreIndex),
    scope: opts.loreScope,
    loreBudgetChars: opts.loreBudgetChars,
    doc: null,
  });
  if (inj.text) {
    const carrier: StreamMessage = { role: "user", content: inj.text };
    history.push(carrier);
    recordInjectionsFromReport(meta, inj.loreReport, loreIndex, carrier);
  }

  const recall = await injectAreaRecall({
    projectPath,
    areaId: agent.areaId,
    matchText: opts.matchText,
    history, meta,
    insertIndex: history.length,
    budgetChars: opts.areaBudgetChars,
  });

  const question: StreamMessage = { role: "user", content: opts.wire };
  noteTurnStart(meta, question);
  history.push(question);
  recordInlinedRefs(meta, loreIndex, opts.refDirs, question);

  return {
    history, compactedEvent, summaryToSave, memoryRecords,
    // 报告无条件带出去，`inj.text` 为空时也带：一次「什么都没命中」和一次
    // 「没跑过检索」在界面上是两句话，而只有这里分得清。
    loreReport: inj.loreReport,
    recall,
  };
}
