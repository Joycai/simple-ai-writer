/**
 * 扮演会话的上下文装配。
 *
 * ## 不变量二：绑定内容进 prelude 的独立消息，永不进 seed 块
 *
 * 播种出来的历史**必须**是这个形状：
 *
 *   [0] system  人设 + 扮演规则 + 作者身份 + 输入语法
 *   [1] user    【绑定条目】boundPaths 的正文        ← prelude，压缩不丢
 *   [2] user    【记忆】仍在生效的约定 / 待办 / 关系  ← prelude，压缩不丢，会被刷新
 *   [3] user    【场景】首轮自动命中的其他条目        ← meta.seedContext，压缩会丢
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
import {
  clearCarrier, coreDoneFor, createSessionMeta, injectedFacetsFor, noteTurnStart,
  recordInjection, recordInjectionsFromReport, type ChatSessionMeta,
} from "../agent/compact";
import { estimateTextTokens } from "../ai/tokenEstimate";
import type { MessageContent, StreamMessage } from "../ai/types";
import { parsePins, selectLore, type LoreActivationReport } from "../context/loreSelect";
import { readEntityFile } from "../lore/entity";
import type { LoreEntity, LoreIndex } from "../lore/model";
import type { LoreScope } from "../lore/collections";
import { renderMemoryBlock } from "./memory";
import {
  RESTORE_REPLAY_CHAR_CAP,
  type AuthorPersona, type MemoryRecord, type RoleplayAgent, type SceneTurn,
} from "./model";
// 方向只有这一条：context → trace。trace 是纯类型 + 纯装配，不认识这个文件。
import { indexByDir, type ResidentPiece } from "./trace";

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
  /** 解析成功的条目。 */
  entities: LoreEntity[];
  /** 失效的绑定（条目或特征已被删除），UI 用来标灰 + 一键移除。 */
  stalePaths: string[];
  /**
   * 块里**真的装着正文**的那些层——写进注入账本的就是这一份，不是 `entities`。
   *
   * 超预算而只写了一行占位的绑定项**不在这里**：那一行只有标题，正文并不在
   * 上下文里。把它算成已注入，条目就两头落空——块里没有，检索也不会去补。
   */
  resident: {
    /** 整条绑定（裸 pin）且正文写进去了的条目。 */
    coreDirs: string[];
    /** 特征绑定且正文写进去了的那几段。 */
    facets: { dirPath: string; file: string }[];
  };
  /**
   * 同一件事的**显示**一侧：块里每一项各占多少字符，超预算的那些标出来。
   *
   * 和 `resident` 分开而不是合并，是因为两者的成员**不同**：`resident` 是给
   * 账本的，只收真的装了正文的层；`pieces` 是给作者看的，必须**同时**列出
   * 那些只写了一行标题的项——「它在清单里但正文没进去」正是作者最需要看见
   * 的一种状态，而把它塞进 `resident` 会让检索不再去补它（那是这个字段的
   * 注释里已经写死的一条）。
   */
  pieces: ResidentPiece[];
}

/** 绑定块里的一项，按它在块里的真实形状描述。 */
function piece(
  entity: LoreEntity,
  facetFile: string | null,
  chars: number,
  unexpanded: boolean,
): ResidentPiece {
  return {
    kind: facetFile ? "bound-facet" : "bound-core",
    name: entity.name,
    dirPath: entity.dirPath,
    facetTitle: facetFile
      ? (entity.facets ?? []).find((f) => f.file === facetFile)?.title ?? facetFile
      : null,
    chars,
    unexpanded,
  };
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
  const coreDirs: string[] = [];
  const facets: { dirPath: string; file: string }[] = [];
  const pieces: ResidentPiece[] = [];
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
      const placeholder = `${title}\n[未展开——绑定内容已超出预算，需要时用 read_lore_entity 读它。]`;
      parts.push(placeholder);
      // 占位行也占字符：不计入的话，几十个超预算的绑定项能把「已封顶」的块
      // 越顶越高。
      used += placeholder.length;
      if (!entities.includes(entity)) entities.push(entity);
      // 清单里有它，但正文没进去。`resident` 刻意不收它（那会让检索也不去补），
      // 而作者恰恰需要看见这个状态。
      pieces.push(piece(entity, pin.facetFile, title.length, true));
      continue;
    }
    const clipped = body.length <= room ? body : `${body.slice(0, room)}\n[……余下部分用 read_lore_entity 读。]`;
    parts.push(`${title}\n${clipped}`);
    used += title.length + clipped.length;
    if (!entities.includes(entity)) entities.push(entity);
    // 截断过的也算常驻：块里已经有它的绝大部分，检索再送一份完整的就是重复，
    // 而剩下的那点模型可以 read_lore_entity 自己去拿。
    if (pin.facetFile) facets.push({ dirPath: entity.dirPath, file: pin.facetFile });
    else coreDirs.push(entity.dirPath);
    pieces.push(piece(entity, pin.facetFile, title.length + clipped.length, false));
  }

  return {
    text: parts.join("\n\n"), entities, stalePaths, pieces,
    resident: { coreDirs, facets },
  };
}

