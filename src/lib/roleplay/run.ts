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
import { excludeDirsFor, noteTurnStart, recordInjections } from "../agent/compact";
import type { StreamMessage } from "../ai/types";
import { selectLore } from "../context/loreSelect";
import { readEntityFile } from "../lore/entity";
import { areaEntities, scanArea } from "./area";
import type { RoleplaySessionMeta } from "./context";
import type { ConversationReader } from "./conversationTools";
import type { RoleplayAgent } from "./model";
import { loadPersonaCard, transcriptPath } from "./store";
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
    read: async () => {
      const { turns, renumbered } = await loadTranscript(transcriptPath(projectPath, agentId));
      return { turns, renumbered };
    },
  };
}

// ─── 记忆区检索 ──────────────────────────────────────────────────────────────

export interface RecalledEntity {
  name: string;
  dirPath: string;
}

/**
 * 记忆区：第二路检索，**独立成块**，插在 `history[insertIndex]`。
 *
 * 分块不是排版偏好：【设定】是世界的事实，【记忆】是这个角色**以为**的事，
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
 * 返回想起的条目（稿面上那道「想起了…」痕迹的数据），`[]` = 没想起任何事
 * ——区为空、没命中、或读不出来。读不出来不该毁掉这一轮：角色少想起几件事，
 * 比这一句话发不出去好。
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
}): Promise<RecalledEntity[]> {
  const { projectPath, areaId, matchText, history, meta, insertIndex, budgetChars } = opts;
  if (!areaId) return [];
  try {
    const areaIndex = await scanArea(projectPath, areaId);
    const picked = await selectLore(
      matchText, areaIndex, [], budgetChars,
      // 账本共用一份；记忆区条目住在 `.ai-writer/roleplay/areas/` 下，dirPath
      // 天然不会和项目条目撞车。
      { excludeDirs: excludeDirsFor(meta, areaIndex) },
    );
    if (!picked.text) return [];
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
    return picked.report.entities.map((r) => ({
      name: byDir.get(r.dirPath)?.name ?? r.dirPath,
      dirPath: r.dirPath,
    }));
  } catch (e) {
    console.warn("[roleplay] memory area not read:", e);
    return [];
  }
}
