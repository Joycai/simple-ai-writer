/**
 * 扮演会话的上下文装配。
 *
 * ## 不变量二：绑定内容进 prelude 的独立消息，永不进 seed 块
 *
 * 播种出来的历史**必须**是这个形状：
 *
 *   [0] system  人设 + 扮演规则 + 作者身份 + 输入语法
 *   [1] user    【绑定设定】boundPaths 的正文        ← prelude，压缩不丢
 *   [2] user    【记忆】仍在生效的约定 / 待办 / 关系  ← prelude，压缩不丢，会被刷新
 *   [3] user    【场景】首轮自动命中的其他词条        ← meta.seedContext，压缩会丢
 *   [4] user    作者第一句                          ← meta.turnStarts[0]
 *
 * 为什么放对位置就够、不需要给压缩加白名单：`buildCompactedHistory`
 * (lib/agent/compact) 遍历 prelude 时**只跳过** `meta.seedContext` 和
 * `meta.summary`，其余原样保留；`trimHistory` (lib/agent/runtime) 只把
 * `role:"tool"` 的内容和图片 part 换掉，不动普通 user 消息。所以 `[1]` 在
 * 两条裁剪路径下都永久存活，而 `[3]` 会在压缩时正确地消失——它是检索输出，
 * 可复现；`[1]`/`[2]` 是这个角色是谁、答应过什么，不可复现。
 *
 * ## 为什么不走 assembleContext
 *
 * 扮演没有「当前文档」、没有选区、没有故事记忆。走 `assembleContext` 意味着
 * 给四个参数传空串，只为了拿它内部的一次 `selectLore` 调用——而那次调用还
 * 不接受 `excludeDirs`，于是首轮会把已经在 `[1]` 里的绑定条目再注入一遍。
 * 直接调 `selectLore` 既短又对。
 */

import i18n from "../../i18n";
import { createSessionMeta, noteTurnStart, recordInjections, type ChatSessionMeta } from "../agent/compact";
import type { MessageContent, StreamMessage } from "../ai/types";
import { parsePins, selectLore, type LoreActivationReport } from "../context/loreSelect";
import { readEntityFile } from "../lore/entity";
import type { LoreEntity, LoreIndex } from "../lore/model";
import { renderMemoryBlock } from "./memory";
import {
  RESTORE_REPLAY_CHAR_CAP,
  type AuthorPersona, type MemoryRecord, type RoleplayAgent, type SceneTurn,
} from "./model";

/** 绑定块最多多少字符。超出的绑定项被点名但不展开，模型可以自己去读。 */
export const BOUND_BLOCK_CHAR_CAP = 12_000;

export interface RoleplaySessionMeta extends ChatSessionMeta {
  /** `[1]` 的对象身份。按身份而不是下标持有——repairToolCallPairing 会 splice。 */
  boundBlock: StreamMessage | null;
  /** `[2]` 的对象身份，刷新记忆时定位它。 */
  memoryBlock: StreamMessage | null;
}

export function createRoleplayMeta(): RoleplaySessionMeta {
  return { ...createSessionMeta(), boundBlock: null, memoryBlock: null };
}

// ─── 绑定块 ──────────────────────────────────────────────────────────────────

export interface BoundContent {
  /** 渲染好的正文；没有任何有效绑定时是空串。 */
  text: string;
  /** 解析成功的条目，用于写注入账本（防止逐轮注入重复注入它们）。 */
  entities: LoreEntity[];
  /** 失效的绑定（条目或特征已被删除），UI 用来标灰 + 一键移除。 */
  stalePaths: string[];
}

function indexByDir(loreIndex: LoreIndex): Map<string, LoreEntity> {
  const byDir = new Map<string, LoreEntity>();
  for (const entities of Object.values(loreIndex)) {
    for (const e of entities ?? []) byDir.set(e.dirPath, e);
  }
  return byDir;
}

/**
 * 读出绑定的条目 / 特征正文。
 *
 * 失效的 pin **不静默降级**：一个指向已删特征的 pin 绝不能退化成「整条都
 * 注入」——那会把作者刻意排除的内容偷偷送进去。它进 `stalePaths`，由 UI
 * 告诉作者。同样的判断已经写在 loreSelect 里，这里保持一致。
 */