/**
 * 绑定块里**实际**装着的东西进账本，carrier 是块本身——它永不离场，所以这些
 * 账目也永不失效（不变量二）。
 *
 * 按层记而不是按条目记，是整件事的支点：绑了「战甲」这一段，条目的其余部分
 * 必须继续参与自动检索。整条记账等于「勾一段 = 整条失联」。
 */
function recordBoundLayers(
  meta: ChatSessionMeta,
  loreIndex: LoreIndex,
  bound: BoundContent,
  carrier: StreamMessage,
): void {
  const byDir = indexByDir(loreIndex);
  const facetsByDir = new Map<string, string[]>();
  for (const f of bound.resident.facets) {
    const list = facetsByDir.get(f.dirPath) ?? [];
    list.push(f.file);
    facetsByDir.set(f.dirPath, list);
  }
  const coreDirs = new Set(bound.resident.coreDirs);
  for (const dir of new Set([...coreDirs, ...facetsByDir.keys()])) {
    const entity = byDir.get(dir);
    if (!entity) continue;
    recordInjection(meta, entity, carrier, {
      core: coreDirs.has(dir),
      facets: facetsByDir.get(dir) ?? [],
    });
  }
}

/**
 * 主角条目的正文住在 system 层的「## 你是谁」里——这件事也要进账本，否则第一次
 * 提到角色名时检索会把同一份正文再注入一遍。
 *
 * carrier 是 system 消息：它恒在 `history[0]`，压缩重建 prelude 时按对象身份搬过去
 * （`refreshSystemPrompt` 也是就地改 content，不换对象），所以这笔账和绑定块的一样
 * 永不失效。
 *
 * `primaryText` 为空就不记：条目读不出来时 system 层里根本没有它，记了只会让检索
 * 也不去补，条目就彻底不在上下文里。
 */
export function recordPrimaryCore(
  meta: ChatSessionMeta,
  loreIndex: LoreIndex,
  primaryDirPath: string | null,
  primaryText: string,
  system: StreamMessage,
): void {
  if (!primaryDirPath || !primaryText.trim()) return;
  const entity = indexByDir(loreIndex).get(primaryDirPath);
  if (entity) recordInjection(meta, entity, system, { core: true });
}

/**
 * 作者用 `@` 引用、正文已经被内联进问句的条目（`lib/agent/chatRefs`）。
 *
 * 记在**问句**上：那一轮被折叠时这笔账跟着走，之后再提到它才会重新注入。不记的话
 * 同一轮的自动检索会把它再送一份——【引用资料】一份、【知识库】一份，一模一样。
 */
export function recordInlinedRefs(
  meta: ChatSessionMeta,
  loreIndex: LoreIndex,
  dirPaths: readonly string[] | undefined,
  carrier: StreamMessage,
): void {
  if (!dirPaths?.length) return;
  const byDir = indexByDir(loreIndex);
  for (const dir of dirPaths) {
    const entity = byDir.get(dir);
    if (entity) recordInjection(meta, entity, carrier, { core: true });
  }
}

/**
 * 此刻**正文已经常驻在上下文里**的条目——UI 用它回答「这个条目还需要再 `@` 一次吗」。
 *
 * 有活会话就问账本（`coreDoneFor`）：它记的是块里实际有什么，是真相。没有活会话
 * （作者还没发第一句，块正要被建出来）才退回配置去推——主角条目 + 裸 pin 绑的条目。
 * 反过来只信配置是不行的：作者改了绑定却还没点「刷新设定」时，配置说常驻、上下文里
 * 其实没有，于是那一段既不会被内联、也不会被检索——正是这次返工要消灭的那种失联。
 *
 * 特征 pin 不进这个集合：常驻的是那一段特征，条目正文并不在上下文里。
 */
export function residentCoreDirs(
  agent: RoleplayAgent,
  meta: RoleplaySessionMeta | null,
  loreIndex: LoreIndex,
): Set<string> {
  if (meta) return coreDoneFor(meta, loreIndex);
  const byDir = indexByDir(loreIndex);
  const out = new Set<string>();
  if (agent.primaryDirPath && byDir.has(agent.primaryDirPath)) out.add(agent.primaryDirPath);
  for (const raw of agent.boundPaths) {
    // `byDir` 命中就是裸 pin——即使路径里带 `#`（和 selectLore 的 pin 解析同一条规则）。
    if (byDir.has(raw)) out.add(raw);
  }
  return out;
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
  if (persona.mode === "stranger") {
    // 这段话是改动之前 `none` 的原文，原样搬过来——它描述的是一个真实存在、
    // 而且有人在用的状态（作者临时演一个还没建条目的人），不该被悄悄改掉。
    return i18n.t("ai.instructions.roleplayPersonaStranger", {
      defaultValue: isZh
        ? "与你对话的人没有给出身份，把他当成故事里一个你还不认识的人。"
        : "The person speaking has not given an identity — treat them as someone in the story you do not yet know.",
    });
  }
  // 默认：导演视角。**必须说清三件事**，少一件模型就退回去把作者当角色——
  // 「他不是故事里的人」「他写的是场面和指令」「你演下去，不要回应他本人」。
  return i18n.t("ai.instructions.roleplayPersonaNone", {
    defaultValue: isZh
      ? "与你对话的**不是故事里的人**，是这部作品的作者。他写下的是场面描述和剧情指令"
        + "——「天开始下雨」「她推门进来」「让这段冷下来」——**不是有人在对你说话**。"
        + "你据此把这一段演下去：该发生的事让它发生，该说的话说出来。不要回应作者本人，"
        + "不要向他确认，也不要在正文里承认他的存在。"
      : "The person on the other side is **not someone in the story** — they are this work's author. "
        + "What they write is stage direction and scene description (\"it starts to rain\", \"she comes "
        + "through the door\", \"let this cool off\"), **not someone speaking to you**. Play the scene "
        + "forward from it: let what should happen happen, say what should be said. Do not answer the "
        + "author, do not check with them, and never acknowledge them in the prose.",
  });
}

/**
 * system 层的全部输入。
 *
 * 成为一个具名类型而不是内联的对象字面量，是因为它现在有三个消费者
 * （`buildSystemPrompt` / `refreshSystemPrompt` / `contextSignature`），而
 * 它们必须看着**同一份**输入——基线漏算一个字段，就是一次永远不亮的提示。
 */
export interface SystemPromptInput {
  agent: RoleplayAgent;
  persona: AuthorPersona;
  personaCard: string;
  primaryText: string;
  loreIndex: LoreIndex;
}

/**
 * 扮演 / 旁白的 system 提示。
 *
 * **刻意不走 `profileSystemPrompt()`**，也不套作者自定义的写作提示词模板。
 * 那一套是「写作协作者」人格，要求「零附加评论、只输出所请求的写作内容」——
 * 套在扮演上是灾难：角色会开始解释自己为什么这么说。扮演有自己的一份提示，
 * 自带创作主权条款（扮演比写作更容易触发模型的自我审查）。
 */
export function buildSystemPrompt(opts: SystemPromptInput): string {
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
  // 裸文本的含义随身份而变，所以这一句必须跟着分岔：导演模式下它不是「故事里
  // 某个人在描述场景」，而是作者在下指令。两种模式共用一套语法说明会互相打架
  // ——一边说「不是对你说的话」，另一边整篇都是对你说的话。
  if (opts.agent.kind !== "narrator" && opts.persona.mode === "none") {
    parts.push(i18n.t("ai.instructions.roleplaySyntaxDirector", {
      defaultValue: isZh
        ? "（作者此刻是导演，所以裸文本是**他给你的场面指令**，不是故事里某个人在描述环境。"
          + "照它演，别把它当成有人在说话。）"
        : "(The author is directing right now, so unmarked text is **their instruction for the scene**, "
          + "not someone in the story describing the surroundings. Play it; do not treat it as speech.)",
    }));
  }
  parts.push(i18n.t("ai.instructions.roleplayMemory"));
  return parts.join("\n\n");
}