export async function buildBoundContent(
  loreIndex: LoreIndex,
  boundPaths: string[],
): Promise<BoundContent> {
  const byDir = indexByDir(loreIndex);
  const parts: string[] = [];
  const entities: LoreEntity[] = [];
  const stalePaths: string[] = [];
  let used = 0;

  for (const raw of boundPaths) {
    const [pin] = parsePins([raw]);
    const entity = byDir.get(pin.dirPath);
    if (!entity) { stalePaths.push(raw); continue; }
    if (pin.facetFile && !(entity.facets ?? []).some((f) => f.file === pin.facetFile)) {
      stalePaths.push(raw);
      continue;
    }

    const file = pin.facetFile ?? "index.md";
    let body: string;
    try {
      body = (await readEntityFile(entity.dirPath, file)).trim();
    } catch {
      stalePaths.push(raw);
      continue;
    }
    const title = pin.facetFile
      ? `## ${entity.name} · ${(entity.facets ?? []).find((f) => f.file === pin.facetFile)?.title ?? pin.facetFile}`
      : `## ${entity.name}`;

    const room = BOUND_BLOCK_CHAR_CAP - used;
    if (room <= title.length + 32) {
      parts.push(`${title}\n[未展开——绑定内容已超出预算，需要时用 read_lore_entity 读它。]`);
      if (!entities.includes(entity)) entities.push(entity);
      continue;
    }
    const clipped = body.length <= room ? body : `${body.slice(0, room)}\n[……余下部分用 read_lore_entity 读。]`;
    parts.push(`${title}\n${clipped}`);
    used += title.length + clipped.length;
    if (!entities.includes(entity)) entities.push(entity);
  }

  return { text: parts.join("\n\n"), entities, stalePaths };
}

// ─── system 层 ───────────────────────────────────────────────────────────────

function personaLine(persona: AuthorPersona, loreIndex: LoreIndex, isZh: boolean): string {
  if (persona.mode === "lore" && persona.dirPath) {
    const entity = indexByDir(loreIndex).get(persona.dirPath);
    if (entity) {
      const summary = entity.summary ? `（${entity.summary}）` : "";
      return i18n.t("ai.instructions.roleplayPersonaLore", {
        name: entity.name,
        summary,
        defaultValue: isZh
          ? `与你对话的是${entity.name}${summary}。他/她是故事里的另一个人，不是作者本人。`
          : `You are speaking with ${entity.name}${summary} — another person in the story, not the author.`,
      });
    }
  }
  if (persona.mode === "prompt" && persona.prompt.trim()) {
    return i18n.t("ai.instructions.roleplayPersonaPrompt", {
      prompt: persona.prompt.trim(),
      defaultValue: isZh
        ? `与你对话的人是：${persona.prompt.trim()}`
        : `The person speaking with you: ${persona.prompt.trim()}`,
    });
  }
  return i18n.t("ai.instructions.roleplayPersonaNone", {
    defaultValue: isZh
      ? "与你对话的人没有给出身份，把他当成故事里一个你还不认识的人。"
      : "The person speaking has not given an identity — treat them as someone in the story you do not yet know.",
  });
}

/**
 * 扮演 / 旁白的 system 提示。
 *
 * **刻意不走 `profileSystemPrompt()`**，也不套作者自定义的写作提示词模板。
 * 那一套是「写作协作者」人格，要求「零附加评论、只输出所请求的写作内容」——
 * 套在扮演上是灾难：角色会开始解释自己为什么这么说。扮演有自己的一份提示，
 * 自带创作主权条款（扮演比写作更容易触发模型的自我审查）。
 */
export function buildSystemPrompt(opts: {
  agent: RoleplayAgent;
  persona: AuthorPersona;
  personaCard: string;
  primaryText: string;
  loreIndex: LoreIndex;
}): string {
  const isZh = i18n.language === "zh-CN";
  const parts: string[] = [];

  if (opts.agent.kind === "narrator") {
    parts.push(i18n.t("ai.instructions.narrator"));
  } else {
    parts.push(i18n.t("ai.instructions.roleplay", { name: opts.agent.name }));
    if (opts.primaryText.trim()) {
      parts.push(`${isZh ? "## 你是谁" : "## Who you are"}\n${opts.primaryText.trim()}`);
    }
    parts.push(personaLine(opts.persona, opts.loreIndex, isZh));
  }

  if (opts.personaCard.trim()) {
    parts.push(`${isZh ? "## 作者给你的指令" : "## The author's direction"}\n${opts.personaCard.trim()}`);
  }
  parts.push(i18n.t("ai.instructions.roleplaySyntax"));
  parts.push(i18n.t("ai.instructions.roleplayMemory"));
  return parts.join("\n\n");
}

// ─── 从 transcript 回放 ──────────────────────────────────────────────────────

/**
 * 挑出要回放进新历史的轮次。
 *
 * `session.json` 是缓存，transcript 才是资产——缓存没了就用资产重建。不这么做
 * 的话作者会看着满屏的对话，而角色说它不知道之前发生过什么：**稿面完好、模型
 * 失忆**，这是最难自查的一种坏法。
 *
 * 两条约束：
 * 1. **从作者轮开始**。轮的边界由 `noteTurnStart` 标在作者的提问上，若切片以
 *    角色轮打头，那条 assistant 消息会落在 prelude 里（第一个 turnStart 之前），
 *    压缩永远够不着它。
 * 2. **按字符封顶，取最近的**。回放走播种那条路，而播种不过压缩。
 */
export function selectReplayTurns(
  turns: readonly SceneTurn[],
  charCap: number = RESTORE_REPLAY_CHAR_CAP,
): SceneTurn[] {
  const picked: SceneTurn[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (used + turn.text.length > charCap && picked.length) break;
    picked.unshift(turn);
    used += turn.text.length;
  }
  while (picked.length && picked[0].speaker !== "author") picked.shift();
  return picked;
}

// ─── 播种 ────────────────────────────────────────────────────────────────────

export interface SeedResult {
  messages: StreamMessage[];
  meta: RoleplaySessionMeta;
  report: LoreActivationReport | null;
  bound: BoundContent;
}

export async function seedRoleplayHistory(opts: {
  agent: RoleplayAgent;
  persona: AuthorPersona;
  personaCard: string;
  primaryText: string;
  loreIndex: LoreIndex;
  firstMessage: MessageContent;
  /** 检索用的纯文本（`firstMessage` 可能带图片 part，图片没有词可匹配）。 */
  matchText: string;
  loreBudgetChars: number;
  /** 这个 agent 已经记下的东西；只有 `open` 的会进上下文。 */
  memory: readonly MemoryRecord[];
  /**
   * 从 transcript 回放的过往轮次（`session.json` 丢了时才非空）。
   * **不含**正在提的这一问——它由 `firstMessage` 承担。
   */
  priorTurns?: readonly SceneTurn[];
  /** `summary.md` 里存着的滚动摘要，回放时一并接回来。 */
  priorSummary?: string;
}): Promise<SeedResult> {
  const bound = await buildBoundContent(opts.loreIndex, opts.agent.boundPaths);
  const system: StreamMessage = {
    role: "system",
    content: buildSystemPrompt({
      agent: opts.agent,
      persona: opts.persona,
      personaCard: opts.personaCard,
      primaryText: opts.primaryText,
      loreIndex: opts.loreIndex,
    }),
  };

  const messages: StreamMessage[] = [system];
  const meta = createRoleplayMeta();

  if (bound.text) {
    const block: StreamMessage = {
      role: "user",
      content: `【${i18n.t("roleplay.section.bound", { defaultValue: "绑定设定" })}】\n${bound.text}`,
    };
    messages.push(block);
    meta.boundBlock = block;
    // 账本：绑定条目已经在上下文里，逐轮注入不该再送一遍。carrier 是绑定块
    // 本身——它永不离开历史，所以这些账本条目也永不失效。
    recordInjections(meta, bound.entities, block);
  }

  const memoryText = renderMemoryBlock(opts.memory);
  if (memoryText) {
    const block: StreamMessage = { role: "user", content: memoryBlockContent(memoryText) };
    messages.push(block);
    meta.memoryBlock = block;
  }

  // 首轮自动命中：绑定之外的词条，用作者第一句去匹配。
  const excludeDirs = new Set(bound.entities.map((e) => e.dirPath));
  const { text: snippets, report } = await selectLore(
    opts.matchText, opts.loreIndex, [], opts.loreBudgetChars, { excludeDirs },
  );
  if (snippets) {
    const seed: StreamMessage = {
      role: "user",
      content: `【${i18n.t("roleplay.section.scene", { defaultValue: "场景" })}】\n${snippets}`,
    };
    messages.push(seed);
    meta.seedContext = seed;
    const byDir = indexByDir(opts.loreIndex);
    recordInjections(
      meta,
      report.entities.flatMap((r) => byDir.get(r.dirPath) ?? []),
      seed,
    );
  }

  // 摘要接在 prelude 末尾、回放之前——`buildCompactedHistory` 也把它摆在这个
  // 位置，保持一致，下一次压缩才不用挪它。
  const summaryText = opts.priorSummary?.trim() ?? "";
  if (summaryText) {
    const block: StreamMessage = {
      role: "user",
      content: i18n.t("ai.instructions.chatCompactBlock", { summary: summaryText }),
    };
    messages.push(block);
    meta.summary = block;
    meta.summaryText = summaryText;
  }

  for (const turn of selectReplayTurns(opts.priorTurns ?? [])) {
    if (turn.speaker === "author") {
      const msg: StreamMessage = { role: "user", content: turn.text };
      messages.push(msg);
      noteTurnStart(meta, msg);
    } else {
      messages.push({ role: "assistant", content: turn.text });
    }
  }

  const question: StreamMessage = { role: "user", content: opts.firstMessage };
  messages.push(question);
  noteTurnStart(meta, question);

  return { messages, meta, report, bound };
}