/**
 * 重写 system 提示（作者点了「刷新设定」）。
 *
 * system 层装着**四样只在播种时读过一次**的东西：角色人设正文（`primaryText`）、
 * 作者给的指令（`personaCard`）、作者此刻的身份（`persona`）、以及扮演规则本身。
 * 前三样作者随时会改，而在这个函数存在之前，改完之后唯一能让模型看见的办法是
 * 开新的一场——UI 却已经把身份 chip 和署名换掉了。作者看到的和模型看到的从此
 * 分岔，且没有任何提示：**操作看起来生效了，其实没有**。
 *
 * 就地改 `content`、不换消息对象，理由和 `refreshBoundBlock` 一样。这里额外靠
 * 一件事：system 恒在 `history[0]`——`buildCompactedHistory` 把 prelude 按对象
 * 身份搬进新数组，`trimHistory` 不动普通消息，`repairToolCallPairing` 只 splice
 * 配不上对的 tool 消息。所以它不需要像绑定块那样在 meta 里被持有，也就不需要
 * 动 `session.json` 的格式。守一句 role 判断，是因为「恒在 0 位」是别处的性质，
 * 不是这里能保证的事。
 */
export function refreshSystemPrompt(
  history: StreamMessage[],
  opts: SystemPromptInput,
): boolean {
  const head = history[0];
  if (!head || head.role !== "system") return false;
  head.content = buildSystemPrompt(opts);
  return true;
}

/**
 * 「设定变没变」的基线。
 *
 * 覆盖 system 层和绑定块里**全部**由作者改动的输入，而不只是绑定条目：改主角
 * 条目、改「作者给你的指令」、换身份，和改一个绑定条目是同一件事——「我改了
 * 设定，为什么角色没变」——凭什么只有最后一种能亮起提示。
 *
 * 取**输入**而不是取 `buildSystemPrompt` 的产物：那份产物含 i18n 文案，切一次
 * 界面语言会把整个花名册标成「设定已更新」，而那不是作者改的东西。
 *
 * persona 是 `lore` 时，把条目的名字和摘要一起算进去——system 行里写的就是这
 * 两样，改了名字而基线不动，等于漏掉一种最容易发生的改动。旁白则整段跳过
 * persona 和 primaryText：它的提示词根本不读这两样，算进去只会让「换身份」在
 * 一个不扮演任何人的 agent 上亮起提示。
 */
export function contextSignature(input: SystemPromptInput & { boundText: string }): string {
  // 名字也算：`ai.instructions.roleplay` 把它插在「你现在扮演一个角色：{{name}}」
  // 里，改名就是改了 system 层。
  const parts = [input.agent.name, input.boundText, input.personaCard.trim()];
  if (input.agent.kind !== "narrator") {
    parts.push(input.primaryText.trim(), personaKey(input.persona, input.loreIndex));
  }
  // \u0001 作分隔：正文里不会出现，所以拼接不会把两个字段的边界糊掉。
  return parts.join("\n\u0001\n");
}