function memoryBlockContent(body: string): string {
  const label = i18n.t("roleplay.section.memory", { defaultValue: "记忆" });
  const lead = i18n.t("roleplay.section.memoryLead", {
    defaultValue: "以下是你自己记下的、到现在仍然有效的事。它们不随对话变长而遗忘。",
  });
  return `【${label}】\n${lead}\n${body}`;
}

/**
 * 刷新记忆块。
 *
 * **只在四个时刻调用**：播种、压缩之后、会话恢复、作者手动。绝不在 `remember`
 * 写入的当下——那条工具结果本身就在历史里，模型这一轮、以及之后直到折叠为止的
 * 每一轮都看得见它。真正的失效边界是**那条结果被折叠掉的时刻**，而那正是压缩
 * 发生的时刻。所以「压缩后刷新」不是省钱的优化，**它精确地就是正确性边界**；
 * 写入即刷新只会让每记一件事就作废一次 prompt 缓存前缀，换来零收益。
 *
 * 就地改 content，不换消息对象——`meta.memoryBlock` 按身份持有它。
 *
 * 块从「有」变「没有」时不删除消息，改成一句「暂时没有」：删一条 prelude 消息
 * 会让历史的稳定前缀变短，等于白白作废一次缓存，而它只是一行字。
 */
export function refreshMemoryBlock(
  meta: RoleplaySessionMeta,
  records: readonly MemoryRecord[],
): void {
  if (!meta.memoryBlock) return;
  const body = renderMemoryBlock(records);
  meta.memoryBlock.content = memoryBlockContent(
    body || i18n.t("roleplay.section.memoryNone", { defaultValue: "（暂时没有。）" }),
  );
}

/**
 * 刷新绑定块（作者点了「刷新设定」）。
 *
 * **就地改 content，不换消息对象**：`meta.boundBlock` 按身份持有它，换对象
 * 就等于把账本和自己指向的东西切断。这一次刷新会作废 prompt 缓存前缀，所以
 * 它是作者的显式动作，不是每次条目变动的自动行为。
 */
export async function refreshBoundBlock(
  loreIndex: LoreIndex,
  agent: RoleplayAgent,
  meta: RoleplaySessionMeta,
): Promise<BoundContent> {
  const bound = await buildBoundContent(loreIndex, agent.boundPaths);
  if (meta.boundBlock) {
    meta.boundBlock.content =
      `【${i18n.t("roleplay.section.bound", { defaultValue: "绑定设定" })}】\n${bound.text}`;
    recordInjections(meta, bound.entities, meta.boundBlock);
  }
  return bound;
}