function personaKey(persona: AuthorPersona, loreIndex: LoreIndex): string {
  if (persona.mode === "lore" && persona.dirPath) {
    const entity = indexByDir(loreIndex).get(persona.dirPath);
    return `lore\u0000${persona.dirPath}\u0000${entity?.name ?? ""}\u0000${entity?.summary ?? ""}`;
  }
  if (persona.mode === "prompt") return `prompt\u0000${persona.prompt.trim()}`;
  // 导演和陌生人**必须给出不同的键**：它们在 system 层是完全不同的两段话，而这个
  // 函数是「设定变没变」的唯一判据。两档共用一个 "none" 的样子是——作者在它们之间
  // 切换，「设定已更新」永远不亮，操作看起来生效了、其实没有。
  return persona.mode === "stranger" ? "stranger" : "none";
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
  /** 取材范围（见 lib/lore/collections）；绑定条目不受它限制。 */
  loreScope?: LoreScope;
  firstMessage: MessageContent;
  /** 检索用的纯文本（`firstMessage` 可能带图片 part，图片没有词可匹配）。 */
  matchText: string;
  /**
   * `@` 引用已经把正文内联进 `firstMessage` 的条目（dirPath）。它们这一轮不再
   * 由检索送第二份，见 {@link recordInlinedRefs}。
   */
  refDirs?: readonly string[];
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

  // 两个 prelude 块**无条件**创建，空时只是一行占位。「有内容才建」曾经是这里
  // 的写法，而它让「无→有」成为一个到处都接不住的状态迁移：新角色首场戏中途
  // `remember` 的东西，压缩把工具结果折叠掉之后，`refreshMemoryBlock` 面对一个
  // 不存在的块只能沉默——记忆块「恒在 prelude」的不变量四就这样在最常见的情形
  // （零记忆开场的新角色）下失效。块恒存在，所有刷新路径就天然闭合，prelude 的
  // 稳定前缀长度也不再随内容有无而变。
  const boundBlock: StreamMessage = { role: "user", content: boundBlockContent(bound.text) };
  messages.push(boundBlock);
  meta.boundBlock = boundBlock;
  // 账本：绑定块里**真的装着**的那些层已经在上下文里，逐轮注入不该再送一遍。
  // carrier 是绑定块本身——它永不离开历史，所以这些账本条目也永不失效。
  recordBoundLayers(meta, opts.loreIndex, bound, boundBlock);
  // 主角条目的正文住在 system 层，同样记一笔。**排在绑定块之后**是有意的：
  // 作者若把主角也绑了整条（PR-4 之前的老数据正是如此），两处都有它的正文，
  // 而 system 那份活得更久——「刷新设定」清掉的是绑定块那一版的账，system
  // 里的那份不该跟着失效。
  recordPrimaryCore(meta, opts.loreIndex, opts.agent.primaryDirPath, opts.primaryText, system);

  const memoryBlock: StreamMessage = {
    role: "user",
    content: memoryBlockContent(renderMemoryBlock(opts.memory) || memoryNoneText()),
  };
  messages.push(memoryBlock);
  meta.memoryBlock = memoryBlock;

  // 首轮自动命中：已经在上下文里的那些层之外，用作者第一句去匹配。
  //
  // **主角条目当 pin 传进去**：作者是第一人称对着角色说话，一整场戏都未必写出它
  // 的名字，而自动匹配要先命中条目名才轮得到特征。pin 让它每轮都在候选里（正文
  // 由 `coreDone` 挡着不重发），它的特征才可能按 keys 激活——「绑定主条目 + 特征
  // 自动注入」这条期望，靠的就是这一行。
  const coreDone = coreDoneFor(meta, opts.loreIndex);
  for (const dir of opts.refDirs ?? []) coreDone.add(dir);
  const { text: snippets, report } = await selectLore(
    opts.matchText,
    opts.loreIndex,
    opts.agent.primaryDirPath ? [opts.agent.primaryDirPath] : [],
    opts.loreBudgetChars,
    {
      coreDone,
      excludeFacets: injectedFacetsFor(meta, opts.loreIndex),
      scope: opts.loreScope ?? null,
    },
  );
  if (snippets) {
    const seed: StreamMessage = {
      role: "user",
      content: `【${i18n.t("roleplay.section.scene", { defaultValue: "场景" })}】\n${snippets}`,
    };
    messages.push(seed);
    meta.seedContext = seed;
    recordInjectionsFromReport(meta, report, opts.loreIndex, seed);
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
  recordInlinedRefs(meta, opts.loreIndex, opts.refDirs, question);

  return { messages, meta, report, bound };
}

/**
 * 首次请求会带上的三个固定块各有多大。
 *
 * 存在的理由和 `contextSignature` 一样：**估的那一份和真的那一份必须由同一段
 * 代码算出来**。首轮之前 `session.history` 是 `null`，上下文构成条只画得出工具
 * schema——而首次请求真正会带上的 system 层、绑定块、记忆块一样都还没装配。
 * 在别处照着拼一遍块的形状，就是让一个「预估」在下次有人改动块头文案时安静
 * 地失准，而它恰恰无法被任何测试发现（估值本来就不精确）。
 *
 * 三块都用真的构造函数，含 `【…】` 块头和那句引导语——少算四十个字符事小，
 * 让两份代码各自演化事大。检索块不在这里：它取决于作者还没打出来的那句话。
 *
 * **字数和 token 数一起给**，因为只有这里同时握着那三段**真正的文本**。上下文
 * 构成条要的是 token，而字→token 的比值随语种在 1（中文）和 4（拉丁字母）之间
 * 差四倍——拿一个常数去换算，等于在一条写着「≥」的读数上报一个可能高四倍的数，
 * 而「≥」是个下界声明，高报就是假的。用权威估算器（`estimateTextTokens`，预检
 * 门用的同一个）当场数，一次换算、不猜比值。
 */
export function blockSizes(opts: {
  system: SystemPromptInput;
  boundText: string;
  memory: readonly MemoryRecord[];
}): {
  systemChars: number; boundChars: number; memoryChars: number;
  systemTokens: number; boundTokens: number; memoryTokens: number;
} {
  const system = buildSystemPrompt(opts.system);
  const bound = boundBlockContent(opts.boundText);
  const memory = memoryBlockContent(renderMemoryBlock(opts.memory) || memoryNoneText());
  return {
    systemChars: system.length,
    boundChars: bound.length,
    memoryChars: memory.length,
    systemTokens: estimateTextTokens(system),
    boundTokens: estimateTextTokens(bound),
    memoryTokens: estimateTextTokens(memory),
  };
}

function memoryBlockContent(body: string): string {
  const label = i18n.t("roleplay.section.memory", { defaultValue: "记忆" });
  const lead = i18n.t("roleplay.section.memoryLead", {
    defaultValue: "以下是你自己记下的、到现在仍然有效的事。它们不随对话变长而遗忘。",
  });
  return `【${label}】\n${lead}\n${body}`;
}

function memoryNoneText(): string {
  return i18n.t("roleplay.section.memoryNone", { defaultValue: "（暂时没有。）" });
}

/** 绑定块的完整正文。播种和刷新必须产出同一个形状，所以只有这一处拼它。 */
function boundBlockContent(text: string): string {
  const label = i18n.t("roleplay.section.bound", { defaultValue: "绑定条目" });
  const body = text || i18n.t("roleplay.section.boundNone", {
    defaultValue: "（暂时没有绑定的条目。需要资料时用 read_lore_entity 去读。）",
  });
  return `【${label}】\n${body}`;
}

/**
 * 给一段**旧版本播种的**历史补上缺失的块。
 *
 * 播种现在无条件创建两个块，但本版本之前的 `session.json` 里躺着两类残缺历史：
 * 播种时恰好没内容于是根本没建过块的，和序列化丢了 `memoryBlock` 身份的（旧
 * `SerializedSession` 只存 boundBlock 下标）。对后者，如果历史里其实还留着旧的
 * 记忆块消息，这里会再插一条新的——旧的退化成一条几十字的惰性消息，代价有界且
 * 只发生一次；换取的是不用按 i18n 文案去历史里猜哪条消息曾经是块。
 *
 * 只在**恢复**（select）和「刷新设定」这两个低频入口调用，不进热路径。
 */
export function ensureBlocks(history: StreamMessage[], meta: RoleplaySessionMeta): void {
  const afterSystem = history.length > 0 && history[0].role === "system" ? 1 : 0;
  if (!meta.boundBlock) {
    const block: StreamMessage = { role: "user", content: boundBlockContent("") };
    history.splice(afterSystem, 0, block);
    meta.boundBlock = block;
  }
  if (!meta.memoryBlock) {
    const at = history.indexOf(meta.boundBlock) + 1;
    const block: StreamMessage = { role: "user", content: memoryBlockContent(memoryNoneText()) };
    history.splice(at, 0, block);
    meta.memoryBlock = block;
  }
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
  meta.memoryBlock.content = memoryBlockContent(renderMemoryBlock(records) || memoryNoneText());
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
    meta.boundBlock.content = boundBlockContent(bound.text);
    // 先忘掉这块上一版带来的账目：作者刚取消勾选的那一段既不在新块里了，也不该
    // 继续被当成「已经在上下文里」——否则它从此两头落空，块里没有、检索也不补。
    clearCarrier(meta, meta.boundBlock);
    recordBoundLayers(meta, loreIndex, bound, meta.boundBlock);
  }
  return bound;
}
